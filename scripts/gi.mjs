#!/usr/bin/env node
/**
 * gi.mjs —— 直接读、写千星奇域的 .gil（关卡存档）与 .gia（资产）文件
 *
 * 用法：node scripts/gi.mjs <命令> [参数]      （node scripts/gi.mjs --help 看全部）
 *
 * 读：  info / dump / json / verify / diff / ui / lua ls|get|check / graph ls|show|extract / nodes find|show
 * 写：  build / patch / lua put / graph build|put            —— 写文件必须给 -o；已存在的文件需 --force（并先备份 .bak）
 *
 * 依赖：Node >= 22，零第三方依赖。
 * 证据与边界：见 references/formats/README.md。通过本工具的检查 ≠ 编辑器一定接受，导入前请先备份存档。
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GI_TYPE_NAME, typeFromExt } from './lib/container.mjs';
import { parseFields } from './lib/wire.mjs';
import { GiError, decodeGi, encodeGi, getPath, readGi, setPath, writeGi } from './lib/gifile.mjs';
import { asDumpable, dumpObject } from './lib/dump.mjs';
import { diffObjects, formatDiff } from './lib/diff.mjs';
import { checkGi } from './lib/check.mjs';
import {
  addScript, findGraph, findScript, freshGraphGuid, graphToGiaAsset, listGraphs, listScripts, putGraphIntoGil, setScriptSource,
} from './lib/gil.mjs';
import { buildUiTree, checkLuaAgainstTree, formatUiTree } from './lib/ui.mjs';
import { GraphError, buildGiaFromSpecs, compileGraph, decompileGraph } from './lib/graph.mjs';
import { loadNodeTable, lookupNode, pinsOf, variantsOf } from './lib/nodes.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────── 参数 ───────────────────────────

// 注意：--json 是带值的参数（patch --json 子树.json），不能登记成布尔开关
const BOOL = new Set(['force', 'new', 'all', 'no-check', 'lua', 'raw', 'help', 'client', 'h']);
const SHORT = { o: 'out', h: 'help' };

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const name = a.startsWith('--') ? a.slice(2) : SHORT[a.slice(1)] || a.slice(1);
      const key = SHORT[name] || name;
      if (BOOL.has(key)) flags[key] = true;
      else flags[key] = argv[++i];
    } else pos.push(a);
  }
  return { pos, flags };
}

class UsageError extends Error {}
const need = (v, what) => { if (v == null) throw new UsageError(`缺少 ${what}`); return v; };

const HELP = `gi.mjs —— 直接读写千星奇域 .gil / .gia

读
  info   <文件>                       概要：容器、版本、各板块、脚本、控件、节点图
  dump   <文件> [--path P] [--depth N]   文本转储（可只看某个子树；路径写法见下）
  json   <文件> [--path P] [-o 输出]     导出无损 JSON（未知部分也保留，可改后 build 回去）
  verify <文件> [--lua]                  静态检查（规则 GG***）；--lua 顺带对脚本跑 check-lua-ui
  diff   <文件A> <文件B> [--limit N]     结构差异（逆向利器：改一个设置、各导出一份、diff 一下；默认最多 200 处）
  ui     <.gil> [--all]                  界面控件树（名字/类型/父子/脚本绑定）
  lua ls|get|check <.gil> [--name N] [-o 文件]     客户端脚本：列出 / 取出源码 / 核对 GetChild 与控件树
                                                   （check 加 --file x.lua 可核对磁盘上的脚本，例如 external_lua_file\*.lua）
  graph ls|show <文件> [--name N] [--raw]           节点图：列出 / 反编译成图规格（JSON；--raw 输出原始 NodeGraph）
  graph extract <文件> [--name N] -o 输出.gia      把 .gil/.gia 里的一张图导出成独立 .gia
  nodes find <关键字> [--client]         查节点（中文名/英文名/ID）
  nodes show <名字|ID>                   一个节点的全部引脚与泛型变体

写（必须给 -o；目标已存在需 --force，会先备份成 .bak；写完自动复检）
  build  <文件.json> -o 输出.gil|.gia    JSON → 二进制（json 形如 { "kind":"gil", "root":{…} }，见 json 命令）
  patch  <文件> --path P --json 子树.json -o 输出     用 JSON 替换某个子树
  lua put <.gil> --file f.lua [--name N] [--new [--file-name main.lua]] -o 输出.gil
  graph build <图规格.json>... -o 输出.gia [--uid N]  图规格 → .gia（可多张图；规格写法见 graph example）
  graph put <.gil> <图规格.json|.gia> [--name N] -o 输出.gil   把图放进 .gil（替换同名图或追加；逆向推断，需导入验证）
  graph example                           打印一个可编译的图规格示例

路径写法（dump/json/patch 的 --path）
  node_graphs.graphs[2].graph.nodes[0]    已知字段用名字，[i] 是数组下标
  #15[0]                                  未知字段用 #字段号，[i] 是该字段号第几次出现
`;

// ─────────────────────────── 通用输出 ───────────────────────────

const hex = (n) => (n == null ? '?' : `0x${Number(n).toString(16)}`);
const log = (...a) => console.log(...a);
const warn = (...a) => console.error(...a);

const GIL_FIELDS = {
  2: ['关卡名', '官方示例'], 3: ['(空消息)', '官方示例'], 4: ['元件/玩家角色模板', '第三方'], 5: ['关卡内实体', '第三方'],
  6: ['分类页签', '官方示例'], 7: ['地形', '第三方'], 8: ['(元件数据?)', '第三方'], 9: ['界面控件', '官方示例'],
  10: ['节点图/复合节点/信号/结构体', '官方示例'], 11: ['关卡设置', '第三方'], 15: ['背包模板/环境配置/职业技能?', '第三方'],
  16: ['技能动画/事件轨道?', '第三方'], 18: ['镜头模板', '第三方'], 22: ['关卡功能开关', '第三方'],
  25: ['外围系统(计分/成就/排行榜)', '第三方'], 27: ['装饰物', '第三方'], 29: ['编辑器信息', '第三方'],
  36: ['多语言文本?', '第三方'], 43: ['编辑器版本', '官方示例'], 50: ['客户端脚本(Lua)', '官方示例'],
};

function printProblems(list, { quiet = false } = {}) {
  const order = { error: 0, warn: 1, info: 2 };
  const shown = quiet ? list.filter((p) => p.level !== 'info') : list;
  for (const p of [...shown].sort((a, b) => order[a.level] - order[b.level])) {
    log(`  ${p.level === 'error' ? '✗' : p.level === 'warn' ? '⚠' : 'ℹ'} ${p.code} ${p.where ? `[${p.where}] ` : ''}${p.msg}`);
  }
  const e = list.filter((p) => p.level === 'error').length;
  const w = list.filter((p) => p.level === 'warn').length;
  const i = list.filter((p) => p.level === 'info').length;
  log(`  → ${e} 个 error，${w} 个 warn${i ? `，${i} 个 info` : ''}`);
  return e;
}

/** 写出并复检。返回退出码 */
function emit(outPath, bytes, flags) {
  writeGi(need(outPath, '-o 输出路径'), bytes, { force: !!flags.force });
  log(`已写出 ${outPath}（${bytes.length} 字节）`);
  if (flags['no-check']) return 0;
  const re = decodeGi(bytes, { path: outPath });
  const problems = checkGi(re);
  log('复检：');
  const errs = printProblems(problems, { quiet: true });
  return errs ? 1 : 0;
}

const loadJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

// ─────────────────────────── 读命令 ───────────────────────────

function cmdInfo(path) {
  const f = readGi(path, { lenient: true });
  const c = f.container;
  log(`文件   ${path}  (${f.bytes} 字节)`);
  log(`容器   类型 .${f.kind}  版本 ${c.version}  ${c.ok ? '头尾/长度校验通过' : '⚠ ' + c.errors.join('；')}`);
  if (f.kind === 'gil') {
    log(`关卡名 ${f.root.level_name ?? '(无)'}    编辑器版本 ${f.root.engine_version ?? '(无)'}`);
    log('\n顶层板块（字段号  大小  含义〔证据〕）');
    for (const t of parseFields(c.payload)) {
      const meta = GIL_FIELDS[t.fn];
      const size = t.wt === 2 ? `${t.raw.length}B` : t.wt === 0 ? `varint ${t.v}` : `${t.raw.length}B`;
      if (t.wt === 2 && t.raw.length === 0) continue;
      log(`  ${String(t.fn).padStart(3)}  ${size.padEnd(10)}  ${meta ? `${meta[0]}〔${meta[1]}〕` : '(未解析)'}`);
    }
    const scripts = listScripts(f.root);
    if (scripts.length) {
      log(`\n客户端脚本 ${scripts.length} 个：`);
      for (const s of scripts) log(`  「${s.name}」 ${s.file_name}  ${Buffer.byteLength(s.source ?? '', 'utf8')}B  ${hex(s.guid)}`);
    }
    if (f.root.ui) {
      const tree = buildUiTree(f.root);
      const custom = [...tree.nodes.values()].filter((n) => n.label.includes('客户端控件') || ['图片控件', '文本控件', '光标检测区域', '容器控件'].includes(n.label)).length;
      log(`\n界面控件节点 ${tree.nodes.size} 个（其中新式客户端控件 ${custom} 个），绑定脚本 ${tree.scripts.size} 处`);
    }
  } else {
    log(`导出信息 ${f.root.export_info ?? '(无)'}${f.root.engine_version ? `    引擎版本 ${f.root.engine_version}` : ''}`);
    log(`\n资产 ${f.root.assets?.length ?? 0} 个，关联资产 ${f.root.related?.length ?? 0} 个：`);
    const show = (a, tag, i) => {
      const g = a.graph_data?.inner?.graph;
      const payload = Object.keys(a).filter((k) => !['identity', 'reference_list', 'internal_name', 'resource_class', '_u'].includes(k));
      const unk = (a._u || []).map((u) => `字段${u.f}(${u.w === 'len' ? (u.hex ? `${(u.hex.length - 2) / 2}B` : '结构化') : u.w})`);
      log(`  [${tag}#${i}] ${a.resource_class ?? '?'}「${a.internal_name ?? ''}」 guid ${hex(a.identity?.asset_guid)}  ${g ? `节点图，${(g.nodes || []).length} 个节点` : `载荷 ${[...payload, ...unk].join(' ') || '无'}`}`);
    };
    (f.root.assets || []).forEach((a, i) => show(a, 'assets', i));
    (f.root.related || []).forEach((a, i) => show(a, 'related', i));
  }
  const gs = listGraphs(f);
  if (gs.length) log(`\n节点图 ${gs.length} 张（gi.mjs graph ls 查看）`);
  return 0;
}

