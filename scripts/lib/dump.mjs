/**
 * dump.mjs —— 把解码结果（codec.mjs 的对象）打印成 protobuf 文本格式风格的可读文本
 *
 *   已知字段（schema 里有）：   name: 值 / name { … }（repeated 逐项各一块）
 *   未知字段（_u）：            #字段号: 值 / #字段号 { … }
 *   32 位定长未知值同时给出 float 解读：#5: f32 0x0000803f (1)
 *
 * 另提供 pathGet：用 `9[0].502[21].505[3]` 这种路径取子树（下标是「同字段号第几次出现」，
 * 已知字段用名字：`nodes[2].pins[0]`；未知字段用 `#502[21]`）。
 */

const HEX_CUT = 24;

const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function fmtScalar(v, maxStr) {
  if (typeof v === 'string') {
    if (v.startsWith('0x') && /^0x[0-9a-f]*$/.test(v) && v.length > 2 + HEX_CUT * 2) return `${v.slice(0, 2 + HEX_CUT * 2)}…(${(v.length - 2) / 2}B)`;
    const s = v.length > maxStr ? `${v.slice(0, maxStr)}…(+${v.length - maxStr})` : v;
    return JSON.stringify(s);
  }
  if (typeof v === 'number' && Number.isInteger(v) && Math.abs(v) > 0xffff) return `${v} (0x${v.toString(16)})`;
  return String(v);
}

function fmtUnknown(list, ind, out, maxStr) {
  const pad = '  '.repeat(ind);
  for (const u of list) {
    const tag = `#${u.f}`;
    if (u.w === 'varint') out.push(`${pad}${tag}: ${fmtScalar(u.v, maxStr)}`);
    else if (u.w === 'i32') {
      const b = Buffer.from(u.hex.slice(2), 'hex');
      const fl = b.readFloatLE(0);
      out.push(`${pad}${tag}: f32 ${u.hex} (${Number.isFinite(fl) ? +fl.toPrecision(7) : 'nan'} | i32 ${b.readInt32LE(0)})`);
    } else if (u.w === 'i64') {
      const b = Buffer.from(u.hex.slice(2), 'hex');
      out.push(`${pad}${tag}: f64 ${u.hex} (${b.readDoubleLE(0)})`);
    } else if (Array.isArray(u.msg)) {
      out.push(`${pad}${tag} {`);
      fmtUnknown(u.msg, ind + 1, out, maxStr);
      out.push(`${pad}}`);
    } else if (typeof u.text === 'string') out.push(`${pad}${tag}: ${fmtScalar(u.text, maxStr)}`);
    else out.push(`${pad}${tag}: ${fmtScalar(u.hex, maxStr)}`);
  }
}

/** 对象 → 文本行。opts: { maxStr=60, maxDepth=∞ } */
export function dumpObject(obj, opts = {}) {
  const out = [];
  fmtObject(obj, 0, out, opts.maxStr ?? 60, opts.maxDepth ?? Infinity);
  return out.join('\n');
}

function fmtObject(obj, ind, out, maxStr, maxDepth) {
  const pad = '  '.repeat(ind);
  for (const [k, v] of Object.entries(obj)) {
    if (k === '_u') continue;
    const items = Array.isArray(v) ? v : [v];
    for (const it of items) {
      if (isPlain(it)) {
        if (ind >= maxDepth) { out.push(`${pad}${k} { … }`); continue; }
        out.push(`${pad}${k} {`);
        fmtObject(it, ind + 1, out, maxStr, maxDepth);
        out.push(`${pad}}`);
      } else out.push(`${pad}${k}: ${fmtScalar(it, maxStr)}`);
    }
  }
  if (obj._u?.length) {
    if (ind >= maxDepth) out.push(`${pad}#… ${obj._u.length} 个未知字段`);
    else fmtUnknown(obj._u, ind, out, maxStr);
  }
}

/** 只打印未知字段列表（用于对完全未知的子树） */
export function dumpUnknown(list, opts = {}) {
  const out = [];
  fmtUnknown(list, 0, out, opts.maxStr ?? 60);
  return out.join('\n');
}

// ─────────────────────────── 路径 ───────────────────────────

/**
 * 解析并取值。path 例：`nodes[2].pins[0]`、`#9[0].#502[21].#505[3]`
 * 节点可以是：对象（已知字段）、_u 记录（{f,w,msg…}）。返回找到的值，找不到返回 undefined。
 * 遇到 _u 里的 msg 时，会把它当作「只有未知字段的对象」继续往下走。
 */
export function pathGet(root, path) {
  let cur = root;
  for (const seg of path.split('.').filter(Boolean)) {
    const m = /^(#?)([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(seg);
    if (!m) throw new Error(`路径段无法解析：${seg}`);
    const [, hash, key, idxStr] = m;
    const idx = idxStr == null ? 0 : Number(idxStr);
    if (cur == null) return undefined;
    if (Array.isArray(cur.msg)) cur = { _u: cur.msg };
    if (hash) {
      const hits = (cur._u || []).filter((u) => u.f === Number(key));
      cur = hits[idx];
    } else {
      const v = cur[key];
      cur = Array.isArray(v) ? v[idx] : idx === 0 ? v : undefined;
    }
  }
  return cur;
}

/** 把 pathGet 取到的东西转成可 dump 的对象 */
export function asDumpable(node) {
  if (node == null) return null;
  if (node.w && node.f != null) return { _u: Array.isArray(node.msg) ? node.msg : [node] };
  return node;
}
