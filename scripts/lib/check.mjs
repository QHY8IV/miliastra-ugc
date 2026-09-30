/**
 * check.mjs —— .gil / .gia 静态检查（规则编号 GG***，风格同 check-lua-ui.mjs 的 LX***）
 *
 * 检查的是「文件自己能不能自洽」：容器、往返无损、节点图的节点/引脚/连线/类型、控件树、脚本登记。
 * 它不能替代真机：通过检查 ≠ 编辑器一定接受，见 references/formats/README.md 的导入检验流程。
 *
 * 规则一览
 *   GG001 容器头/尾/长度不合法（游戏会拒绝加载）          error
 *   GG002 版本号 ≠ 1                                       warn
 *   GG003 载荷解析失败                                     error
 *   GG004 解码再编码与原文件字节不一致（工具自检，理论上不该出现）  error
 *   GG005 字段类型与 schema 不符（schema 可能过时或文件损坏）      warn
 *   GG101 节点序号重复                                     error
 *   GG102 连线指向不存在的节点                             error
 *   GG103 节点 ID 不在节点表里（可能是 7.x 新增节点）       warn
 *   GG104 引脚（种类+序号）不在节点表定义里                  error
 *   GG105 数据连线两端类型不匹配                            error
 *   GG106 连线方向/引脚种类不对                             error
 *   GG107 泛型节点的 kernel 不在表内变体里                   warn
 *   GG109 同一文件内节点图 GUID 重复                         error
 *   GG113 服务器图里出现客户端节点（或反之）                  warn
 *   GG201 控件树不自洽（父子不一致/悬空/环/GUID 重复）         error
 *   GG202 同一父控件下有同名子控件（官方样本里老式控件常见，仅提示；只有 Lua 用 GetChild 取到它时才算问题）  info
 *   GG203 控件绑定了不存在的脚本                             error
 *   GG301 脚本 GUID 重复                                    error
 *   GG302 分类页签登记了不存在的脚本                          error
 *   GG303 脚本没有登记到分类页签                              warn
 *   GG304 脚本没有被任何控件绑定                              warn
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { encodeMessage } from './codec.mjs';
import { ROOT_MESSAGE, getSchema } from './schema.mjs';
import { substitute, typeExprToId, variantsOf, loadNodeTable } from './nodes.mjs';
import { listGraphs } from './gil.mjs';
import { buildUiTree, checkUiTree } from './ui.mjs';
import { SCRIPT_ASSET_KIND, SCRIPT_CATEGORY_KIND, listScripts } from './gil.mjs';

const PIN_KIND_DIR = { IN_FLOW: ['flow', 'in'], OUT_FLOW: ['flow', 'out'], IN_PARAM: ['data', 'in'], OUT_PARAM: ['data', 'out'] };

/**
 * @param {object} file  decodeGi 的结果
 * @param {object} [opts] { table }
 * @returns {{ level: 'error'|'warn', code: string, msg: string, where?: string }[]}
 */
export function checkGi(file, opts = {}) {
  const table = opts.table || loadNodeTable();
  const out = [];
  const add = (level, code, msg, where) => out.push({ level, code, msg, where });

  // —— 容器 ——
  for (const e of file.container.errors) add('error', 'GG001', e);
  if (file.container.version !== 1) add('warn', 'GG002', `版本号 ${file.container.version} ≠ 1（官方样本恒为 1）`);
  for (const m of file.mismatches || []) add('warn', 'GG005', `字段类型与 schema 不符：${m}`);

  // —— 往返无损（工具自检）——
  try {
    const again = encodeMessage(getSchema(), ROOT_MESSAGE[file.kind], file.root);
    if (Buffer.compare(again, file.container.payload) !== 0) add('error', 'GG004', `解码再编码与原文件不一致（${again.length} ≠ ${file.container.payload.length} 字节）`);
  } catch (e) {
    add('error', 'GG004', `重新编码失败：${e.message}`);
  }

  // —— 节点图 ——
  const graphs = listGraphs(file);
  const seenGuid = new Map();
  for (const g of graphs) {
    if (g.guid != null) {
      if (seenGuid.has(g.guid)) add('error', 'GG109', `节点图 GUID 0x${g.guid.toString(16)} 重复（「${seenGuid.get(g.guid)}」与「${g.name}」）`, `#${g.n}`);
      seenGuid.set(g.guid, g.name);
    }
    checkGraph(g, table, add);
  }

  // —— .gil 专属：控件树、脚本 ——
  if (file.kind === 'gil') {
    if (file.root.ui) {
      const tree = buildUiTree(file.root);
      for (const p of checkUiTree(tree)) {
        const dup = p.msg.includes('同名');
        add(dup ? 'info' : p.level, dup ? 'GG202' : 'GG201', p.msg);
      }
      checkScripts(file.root, tree, add);
    } else if (file.root.client_scripts) checkScripts(file.root, null, add);
  }
  return out;
}

