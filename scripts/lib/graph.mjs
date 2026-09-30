/**
 * graph.mjs —— 服务器节点图：NodeGraph ⇄ 图规格（GraphSpec，agent 直接写的 JSON）
 *
 * 只覆盖「服务器侧节点图」：实体 / 状态 / 职业 / 道具 节点图，节点全部来自节点表（固定 + 泛型），
 * 常量支持 整数 / 浮点 / 布尔 / 字符串 / 三维向量 / ID 类（GUID、元件、配置、阵营）/ 枚举 / 基础类型列表，
 * 连线支持 执行流 与 数据。不在覆盖范围内的（黑板变量、注释、信号、结构体、字典、复合节点、客户端图）
 * 反编译时以 raw 原样保留，编译时报「不支持」——不会悄悄丢。
 *
 * ── 图规格（GraphSpec）────────────────────────────────────────────
 * {
 *   "name": "元件—交互拾取得分",           图名
 *   "kind": "entity",                     entity | status | class | item（默认 entity）
 *   "nodes": [
 *     { "id": "n1",                       稿内标识，任意唯一字符串
 *       "node": "设置自定义变量",           节点：中文名 / 英文名 / 标识符 / 数字 ID
 *       "T": "Int",                       泛型绑定（可选）；双参数写 {"K":"Str","V":"Int"}
 *       "pos": [-198, -455],              画布坐标
 *       "in":  { "变量名": "积分值",        数据入引脚：常量
 *                "目标实体": {"from": "n0.事件源实体"} },   或连线（点后是出引脚名，省略则取第一个数据出引脚）
 *       "then": "n2"                      执行流：省略引脚名 = 第一个流程出引脚；
 *               | { "是": "n3", "否": "n4.流程入" }        多出口按引脚名；目标可带入引脚名
 *     } ]
 * }
 *
 * 【证据】编码规则来自对 references/samples/ 中 169 张官方节点图的分析：
 *   输入执行流引脚从不落盘；输出执行流引脚只有连线时才写；数据入引脚只有「有连线或被设置过」才写；
 *   泛型（R<T>）的入/出引脚总会写出类型占位；数据连线记在「入引脚」上，执行流连线记在「出引脚」上；
 *   节点内引脚按 (种类, 序号) 升序。TypedValue 里 type_def / is_value_set 的有无在官方导出里并不统一
 *   （同一类型有多种形态），说明游戏读取这一层是宽容的，这里取多数派形态。
 *   【未在真机验证】生成的文件必须导入编辑器确认（见 references/formats/README.md 的导入检验流程）。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import {
  chooseVariant, findPin, lookupNode, parseTypeExpr, pinsOf, substitute, typeExprToId, variantsOf,
} from './nodes.mjs';

export class GraphError extends Error {
  constructor(problems) {
    super(problems.map((p) => `${p.path ? p.path + '：' : ''}${p.msg}`).join('\n'));
    this.name = 'GraphError';
    this.problems = problems;
  }
}

// 图的种类 → 身份常量（SystemConstants.GRAPH_CATEGORY_CONSTS，第三方；实体图/道具图已被官方样本印证）
export const GRAPH_KINDS = Object.freeze({
  entity: { resource_class: 'ENTITY_NODE_GRAPH', category: 'SERVER_BASIC' },
  status: { resource_class: 'STATUS_NODE_GRAPH', category: 'SERVER_STATUS' },
  class: { resource_class: 'CLASS_NODE_GRAPH', category: 'SERVER_CLASS' },
  item: { resource_class: 'ITEM_NODE_GRAPH', category: 'SERVER_ITEM' },
});

// 【官方示例】有些节点固定带 context_declaration：结算关卡(77)、设置玩家结算成功状态(652)，
// 在全部 18 处出现里内容逐字节相同（kind=7 + 字段 103 = 0x120101）。含义未知，但复制它是安全的。
const SETTLE_CONTEXT = { kind: 7, _u: [{ f: 103, w: 'len', hex: '0x120101' }] };
const NODE_CONTEXT = new Map([[77, SETTLE_CONTEXT], [652, SETTLE_CONTEXT]]);

const KIND = { IN_FLOW: 'IN_FLOW', OUT_FLOW: 'OUT_FLOW', IN_PARAM: 'IN_PARAM', OUT_PARAM: 'OUT_PARAM' };
const KIND_ORDER = { IN_FLOW: 1, OUT_FLOW: 2, IN_PARAM: 3, OUT_PARAM: 4 };

const typeName = (schemaEnumByNumber, id) => schemaEnumByNumber.get(id) ?? id;

// ServerTypeId → 名字（S_INT …）。写编码时 codec 也接受数字，这里只为 type_def 用。
const SERVER_TYPE_TAG = {
  1: 'S_ENTITY', 2: 'S_GUID', 3: 'S_INT', 4: 'S_BOOL', 5: 'S_FLOAT', 6: 'S_STRING', 7: 'S_GUID_LIST', 8: 'S_INT_LIST',
  9: 'S_BOOL_LIST', 10: 'S_FLOAT_LIST', 11: 'S_STRING_LIST', 12: 'S_VECTOR', 13: 'S_ENTITY_LIST', 14: 'S_ENUM_ITEM',
  15: 'S_VECTOR_LIST', 17: 'S_FACTION', 18: 'S_ENUM_LIST', 20: 'S_CONFIG', 21: 'S_PREFAB', 22: 'S_CONFIG_LIST',
  23: 'S_PREFAB_LIST', 24: 'S_FACTION_LIST', 25: 'S_STRUCT', 26: 'S_STRUCT_LIST', 27: 'S_DICT',
};

// 节点图变量（黑板）的类型标签 ⇄ 类型表达式（只覆盖基础类型与基础列表；字典/结构体走 raw）
const TAG_TO_EXPR = {
  S_ENTITY: 'Ety', S_GUID: 'Gid', S_INT: 'Int', S_BOOL: 'Bol', S_FLOAT: 'Flt', S_STRING: 'Str', S_VECTOR: 'Vec',
  S_CONFIG: 'Cfg', S_PREFAB: 'Pfb', S_FACTION: 'Fct',
  S_GUID_LIST: 'L<Gid>', S_INT_LIST: 'L<Int>', S_BOOL_LIST: 'L<Bol>', S_FLOAT_LIST: 'L<Flt>', S_STRING_LIST: 'L<Str>',
  S_ENTITY_LIST: 'L<Ety>', S_VECTOR_LIST: 'L<Vec>',
};

const f32 = (x) => Math.fround(Number(x));
/** 浮点数展示：取 float32 能无损往返的最短十进制 */
function f32Pretty(x) {
  for (let p = 1; p <= 9; p++) {
    const s = Number(x.toPrecision(p));
    if (Math.fround(s) === x) return s;
  }
  return x;
}