function cmdDump(path, flags) {
  const f = readGi(path);
  const node = flags.path ? getPath(f.root, flags.path) : f.root;
  if (node === undefined) throw new GiError(`路径不存在：${flags.path}`);
  log(dumpObject(asDumpable(node), { maxStr: Number(flags['max-str'] ?? 80), maxDepth: flags.depth ? Number(flags.depth) : Infinity }));
  return 0;
}

function cmdJson(path, flags) {
  const f = readGi(path);
  const value = flags.path ? getPath(f.root, flags.path) : { $format: 'miliastra-gi/1', kind: f.kind, version: f.container.version, root: f.root };
  if (value === undefined) throw new GiError(`路径不存在：${flags.path}`);
  const text = JSON.stringify(value, null, 2);
  if (flags.out) { writeFileSync(flags.out, text + '\n', 'utf8'); log(`已写出 ${flags.out}（${text.length} 字符）`); } else log(text);
  return 0;
}

function cmdVerify(path, flags) {
  let f;
  try { f = readGi(path, { lenient: true }); } catch (e) {
    log(`✗ ${e.code || 'GG003'} ${e.code ? '' : '载荷解析失败：'}${e.message}`);
    return 1;
  }
  log(`${path}  (.${f.kind}, ${f.bytes} 字节)`);
  const problems = checkGi(f);
  let errs = printProblems(problems);
  if (flags.lua && f.kind === 'gil') {
    for (const s of listScripts(f.root)) {
      log(`\nLua「${s.name}」→ check-lua-ui.mjs`);
      const r = spawnSync(process.execPath, [join(HERE, 'check-lua-ui.mjs'), '-'], { input: s.source ?? '', encoding: 'utf8' });
      log((r.stdout || r.stderr || '').trimEnd().split('\n').map((l) => `  ${l}`).join('\n'));
      if (r.status === 1) errs++;
    }
  }
  return errs ? 1 : 0;
}

