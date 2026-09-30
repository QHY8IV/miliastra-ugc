#!/usr/bin/env node
/**
 * index-samples.mjs —— 为 references/samples/ 的官方示例存档生成索引 references/formats/samples.md
 *
 * 用法：node scripts/index-samples.mjs [--samples <目录>] [--out <文件>]
 * 先决条件：已运行 node scripts/fetch-official-samples.mjs
 *
 * 索引列出每个样本的：来源课程、类型、大小、编辑器版本、客户端脚本数、界面控件节点数、节点图数、节点总数。
 * agent 要找「拿哪个存档当底板 / 哪个样本里有 X」时先查这张表，再用 gi.mjs info/ui/graph 深入。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodeGi } from './lib/gifile.mjs';
import { listGraphs, listScripts } from './lib/gil.mjs';
import { buildUiTree } from './lib/ui.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const arg = (n, d) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : d; };
const DIR = arg('--samples', join(HERE, '..', 'references', 'samples'));
const OUT = arg('--out', join(HERE, '..', 'references', 'formats', 'samples.md'));

if (!existsSync(DIR)) { console.error(`没有 ${DIR}\n先运行：node scripts/fetch-official-samples.mjs`); process.exit(1); }
const manifest = existsSync(join(DIR, 'manifest.json')) ? JSON.parse(readFileSync(join(DIR, 'manifest.json'), 'utf8')) : {};

const rows = [];
for (const f of readdirSync(DIR).filter((x) => /\.(gil|gia)$/.test(x)).sort((a, b) => a.localeCompare(b, 'zh'))) {
  const buf = readFileSync(join(DIR, f));
  const file = decodeGi(buf, { path: f });
  const m = manifest[f] || {};
  const graphs = listGraphs(file);
  const nodes = graphs.reduce((n, g) => n + g.nodeCount, 0);
  const ui = file.kind === 'gil' && file.root.ui ? buildUiTree(file.root).nodes.size : 0;
  rows.push({
    file: f, name: m.name || f.replace(/^[a-z0-9]{12}_/, ''), entry: m.entryId || f.slice(0, 12), title: (m.entryTitle || '').trim(),
    kind: file.kind, kb: (buf.length / 1000).toFixed(1), ver: file.root.engine_version ?? (file.kind === 'gil' ? '（无）' : ''),
    scripts: file.kind === 'gil' ? listScripts(file.root).length : 0, ui, graphs: graphs.length, nodes,
  });
}

const lines = [
  '# 官方示例存档索引',
  '',
  '> 由 `scripts/index-samples.mjs` 生成（不要手改）。样本本体在 `references/samples/`（由 `scripts/fetch-official-samples.mjs` 抓取，**不随技能分发**，版权归米哈游）。',
  '> 「版本」列是存档里写的编辑器版本；（无）表示较早的存档格式，没有顶层字段 43。',
  '> 想知道样本里具体有什么：`node scripts/gi.mjs info <样本>`、`… ui <样本>`、`… graph ls <样本>`。',
  '',
  `共 ${rows.length} 个：.gil ${rows.filter((r) => r.kind === 'gil').length} 个，.gia ${rows.filter((r) => r.kind === 'gia').length} 个。`,
  '',
  '| 存档 | 类型 | KB | 版本 | 脚本 | 控件节点 | 节点图 | 节点总数 | 来自课程（条目 id） |',
  '|---|---|--:|---|--:|--:|--:|--:|---|',
  ...rows.map((r) => `| ${r.name} | .${r.kind} | ${r.kb} | ${r.ver} | ${r.scripts || ''} | ${r.ui || ''} | ${r.graphs || ''} | ${r.nodes || ''} | ${r.title || '—'}（\`${r.entry}\`） |`),
  '',
];
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, lines.join('\n'), 'utf8');
console.log(`已写出 ${OUT}（${rows.length} 行）`);
