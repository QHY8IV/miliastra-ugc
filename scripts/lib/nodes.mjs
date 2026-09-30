/**
 * nodes.mjs —— 节点表（references/formats/data/nodes.json）的查询接口
 *
 * 数据出处：【第三方】社区节点表（MIT，见 references/formats/schema/THIRD_PARTY_LICENSES.md），
 * 已与 references/samples/ 的官方样本交叉核对：样本里服务器节点的 6091 个引脚（种类+序号）100% 存在于表中，
 * 2008 个带类型的数据引脚类型码 100% 吻合。表是 game 6.2.0 的，7.x 新增的节点可能缺失。
 *
 * 术语
 *   shell  节点的「外壳」（UI 上看到的那个节点）；泛型节点的 shell 用基类 ID
 *   kernel 节点的「内核」（实际执行的实现）；泛型节点的 kernel 是具体类型版本的 ID（= variants 里的 kernelId）
 *   pin    引脚：flow（执行流）/ data（数据），各有入/出。shellIndex / kernelIndex 是「该方向该种类里第几个」
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
export const DEFAULT_NODE_TABLE = join(HERE, '..', '..', 'references', 'formats', 'data', 'nodes.json');

let cached = null;

export function loadNodeTable(path = DEFAULT_NODE_TABLE) {
  if (cached && cached.path === path) return cached.table;
  const raw = JSON.parse(readFileSync(path, 'utf8'));
  const table = { meta: raw._meta, types: raw.types, enums: raw.enums, enumNames: raw.enumNames, nodes: raw.nodes, kernelFix: raw.kernelFix || {} };
  table.byId = new Map();
  table.byIdent = new Map();
  table.byName = new Map(); // 中文名/英文名 → 节点[]（同名可能有服务器和客户端各一个）
  for (const n of table.nodes) {
    // kernelFix：官方样本里 kernel 序号与第三方表不同的引脚（以样本为准），键 "flow|data:in|out:shellIndex"
    const fix = table.kernelFix[n.id] || {};
    n.flowPins = n.flow.map(([name, d, si, ki, zh]) => {
      const dir = d === 'i' ? 'in' : 'out';
      return { kind: 'flow', name, dir, shellIndex: si, kernelIndex: fix[`flow:${dir}:${si}`] ?? ki, zh };
    });
    n.dataPins = n.data.map(([name, d, type, si, ki, vis, zh]) => {
      const dir = d === 'i' ? 'in' : 'out';
      return { kind: 'data', name, dir, type, shellIndex: si, kernelIndex: fix[`data:${dir}:${si}`] ?? ki, vis, zh };
    });
    // 同一 ID 只应有一个节点；有重复时保留先出现的
    if (!table.byId.has(n.id)) table.byId.set(n.id, n);
    table.byIdent.set(n.ident, n);
    for (const nm of [n.zh, n.en]) {
      if (!nm) continue;
      const key = nm.trim();
      if (!table.byName.has(key)) table.byName.set(key, []);
      table.byName.get(key).push(n);
    }
  }
  cached = { path, table };
  return table;
}

/** 类型表达式解析。返回 { k:'basic'|'list'|'enum'|'dict'|'struct'|'reflect', … } */
export function parseTypeExpr(expr) {
  const s = (expr || '').trim();
  let m;
  if ((m = /^R<(\w+)>$/.exec(s))) return { k: 'reflect', name: m[1] };
  if ((m = /^L<(.+)>$/.exec(s))) return { k: 'list', item: parseTypeExpr(m[1]) };
  if ((m = /^E<(\w*)>$/.exec(s))) return { k: 'enum', enum: m[1] };
  if (/^D<.*>$/.test(s)) {
    const inner = s.slice(2, -1);
    let depth = 0, cut = -1;
    for (let i = 0; i < inner.length; i++) {
      if (inner[i] === '<') depth++;
      else if (inner[i] === '>') depth--;
      else if (inner[i] === ',' && depth === 0) { cut = i; break; }
    }
    return cut < 0 ? { k: 'dict', key: parseTypeExpr(inner), value: null }
      : { k: 'dict', key: parseTypeExpr(inner.slice(0, cut)), value: parseTypeExpr(inner.slice(cut + 1)) };
  }
  if (/^S<.*>$/.test(s)) return { k: 'struct', raw: s };
  return { k: 'basic', id: s };
}

const typeToString = (t) => {
  switch (t.k) {
    case 'reflect': return `R<${t.name}>`;
    case 'list': return `L<${typeToString(t.item)}>`;
    case 'enum': return `E<${t.enum}>`;
    case 'dict': return `D<${typeToString(t.key)},${t.value ? typeToString(t.value) : ''}>`;
    case 'struct': return t.raw;
    default: return t.id;
  }
};

