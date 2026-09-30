#!/usr/bin/env node
/**
 * fetch-official-samples.mjs —— 抓官方教程站挂的示例存档（.gil / .gia）
 *
 * 背景：官方教程每一课都附带「教学存档」（辅助课件），文件挂在
 *       act-webstatic.mihoyo.com/ugc-tutorial/.../<条目id>/<uuid>.gil|.gia 。
 *       官方站没有公开 .gil/.gia 的二进制结构，这些样本是逆向与回归的唯一官方依据。
 *
 * 用法：
 *   node scripts/fetch-official-samples.mjs --list                 # 只列清单，不下载
 *   node scripts/fetch-official-samples.mjs                        # 下载全部到 references/samples/
 *   node scripts/fetch-official-samples.mjs --only <条目id>[,…]     # 只处理指定条目
 *   node scripts/fetch-official-samples.mjs --out <目录>            # 换个输出目录
 *   node scripts/fetch-official-samples.mjs --force                # 已存在也重下
 *
 * 产物：
 *   references/samples/<条目id>_<原文件名>      样本本体（同名文件在不同课里会重复，所以带条目 id 前缀）
 *   references/samples/manifest.json            来源 URL、字节数、sha256（供核对与回归）
 *
 * 边界：
 *   - 只做只读 GET，公开静态资源；不登录、不带凭据。
 *   - 只下载 .gil / .gia；页面里出现的其它附件类型只会在清单里提示，不会下载。
 *   - 样本版权归米哈游（miHoYo / HoYoverse）所有，仅供个人学习与创作辅助，
 *     所以 references/samples/ 不属于技能的分发内容（README 的安装命令已排除它）。
 *
 * 依赖：Node >= 22（内建 fetch）。零第三方依赖。
 */

import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT = join(HERE, '..', 'references', 'samples');

// 附件只出现在教程（course）与综合指南（knowledge）里；faq 不含附件
const SECTIONS = {
  course: 'https://act-webstatic.mihoyo.com/ugc-tutorial/course/cn',
  knowledge: 'https://act-webstatic.mihoyo.com/ugc-tutorial/knowledge/cn',
};
const LANG = 'zh-cn';
const CONCURRENCY = 6;

/** 瞬时网络错误（TLS 重置等）重试 3 次；HTTP 状态码错误不重试 */
const get = async (url, binary = false) => {
  let last;
  for (let i = 0; i < 3; i++) {
    try {
      const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
      if (!res.ok) throw new Error(`HTTP ${res.status}  ${url}`);
      return binary ? Buffer.from(await res.arrayBuffer()) : await res.text();
    } catch (e) {
      last = e;
      if (/^HTTP \d+/.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 800 * (i + 1)));
    }
  }
  throw last;
};

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push({ id: n.real_id || n.path_id, title: n.title });
    if (n.children?.length) flatten(n.children, out);
  }
  return out;
}

