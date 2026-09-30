/**
 * diff.mjs —— 两个解码结果的结构差异（按路径列出：新增 / 删除 / 修改）
 *
 * 逆向与日常都很好用：在编辑器里改一个设置、各导出一份，diff 一下就知道这个设置落在哪个字段。
 * _u 里的未知字段按 #字段号 展示，嵌套的 msg 展开成对象，便于对齐比较。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

/** 把 _u 记录变成可比较的普通 JSON */
function unknownValue(u) {
  if (u.w === 'varint') return u.v;
  if (u.w === 'len') return Array.isArray(u.msg) ? normalize({ _u: u.msg }) : (u.text ?? u.hex);
  return u.hex;
}

export function normalize(node) {
  if (Array.isArray(node)) return node.map(normalize);
  if (node === null || typeof node !== 'object') return node;
  const out = {};
  for (const [k, v] of Object.entries(node)) {
    if (k !== '_u') out[k] = normalize(v);
  }
  for (const u of node._u || []) (out[`#${u.f}`] ||= []).push(unknownValue(u));
  return out;
}

const short = (v) => {
  const s = typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v);
  return s.length > 90 ? `${s.slice(0, 90)}…` : s;
};

/**
 * @returns {{ path: string, kind: 'add'|'del'|'mod', a?: any, b?: any }[]}
 */
export function diffObjects(a, b, { limit = 200, ignore = [] } = {}) {
  const out = [];
  const A = normalize(a);
  const B = normalize(b);
  const skip = (path) => ignore.some((p) => path === p || path.startsWith(`${p}.`) || path.startsWith(`${p}[`));
  const walk = (x, y, path) => {
    if (out.length >= limit || skip(path)) return;
    if (JSON.stringify(x) === JSON.stringify(y)) return;
    const isObj = (v) => v !== null && typeof v === 'object';
    if (Array.isArray(x) && Array.isArray(y)) {
      const n = Math.max(x.length, y.length);
      for (let i = 0; i < n; i++) {
        if (i >= x.length) out.push({ path: `${path}[${i}]`, kind: 'add', b: y[i] });
        else if (i >= y.length) out.push({ path: `${path}[${i}]`, kind: 'del', a: x[i] });
        else walk(x[i], y[i], `${path}[${i}]`);
        if (out.length >= limit) return;
      }
    } else if (isObj(x) && isObj(y) && !Array.isArray(x) && !Array.isArray(y)) {
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) {
        const p = path ? `${path}.${k}` : k;
        if (!(k in x)) out.push({ path: p, kind: 'add', b: y[k] });
        else if (!(k in y)) out.push({ path: p, kind: 'del', a: x[k] });
        else walk(x[k], y[k], p);
        if (out.length >= limit) return;
      }
    } else {
      out.push({ path, kind: 'mod', a: x, b: y });
    }
  };
  walk(A, B, '');
  return out;
}

export function formatDiff(list) {
  return list.map((d) => {
    if (d.kind === 'add') return `+ ${d.path}: ${short(d.b)}`;
    if (d.kind === 'del') return `- ${d.path}: ${short(d.a)}`;
    return `~ ${d.path}: ${short(d.a)}  →  ${short(d.b)}`;
  }).join('\n');
}