function cmdDiff(a, b, flags) {
  const A = readGi(a);
  const B = readGi(b);
  if (A.kind !== B.kind) throw new GiError(`两个文件类型不同（.${A.kind} vs .${B.kind}）`);
  const d = diffObjects(A.root, B.root, { limit: Number(flags.limit ?? 200) });
  log(d.length ? formatDiff(d) : '（结构完全相同）');
  log(`\n${d.length}${d.length >= Number(flags.limit ?? 200) ? '+' : ''} 处差异`);
  return 0;
}

function cmdUi(path, flags) {
  const f = readGi(path);
  if (f.kind !== 'gil') throw new GiError('ui 只适用于 .gil');
  const tree = buildUiTree(f.root);
  log(formatUiTree(tree, { onlyCustom: !flags.all }));
  log(`\n共 ${tree.nodes.size} 个控件节点${flags.all ? '' : '（默认只列自定义控件树，--all 列全部）'}`);
  log('类型标注：〔官方示例〕= 已用官方样本核对；带「(推测)」的是逆向推断，仅供参考');
  return 0;
}

function cmdLua(sub, path, flags) {
  const f = readGi(need(path, '.gil 文件'));
  if (f.kind !== 'gil') throw new GiError('lua 命令只适用于 .gil');
  if (sub === 'ls') {
    const list = listScripts(f.root);
    if (!list.length) log('（没有客户端脚本）');
    for (const s of list) log(`${s.index}  「${s.name}」  ${s.file_name}  ${Buffer.byteLength(s.source ?? '', 'utf8')}B  ${hex(s.guid)}`);
    return 0;
  }
  if (sub === 'get') {
    const s = findScript(f.root, flags.name);
    if (flags.out) { writeFileSync(flags.out, s.source ?? '', 'utf8'); log(`已写出 ${flags.out}（脚本「${s.name}」，${Buffer.byteLength(s.source ?? '', 'utf8')} 字节）`); } else process.stdout.write(s.source ?? '');
    return 0;
  }
  if (sub === 'check') {
    const s = findScript(f.root, flags.name);
    const tree = buildUiTree(f.root);
    const owner = tree.scripts.get(s.guid);
    if (owner == null) { log(`脚本「${s.name}」没有被任何控件绑定，无法核对（脚本要绑在某个控件上）`); return 1; }
    log(`脚本「${s.name}」绑定在控件「${tree.nodes.get(owner).name}」上`);
    // --file：核对磁盘上的 Lua（日常迭代改的 external_lua_file\*.lua），而不是存档里嵌的那一份
    let source = s.source ?? '';
    if (flags.file) { source = readFileSync(flags.file, 'utf8'); log(`核对的是 ${flags.file}，不是存档里嵌的版本`); }
    const problems = checkLuaAgainstTree(tree, owner, source);
    if (!problems.length) { log('✓ Lua 里 GetChild/FindChild 引用到的控件，在控件树里都存在（未识别的动态引用不在核对范围）'); return 0; }
    for (const p of problems) log(`  ${p.level === 'error' ? '✗' : '⚠'} ${p.msg}`);
    return problems.some((p) => p.level === 'error') ? 1 : 0;
  }
  if (sub === 'put') {
    need(flags.out, '-o 输出路径'); // 先校验参数，再动手
    const src = readFileSync(need(flags.file, '--file 源码文件'), 'utf8');
    if (flags.new) {
      const s = addScript(f.root, { name: need(flags.name, '--name 新脚本名'), fileName: flags['file-name'] || 'main.lua', source: src });
      warn(`⚠ 新增脚本属于【逆向推断】：已写入 50.1 并登记到分类页签，guid=${hex(s.guid)}。导入编辑器后请确认它出现在资产列表，并手动把它绑定到控件。`);
    } else {
      const r = setScriptSource(f.root, flags.name, src);
      log(`已替换脚本「${r.script.name}」：${r.before}B → ${r.after}B`);
    }
    return emit(flags.out, encodeGi({ kind: 'gil', root: f.root, version: f.container.version }), flags);
  }
  throw new UsageError(`lua 子命令应为 ls / get / check / put，得到 ${sub}`);
}