// ─────────────────────────── 值：JS ⇄ TypedValue ───────────────────────────

/** 基础类型 → { widget, storage }。Ety 没有常量形式。 */
const SCALAR_FORM = {
  Int: { widget: 'NUMBER_INPUT', key: 'val_int' },
  Flt: { widget: 'DECIMAL_INPUT', key: 'val_float' },
  Str: { widget: 'TEXT_INPUT', key: 'val_string' },
  Bol: { widget: 'ENUM_PICKER', key: 'val_enum' },
  Vec: { widget: 'VECTOR_GROUP', key: 'val_vector' },
  Gid: { widget: 'ID_INPUT', key: 'val_id' },
  Pfb: { widget: 'ID_INPUT', key: 'val_id' },
  Cfg: { widget: 'ID_INPUT', key: 'val_id' },
  Fct: { widget: 'ID_INPUT', key: 'val_id' },
};
// 【官方示例】常量引脚的 type_def 在官方导出里有带有不带（游戏读取这一层是宽容的）。这里取多数派：
//   带 type_def 的占比：Str 87% · Int 76% · Flt 67% · Bol 92% · Vec 74% · Gid 83% · Pfb 88% · Cfg 97% · 枚举 88%；
//   阵营(Fct) 5 个样本全部不带 → 不写。
const WITH_TYPE_DEF = new Set(['Int', 'Flt', 'Str', 'Bol', 'Vec', 'Gid', 'Pfb', 'Cfg', 'E']);

function typeDefOf(typeId) {
  const tag = SERVER_TYPE_TAG[typeId];
  return tag ? { backend: 'SERVER', server_side: { type_tag: tag } } : undefined;
}

function enumValueOf(table, enumType, v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'boolean') return v ? 1 : 0;
  const s = String(v).trim();
  if (/^-?\d+$/.test(s)) return Number(s);
  const et = table.enums[enumType];
  // 先按完整标识符，再按 英文名/别名
  if (et && et.items[s] != null) return et.items[s];
  for (const [ident, val] of Object.entries(et?.items || {})) {
    const info = table.enumNames[ident];
    if (!info) continue;
    if (info.en === s || info.alias.includes(s) || ident.endsWith(`.${s}`)) return val;
  }
  return null;
}

function enumNameOf(table, enumType, value) {
  const et = table.enums[enumType];
  if (!et) return value;
  for (const [ident, val] of Object.entries(et.items)) if (val === value) return ident.includes('.') ? ident.split('.').slice(1).join('.') : ident;
  return value;
}

/**
 * 常量 → 一个「具体类型」的 TypedValue（不含泛型外壳）。
 *   concrete: 具体类型表达式（"Int" / "L<Str>" / "E<SORT>" …）
 *   value:    JS 值；undefined 表示「占位」（未设置）
 * 返回 { tv, error }
 */
