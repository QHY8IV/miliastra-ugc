#!/usr/bin/env node
/**
 * check-lua-sim.mjs —— 离线 Lua 模拟器（scripts/lib/lua + scripts/lib/sim）的自检
 *
 *   node scripts/check-lua-sim.mjs            跑全部（离线，不需要任何样本；有样本时多跑几组对照）
 *   node scripts/check-lua-sim.mjs -v         每条用例都打印
 *   node scripts/check-lua-sim.mjs --only 世界   只跑名字里含「世界」的分组
 *
 * 分组：
 *   Lua 核心          Lua 5.3 语义用例表（lib/lua/cases.mjs）：数字 / 字符串 / 模式 / 表 / 元表 / 闭包 / goto / 报错文案 / 语法错误
 *   Lua 内部          值表示、浮点格式化（C 风格平局取偶）、表的边界与键归一化、lint 规则
 *   API 表            client-api.json 与官方原文一致；模拟器对文档里每个字段 / 方法 / 函数都有实现（防「文档有、模拟器悄悄没做」）
 *   世界契约          runtime-contract.md 里每一条真机 / 文档事实在模拟世界里的体现
 *   官方示例校准      官方教程 3.21 的脚本在模拟世界里的行为（我对引擎建模的唯一校准点）
 *   圆圈挑战示例      references/examples/circle-challenge 的整局场景测试
 *   存档样本          （有 references/samples 时）从官方 .gil 导入控件树与布局
 *
 * 退出码：0 全部通过 / 2 有失败。通过 ≠ 真机通过：这些用例锁住的是「模拟器按我的建模工作」，不是「引擎就是这样」。
 * 依赖：Node >= 22，零第三方依赖。
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { LUA_CASES } from './lib/lua/cases.mjs';
import { runLua } from './lib/lua/run.mjs';
import { registerApi } from './lib/sim/selftest-api.mjs';
import { registerContract } from './lib/sim/selftest-contract.mjs';
import { registerInternals } from './lib/sim/selftest-internals.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');

const args = process.argv.slice(2);
const VERBOSE = args.includes('-v') || args.includes('--verbose');
const ONLY = args.includes('--only') ? args[args.indexOf('--only') + 1] : null;

// ─────────────────────────── 迷你测试框架 ───────────────────────────

const suites = [];
let current = null;
const suite = (name, fn) => suites.push({ name, fn });
const test = (name, fn) => current.cases.push({ name, fn });

const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
const eq = (a, b, msg) => { if (j(a) !== j(b)) throw new Error(`${msg ?? '不相等'}：实际 ${j(a)}，期望 ${j(b)}`); };
const ok = (c, msg) => { if (!c) throw new Error(msg ?? '断言失败'); };
const throws = (fn, re, msg) => {
  try { fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${msg ?? ''}报错内容不对：${e.message}`); return; }
  throw new Error(`${msg ?? ''}应当报错但没有`);
};
const T = { test, eq, ok, throws, ROOT };

// ─────────────────────────── 分组：Lua 核心 ───────────────────────────

suite('Lua 核心', () => {
  for (const entry of LUA_CASES) {
    const [name, a, b] = entry;
    const c = typeof a === 'string' ? { code: a, out: b } : a;
    test(name, () => {
      const r = runLua(c.code, c.opts);
      if (c.syntax !== undefined) { eq(r.syntax, c.syntax, '语法错误文案'); return; }
      if (c.err !== undefined) { eq(r.error, c.err, '运行时错误文案'); return; }
      if (c.timeout) { ok(r.timeout !== undefined, '应当触发步数预算（死循环保护）'); return; }
      ok(r.syntax === undefined, `不该有语法错误：${r.syntax}`);
      ok(r.error === undefined, `不该有运行时错误：${r.error}（已输出：${r.out}）`);
      if (c.match) ok(c.match.test(r.out), `输出应匹配 ${c.match}，实际：${r.out}`);
      else eq(r.out, c.out, '输出');
    });
  }
});

registerInternals({ suite, test, eq, ok, throws, ROOT });
registerApi({ suite, test, eq, ok, throws, ROOT });
registerContract({ suite, test, eq, ok, throws });

// ─────────────────────────── 运行 ───────────────────────────

async function main() {
  let pass = 0;
  let fail = 0;
  const t0 = Date.now();
  for (const s of suites) {
    if (ONLY && !s.name.includes(ONLY)) continue;
    current = { name: s.name, cases: [] };
    await s.fn(T);
    let sp = 0;
    const failed = [];
    for (const c of current.cases) {
      try { await c.fn(); sp++; if (VERBOSE) console.log(`  ✓ ${c.name}`); } catch (e) { failed.push([c.name, e]); }
    }
    pass += sp;
    fail += failed.length;
    console.log(`${failed.length ? '✗' : '✓'} ${s.name}：${sp}/${current.cases.length}`);
    for (const [n, e] of failed) console.log(`    ✗ ${n}\n        ${String(e.message).split('\n').join('\n        ')}`);
  }
  console.log(`\n${fail ? `失败 ${fail} 项，通过 ${pass} 项` : `全部 ${pass} 项通过`}（${((Date.now() - t0) / 1000).toFixed(1)} 秒）`);
  return fail ? 2 : 0;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(`自检本身出错：${e.stack}`); process.exitCode = 2; });

