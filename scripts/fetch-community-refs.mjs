#!/usr/bin/env node
/**
 * fetch-community-refs.mjs —— 抓取社区（第三方）对 .gia/.gil 格式的逆向资料
 *
 * 为什么要有它：官方站只讲怎么导入导出，不公开二进制结构，也不公开节点的数字 ID。
 *              社区（均为 MIT 许可）做了大量逆向，其中节点 ID 表是用「导入游戏再导出」的
 *              碰撞法实测出来的。本技能把它们当作【第三方】级别的线索，
 *              一律先用官方示例存档（references/samples/）逐项核对才采用。
 *
 * 用法：
 *   node scripts/fetch-community-refs.mjs --list             # 只列会下载什么，不下载
 *   node scripts/fetch-community-refs.mjs                    # 下载到 references/community/
 *   node scripts/fetch-community-refs.mjs --out <目录>
 *   node scripts/fetch-community-refs.mjs --force            # 已存在也重下
 *
 * 产物：
 *   references/community/<owner>__<repo>/<仓库内路径>   原文件（钉在具体 commit，可复现）
 *   references/community/manifest.json                  仓库、commit、许可证、字节数、sha256
 *
 * 边界：
 *   - 只做只读 GET（GitHub API 取 commit 与文件树，raw.githubusercontent.com 取文件）；
 *   - 只下载下面 SOURCES 里白名单列出的路径，全部是文本/数据文件，绝不执行；
 *   - 原文件版权归各自作者，MIT 许可要求保留版权声明——LICENSE 一并下载并随 manifest 记录；
 *   - references/community/ 不属于技能的分发内容；随技能分发的是核对后提取的
 *     references/formats/data/ 下的精简表，并在其中保留出处与许可证。
 *
 * 依赖：Node >= 22（内建 fetch）。零第三方依赖。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, '..', 'references', 'community');

/**
 * 白名单。exact = 精确路径；prefix = 路径前缀（只用于小体量的文档/proto 目录）。
 * 与向使用者申请下载时列出的范围一致，不要随手加新路径。
 */
const SOURCES = [
  {
    owner: 'Wu-Yijun',
    repo: 'Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack',
    license: 'MIT',
    branch: 'main',
    exact: [
      'LICENSE',
      'utils/protobuf/gia.proto',
      'utils/protobuf/readme.md',
      'utils/node_data/data.json',
      'utils/node_data/readme.md',
      'docs/utils/原神导入 GIA 文件的规则说明.md',
      'docs/utils/NodePinsRecords 与类型系统说明.md',
    ],
    prefix: [],
  },
  {
    owner: 'script-1024',
    repo: 'genshin-miliastra-file-format',
    license: 'MIT',
    branch: 'main',
    exact: ['LICENSE'],
    prefix: ['proto/', 'docs/zh/'],
  },
];

const UA = { 'User-Agent': 'miliastra-ugc-skill', Accept: 'application/vnd.github+json' };

/** 瞬时网络错误（TLS 重置等）重试 3 次；HTTP 状态码错误不重试 */
async function withRetry(fn) {
  let last;
  for (let i = 0; i < 3; i++) {
    try { return await fn(); } catch (e) {
      last = e;
      if (/^HTTP \d+/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
}
const getJSON = (url) => withRetry(async () => {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`HTTP ${res.status}  ${url}`);
  return res.json();
});
const getBuf = (url) => withRetry(async () => {
  const res = await fetch(url, { headers: { 'User-Agent': 'miliastra-ugc-skill' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}  ${url}`);
  return Buffer.from(await res.arrayBuffer());
});

const encodePath = (p) => p.split('/').map(encodeURIComponent).join('/');
const sha256 = (b) => createHash('sha256').update(b).digest('hex');

function parseArgs(argv) {
  const o = { list: false, force: false, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') o.list = true;
    else if (a === '--force') o.force = true;
    else if (a === '--out') o.out = argv[++i];
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return o;
}

async function plan(src) {
  const commit = await getJSON(`https://api.github.com/repos/${src.owner}/${src.repo}/commits/${src.branch}`);
  const sha = commit.sha;
  const tree = await getJSON(`https://api.github.com/repos/${src.owner}/${src.repo}/git/trees/${sha}?recursive=1`);
  const wanted = tree.tree.filter((t) =>
    t.type === 'blob' && (src.exact.includes(t.path) || src.prefix.some((p) => t.path.startsWith(p))));
  const missing = src.exact.filter((p) => !wanted.some((t) => t.path === p));
  return { sha, date: commit.commit?.committer?.date, wanted, missing, truncated: !!tree.truncated };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const manifestPath = join(args.out, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};
  let total = 0, fetched = 0, skipped = 0;

  for (const src of SOURCES) {
    const p = await plan(src);
    const bytes = p.wanted.reduce((n, t) => n + (t.size || 0), 0);
    console.log(`\n${src.owner}/${src.repo} @ ${p.sha.slice(0, 10)} (${p.date || '?'})  ${src.license}`);
    console.log(`  白名单命中 ${p.wanted.length} 个文件，共 ${(bytes / 1024).toFixed(1)} KB`);
    if (p.truncated) console.log('  ⚠ 仓库文件树被 API 截断，白名单可能不完整');
    for (const m of p.missing) console.log(`  ⚠ 白名单里的路径在仓库中不存在：${m}`);
    for (const t of p.wanted) console.log(`   ${String(t.size).padStart(9)} B  ${t.path}`);
    total += p.wanted.length;
    if (args.list) continue;

    for (const t of p.wanted) {
      const rel = `${src.owner}__${src.repo}/${t.path}`;
      const dest = join(args.out, rel);
      const key = rel;
      if (!args.force && existsSync(dest) && manifest[key]?.commit === p.sha) { skipped++; continue; }
      const url = `https://raw.githubusercontent.com/${src.owner}/${src.repo}/${p.sha}/${encodePath(t.path)}`;
      const buf = await getBuf(url);
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, buf);
      manifest[key] = {
        repo: `${src.owner}/${src.repo}`, commit: p.sha, commitDate: p.date, license: src.license,
        path: t.path, url, bytes: buf.length, sha256: sha256(buf),
      };
      fetched++;
    }
  }

  if (args.list) { console.log(`\n共 ${total} 个文件（未下载，--list）`); return; }
  mkdirSync(args.out, { recursive: true });
  const sorted = Object.fromEntries(Object.entries(manifest).sort(([a], [b]) => a.localeCompare(b, 'zh')));
  writeFileSync(manifestPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  console.log(`\n完成：新下载 ${fetched}，已存在跳过 ${skipped}（白名单共 ${total}）`);
  console.log(`目录：${args.out}\n清单：${manifestPath}`);
}

main().catch((e) => {
  // Node 的 fetch 失败只报 "fetch failed"，真正原因（DNS/TLS/代理）在 cause 里
  const why = e.cause ? `（${e.cause.code || e.cause.message}）` : '';
  console.error(`失败：${e.message}${why}`);
  process.exit(1);
});