/** 有限并发的 map，保持输入顺序 */
async function pool(items, limit, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

/**
 * 从正文 HTML 里取附件。官方结构：
 *   <div class="card-content-primary">客户端脚本.gil</div>
 *   <div class="card-content-secondary">35.8 KB</div></div>
 *   <a href="https://…/<条目id>/<uuid>.gil" download="<uuid>.gil"></a>
 */
function extractAttachments(html) {
  const found = [];
  const seen = new Set();
  const anchorRe = /<a\b[^>]*\bhref="([^"]+\.[A-Za-z0-9]{2,5})"[^>]*>/g;
  let m;
  while ((m = anchorRe.exec(html))) {
    const href = m[1];
    if (seen.has(href)) continue;
    // 只关心站内挂的附件：href 指向该条目自己的目录，且是「卡片」结构里的链接
    const before = html.slice(Math.max(0, m.index - 600), m.index);
    const nameM = [...before.matchAll(/card-content-primary">([^<]*)</g)].pop();
    const sizeM = [...before.matchAll(/card-content-secondary">([^<]*)</g)].pop();
    if (!nameM) continue; // 不是附件卡片（普通超链接）
    seen.add(href);
    found.push({
      url: href,
      name: decode(nameM[1]).trim(),
      sizeText: sizeM ? decode(sizeM[1]).trim() : '',
    });
  }
  return found;
}

// 官方页面标注的 KB 是十进制（1KB=1000B）：112658B 标成 "112.7 KB"
const sizeTextToBytes = (t) => {
  const m = /([\d.]+)\s*(KB|MB|B)/i.exec(t || '');
  if (!m) return null;
  return Math.round(parseFloat(m[1]) * ({ B: 1, KB: 1000, MB: 1e6 }[m[2].toUpperCase()]));
};

const sanitize = (s) => s.replace(/[\\/:*?"<>|]/g, '_');
const sha256 = (buf) => createHash('sha256').update(buf).digest('hex');

function parseArgs(argv) {
  const out = { list: false, force: false, only: null, out: DEFAULT_OUT };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--force') out.force = true;
    else if (a === '--only') out.only = new Set(argv[++i].split(',').map((s) => s.trim()).filter(Boolean));
    else if (a === '--out') out.out = argv[++i];
    else { console.error(`未知参数：${a}`); process.exit(2); }
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // 1. 收集所有条目
  const entries = [];
  for (const [section, base] of Object.entries(SECTIONS)) {
    const cat = JSON.parse(await get(`${base}/${LANG}/catalog.json`));
    for (const it of flatten(cat)) {
      if (args.only && !args.only.has(it.id)) continue;
      entries.push({ section, base, ...it });
    }
  }
  console.log(`扫描 ${entries.length} 个条目的正文，查找 .gil/.gia 附件 …`);

  // 2. 逐条取正文，抽附件
  const perEntry = await pool(entries, CONCURRENCY, async (e) => {
    try {
      const html = await get(`${e.base}/${LANG}/${e.id}/content.html?v=1016`);
      return extractAttachments(html).map((a) => ({ ...a, entryId: e.id, entryTitle: e.title, section: e.section }));
    } catch (err) {
      // 目录里有、正文没有的空条目很常见（分组节点），不算错误
      return [];
    }
  });
  const all = perEntry.flat();

  const wanted = all.filter((a) => /\.(gil|gia)$/i.test(a.url));
  const others = all.filter((a) => !/\.(gil|gia)$/i.test(a.url));

  const ext = (a) => a.url.slice(a.url.lastIndexOf('.') + 1).toLowerCase();
  const nGil = wanted.filter((a) => ext(a) === 'gil').length;
  const nGia = wanted.filter((a) => ext(a) === 'gia').length;
  console.log(`\n找到 ${wanted.length} 个存档附件（.gil ${nGil} / .gia ${nGia}）`);
  if (others.length) {
    console.log(`另有 ${others.length} 个其它类型附件，本脚本不下载：`);
    for (const o of others) console.log(`  [${ext(o)}] ${o.entryId} ${o.name}`);
  }

  wanted.sort((a, b) => (a.entryId + a.name).localeCompare(b.entryId + b.name, 'zh'));
  for (const a of wanted) {
    console.log(`  ${a.entryId}  ${a.sizeText.padStart(9)}  ${a.name}   [${a.entryTitle}]`);
  }
  if (args.list) return;

  // 3. 下载
  mkdirSync(args.out, { recursive: true });
  const manifestPath = join(args.out, 'manifest.json');
  const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : {};

  let fetched = 0, skipped = 0, warn = 0;
  await pool(wanted, CONCURRENCY, async (a) => {
    const file = `${a.entryId}_${sanitize(a.name)}`;
    const dest = join(args.out, file);
    if (!args.force && existsSync(dest) && manifest[file]) { skipped++; return; }
    const buf = await get(a.url, true);
    writeFileSync(dest, buf);
    const expect = sizeTextToBytes(a.sizeText);
    // 页面上的大小四舍五入到 0.1KB（±50B），留一点余量
    const drift = expect == null ? 0 : Math.abs(buf.length - expect);
    if (expect != null && drift > 120) { warn++; console.log(`  ⚠ 大小与页面标注差异较大：${file}  实际 ${buf.length}B / 标注 ${a.sizeText}`); }
    manifest[file] = {
      entryId: a.entryId, entryTitle: a.entryTitle, section: a.section, name: a.name,
      url: a.url, bytes: buf.length, sha256: sha256(buf), pageSize: a.sizeText,
    };
    fetched++;
  });

  const sorted = Object.fromEntries(Object.entries(manifest).sort(([x], [y]) => x.localeCompare(y, 'zh')));
  writeFileSync(manifestPath, JSON.stringify(sorted, null, 2) + '\n', 'utf8');
  console.log(`\n完成：新下载 ${fetched}，已存在跳过 ${skipped}，大小告警 ${warn}`);
  console.log(`目录：${args.out}\n清单：${manifestPath}`);
}

main().catch((e) => { console.error(`失败：${e.message}`); process.exit(1); });