function actualForm(table, concrete, value, { poly, dir = 'in' }) {
  const t = parseTypeExpr(concrete);
  const typeId = typeExprToId(table, concrete);
  const set = value !== undefined;
  const out = {};
  // 【官方示例】泛型引脚 val_poly.actual_value 里 type_def：样本里枚举全部不带、其余基本都带。
  // （曾试过「整数入引脚占位不带 type_def」——与官方逐字段一致率从 85.9% 降到 76.9%，是错误规则，已弃用。）
  const polyTypeDef = t.k !== 'enum';

  if (t.k === 'basic') {
    const form = SCALAR_FORM[t.id];
    if (t.id === 'Ety') {
      if (set) return { error: '实体类型的引脚不能写常量，请用连线' };
      return { tv: { type_def: typeDefOf(typeId) } };
    }
    if (!form) return { error: `暂不支持给类型 ${concrete} 写常量` };
    if (form.widget) out.widget = form.widget;
    if (set) out.is_value_set = 1;
    if (poly ? polyTypeDef : WITH_TYPE_DEF.has(t.id)) out.type_def = typeDefOf(typeId);
    let payload;
    if (!set) payload = {};
    else if (t.id === 'Int') {
      if (!Number.isInteger(value)) return { error: `整数引脚需要整数，得到 ${JSON.stringify(value)}` };
      payload = value === 0 ? {} : { int: value };
    } else if (t.id === 'Flt') {
      if (typeof value !== 'number') return { error: `浮点引脚需要数字，得到 ${JSON.stringify(value)}` };
      payload = value === 0 ? {} : { float: f32(value) };
    } else if (t.id === 'Str') {
      if (typeof value !== 'string') return { error: `字符串引脚需要字符串，得到 ${JSON.stringify(value)}` };
      payload = value === '' ? {} : { str: value };
    } else if (t.id === 'Bol') {
      if (typeof value !== 'boolean') return { error: `布尔引脚需要 true/false，得到 ${JSON.stringify(value)}` };
      payload = value ? { enum: 1 } : {};
    } else if (t.id === 'Vec') {
      if (!Array.isArray(value) || value.length !== 3 || value.some((x) => typeof x !== 'number')) return { error: `向量引脚需要 [x, y, z]，得到 ${JSON.stringify(value)}` };
      const vec = {};
      ['x', 'y', 'z'].forEach((k, i) => { if (value[i] !== 0) vec[k] = f32(value[i]); });
      payload = { vec };
    } else { // ID 类
      if (!Number.isInteger(value)) return { error: `ID 引脚需要整数，得到 ${JSON.stringify(value)}` };
      payload = value === 0 ? {} : { id: value };
    }
    out[form.key] = payload;
    if (!out.type_def) delete out.type_def;
    return { tv: out };
  }

  if (t.k === 'enum') {
    out.widget = 'ENUM_PICKER';
    if (set) out.is_value_set = 1;
    if (!poly) out.type_def = typeDefOf(typeId ?? 14);
    if (!set) { out.val_enum = {}; return { tv: out }; }
    const n = enumValueOf(table, t.enum, value);
    if (n == null) {
      const opts = Object.keys(table.enums[t.enum]?.items || {}).map((id) => `${table.enumNames[id]?.en || id}(${table.enums[t.enum].items[id]})`);
      return { error: `枚举 ${t.enum} 里没有 ${JSON.stringify(value)}；可用：${opts.join('、') || '（表里没有这个枚举）'}；也可以直接写数字` };
    }
    out.val_enum = n === 0 ? {} : { enum: n };
    return { tv: out };
  }

  if (t.k === 'list') {
    out.widget = 'LIST_GROUP';
    if (set) out.is_value_set = 1;
    out.type_def = typeDefOf(typeId);
    if (!set) { out.val_list = {}; return { tv: out }; }
    if (!Array.isArray(value)) return { error: `列表引脚需要数组，得到 ${JSON.stringify(value)}` };
    const item = substituteItem(t.item);
    const elements = [];
    for (const el of value) {
      const r = actualForm(table, item, el, { poly: false });
      if (r.error) return r;
      // 列表元素在官方样本里都带 type_def
      if (!r.tv.type_def) r.tv.type_def = typeDefOf(typeExprToId(table, item));
      elements.push(r.tv);
    }
    out.val_list = elements.length ? { elements } : {};
    return { tv: out };
  }

  return { error: `暂不支持类型 ${concrete}（字典、结构体等）` };
}

function substituteItem(t) {
  return t.k === 'basic' ? t.id : t.k === 'enum' ? `E<${t.enum}>` : 'Unk';
}

/** 一个数据入/出引脚的 PinInstance.value（含泛型外壳）。connected 用于决定占位形态 */
function pinValue(table, pin, concrete, generic, chosenIndex, value, connected, dir = 'in') {
  if (generic) {
    const r = actualForm(table, concrete, connected ? undefined : value, { poly: true, dir });
    if (r.error) return { error: r.error };
    const poly = {};
    if (chosenIndex) poly.chosen_type_index = chosenIndex;
    poly.actual_value = r.tv;
    return { tv: { widget: 'TYPE_SELECTOR', is_value_set: 1, val_poly: poly } };
  }
  if (connected) return { tv: undefined }; // 固定类型 + 连线：官方多数派不写值
  const r = actualForm(table, concrete, value, { poly: false });
  return r.error ? { error: r.error } : { tv: r.tv };
}

// ─────────────────────────── 编译：GraphSpec → NodeGraph ───────────────────────────

const PIN_SIG = (kind, index) => (index ? { kind, index } : { kind });

/** 解析 "n3" / "n3.引脚名" */
function splitRef(ref) {
  const s = String(ref);
  const i = s.indexOf('.');
  return i < 0 ? { id: s, pin: null } : { id: s.slice(0, i), pin: s.slice(i + 1) };
}

/**
 * @param {object} spec  图规格
 * @param {object} table loadNodeTable() 的结果
 * @param {object} [opts] { guid: 图的资产 ID（默认 0x40000001） }
 * @returns {{ graph: object, warnings: string[] }}  graph 是 gia.proto 里 NodeGraph 的对象形态
 */