// ─────────────────────────── 节点图 ───────────────────────────

// 图规格示例：接线示范，不保证玩法语义。
// 执行流：事件 e → 设置变量 set → 销毁 del；「获取自定义变量」「加法运算」是纯数据节点，没有执行流，只靠数据连线参与计算。
const EXAMPLE_SPEC = {
  name: '示例—进入触发器后加分并销毁',
  kind: 'entity',
  nodes: [
    { id: 'e', node: '进入碰撞触发器时', pos: [0, 0], then: 'set' },
    { id: 'get', node: '获取自定义变量', T: 'Int', pos: [0, 220], in: { 目标实体: { from: 'e.进入者实体' }, 变量名: '积分' } },
    { id: 'add', node: '加法运算', T: 'Int', pos: [320, 220], in: { a: { from: 'get.变量值' }, b: 1 } },
    { id: 'set', node: '设置自定义变量', T: 'Int', pos: [640, 0], in: { 目标实体: { from: 'e.进入者实体' }, 变量名: '积分', 变量值: { from: 'add.结果' }, 是否触发事件: false }, then: 'del' },
    { id: 'del', node: '销毁实体', pos: [960, 0], in: { 目标实体: { from: 'e.触发器实体' } } },
  ],
};
const graphExample = () => structuredClone(EXAMPLE_SPEC);

function readSpecs(paths) {
  const specs = [];
  for (const p of paths) {
    const j = loadJson(p);
    if (Array.isArray(j)) specs.push(...j);
    else if (Array.isArray(j.graphs)) specs.push(...j.graphs);
    else specs.push(j);
  }
  return specs;
}

function printGraphProblems(e) {
  if (e instanceof GraphError) {
    warn('图规格有问题：');
    for (const p of e.problems) warn(`  ✗ ${p.path ? p.path + '：' : ''}${p.msg}`);
    return true;
  }
  return false;
}

function cmdGraph(sub, rest, flags) {
  const table = loadNodeTable();
  if (sub === 'example') { log(JSON.stringify(graphExample(), null, 2)); return 0; }

  if (sub === 'ls') {
    const f = readGi(need(rest[0], '文件'));
    const list = listGraphs(f);
    if (!list.length) log('（没有节点图）');
    for (const g of list) log(`#${g.n}  「${g.name}」  ${g.category ?? '?'}  ${g.nodeCount} 节点  guid ${hex(g.guid)}  (${g.where}[${g.index}])`);
    return 0;
  }

  if (sub === 'show') {
    const f = readGi(need(rest[0], '文件'));
    const g = findGraph(f, flags.name);
    const { spec, notes } = decompileGraph(g.graph, table);
    if (notes.length) { warn(`反编译说明（${notes.length} 条，以 raw 保留的部分不会丢）：`); for (const n of notes.slice(0, 12)) warn(`  · ${n}`); if (notes.length > 12) warn(`  … 还有 ${notes.length - 12} 条`); }
    if (flags.raw) log(JSON.stringify(g.graph, null, 2));
    else log(JSON.stringify(spec, null, 2));
    return 0;
  }

  if (sub === 'extract') {
    need(flags.out, '-o 输出路径');
    const f = readGi(need(rest[0], '文件'));
    const g = findGraph(f, flags.name);
    const asset = graphToGiaAsset(g);
    const bytes = encodeGi({ kind: 'gia', root: { assets: [asset], export_info: `0-${Math.floor(Date.now() / 1000)}-${asset.identity.asset_guid}-\\${g.name}.gia` } });
    return emit(flags.out, bytes, flags);
  }

  if (sub === 'build') {
    need(flags.out, '-o 输出路径');
    const specs = readSpecs(rest);
    if (!specs.length) throw new UsageError('至少给一个图规格 .json');
    try {
      const { bundle, warnings } = buildGiaFromSpecs(specs, table, { uid: Number(flags.uid ?? 0) });
      for (const w of warnings) warn(`⚠ ${w}`);
      warn('提示：生成的 .gia 未在真机验证，请先在编辑器里「资产导入导出 → 加载外部资产」试导入，并保留原存档备份。');
      return emit(flags.out, encodeGi({ kind: 'gia', root: bundle }), flags);
    } catch (e) { if (printGraphProblems(e)) return 1; throw e; }
  }

  if (sub === 'put') {
    need(flags.out, '-o 输出路径');
    const f = readGi(need(rest[0], '.gil 文件'));
    if (f.kind !== 'gil') throw new GiError('graph put 的目标必须是 .gil');
    const src = need(rest[1], '图规格 .json 或 .gia');
    let graph;
    if (/\.gia$/i.test(src)) {
      const g = findGraph(readGi(src), flags.name);
      graph = structuredClone(g.graph);
    } else {
      const spec = readSpecs([src])[0];
      const existing = listGraphs(f).find((x) => x.name === (flags.name || spec.name));
      try { graph = compileGraph(spec, table, { guid: existing?.guid ?? freshGraphGuid(f), evaluationInterval: null }).graph; } catch (e) { if (printGraphProblems(e)) return 1; throw e; }
    }
    const existing = listGraphs(f).find((x) => x.name === graph.display_name);
    if (existing) graph.identity = { ...graph.identity, runtime_id: existing.guid };
    else graph.identity = { ...graph.identity, runtime_id: freshGraphGuid(f) };
    const idx = putGraphIntoGil(f.root, graph, { replaceIndex: existing ? existing.index : null });
    warn(`⚠ 往 .gil 里放图属于【逆向推断】：${existing ? '已替换同名图' : '已追加'}（node_graphs.graphs[${idx}]，guid ${hex(graph.identity.runtime_id)}）。`);
    warn('  图与实体的挂接、节点图管理器里的登记本工具没有处理；导入后请在编辑器确认图可见并手动挂接。更稳的做法是生成 .gia 走官方资产导入。');
    return emit(flags.out, encodeGi({ kind: 'gil', root: f.root, version: f.container.version }), flags);
  }
  throw new UsageError(`graph 子命令应为 ls / show / extract / build / put / example，得到 ${sub}`);
}

