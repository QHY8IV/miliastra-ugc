#!/usr/bin/env node
/**
 * fetch-official-doc.mjs —— 直接从米哈游官方教程站抓正文
 *
 * 背景：官方教程站是前端渲染的 SPA，直接 GET 页面只能拿到空壳。
 *       但正文其实以静态 JSON / HTML 挂在 CDN 上，本脚本直接命中 CDN。
 *
 * 用法：
 *   node scripts/fetch-official-doc.mjs --list
 *   node scripts/fetch-official-doc.mjs <条目id> [--section course|guide|faq] [--raw]
 *
 * 例：
 *   node scripts/fetch-official-doc.mjs mh47p30a87qo
 *   node scripts/fetch-official-doc.mjs mhtakr07vej4 --raw
 *
 * 产物写到 references/live/（与 git 镜像隔离，git pull 不会冲突）。
 *
 * 依赖：Node >= 22（用内建 fetch）。零第三方依赖。不改动 references/corpus/。
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const LIVE_DIR = join(HERE, '..', 'references', 'live');

const SECTIONS = {
  course: 'https://act-webstatic.mihoyo.com/ugc-tutorial/course/cn',
  guide: 'https://act-webstatic.mihoyo.com/ugc-tutorial/knowledge/cn',
  faq: 'https://act-webstatic.mihoyo.com/ugc-tutorial/faq/cn',
};
const LANG = 'zh-cn';

// ─────────────────────────── 网络 ───────────────────────────

async function get(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!res.ok) throw new Error(`HTTP ${res.status}  ${url}`);
  return res.text();
}

async function getJSON(url) {
  return JSON.parse(await get(url));
}

// ─────────────────────────── 目录 ───────────────────────────

function flatten(nodes, out = []) {
  for (const n of nodes || []) {
    out.push({ id: n.real_id || n.path_id, title: n.title, updated: n.updated_at });
    if (n.children?.length) flatten(n.children, out);
  }
  return out;
}

async function listAll() {
  for (const [name, base] of Object.entries(SECTIONS)) {
    let cat;
    try {
      cat = await getJSON(`${base}/${LANG}/catalog.json`);
    } catch (e) {
      console.log(`\n[${name}] 目录取不到：${e.message}`);
      continue;
    }
    const items = flatten(cat);
    console.log(`\n[${name}] 共 ${items.length} 条  (${base}/${LANG}/catalog.json)`);
    for (const it of items) {
      console.log(`  ${it.id}  ${it.updated || ''}  ${it.title}`);
    }
  }
}

// ─────────────────────── HTML → Markdown ───────────────────────

const decode = (s) =>
  s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
   .replace(/&#39;/g, "'").replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&');

const stripTags = (s) => decode(s.replace(/<[^>]+>/g, ''));

/** 正文里的站内链接是相对路径，落到本地后点不开；补成绝对地址 */
const SITE = 'https://act.mihoyo.com';
const absolutize = (u) =>
  /^https?:\/\//i.test(u) ? u
  : u.startsWith('//') ? `https:${u}`
  : u.startsWith('/') ? `${SITE}${u.replace(/\/{2,}/g, '/')}`
  : u;