export function compileGraph(spec, table, opts = {}) {
  const problems = [];
  const warnings = [];
  const err = (path, msg) => problems.push({ level: 'error', path, msg });

  const kindInfo = GRAPH_KINDS[spec.kind || 'entity'];
  if (!kindInfo) err('kind', `未知的图种类 "${spec.kind}"（可选 ${Object.keys(GRAPH_KINDS).join(' / ')}）`);
  if (!Array.isArray(spec.nodes)) err('nodes', 'nodes 必须是数组');
  else if (!spec.nodes.length) warnings.push('图里没有节点');
  if (problems.length) throw new GraphError(problems);

  // 0. 节点序号：优先用显式的 idx，其次 id 形如 n12 时取 12（反编译出来的规格靠它保住原序号），否则顺延取未占用的最小正整数
  const wantIdx = new Map();
  const taken = new Set();
  for (const ns of spec.nodes) {
    const explicit = ns.raw ? ns.raw.index : Number.isInteger(ns.idx) ? ns.idx : /^n(\d+)$/.exec(ns.id || '') ? Number(/^n(\d+)$/.exec(ns.id)[1]) : null;
    if (explicit != null && explicit > 0 && !taken.has(explicit)) { wantIdx.set(ns, explicit); taken.add(explicit); }
  }
  let nextFree = 1;
  for (const ns of spec.nodes) {
    if (wantIdx.has(ns)) continue;
    while (taken.has(nextFree)) nextFree++;
    wantIdx.set(ns, nextFree); taken.add(nextFree);
  }

  // 1. 解析节点
  const infos = new Map(); // spec id → { idx, node, variant, def, spec }
  spec.nodes.forEach((ns, i) => {
    const path = `nodes[${i}](${ns.id ?? '?'})`;
    if (!ns.id) { err(path, '缺少 id'); return; }
    if (infos.has(ns.id)) { err(path, `id "${ns.id}" 重复`); return; }
    if (ns.raw) {
      // raw = 反编译时本工具不认识/不覆盖的节点，原样透传（保留序号，可作为连线目标/来源；它自己的引脚记录不动）
      if (!Number.isInteger(ns.raw.index)) { err(path, 'raw 节点缺少 index'); return; }
      infos.set(ns.id, { idx: ns.raw.index, raw: ns.raw, isRaw: true, path, pins: new Map() });
      return;
    }
    const r = lookupNode(table, ns.node, 'S');
    if (!r.node) {
      const any = lookupNode(table, ns.node, undefined);
      if (any.node?.sys === 'C') { err(path, `"${ns.node}" 是客户端节点（客户端技能/过滤器图用的），本工具只生成服务器节点图`); return; }
      const hint = r.candidates?.length ? `；你是不是想找：${r.candidates.slice(0, 6).map((n) => `${n.zh || n.en}(${n.id})`).join('、')}` : '';
      err(path, `找不到服务器节点 "${ns.node}"${hint}`); return;
    }
    const node = r.node;
    if (node.sys !== 'S') { err(path, `节点 "${node.zh}" 是客户端节点，本工具只生成服务器节点图`); return; }
    let variant = null;
    if (node.var) {
      const bind = normalizeBindings(node, ns.T);
      if (!bind) { err(path, `"${node.zh}" 是泛型节点，需要用 "T" 指定类型（例如 "T": "Int"）；可用的 T：${variantsOf(node).slice(0, 8).map((v) => JSON.stringify(v.bindings)).join(' ')} …`); return; }
      variant = chooseVariant(node, bind);
      if (!variant) { err(path, `"${node.zh}" 没有 T=${JSON.stringify(bind)} 的具体版本`); return; }
    } else if (ns.T != null) warnings.push(`${path}：节点 "${node.zh}" 不是泛型节点，忽略 T`);
    infos.set(ns.id, { idx: wantIdx.get(ns), node, variant, spec: ns, path, pins: new Map() });
  });
  if (problems.length) throw new GraphError(problems);

  // 2. 每个节点的引脚记录（按 kind,index 键）
  const pinKey = (kind, index) => `${KIND_ORDER[kind]}:${index}`;
  const getPin = (info, kind, pd, extra) => {
    const k = pinKey(kind, pd.shellIndex);
    if (!info.pins.has(k)) info.pins.set(k, { kind, pd, connections: [], ...extra });
    return info.pins.get(k);
  };

  // 2a. 数据入引脚：常量与连线
  for (const info of infos.values()) {
    if (info.isRaw) continue;
    const { node, variant, spec: ns, path } = info;
    const bindings = variant?.bindings || {};
    for (const [key, val] of Object.entries(ns.in || {})) {
      const pd = findPin(node, key, 'data', 'in');
      if (!pd) { err(`${path}.in.${key}`, `节点 "${node.zh}" 没有数据入引脚 "${key}"（可用：${pinsOf(node, 'data', 'in').filter((p) => p.vis !== 'H').map((p) => p.zh || p.name).join('、')}）`); continue; }
      const pin = getPin(info, KIND.IN_PARAM, pd);
      if (val && typeof val === 'object' && !Array.isArray(val) && 'from' in val) {
        const src = splitRef(val.from);
        const sInfo = infos.get(src.id);
        if (!sInfo) { err(`${path}.in.${key}`, `连线来源节点 "${src.id}" 不存在`); continue; }
        let spd;
        if (sInfo.isRaw) {
          if (src.pin == null || !/^\d+$/.test(src.pin)) { err(`${path}.in.${key}`, `来源 ${src.id} 是 raw 节点，请写成 "${src.id}.数字引脚序号"（数据出引脚的序号，从 0 起）`); continue; }
          spd = { shellIndex: Number(src.pin), kernelIndex: Number(src.pin) };
        } else {
          spd = src.pin == null ? pinsOf(sInfo.node, 'data', 'out').find((p) => p.vis !== 'H') : findPin(sInfo.node, src.pin, 'data', 'out');
          if (!spd) { err(`${path}.in.${key}`, `节点 "${sInfo.node.zh}" 没有数据出引脚 "${src.pin ?? '(默认)'}"`); continue; }
          checkTypeCompat(warnings, err, `${path}.in.${key}`, table, pd, bindings, spd, sInfo.variant?.bindings || {});
        }
        pin.connections.push({ from: sInfo, spd });
      } else {
        pin.value = val;
        pin.hasValue = true;
      }
    }
  }

  // 2b. 执行流：出引脚 → 目标节点入引脚
  for (const info of infos.values()) {
    if (info.isRaw) continue;
    const { node, spec: ns, path } = info;
    if (ns.then == null) continue;
    const outs = pinsOf(node, 'flow', 'out');
    const entries = typeof ns.then === 'string' || Array.isArray(ns.then)
      ? [[null, ns.then]] : Object.entries(ns.then);
    for (const [pname, target] of entries) {
      const pd = pname == null ? outs[0] : findPin(node, pname, 'flow', 'out');
      if (!pd) { err(`${path}.then`, `节点 "${node.zh}" 没有执行流出引脚 "${pname ?? '(默认)'}"（可用：${outs.map((p) => p.zh || p.name).join('、') || '无'}）`); continue; }
      const pin = getPin(info, KIND.OUT_FLOW, pd);
      const targets = Array.isArray(target) ? target : [target];
      for (const t of targets) {
        const ref = splitRef(t);
        const tInfo = infos.get(ref.id);
        if (!tInfo) { err(`${path}.then`, `目标节点 "${ref.id}" 不存在`); continue; }
        let tpd;
        if (tInfo.isRaw) {
          if (ref.pin != null && !/^\d+$/.test(ref.pin)) { err(`${path}.then`, `目标 ${ref.id} 是 raw 节点，引脚请写数字序号或省略（默认第 0 个执行流入引脚）`); continue; }
          tpd = { shellIndex: ref.pin == null ? 0 : Number(ref.pin), kernelIndex: ref.pin == null ? 0 : Number(ref.pin) };
        } else {
          const ins = pinsOf(tInfo.node, 'flow', 'in');
          tpd = ref.pin == null ? ins[0] : findPin(tInfo.node, ref.pin, 'flow', 'in');
          if (!tpd) { err(`${path}.then`, `节点 "${tInfo.node.zh}" 没有执行流入引脚 "${ref.pin ?? '(默认)'}"（它可能是事件节点，事件节点不能作为执行流目标）`); continue; }
        }
        pin.connections.push({ to: tInfo, tpd });
      }
    }
  }
  if (problems.length) throw new GraphError(problems);

  // 3. 生成 NodeInstance
  const nodes = [];
  for (const info of infos.values()) {
    if (info.isRaw) { nodes.push(structuredClone(info.raw)); continue; }
    const { node, variant, spec: ns } = info;
    const bindings = variant?.bindings || {};
    const inject = variant?.inject || {};
    const shell = nodeRef(node.id, kindInfo.category);
    const kernel = nodeRef(variant ? variant.kernelId : node.id, kindInfo.category);

    // 泛型入引脚：即使没有连线/常量也要写占位
    if (node.var) {
      for (const pd of pinsOf(node, 'data', 'in')) {
        if (pd.vis === 'H' || !/R</.test(pd.type)) continue;
        getPin(info, KIND.IN_PARAM, pd);
      }
      for (const pd of pinsOf(node, 'data', 'out')) {
        if (pd.vis === 'H' || !/R</.test(pd.type)) continue;
        getPin(info, KIND.OUT_PARAM, pd);
      }
    }

    const pinObjs = [];
    const sorted = [...info.pins.values()].sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind] || a.pd.shellIndex - b.pd.shellIndex);
    for (const pin of sorted) {
      const { pd } = pin;
      const rec = { shell_sig: PIN_SIG(pin.kind, pd.shellIndex), kernel_sig: PIN_SIG(pin.kind, pd.kernelIndex) };
      if (pin.kind === KIND.OUT_FLOW) {
        rec.connections = pin.connections.map((c) => ({
          target_node_index: c.to.idx,
          target_pin_shell: PIN_SIG(KIND.IN_FLOW, c.tpd.shellIndex),
          target_pin_kernel: PIN_SIG(KIND.IN_FLOW, c.tpd.kernelIndex),
        }));
      } else {
        const generic = /R</.test(pd.type);
        const concrete = substitute(pd.type, bindings);
        const typeId = typeExprToId(table, concrete);
        if (typeId == null) { problems.push({ level: 'error', path: `${info.path}`, msg: `无法确定引脚 "${pd.zh || pd.name}" 的具体类型（${pd.type}，T=${JSON.stringify(bindings)}）` }); continue; }
        const connected = pin.connections.length > 0;
        const pv = pinValue(table, pd, concrete, generic, inject[pd.name] ?? 0, pin.value, pin.kind === KIND.OUT_PARAM ? true : connected, pin.kind === KIND.OUT_PARAM ? 'out' : 'in');
        if (pv.error) { problems.push({ level: 'error', path: `${info.path}.in.${pd.zh || pd.name}`, msg: pv.error }); continue; }
        if (pv.tv) rec.value = pv.tv;
        rec.type = typeId;
        if (pin.kind === KIND.IN_PARAM && connected) {
          rec.connections = pin.connections.map((c) => ({
            target_node_index: c.from.idx,
            target_pin_shell: PIN_SIG(KIND.OUT_PARAM, c.spd.shellIndex),
            target_pin_kernel: PIN_SIG(KIND.OUT_PARAM, c.spd.kernelIndex),
          }));
        }
      }
      pinObjs.push(rec);
    }
    const [x, y] = ns.pos || [0, 0];
    const nodeObj = { index: info.idx, shell_ref: shell, kernel_ref: kernel };
    if (pinObjs.length) nodeObj.pins = pinObjs;
    if (x) nodeObj.x_pos = f32(x);
    if (y) nodeObj.y_pos = f32(y);
    if (typeof ns.comment === 'string' && ns.comment) nodeObj.attached_comment = { text: ns.comment };
    if (NODE_CONTEXT.has(node.id)) nodeObj.context_declaration = NODE_CONTEXT.get(node.id);
    nodes.push(nodeObj);
  }
  if (problems.length) throw new GraphError(problems);

  // 4. 节点图变量（黑板）
  const blackboard = [];
  const declared = new Set();
  (spec.vars || []).forEach((v, i) => {
    const path = `vars[${i}](${v.name ?? '?'})`;
    if (!v.name || typeof v.name !== 'string') { err(path, '变量缺少 name'); return; }
    if (declared.has(v.name)) { err(path, `变量名 "${v.name}" 重复`); return; }
    declared.add(v.name);
    const typeId = typeExprToId(table, v.type ?? '');
    const tag = SERVER_TYPE_TAG[typeId];
    if (!tag || !Object.values(TAG_TO_EXPR).includes(v.type)) { err(path, `变量类型 "${v.type}" 暂不支持（可选：${Object.values(TAG_TO_EXPR).join(' ')}）`); return; }
    let storage;
    if (v.type === 'Ety') {
      if (v.value !== undefined) { err(path, '实体类型的变量不能设初值'); return; }
      storage = { widget: 'ID_INPUT', type_def: typeDefOf(typeId), val_id: {} };
    } else {
      const r = actualForm(table, v.type, v.value, { poly: false });
      if (r.error) { err(path, r.error); return; }
      storage = r.tv;
    }
    const bb = { var_name: v.name, base_type: tag, storage_value: storage };
    if (v.public) bb.is_public = true;
    bb.container_key_type = 'S_STRING'; // 官方样本里基础类型变量都带着这两个残留字段
    bb.container_value_type = 'S_STRING';
    blackboard.push(bb);
  });
  // 用了「节点图变量」类节点但变量名（常量）没声明：提示
  for (const info of infos.values()) {
    if (info.isRaw || !/节点图变量/.test(info.node.zh)) continue;
    const nm = info.spec.in?.变量名 ?? info.spec.in?.variable_name;
    if (typeof nm === 'string' && !declared.has(nm)) warnings.push(`${info.path}：引用了节点图变量 "${nm}"，但 vars 里没有声明它`);
  }
  if (problems.length) throw new GraphError(problems);

  const guid = opts.guid ?? 0x40000001;
  const graph = {
    identity: { source_domain: 'USER_DEFINED', service_domain: kindInfo.category, kind: 'CUSTOM_GRAPH', runtime_id: guid },
    display_name: spec.name || '未命名节点图',
    nodes,
  };
  if (blackboard.length) graph.blackboard = blackboard;
  // spec.extra：反编译时本工具不解析的图级内容（含字典/结构体的变量、图注释、复合节点端口映射、入口序号），原样透传，绝不悄悄丢
  const extra = spec.extra || {};
  if (extra.blackboard?.length) {
    if (blackboard.length) warnings.push('spec.vars 与 spec.extra.blackboard 同时存在，extra.blackboard 被忽略');
    else graph.blackboard = structuredClone(extra.blackboard);
  }
  for (const key of ['comments', 'port_mappings']) if (extra[key]?.length) graph[key] = structuredClone(extra[key]);
  if (extra.entry_slot_index != null) graph.entry_slot_index = extra.entry_slot_index;
  if (opts.evaluationInterval !== null) graph.evaluation_interval = opts.evaluationInterval ?? 0.3;
  return { graph, warnings };
}