// ─────────────────────────── 节点表 ───────────────────────────

function nodeLine(n) {
  const fi = pinsOf(n, 'flow', 'in').map((p) => p.zh || p.name);
  const fo = pinsOf(n, 'flow', 'out').map((p) => p.zh || p.name);
  const di = pinsOf(n, 'data', 'in').filter((p) => p.vis !== 'H').map((p) => `${p.zh || p.name}:${p.type}`);
  const dout = pinsOf(n, 'data', 'out').filter((p) => p.vis !== 'H').map((p) => `${p.zh || p.name}:${p.type}`);
  return `${String(n.id).padStart(7)}  ${n.zh || n.en}${n.en && n.zh ? ` (${n.en})` : ''}  [${n.dom}${n.var ? ',泛型' : ''}${n.sys === 'C' ? ',客户端' : ''}]\n         流程 入(${fi.join('、')}) 出(${fo.join('、')})   数据 入(${di.join('、')}) 出(${dout.join('、')})`;
}

function cmdNodes(sub, q, flags) {
  const table = loadNodeTable();
  if (sub === 'find') {
    const key = need(q, '关键字').toLowerCase();
    const hits = table.nodes.filter((n) => (flags.client || n.sys === 'S') && (String(n.id) === key || n.zh.toLowerCase().includes(key) || n.en.toLowerCase().includes(key) || n.ident.toLowerCase().includes(key)));
    for (const n of hits.slice(0, 40)) log(nodeLine(n));
    log(`\n${hits.length} 个匹配${hits.length > 40 ? '（只列前 40）' : ''}${flags.client ? '' : '（服务器节点；--client 含客户端）'}`);
    log(`节点表来源：第三方（game ${table.meta.gameVersion}），7.x 新增的节点可能没有`);
    return 0;
  }
  if (sub === 'show') {
    const r = lookupNode(table, need(q, '名字或 ID'), flags.client ? undefined : 'S');
    if (!r.node) { log(r.candidates?.length ? `不确定是哪个，候选：\n${r.candidates.map(nodeLine).join('\n')}` : '找不到'); return 1; }
    const n = r.node;
    log(nodeLine(n));
    log('\n引脚（shell 序号 / kernel 序号）');
    for (const [k, d] of [['flow', 'in'], ['flow', 'out'], ['data', 'in'], ['data', 'out']]) {
      for (const p of pinsOf(n, k, d)) log(`  ${k === 'flow' ? '流程' : '数据'}${d === 'in' ? '入' : '出'}  ${p.zh || p.name}  (${p.name})  ${p.type || ''}  ${p.shellIndex}/${p.kernelIndex}${p.vis === 'H' ? '  隐藏' : ''}`);
    }
    const enumPins = pinsOf(n, 'data', 'in').filter((p) => /^E<\w+>$/.test(p.type));
    if (enumPins.length) {
      log('\n枚举引脚的可选值（写图规格时用英文名或数字）：');
      for (const p of enumPins) {
        const et = table.enums[p.type.slice(2, -1)];
        const opts = Object.entries(et?.items || {}).map(([id, v]) => `${table.enumNames[id]?.en || id}(${v})`);
        log(`  ${p.zh || p.name}: ${opts.join(' / ') || '（表里没有这个枚举的选项）'}`);
      }
    }
    if (n.var) {
      const vs = variantsOf(n);
      log(`\n泛型变体 ${vs.length} 个（T 写法示例）：`);
      for (const v of vs.slice(0, 12)) log(`  ${JSON.stringify(v.bindings)} → kernel ${v.kernelId}`);
      if (vs.length > 12) log(`  … 共 ${vs.length} 个`);
    }
    return 0;
  }
  throw new UsageError(`nodes 子命令应为 find / show，得到 ${sub}`);
}