function checkGraph(g, table, add) {
  const where = `#${g.n}「${g.name}」`;
  const nodes = g.graph.nodes || [];
  const byIndex = new Map();
  for (const n of nodes) {
    if (byIndex.has(n.index)) add('error', 'GG101', `节点序号 ${n.index} 重复`, where);
    byIndex.set(n.index, n);
  }
  const defOf = (n) => {
    const s = n.shell_ref;
    if (!s || s.source_domain !== 'SYSTEM_DEFINED' || s.kind !== 'SYS_CALL_STUB') return null;
    return table.byId.get(s.runtime_id) || null;
  };
  const serverGraph = /^SERVER_/.test(g.graph.identity?.service_domain || '');
  for (const n of nodes) {
    const s = n.shell_ref;
    const isStub = s && s.source_domain === 'SYSTEM_DEFINED' && s.kind === 'SYS_CALL_STUB';
    const def = defOf(n);
    const label = `节点 ${n.index}${def ? `「${def.zh || def.en}」` : ''}`;
    if (isStub && !def) { add('warn', 'GG103', `${label}：节点表里没有 ID ${s.runtime_id}（可能是 7.x 新增节点，无法核对其引脚）`, where); continue; }
    if (!def) continue; // 生成的存根（信号/结构体）等，不核对
    if (serverGraph && def.sys === 'C') add('warn', 'GG113', `${label}：服务器图里出现客户端节点`, where);
    if (!serverGraph && def.sys === 'S' && /^CLIENT_/.test(g.graph.identity?.service_domain || '')) add('warn', 'GG113', `${label}：客户端图里出现服务器节点`, where);

    let bindings = {};
    if (def.var) {
      const k = n.kernel_ref?.runtime_id ?? def.id;
      const v = variantsOf(def).find((x) => x.kernelId === k);
      if (!v) add('warn', 'GG107', `${label}：kernel ${k} 不在该泛型节点的变体里`, where);
      else bindings = v.bindings;
    }
    for (const p of n.pins || []) {
      const kind = p.shell_sig?.kind;
      const idx = p.shell_sig?.index ?? 0;
      const map = PIN_KIND_DIR[kind];
      if (!map) continue; // 特殊引脚（信号等）
      const pd = (map[0] === 'flow' ? def.flowPins : def.dataPins).find((q) => q.dir === map[1] && q.shellIndex === idx);
      if (!pd) { add('error', 'GG104', `${label}：没有 ${kind}#${idx} 这个引脚`, where); continue; }
      // 注意：一个执行流出引脚连多个目标在官方导出里出现过（3/766），是合法的，不告警
      for (const c of p.connections || []) {
        const tn = byIndex.get(c.target_node_index);
        if (!tn) { add('error', 'GG102', `${label}：${kind}#${idx} 连到不存在的节点 ${c.target_node_index}`, where); continue; }
        const tkind = c.target_pin_shell?.kind;
        const okPair = (kind === 'OUT_FLOW' && tkind === 'IN_FLOW') || (kind === 'IN_PARAM' && tkind === 'OUT_PARAM');
        if (!okPair) { add('error', 'GG106', `${label}：${kind}#${idx} 连到了 ${tkind}，方向/种类不对`, where); continue; }
        if (kind === 'IN_PARAM') {
          const tdef = defOf(tn);
          if (!tdef) continue;
          const tmap = PIN_KIND_DIR[tkind];
          const tpd = tdef.dataPins.find((q) => q.dir === tmap[1] && q.shellIndex === (c.target_pin_shell?.index ?? 0));
          if (!tpd) { add('error', 'GG104', `节点 ${tn.index}「${tdef.zh}」没有 ${tkind}#${c.target_pin_shell?.index ?? 0} 这个引脚（被节点 ${n.index} 引用）`, where); continue; }
          let tb = {};
          if (tdef.var) { const tv = variantsOf(tdef).find((x) => x.kernelId === (tn.kernel_ref?.runtime_id ?? tdef.id)); tb = tv?.bindings || {}; }
          const a = substitute(pd.type, bindings);
          const b = substitute(tpd.type, tb);
          if (!/R</.test(a) && !/R</.test(b) && typeExprToId(table, a) !== typeExprToId(table, b)) {
            add('error', 'GG105', `${label}：入引脚「${pd.zh || pd.name}」需要 ${a}，但连的是节点 ${tn.index}「${tdef.zh}」的「${tpd.zh || tpd.name}」(${b})`, where);
          }
        }
      }
    }
  }
}

function checkScripts(gil, tree, add) {
  const scripts = listScripts(gil);
  const guids = new Map();
  for (const s of scripts) {
    if (guids.has(s.guid)) add('error', 'GG301', `脚本 GUID 0x${s.guid.toString(16)} 重复（「${guids.get(s.guid)}」与「${s.name}」）`);
    guids.set(s.guid, s.name);
  }
  const tree69 = (gil.categories?.trees || []).find((t) => t.category_kind === SCRIPT_CATEGORY_KIND);
  const registered = new Set((tree69?.default_tab?.assets || []).filter((a) => a.asset_kind === SCRIPT_ASSET_KIND).map((a) => a.asset_guid));
  for (const g of registered) if (!guids.has(g)) add('error', 'GG302', `分类页签登记了不存在的脚本 0x${g.toString(16)}`);
  for (const s of scripts) if (tree69 && !registered.has(s.guid)) add('warn', 'GG303', `脚本「${s.name}」没有登记到分类页签，编辑器里可能看不到它`);
  if (tree) {
    for (const [sg, node] of tree.scripts) if (!guids.has(sg)) add('error', 'GG203', `控件「${tree.nodes.get(node)?.name}」绑定了不存在的脚本 0x${sg.toString(16)}`);
    for (const s of scripts) if (!tree.scripts.has(s.guid)) add('warn', 'GG304', `脚本「${s.name}」没有被任何控件绑定（脚本要绑在某个控件上才会运行）`);
  }
}