function nodeRef(id, category) {
  return { source_domain: 'SYSTEM_DEFINED', service_domain: category, kind: 'SYS_CALL_STUB', runtime_id: id };
}

/** 把 spec 里的 T 规范成 {T:'Int'} / {K:'Str',V:'Int'}；缺失返回 null */
function normalizeBindings(node, T) {
  if (T == null) return null;
  if (typeof T === 'object') return T;
  const sample = variantsOf(node)[0];
  const keys = Object.keys(sample?.bindings || {});
  if (keys.length === 1) return { [keys[0]]: T };
  return null;
}

function checkTypeCompat(warnings, err, path, table, toPin, toBind, fromPin, fromBind) {
  const a = substitute(toPin.type, toBind);
  const b = substitute(fromPin.type, fromBind);
  if (/R</.test(a) || /R</.test(b)) return;
  if (a !== b) err(path, `类型不匹配：入引脚需要 ${a}，来源出引脚是 ${b}`);
}

// ─────────────────────────── 反编译：NodeGraph → GraphSpec ───────────────────────────

/** 从 TypedValue 取回 JS 常量（按具体类型）；认不出的返回 { $raw } */
function readValue(table, concrete, tv) {
  if (!tv) return { none: true };
  let inner = tv;
  if (tv.val_poly) inner = tv.val_poly.actual_value || {};
  // 值里带 schema 没有的字段（如信号参数的类型标注）：不敢丢，整个节点走 raw
  if (tv._u?.length || inner._u?.length || tv.val_poly?._u?.length) return { $raw: tv };
  const t = parseTypeExpr(concrete);
  const isSet = inner.is_value_set === 1 || tv.val_poly?.actual_value?.is_value_set === 1;
  if (t.k === 'basic') {
    if (t.id === 'Int' && inner.val_int) return { set: isSet, v: inner.val_int.int ?? 0 };
    if (t.id === 'Flt' && inner.val_float) return { set: isSet, v: f32Pretty(inner.val_float.float ?? 0) };
    if (t.id === 'Str' && inner.val_string) return { set: isSet, v: inner.val_string.str ?? '' };
    if (t.id === 'Bol' && inner.val_enum) return { set: isSet, v: (inner.val_enum.enum ?? 0) === 1 };
    if (t.id === 'Vec' && inner.val_vector) { const v = inner.val_vector.vec || {}; return { set: isSet, v: [f32Pretty(v.x ?? 0), f32Pretty(v.y ?? 0), f32Pretty(v.z ?? 0)] }; }
    if (['Gid', 'Pfb', 'Cfg', 'Fct'].includes(t.id) && inner.val_id) return { set: isSet, v: inner.val_id.id ?? 0 };
    if (t.id === 'Ety') return { none: true };
  }
  if (t.k === 'enum' && inner.val_enum) return { set: isSet, v: enumNameOf(table, t.enum, inner.val_enum.enum ?? 0) };
  if (t.k === 'list' && inner.val_list) {
    const item = substituteItem(t.item);
    const els = (inner.val_list.elements || []).map((e) => readValue(table, item, e));
    if (els.some((e) => e.$raw || e.none)) return { $raw: tv };
    return { set: isSet, v: els.map((e) => e.v) };
  }
  return { $raw: tv };
}

