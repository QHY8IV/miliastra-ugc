#!/usr/bin/env node
/**
 * build-node-table.mjs —— 从社区节点表抽取精简版 references/formats/data/nodes.json
 *
 * 输入：references/community/Wu-Yijun__…/utils/node_data/data.json（先跑 fetch-community-refs.mjs）
 *       MIT 许可，作者标注 Aluria，GameVersion 6.2.0。归属声明见 references/formats/schema/THIRD_PARTY_LICENSES.md。
 * 输出：references/formats/data/nodes.json   随技能分发的精简表（去掉长描述，那些以官方节点文档为准）
 *
 * 用法：node scripts/build-node-table.mjs [--in <data.json>] [--out <nodes.json>]
 *
 * 精简后的形状（用数组省体积，字段含义见下）：
 *   _meta   出处、版本、许可证、字段说明
 *   types   类型标识符 → ServerTypeId（"Int" → 3）
 *   enums   枚举类型标识符 → { typeId, items: { 枚举项标识符: 枚举值 } }
 *   nodes   [ { id, zh, en, sys, dom, var, flow, data, variants } ]
 *     sys      "S" 服务器 / "C" 客户端
 *     flow     [[标识符, "i"|"o", shellIndex, kernelIndex, 中文名]]
 *     data     [[标识符, "i"|"o", 类型表达式, shellIndex, kernelIndex, 可见性("D"显示/"H"隐藏/"C"条件), 中文名]]
 *     variants 泛型节点的具体版本 [[约束表达式, kernelId, 注入内容]]（无则省略）
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const DEFAULT_IN = join(ROOT, 'references', 'community',
  'Wu-Yijun__Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack', 'utils', 'node_data', 'data.json');
const DEFAULT_OUT = join(ROOT, 'references', 'formats', 'data', 'nodes.json');

function arg(name, dflt) {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : dflt;
}

const inPath = arg('--in', DEFAULT_IN);
const outPath = arg('--out', DEFAULT_OUT);
if (!existsSync(inPath)) {
  console.error(`找不到 ${inPath}\n先运行：node scripts/fetch-community-refs.mjs`);
  process.exit(1);
}

const src = JSON.parse(readFileSync(inPath, 'utf8'));
const zhOf = (o) => (o && (o['zh-Hans'] || o.zh)) || '';
const enOf = (o) => (o && o.en) || '';
const dirCode = (d) => (d === 'In' ? 'i' : 'o');
const visCode = (v) => (v === 'Hidden' ? 'H' : v === 'Conditional' ? 'C' : 'D');

const types = {};
for (const t of src.Types) types[t.Identifier] = t.ID;

const enumById = new Map(src.Enums.map((e) => [e.Identifier, e]));
const enums = {};
for (const et of src.EnumTypes) {
  const items = {};
  for (const id of et.Collection || []) {
    const e = enumById.get(id);
    if (e) items[id] = e.ID;
  }
  enums[et.Identifier] = { typeId: et.TypeID, en: enOf(et.InGameName), items };
}
// 枚举项的英文名（下拉选项的显示名），单独放一张表便于按名字找
const enumNames = {};
for (const e of src.Enums) enumNames[e.Identifier] = { v: e.ID, en: enOf(e.InGameName), alias: e.Alias || [] };

const nodes = src.Nodes.map((n) => {
  const rec = {
    id: n.ID,
    zh: zhOf(n.InGameName),
    en: enOf(n.InGameName),
    sys: n.System === 'Client' ? 'C' : 'S',
    dom: n.Domain,
    var: n.Type === 'Variant' ? 1 : 0,
    ident: n.Identifier,
    flow: (n.FlowPins || []).map((p) => [p.Identifier, dirCode(p.Direction), p.ShellIndex ?? 0, p.KernelIndex ?? 0, zhOf(p.Label)]),
    data: (n.DataPins || []).map((p) => [
      p.Identifier, dirCode(p.Direction), p.Type || '', p.ShellIndex ?? 0, p.KernelIndex ?? 0, visCode(p.Visibility), zhOf(p.Label),
    ]),
  };
  if (n.Variants?.length) {
    rec.variants = n.Variants.map((v) => [v.Constraints || '', v.KernelID ?? null, v.InjectedContents || []]);
  }
  return rec;
});

// ─────────────────────────── 用官方样本校正 kernel 序号 ───────────────────────────
//
// 第三方表的 KernelIndex 与官方导出在少数节点上不一致（例：挂载循环特效 位置偏移 shell=5，官方 kernel=4，表里是 5）。
// 官方导出是标准答案，所以这里扫描 references/samples/，凡「同一引脚在所有样本里 kernel 序号一致、且与表不同」的，
// 记进 kernelFix；同一引脚在样本里有多种取值的（冲突）不校正，只在构建时提示。

async function mineKernelFixes(nodes, samplesDir) {
  const { existsSync: ex, readdirSync } = await import('node:fs');
  if (!ex(samplesDir)) return { fixes: {}, note: '未找到 references/samples/，跳过 kernel 序号校正（先运行 fetch-official-samples.mjs）', stats: null };
  const { readGi } = await import('./lib/gifile.mjs');
  const { listGraphs } = await import('./lib/gil.mjs');
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const KIND = { IN_FLOW: ['flow', 'in'], OUT_FLOW: ['flow', 'out'], IN_PARAM: ['data', 'in'], OUT_PARAM: ['data', 'out'] };
  const obs = new Map(); // `${id}|${k}:${d}:${si}` → Map(ki → 次数)
  let pins = 0;
  for (const f of readdirSync(samplesDir).filter((x) => /\.(gil|gia)$/.test(x))) {
    const file = readGi(join(samplesDir, f));
    for (const g of listGraphs(file)) {
      if (g.graph.identity?.service_domain !== 'SERVER_BASIC') continue;
      for (const n of g.graph.nodes || []) {
        const s = n.shell_ref;
        const def = s && s.source_domain === 'SYSTEM_DEFINED' && s.kind === 'SYS_CALL_STUB' ? byId.get(s.runtime_id) : null;
        if (!def || def.sys !== 'S') continue;
        for (const p of n.pins || []) {
          const km = KIND[p.shell_sig?.kind];
          if (!km) continue;
          pins++;
          const key = `${def.id}|${km[0]}:${km[1]}:${p.shell_sig.index ?? 0}`;
          const m = obs.get(key) || new Map();
          const ki = p.kernel_sig?.index ?? 0;
          m.set(ki, (m.get(ki) || 0) + 1);
          obs.set(key, m);
        }
      }
    }
  }
  const fixes = {};
  const conflicts = [];
  for (const [key, m] of obs) {
    const [id, pk] = key.split('|');
    const def = byId.get(Number(id));
    const [k, d, si] = pk.split(':');
    const row = k === 'flow'
      ? def.flow.find((p) => (p[1] === 'i' ? 'in' : 'out') === d && p[2] === Number(si))
      : def.data.find((p) => (p[1] === 'i' ? 'in' : 'out') === d && p[3] === Number(si));
    if (!row) continue;
    const tableKi = k === 'flow' ? row[3] : row[4];
    if (m.size > 1) { conflicts.push(`${def.zh}(${id}) ${pk}: 样本里有 ${[...m.keys()].join('/')}`); continue; }
    const [ki] = [...m.keys()];
    if (ki !== tableKi) (fixes[id] ||= {})[pk] = ki;
  }
  return { fixes, conflicts, stats: { pins, nodesFixed: Object.keys(fixes).length, pinsFixed: Object.values(fixes).reduce((a, o) => a + Object.keys(o).length, 0) } };
}

const samplesDir = arg('--samples', join(ROOT, 'references', 'samples'));
const mined = await mineKernelFixes(nodes, samplesDir);
if (mined.stats) {
  console.log(`kernel 序号校正：扫描样本引脚 ${mined.stats.pins} 个，校正 ${mined.stats.nodesFixed} 个节点的 ${mined.stats.pinsFixed} 个引脚`);
  for (const c of mined.conflicts || []) console.log(`  ⚠ 冲突（不校正）：${c}`);
} else console.log(`⚠ ${mined.note}`);

const out = {
  _meta: {
    kernelFixNote: mined.stats
      ? `kernelFix 由 build-node-table.mjs 从官方样本挖出：同一引脚在全部样本里 kernel 序号一致且与第三方表不同者。键 "flow|data:in|out:shellIndex" → kernelIndex。【官方示例】`
      : '未做 kernel 序号校正',
    source: 'Wu-Yijun/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack utils/node_data/data.json',
    sourceVersion: src.Version,
    gameVersion: src.GameVersion,
    author: src.Author,
    license: 'MIT（见 references/formats/schema/THIRD_PARTY_LICENSES.md）',
    evidence: '第三方；已与 references/samples/ 的官方样本交叉核对（结果见 references/formats/README.md）',
    builtBy: 'scripts/build-node-table.mjs',
    note: '节点 ID 为游戏内 ID；泛型节点用基类 ID（shell）+ variants 里的 kernelId（kernel）。客户端节点（sys=C）的 ID 体系与服务器不同，暂只读。',
    fields: {
      flow: '[标识符, i|o, shellIndex, kernelIndex, 中文名]',
      data: '[标识符, i|o, 类型表达式, shellIndex, kernelIndex, D显示|H隐藏|C条件, 中文名]',
      variants: '[约束表达式, kernelId, 注入内容]',
    },
  },
  types,
  enums,
  enumNames,
  kernelFix: mined.fixes,
  nodes,
};

mkdirSync(dirname(outPath), { recursive: true });
const text = JSON.stringify(out);
writeFileSync(outPath, text + '\n', 'utf8');
const srv = nodes.filter((n) => n.sys === 'S').length;
console.log(`节点 ${nodes.length}（服务器 ${srv} / 客户端 ${nodes.length - srv}），枚举类型 ${Object.keys(enums).length}，枚举项 ${Object.keys(enumNames).length}`);
console.log(`已写出 ${outPath}  ${(text.length / 1024).toFixed(0)} KB`);
