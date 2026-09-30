#!/usr/bin/env node
/**
 * build-client-api.mjs —— 把官方「客户端控件API文档」的 Markdown 表格机械解析成 JSON
 *
 * 为什么要做：离线模拟器（scripts/lib/sim）需要「哪个控件有哪些字段、哪些方法、哪些字段可补间、枚举有哪些值」。
 * 手抄这些表会抄错（我抄过：漏了 RemoveCursorEventListeners / SimulateCursorClick，把 EnumItem.Name 写成小写）。
 * 所以由本脚本从官方原文逐表解析，产物 references/formats/data/client-api.json 随 skill 一起发布，
 * 镜像（references/corpus/）不在也能用；镜像在的时候用 --check 校验产物没有过期。
 *
 * 用法：
 *   node scripts/build-client-api.mjs                      按默认源（镜像里的 mhtakr07vej4）重新生成产物
 *   node scripts/build-client-api.mjs --check              只校验：产物与源文档解析结果是否一致（不一致退出码 1）
 *   node scripts/build-client-api.mjs --source 文件.md --out 输出.json
 *
 * 来源：官方条目 mhtakr07vej4（客户端控件API文档）；证据等级【文档】。
 * 依赖：Node >= 22，零第三方依赖。
 */

import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isMain } from './lib/ismain.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
export const DEFAULT_SOURCE = join(ROOT, 'references', 'corpus', 'Miliastra-knowledge', 'client', 'mhtakr07vej4_客户端控件API文档.md');
export const DEFAULT_OUT = join(ROOT, 'references', 'formats', 'data', 'client-api.json');

// ─────────────────────────── Markdown 表格 ───────────────────────────

// 零宽空格 / 零宽连接符 / BOM 等不可见字符（用码点拼，避免在源码里放真实的不可见字符）
const INVISIBLE = new RegExp(`[${[0x200b, 0x200c, 0x200d, 0xfeff].map((c) => String.fromCharCode(c)).join('')}]`, 'g');

const clean = (s) => s
  .replace(INVISIBLE, '')                               // 文档里夹了零宽空格
  .replace(/\\([\[\]\-=`|*_])/g, '$1')                   // Markdown 转义
  .replace(/`/g, '')
  .replace(/\*\*/g, '')
  .trim();

function splitRow(line) {
  const body = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return body.split(/(?<!\\)\|/).map(clean);
}

/** → [{h2, h3, header, rows}]，h2/h3 是表格所在的二、三级标题（去掉「13.」这样的序号前缀） */
function readTables(text) {
  const lines = text.replace(/\r\n?/g, '\n').split('\n');
  const tables = [];
  let h2 = '';
  let h3 = '';
  const strip = (t) => t.replace(/^\(?\d+\)?[.．)]?\s*/, '').trim();
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let m = /^## (.+)$/.exec(line);
    if (m) { h2 = strip(m[1]); h3 = ''; continue; }
    m = /^### (.+)$/.exec(line);
    if (m) { h3 = m[1].trim(); continue; }
    if (!line.startsWith('|')) continue;
    const rows = [];
    while (i < lines.length && lines[i].startsWith('|')) { rows.push(splitRow(lines[i])); i++; }
    i--;
    if (rows.length >= 2) tables.push({ h2, h3, header: rows[0], rows: rows.slice(2) });
  }
  return tables;
}

// ─────────────────────────── 签名解析 ───────────────────────────