const label = (pd, siblings) => {
  const zh = pd.zh && siblings.filter((p) => (p.zh || p.name) === pd.zh).length === 1 ? pd.zh : null;
  return zh || pd.name;
};

/**
 * @returns {{ spec: object, notes: string[] }} notes 是「没能还原成规格、以 raw 保留」的说明
 */
export function decompileGraph(graph, table, opts = {}) {
  const notes = [];
  const spec = { name: graph.display_name || '', kind: kindOfGraph(graph), nodes: [] };
  const idOf = (index) => `n${index}`;
  const byIndex = new Map((graph.nodes || []).map((n) => [n.index, n]));
  const pending = new Map(); // 规格节点 → 待写成引用字符串的连线描述

  for (const n of graph.nodes || []) {
    const s = n.shell_ref;
    const node = s && s.source_domain === 'SYSTEM_DEFINED' && s.kind === 'SYS_CALL_STUB' ? table.byId.get(s.runtime_id) : null;
    const isServer = node && node.sys === 'S' && s.service_domain === 'SERVER_BASIC';
    const why = [];
    if (!node) why.push(`节点表里没有 ID ${s?.runtime_id}（可能是 7.x 新增节点）`);
    else if (node.sys !== 'S') why.push('客户端节点');
    else if (s.service_domain !== 'SERVER_BASIC') why.push(`类别 ${s.service_domain}`);
    if (n.attached_comment && (n.attached_comment.x_pos != null || n.attached_comment.y_pos != null || n.attached_comment._u?.length)) why.push('备注带坐标');
    if (n.context_declaration && JSON.stringify(n.context_declaration) !== JSON.stringify(NODE_CONTEXT.get(node?.id))) why.push('带未识别的 context_declaration');
    if (n.signal_version != null) why.push('信号节点');
    if (n.using_structs?.length) why.push('使用结构体');
    if (n._u?.length) why.push(`有未知字段 ${n._u.map((u) => u.f)}`);
    if (!isServer || why.length) {
      notes.push(`节点 ${idOf(n.index)}：${node ? node.zh : '未知节点'}——${why.join('、')}，以 raw 保留`);
      spec.nodes.push({ id: idOf(n.index), raw: n });
      continue;
    }
    const kernelId = n.kernel_ref?.runtime_id ?? node.id;
    let variant = null;
    if (node.var) variant = variantsOf(node).find((v) => v.kernelId === kernelId) || null;
    if (node.var && !variant) {
      notes.push(`节点 ${idOf(n.index)}：${node.zh} 的 kernel ${kernelId} 不在表内变体里，以 raw 保留`);
      spec.nodes.push({ id: idOf(n.index), raw: n });
      continue;
    }
    const bindings = variant?.bindings || {};
    const out = { id: idOf(n.index), node: node.zh || node.en };
    if (node.var) out.T = Object.keys(bindings).length === 1 ? Object.values(bindings)[0] : bindings;
    out.pos = [f32Pretty(n.x_pos ?? 0), f32Pretty(n.y_pos ?? 0)];
    if (n.attached_comment?.text) out.comment = n.attached_comment.text;

    const inPins = pinsOf(node, 'data', 'in');
    const outFlow = pinsOf(node, 'flow', 'out');
    const inMap = {};
    const then = {};
    const pend = { then: [], ins: [] }; // 连线先记描述，等知道哪些节点是 raw 之后再统一写成引用字符串
    let bad = false;
    for (const p of n.pins || []) {
      const kind = p.shell_sig?.kind;
      const idx = p.shell_sig?.index ?? 0;
      if (kind === 'OUT_FLOW') {
        const pd = outFlow.find((q) => q.shellIndex === idx);
        if (!pd) { bad = true; break; }
        const targets = (p.connections || []).map((c) => ({ idx: c.target_node_index, pin: c.target_pin_shell?.index ?? 0 }));
        if (targets.length) { then[label(pd, outFlow)] = null; pend.then.push({ key: label(pd, outFlow), targets }); }
      } else if (kind === 'IN_PARAM') {
        const pd = inPins.find((q) => q.shellIndex === idx);
        if (!pd) { bad = true; break; }
        const key = label(pd, inPins);
        if (p.connections?.length) {
          const c = p.connections[0];
          if (p.connections.length > 1) notes.push(`节点 ${out.id}：入引脚 ${key} 有多条连线，只保留第一条`);
          inMap[key] = null; // 占位，保住引脚顺序
          pend.ins.push({ key, idx: c.target_node_index, pin: c.target_pin_shell?.index ?? 0 });
        } else {
          const concrete = substitute(pd.type, bindings);
          const rv = readValue(table, concrete, p.value);
          if (rv.$raw) { bad = true; break; }
          // 泛型入引脚的「未设置占位」不必写进规格
          if (rv.none || rv.set === false) continue;
          inMap[key] = rv.v;
        }
      } else if (kind === 'OUT_PARAM') {
        continue; // 泛型输出的类型占位，编译时按规则重建
      } else { bad = true; break; }
    }
    if (bad) {
      notes.push(`节点 ${out.id}：${node.zh} 的引脚含无法还原的形态，以 raw 保留`);
      spec.nodes.push({ id: out.id, raw: n });
      continue;
    }
    if (Object.keys(inMap).length) out.in = inMap;
    if (Object.keys(then).length) out.then = then;
    pending.set(out, { pend, outFlow });
    spec.nodes.push(out);
  }

  // 第二阶段：现在知道哪些节点是 raw 了，把连线写成引用字符串
  const rawIdx = new Set(spec.nodes.filter((x) => x.raw).map((x) => x.raw.index));
  const flowRef = (idx, pin) => {
    if (rawIdx.has(idx)) return pin ? `${idOf(idx)}.${pin}` : idOf(idx);
    const tt = table.byId.get(byIndex.get(idx)?.shell_ref?.runtime_id);
    const ins = tt ? pinsOf(tt, 'flow', 'in') : [];
    const tpd = ins.find((q) => q.shellIndex === pin);
    return tpd && tpd !== ins[0] ? `${idOf(idx)}.${label(tpd, ins)}` : idOf(idx);
  };
  const dataRef = (idx, pin) => {
    if (rawIdx.has(idx)) return `${idOf(idx)}.${pin}`;
    const st = table.byId.get(byIndex.get(idx)?.shell_ref?.runtime_id);
    const outs = st ? pinsOf(st, 'data', 'out') : [];
    const spd = outs.find((q) => q.shellIndex === pin);
    const firstOut = outs.find((q) => q.vis !== 'H');
    return spd && firstOut && spd !== firstOut ? `${idOf(idx)}.${label(spd, outs)}` : idOf(idx);
  };
  for (const [out, { pend, outFlow }] of pending) {
    for (const { key, targets } of pend.then) {
      const refs = targets.map((t) => flowRef(t.idx, t.pin));
      out.then[key] = refs.length === 1 ? refs[0] : refs;
    }
    for (const { key, idx, pin } of pend.ins) out.in[key] = { from: dataRef(idx, pin) };
    // 只有一个执行流出口且就是第一个出引脚时，写成简写 then: "n7"
    if (out.then) {
      const tk = Object.keys(out.then);
      if (tk.length === 1 && outFlow.length && tk[0] === label(outFlow[0], outFlow)) out.then = out.then[tk[0]];
    }
  }
  // 节点图变量：基础类型还原成 vars；含字典/结构体等的整体走 extra.blackboard
  if (graph.blackboard?.length) {
    const vars = [];
    let all = true;
    for (const v of graph.blackboard) {
      const expr = TAG_TO_EXPR[v.base_type];
      const extraKeys = Object.keys(v).filter((k) => !['var_name', 'base_type', 'storage_value', 'is_public', 'container_key_type', 'container_value_type'].includes(k));
      let rec = null;
      if (expr && !extraKeys.length) {
        const rv = expr === 'Ety' ? { none: true } : readValue(table, expr, v.storage_value);
        if (!rv.$raw) {
          rec = { name: v.var_name, type: expr };
          if (rv.set) rec.value = rv.v;
          if (v.is_public) rec.public = true;
        }
      }
      if (rec) vars.push(rec); else all = false;
    }
    if (all) spec.vars = vars;
    else { notes.push('图变量里含字典/结构体等类型，整体以 extra.blackboard 保留'); (spec.extra ??= {}).blackboard = graph.blackboard; }
  }
  for (const key of ['comments', 'port_mappings']) {
    if (graph[key]?.length) { notes.push(`图的 ${key} 未还原，见 spec.extra`); (spec.extra ??= {})[key] = graph[key]; }
  }
  if (graph.entry_slot_index != null) (spec.extra ??= {}).entry_slot_index = graph.entry_slot_index;
  return { spec, notes };
}

