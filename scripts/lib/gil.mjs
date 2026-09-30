/**
 * gil.mjs —— 对 .gil / .gia 解码结果的「业务操作」：客户端脚本、节点图
 *
 * 全部作用在 readGi/decodeGi 得到的 root 对象上（改完用 encodeGi 写回）。
 *
 * 证据说明（每个函数头都标）
 *   【官方示例】= 用 references/samples/ 的官方存档核对过
 *   【逆向推断】= 从样本规律推断，样本里没有可核对的案例，必须在编辑器里导入验证
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { GiError } from './gifile.mjs';

// 客户端脚本在分类页签里的登记：类别号 69，资产类型码 7900（【官方示例】样本 客户端脚本.gil）
export const SCRIPT_CATEGORY_KIND = 69;
export const SCRIPT_ASSET_KIND = 7900;

// ─────────────────────────── 客户端脚本 ───────────────────────────

/** 【官方示例】列出 .gil 里的客户端脚本 */
export function listScripts(gil) {
  return (gil.client_scripts?.scripts || []).map((s, i) => ({ index: i, ...s }));
}

/** 按 GUID(数字) / 资产名 / 文件名 / 下标 选脚本；不唯一时报错并列出候选 */
export function findScript(gil, sel) {
  const list = listScripts(gil);
  if (!list.length) throw new GiError('这个 .gil 里没有客户端脚本（没有顶层字段 50；可能是 7.x 之前的编辑器导出）');
  if (sel == null) {
    if (list.length === 1) return list[0];
    throw new GiError(`有 ${list.length} 个脚本，请用 --name 指定：${list.map((s) => `「${s.name}」(${s.file_name}, 0x${s.guid.toString(16)})`).join('、')}`);
  }
  const s = String(sel);
  let hits = list.filter((x) => x.name === s);
  if (!hits.length) hits = list.filter((x) => x.file_name === s);
  if (!hits.length && /^(0x[0-9a-f]+|\d+)$/i.test(s)) hits = list.filter((x) => x.guid === Number(s));
  if (!hits.length) throw new GiError(`找不到脚本 "${s}"。现有：${list.map((x) => `「${x.name}」(${x.file_name})`).join('、')}`);
  if (hits.length > 1) throw new GiError(`"${s}" 对应 ${hits.length} 个脚本，请改用 GUID：${hits.map((x) => '0x' + x.guid.toString(16)).join('、')}`);
  return hits[0];
}

/**
 * 【官方示例】替换已有脚本的源码。只动 50.1[i].source 一个字段，其余字节原样保留。
 * 返回 { before, after } 字节数。
 */
export function setScriptSource(gil, sel, source) {
  const s = findScript(gil, sel);
  const target = gil.client_scripts.scripts[s.index];
  const before = Buffer.byteLength(target.source ?? '', 'utf8');
  target.source = source;
  return { script: target, before, after: Buffer.byteLength(source, 'utf8') };
}

/**
 * 【逆向推断】新增脚本：写入 50.1 并在分类页签（类别 69）里登记。
 * 样本里只有一个脚本，「多个脚本时的形态」与「登记是否缺一不可」都没有案例可核对；
 * 新增后必须导入编辑器确认脚本出现在资产列表里。脚本与控件的绑定需要在编辑器里手动做。
 */
export function addScript(gil, { name, fileName = 'main.lua', source }) {
  if (!gil.client_scripts) throw new GiError('这个 .gil 没有客户端脚本板块（顶层字段 50），无法安全新增脚本。请先在编辑器里创建一个脚本再导出。');
  const scripts = gil.client_scripts.scripts || (gil.client_scripts.scripts = []);
  if (scripts.some((s) => s.name === name)) throw new GiError(`已有名为「${name}」的脚本，请换名或用替换`);
  const tree = (gil.categories?.trees || []).find((t) => t.category_kind === SCRIPT_CATEGORY_KIND);
  if (!tree?.default_tab) throw new GiError('分类页签里没有客户端脚本类（类别 69）的默认页签，无法登记新脚本');
  const guid = Math.max(0x40000000, ...scripts.map((s) => s.guid || 0)) + 1;
  const entry = { guid, name, file_name: fileName, source };
  scripts.push(entry);
  (tree.default_tab.assets ||= []).push({ asset_kind: SCRIPT_ASSET_KIND, asset_guid: guid });
  return entry;
}

// ─────────────────────────── 节点图 ───────────────────────────