/** 把类型表达式里的反射参数（R<T>）替换成具体类型；bindings 形如 { T: 'Int' } */
export function substitute(expr, bindings) {
  const walk = (t) => {
    if (t.k === 'reflect') return bindings[t.name] ? parseTypeExpr(bindings[t.name]) : t;
    if (t.k === 'list') return { k: 'list', item: walk(t.item) };
    if (t.k === 'dict') return { k: 'dict', key: walk(t.key), value: t.value ? walk(t.value) : null };
    return t;
  };
  return typeToString(walk(parseTypeExpr(expr)));
}

/** 具体类型表达式 → ServerTypeId；含未绑定的反射参数或不认识的类型返回 null */
export function typeExprToId(table, expr) {
  const t = parseTypeExpr(expr);
  const norm = typeToString(t);
  if (/R</.test(norm)) return null;
  if (table.types[norm] != null) return table.types[norm];
  switch (t.k) {
    case 'enum': return table.types['E<Unk>'];
    case 'list': return t.item.k === 'enum' ? table.types['L<E<Unk>>'] : t.item.k === 'struct' ? table.types['L<S<>>'] : null;
    case 'dict': return table.types['D<Unk,Unk>'];
    case 'struct': return table.types['S<>'];
    default: return null;
  }
}

/** 解析约束表达式 "C<T:Int>" / "C<K:Str,V:Int>" → { T: 'Int' } */
export function parseConstraint(c) {
  const m = /^C<(.*)>$/.exec((c || '').trim());
  const out = {};
  if (!m || !m[1]) return out;
  let depth = 0, start = 0;
  const parts = [];
  for (let i = 0; i <= m[1].length; i++) {
    const ch = m[1][i];
    if (ch === '<') depth++;
    else if (ch === '>') depth--;
    else if ((ch === ',' && depth === 0) || i === m[1].length) { parts.push(m[1].slice(start, i)); start = i + 1; }
  }
  for (const p of parts) {
    const k = p.indexOf(':');
    if (k > 0) out[p.slice(0, k).trim()] = p.slice(k + 1).trim();
  }
  return out;
}

/** 泛型节点的变体：返回 [{ bindings, kernelId, inject: {引脚标识符: TypeSelectorIndex} }] */
export function variantsOf(node) {
  return (node.variants || []).map(([c, kernelId, inj]) => ({
    bindings: parseConstraint(c),
    kernelId,
    inject: Object.fromEntries((inj || []).map((i) => [i.Identifier, i.TypeSelectorIndex ?? 0])),
  }));
}

/** 按绑定（{T:'Int'}）选变体；找不到返回 null */
export function chooseVariant(node, bindings) {
  const want = Object.entries(bindings || {});
  return variantsOf(node).find((v) => want.every(([k, val]) => v.bindings[k] === val) && Object.keys(v.bindings).length === want.length) || null;
}

/** 列出节点在一个方向上的所有引脚（含隐藏的），按 shellIndex 排序 */
export function pinsOf(node, kind, dir) {
  const list = kind === 'flow' ? node.flowPins : node.dataPins;
  return list.filter((p) => p.dir === dir).sort((a, b) => a.shellIndex - b.shellIndex);
}

/**
 * 按标识符 / 中文名 / 1 起的序号 找引脚；找不到返回 null。
 * 字符串先按名字匹配（有的节点引脚就叫 "0"、"1"，例如「拼装列表」），
 * 匹配不到且形如数字时才当作 1 起的序号。同名时优先可见的。
 */
export function findPin(node, ref, kind, dir) {
  const pins = pinsOf(node, kind, dir);
  if (typeof ref === 'number') return pins[ref - 1] || null;
  const s = String(ref).trim();
  const same = pins.filter((p) => p.name === s || (p.zh && p.zh === s));
  if (same.length) return same.find((p) => p.vis !== 'H') || same[0];
  return /^\d+$/.test(s) ? pins[Number(s) - 1] || null : null;
}

/** 按 ID（数字）/ 中文名 / 英文名 / 标识符查节点。sys: 'S'|'C'|undefined。返回 { node } 或 { candidates } */
export function lookupNode(table, q, sys = 'S') {
  if (typeof q === 'number' || /^\d+$/.test(String(q))) {
    const n = table.byId.get(Number(q));
    return n ? { node: n } : { candidates: [] };
  }
  const key = String(q).trim();
  const byIdent = table.byIdent.get(key);
  if (byIdent && (!sys || byIdent.sys === sys)) return { node: byIdent };
  const exact = (table.byName.get(key) || []).filter((n) => !sys || n.sys === sys);
  if (exact.length === 1) return { node: exact[0] };
  if (exact.length > 1) return { candidates: exact };
  // 模糊：子串
  const lower = key.toLowerCase();
  const fuzzy = table.nodes.filter((n) => (!sys || n.sys === sys) && (n.zh.includes(key) || n.en.toLowerCase().includes(lower)));
  return { candidates: fuzzy.slice(0, 12) };
}