function kindOfGraph(graph) {
  const cat = graph.identity?.service_domain;
  for (const [k, v] of Object.entries(GRAPH_KINDS)) if (v.category === cat) return k;
  return `other(${cat})`;
}

// ─────────────────────────── 资产包装 ───────────────────────────

/** NodeGraph 对象 → .gia 里的一条资产（ResourceEntry 对象） */
export function graphAsset(graph, { kind = 'entity', guid = 0x40000001, name } = {}) {
  const info = GRAPH_KINDS[kind];
  if (!info) throw new Error(`未知的图种类 ${kind}`);
  return {
    identity: { service_domain: 'SERVER_NODE_GRAPH', asset_guid: guid },
    internal_name: name ?? graph.display_name,
    resource_class: info.resource_class,
    graph_data: { inner: { graph } },
  };
}

/** 一组图规格 → AssetBundle 对象（可交给 encodeMessage(schema,'AssetBundle',…)） */
export function buildGiaFromSpecs(specs, table, { baseGuid = 0x40000001, uid = 0, now = Math.floor(Date.now() / 1000), fileName } = {}) {
  const assets = [];
  const warnings = [];
  specs.forEach((spec, i) => {
    const guid = baseGuid + i;
    const { graph, warnings: w } = compileGraph(spec, table, { guid });
    warnings.push(...w.map((x) => `[${spec.name || i}] ${x}`));
    assets.push(graphAsset(graph, { kind: spec.kind || 'entity', guid, name: spec.name }));
  });
  const name = fileName || specs[0]?.name || 'graph';
  return { bundle: { assets, export_info: `${uid}-${now}-${baseGuid}-\\${name}.gia` }, warnings };
}