/**
 * 列出文件里的所有节点图。
 * .gil：node_graphs.graphs[i].graph            【官方示例】
 * .gia：assets[i] / related[i] 里带 graph_data 的资产   【官方示例】
 * 返回 [{ where, index, name, guid, category, nodeCount, graph }]
 */
export function listGraphs(file) {
  const out = [];
  const push = (where, index, graph, asset) => out.push({
    where, index, name: graph.display_name ?? asset?.internal_name ?? '', guid: graph.identity?.runtime_id ?? asset?.identity?.asset_guid,
    category: graph.identity?.service_domain, resourceClass: asset?.resource_class, nodeCount: (graph.nodes || []).length, graph, asset,
  });
  if (file.kind === 'gil') {
    (file.root.node_graphs?.graphs || []).forEach((w, i) => { if (w.graph) push('node_graphs.graphs', i, w.graph, null); });
  } else {
    (file.root.assets || []).forEach((a, i) => { const g = a.graph_data?.inner?.graph; if (g) push('assets', i, g, a); });
    (file.root.related || []).forEach((a, i) => { const g = a.graph_data?.inner?.graph; if (g) push('related', i, g, a); });
  }
  return out.map((g, n) => ({ n, ...g }));
}

/** 按序号(数字或 "#3") / 图名 / GUID 选图；不唯一时报错 */
export function findGraph(file, sel) {
  const list = listGraphs(file);
  if (!list.length) throw new GiError('文件里没有节点图');
  if (sel == null) {
    if (list.length === 1) return list[0];
    throw new GiError(`有 ${list.length} 张图，请用 --name 指定（图名 / 序号 / GUID）`);
  }
  const s = String(sel);
  let hits = [];
  if (/^#\d+$/.test(s)) hits = list.filter((g) => g.n === Number(s.slice(1)));
  if (!hits.length) hits = list.filter((g) => g.name === s);
  if (!hits.length && /^(0x[0-9a-f]+|\d+)$/i.test(s)) hits = list.filter((g) => g.guid === Number(s));
  if (!hits.length) throw new GiError(`找不到节点图 "${s}"。现有：${list.map((g) => `#${g.n}「${g.name}」`).join('、')}`);
  if (hits.length > 1) throw new GiError(`"${s}" 对应 ${hits.length} 张图，请改用序号：${hits.map((g) => '#' + g.n).join('、')}`);
  return hits[0];
}

/** 文件里已用的图 GUID（用于分配新 GUID，避免冲突） */
export function usedGraphGuids(file) {
  return new Set(listGraphs(file).map((g) => g.guid).filter((x) => x != null));
}

export function freshGraphGuid(file, floor = 0x40000001) {
  const used = usedGraphGuids(file);
  let g = floor;
  while (used.has(g)) g++;
  return g;
}

/**
 * 【逆向推断】把一张图放进 .gil 的节点图板块：replaceIndex 给了就原位替换，否则追加。
 * 只做「图本体」的写入。样本里图与实体的挂接、以及节点图管理器里的登记信息本工具没有解析；
 * 追加后需要在编辑器里确认图出现在节点图管理器，并手动挂到实体上。
 * （更稳的路线是生成 .gia，走官方「资产导入」，游戏会重分配 GUID 并恢复引用。）
 */
export function putGraphIntoGil(gil, graph, { replaceIndex = null } = {}) {
  const section = gil.node_graphs || (gil.node_graphs = {});
  const list = section.graphs || (section.graphs = []);
  if (replaceIndex != null) {
    if (!list[replaceIndex]) throw new GiError(`node_graphs.graphs[${replaceIndex}] 不存在`);
    list[replaceIndex] = { graph };
    return replaceIndex;
  }
  list.push({ graph });
  return list.length - 1;
}

/** .gil 里的一张图 → 可写进 .gia 的资产（服务器实体图；其它类别按类别号猜资源类） */
export function graphToGiaAsset(graphEntry) {
  const g = graphEntry.graph;
  const byCat = { SERVER_BASIC: 'ENTITY_NODE_GRAPH', SERVER_STATUS: 'STATUS_NODE_GRAPH', SERVER_CLASS: 'CLASS_NODE_GRAPH', SERVER_ITEM: 'ITEM_NODE_GRAPH' };
  const rc = graphEntry.resourceClass || byCat[g.identity?.service_domain];
  if (!rc) throw new GiError(`暂不支持把类别 ${g.identity?.service_domain} 的图导出成 .gia`);
  return {
    identity: { service_domain: 'SERVER_NODE_GRAPH', asset_guid: g.identity?.runtime_id },
    internal_name: g.display_name,
    resource_class: rc,
    graph_data: { inner: { graph: g } },
  };
}