/** 在最外层逗号处切分（参数类型里会出现 fun(a: string, b: any[]) 这样的嵌套） */
function splitTop(s) {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if (ch === '(' || ch === '[' || ch === '{') depth++;
    if (ch === ')' || ch === ']' || ch === '}') depth--;
    if (ch === ',' && depth === 0) { out.push(cur.trim()); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

/** 'script:GetParam(paramName: string)' → { owner:'script', sep:':', name:'GetParam', params:[…] } */
function parseSignature(sig) {
  const m = /^(?:([A-Za-z_]\w*)([.:]))?([A-Za-z_][\w.]*)\s*\((.*)\)\s*$/.exec(sig);
  if (!m) return null;
  const [, owner, sep, name, inner] = m;
  const params = [];
  if (inner.includes('[') && /^\[|\[,/.test(inner.replace(/\s/g, '')) && !/:/.test(inner)) {
    // 可选参数写法：debug.traceback([message[, level]])
    for (const n of inner.match(/[A-Za-z_]\w*/g) || []) params.push({ name: n, optional: true });
  } else {
    for (const part of splitTop(inner)) {
      if (part === '...') { params.push({ name: '...', vararg: true }); continue; }
      const pm = /^([A-Za-z_]\w*|\.\.\.)\s*(?::\s*(.+))?$/.exec(part);
      if (!pm) { params.push({ name: part }); continue; }
      const p = { name: pm[1] };
      if (pm[2]) {
        let t = pm[2].trim();
        if (t.endsWith('?')) { p.optional = true; t = t.slice(0, -1); }
        p.type = t;
      }
      params.push(p);
    }
  }
  return { owner, sep, name, params };
}

const OWNER_TYPE = { script: 'Script', Tween: 'Tween', TweenSequence: 'TweenSequence', ServerSignal: 'ServerSignal', CursorEventData: 'CursorEventData' };

// ─────────────────────────── 解析主体 ───────────────────────────

export function parseApiDoc(text) {
  const fm = /^---\n([\s\S]*?)\n---/.exec(text.replace(/\r\n?/g, '\n'));
  const meta = {};
  for (const line of (fm ? fm[1] : '').split('\n')) {
    const m = /^(\w+):\s*(.*)$/.exec(line);
    if (m) meta[m[1]] = m[2].trim();
  }

  const api = {
    source: { id: meta.id, title: meta.title, crawledAt: meta.crawledAt, sha256: createHash('sha256').update(text.replace(/\r\n?/g, '\n')).digest('hex') },
    lifecycle: [],
    globals: {},
    globalFunctions: {},
    color: { constructor: null, functions: {} },
    game: {},
    types: {},
    controlTypes: [],
    enums: {},
  };
  const type = (name) => (api.types[name] ??= { fields: {}, methods: {} });

  const addMethod = (container, sigText, returns, desc) => {
    const sig = parseSignature(sigText);
    if (!sig) return null;
    const entry = { params: sig.params, returns: returns === '—' ? '' : returns, desc };
    if (!(sig.name in container)) container[sig.name] = entry;
    return sig;
  };

  for (const t of readTables(text)) {
    const head = t.header.join('|');
    const h2 = t.h2;

    // —— 枚举 ——
    if (t.header[0] === '枚举名') {
      for (const r of t.rows) {
        const m = /^Enum\.(\w+)$/.exec(r[0]);
        if (!m) continue;
        (api.enums[m[1]] ??= []).push(r[1]);
      }
      continue;
    }

    // —— 生命周期 ——
    if (t.header[0] === '函数' && t.header[1] === '参数') {
      for (const r of t.rows) {
        const m = /^(\w+)\((.*)\)$/.exec(r[0]);
        if (m) api.lifecycle.push({ name: m[1], params: r[1] === '无' ? [] : [r[1].replace(/\s/g, '')], desc: r[2] });
      }
      continue;
    }

    // —— 继承关系 ——
    if (t.header[0] === '类型' && t.header[1] === '控件名') {
      for (const r of t.rows) api.controlTypes.push(r[0]);
      continue;
    }

    // —— 全局变量 ——
    if (t.header[0] === '名称' && t.header[1] === '类型') {
      for (const r of t.rows) api.globals[r[0]] = r[1];
      continue;
    }

    // —— 字段表 ——
    if (t.header[0] === '字段') {
      const owner = h2;
      const ty = type(owner);
      for (const r of t.rows) {
        const [names, typ, access, desc] = r;
        const tween = /Tweenable/.test(access) || /Tweenable/.test(desc);
        const rw = /只读/.test(access) ? 'r' : 'rw';
        for (const n of names.split(',').map((x) => x.trim()).filter(Boolean)) {
          ty.fields[n] = { type: typ, access: rw, ...(tween ? { tween: true } : {}), desc };
        }
      }
      continue;
    }

    // —— 构造函数（Color） ——
    if (t.header[0] === '构造函数') {
      for (const r of t.rows) {
        const sig = parseSignature(r[0]);
        if (sig && sig.name === 'Color') api.color.constructor = { params: sig.params, returns: r[1], desc: r[2] };
      }
      continue;
    }

    // —— 方法 / 函数表 ——
    if (t.header[0] === '方法' || t.header[0] === '函数') {
      for (const r of t.rows) {
        const [sigText, returns, desc] = r;
        const sig = parseSignature(sigText);
        if (!sig) continue;
        if (sig.owner === 'game') { addMethod(api.game, `${sig.name}(${sigText.slice(sigText.indexOf('(') + 1)}`, returns, desc); continue; }
        if (sig.owner === 'Color') { addMethod(api.color.functions, `${sig.name}(${sigText.slice(sigText.indexOf('(') + 1)}`, returns, desc); continue; }
        if (sig.owner === 'debug' || sig.owner === 'math') {
          api.globalFunctions[`${sig.owner}.${sig.name}`] ??= { params: sig.params, returns: returns === '—' ? '' : returns, desc };
          continue;
        }
        if (!sig.owner && (h2 === '全局API' || h2 === '逐帧控制')) {
          if (h2 === '逐帧控制') { addMethod(type('Script').methods, sigText, returns, desc); continue; }
          api.globalFunctions[sig.name] ??= { params: sig.params, returns: returns === '—' ? '' : returns, desc };
          continue;
        }
        if (!sig.owner && h2 === 'game') { addMethod(api.game, sigText, returns, desc); continue; }
        const owner = sig.owner ? (OWNER_TYPE[sig.owner] ?? sig.owner) : h2;
        addMethod(type(owner).methods, sigText, returns, desc);
      }
      continue;
    }
    void head;
  }

  // game.* 里的 game.PrintClientUITree 被归进 globalFunctions 之外，统一也放进 game
  for (const [k, v] of Object.entries(api.globalFunctions)) {
    if (k.startsWith('game.')) { api.game[k.slice(5)] ??= v; delete api.globalFunctions[k]; }
  }
  return api;
}

// ─────────────────────────── 入口 ───────────────────────────

function summary(api) {
  const nTypes = Object.keys(api.types).length;
  const nFields = Object.values(api.types).reduce((a, t) => a + Object.keys(t.fields).length, 0);
  const nMethods = Object.values(api.types).reduce((a, t) => a + Object.keys(t.methods).length, 0);
  return `${nTypes} 个类型、${nFields} 个字段、${nMethods} 个方法；game ${Object.keys(api.game).length} 个函数；${Object.keys(api.enums).length} 个枚举`;
}

function main() {
  const args = process.argv.slice(2);
  const get = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined; };
  if (args.includes('--help') || args.includes('-h')) {
    console.log('用法：node scripts/build-client-api.mjs [--check] [--source 文件.md] [--out 输出.json]');
    return 0;
  }
  const source = get('--source') ?? DEFAULT_SOURCE;
  const out = get('--out') ?? DEFAULT_OUT;
  if (!existsSync(source)) {
    console.error(`找不到源文档：${source}\n镜像不在时不需要本脚本——产物 ${out} 已随 skill 发布。要重新生成，先克隆镜像（见 README）。`);
    return 2;
  }
  const api = parseApiDoc(readFileSync(source, 'utf8'));
  const json = `${JSON.stringify(api, null, 1)}\n`;
  if (args.includes('--check')) {
    if (!existsSync(out)) { console.error(`没有产物 ${out}，先不带 --check 运行一次。`); return 1; }
    const have = readFileSync(out, 'utf8');
    if (have !== json) {
      const a = JSON.parse(have);
      console.error(`✗ 产物已过期：与源文档解析结果不一致（源 sha256 ${api.source.sha256.slice(0, 12)}…，产物 ${String(a.source?.sha256).slice(0, 12)}…）。重新运行本脚本生成。`);
      return 1;
    }
    console.log(`✓ 产物与源文档一致：${summary(api)}`);
    return 0;
  }
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, json);
  console.log(`已写入 ${out}\n  ${summary(api)}\n  源：${api.source.id}（抓取于 ${api.source.crawledAt}）`);
  return 0;
}

if (isMain(import.meta.url)) process.exitCode = main();