// ─────────────────────────── build / patch ───────────────────────────

function cmdBuild(path, flags) {
  need(flags.out, '-o 输出路径');
  const j = loadJson(path);
  const kind = j.kind || GI_TYPE_NAME[typeFromExt(flags.out)] ;
  if (!kind) throw new UsageError('JSON 里没有 kind，输出文件也没有 .gil/.gia 扩展名，无法判断类型');
  return emit(flags.out, encodeGi({ kind, root: j.root ?? j, version: j.version ?? 1 }), flags);
}

function cmdPatch(path, flags) {
  need(flags.out, '-o 输出路径');
  const f = readGi(path);
  need(flags.path, '--path');
  const value = loadJson(need(flags.json, '--json 子树文件'));
  setPath(f.root, flags.path, value);
  return emit(flags.out, encodeGi({ kind: f.kind, root: f.root, version: f.container.version }), flags);
}

// ─────────────────────────── 入口 ───────────────────────────

function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (!cmd || flags.help || cmd === 'help') { log(HELP); return cmd || flags.help ? 0 : 2; }
  switch (cmd) {
    case 'info': return cmdInfo(need(rest[0], '文件'));
    case 'dump': return cmdDump(need(rest[0], '文件'), flags);
    case 'json': return cmdJson(need(rest[0], '文件'), flags);
    case 'verify': return cmdVerify(need(rest[0], '文件'), flags);
    case 'diff': return cmdDiff(need(rest[0], '文件A'), need(rest[1], '文件B'), flags);
    case 'ui': return cmdUi(need(rest[0], '.gil 文件'), flags);
    case 'lua': return cmdLua(need(rest[0], '子命令 ls/get/check/put'), rest[1], flags);
    case 'graph': return cmdGraph(need(rest[0], '子命令'), rest.slice(1), flags);
    case 'nodes': return cmdNodes(need(rest[0], '子命令 find/show'), rest[1], flags);
    case 'build': return cmdBuild(need(rest[0], '.json 文件'), flags);
    case 'patch': return cmdPatch(need(rest[0], '文件'), flags);
    default: throw new UsageError(`不认识的命令 "${cmd}"（node scripts/gi.mjs --help）`);
  }
}

try {
  process.exitCode = main();
} catch (e) {
  if (e instanceof UsageError) { warn(`用法错误：${e.message}\n（node scripts/gi.mjs --help 看全部命令）`); process.exitCode = 2; }
  else if (e instanceof GraphError) { warn(`图规格有问题：\n${e.message}`); process.exitCode = 1; }
  else { warn(`失败：${e.message}`); process.exitCode = 1; }
}