function htmlToMarkdown(html) {
  let h = html;

  // 1. 代码块先摘出来，避免被后续规则破坏
  const codes = [];
  h = h.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/g, (_, body) => {
    const txt = decode(body.replace(/<[^>]+>/g, '')).replace(/^\n+|\n+$/g, '');
    codes.push(txt);
    return `\u0000CODE${codes.length - 1}\u0000`;
  });

  // 2. 提示框（带 data-icon 的 tooltip）
  h = h.replace(/<div class="tooltip[^"]*"[^>]*data-icon="([^"]*)"[^>]*>/g, '\n\n> $1 ');
  h = h.replace(/<\/div>/g, '\n');

  // 3. 表格
  h = h.replace(/<table[\s\S]*?<\/table>/g, (tbl) => {
    const rows = [...tbl.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/g)];
    const lines = [];
    let first = true;
    for (const r of rows) {
      const cells = [...r[1].matchAll(/<t[dh][^>]*>([\s\S]*?)<\/t[dh]>/g)]
        .map((c) => stripTags(c[1]).replace(/\s+/g, ' ').trim().replace(/\|/g, '\\|'));
      if (!cells.length) continue;
      lines.push(`| ${cells.join(' | ')} |`);
      if (first) { lines.push(`|${cells.map(() => '---').join('|')}|`); first = false; }
    }
    return `\n\n${lines.join('\n')}\n\n`;
  });

  // 4. 行内
  // 图片：官方正文大量用无 alt 的 <img>，补成 ![图](...) 以便阅读时知道那里有张图
  h = h.replace(/<img[^>]*src="([^"]*)"[^>]*>/g, (_, src) => `![图](${absolutize(src)})`);
  h = h.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/g,
    (_, href, txt) => `[${stripTags(txt)}](${absolutize(href)})`);
  h = h.replace(/<(strong|b)>([\s\S]*?)<\/\1>/g, (_, __, t) => `**${t}**`);
  h = h.replace(/<(em|i)>([\s\S]*?)<\/\1>/g, (_, __, t) => `*${t}*`);
  h = h.replace(/<(code|tt)>([\s\S]*?)<\/\1>/g, (_, __, t) => `\`${t}\``);
  h = h.replace(/<u>([\s\S]*?)<\/u>/g, (_, t) => `<u>${t}</u>`);

  // 5. 块级
  h = h.replace(/<h1[^>]*>([\s\S]*?)<\/h1>/g, '\n\n# $1\n\n');
  h = h.replace(/<h2[^>]*>([\s\S]*?)<\/h2>/g, '\n\n## $1\n\n');
  h = h.replace(/<h3[^>]*>([\s\S]*?)<\/h3>/g, '\n\n### $1\n\n');
  h = h.replace(/<h4[^>]*>([\s\S]*?)<\/h4>/g, '\n\n#### $1\n\n');
  h = h.replace(/<li[^>]*>([\s\S]*?)<\/li>/g, '\n- $1');
  h = h.replace(/<br\s*\/?>/g, '\n');
  h = h.replace(/<hr\s*\/?>/g, '\n\n---\n\n');
  h = h.replace(/<\/p>/g, '\n\n');
  h = h.replace(/<\/tr>/g, '\n');

  // 6. 去残余标签
  h = stripTags(h);

  // 7. 还原代码块
  h = h.replace(/\u0000CODE(\d+)\u0000/g, (_, i) => `\n\`\`\`lua\n${codes[+i]}\n\`\`\`\n`);

  // 8. 清理空白
  h = h.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
  return h;
}

// ─────────────────────────── 主流程 ───────────────────────────

function parseArgs(argv) {
  const out = { section: 'course', raw: false, list: false, id: null, out: LIVE_DIR };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--list') out.list = true;
    else if (a === '--raw') out.raw = true;
    else if (a === '--section') out.section = argv[++i];
    else if (a === '--out') out.out = argv[++i];
    else if (!a.startsWith('-')) out.id = a;
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.list || !args.id) {
    await listAll();
    if (!args.id) {
      console.log('\n用法：node scripts/fetch-official-doc.mjs <条目id> [--section course|guide|faq] [--raw]');
      return;
    }
  }

  const base = SECTIONS[args.section];
  if (!base) { console.error(`未知 section：${args.section}`); process.exit(2); }

  // 先查目录拿标题（查不到不致命）
  let title = args.id;
  try {
    const items = flatten(await getJSON(`${base}/${LANG}/catalog.json`));
    const hit = items.find((x) => x.id === args.id);
    if (hit) title = hit.title;
  } catch { /* 目录拿不到就只用 id 命名 */ }

  const url = `${base}/${LANG}/${args.id}/content.html?v=1016`;
  console.log(`抓取：${url}`);
  const html = await get(url);

  mkdirSync(args.out, { recursive: true });
  const safeTitle = title.replace(/[\\/:*?"<>|]/g, '_');
  const stem = `${args.id}_${safeTitle}`;

  writeFileSync(join(args.out, `${stem}.html`), html, 'utf8');

  if (!args.raw) {
    const md = htmlToMarkdown(html);
    const header = [
      `# ${title}`,
      '',
      `> **条目 id**：\`${args.id}\` ｜ **抓取时间**：${new Date().toISOString()}`,
      `> **来源**：${url}`,
      `> **版权**：正文版权归米哈游（miHoYo / HoYoverse）所有，此处仅作个人学习与创作辅助。`,
      '',
      '---',
      '',
    ].join('\n');
    writeFileSync(join(args.out, `${stem}.md`), header + md + '\n', 'utf8');
    console.log(`已写出：${join(args.out, `${stem}.md`)}`);
  }
  console.log(`已写出：${join(args.out, `${stem}.html`)}（原始快照）`);
  console.log('\n注意：自动转换的 Markdown 可能有排版瑕疵，重要条目建议人工过一遍。');
}

main().catch((e) => { console.error(`失败：${e.message}`); process.exit(1); });
