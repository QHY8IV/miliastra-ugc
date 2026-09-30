#!/usr/bin/env node
/**
 * sim-lua.mjs —— 千星奇域客户端 Lua 的离线模拟器命令行
 *
 *   node scripts/sim-lua.mjs lint  脚本.lua                  语法 / 作用域 / 标准库 / 数字类型陷阱（LS）+ 客户端用法（LX）
 *   node scripts/sim-lua.mjs smoke 脚本.lua --gil 关卡.gil   冒烟：lint + 整局运行 + 自动点击 + 诊断报告（最常用）
 *   node scripts/sim-lua.mjs smoke --gil 关卡.gil             不给 .lua 就用 .gil 里嵌着的脚本（验证的正是将要导入的东西）
 *   node scripts/sim-lua.mjs run   脚本.lua --tree '…'        只跑一遍，实时打印日志
 *   node scripts/sim-lua.mjs test  脚本.lua --gil x.gil --scenario 场景.mjs    跑你写的场景测试（断言游戏规则）
 *   node scripts/sim-lua.mjs tree  关卡.gil [--dsl]           看 .gil 里的控件树（含布局）；--dsl 输出可直接给 --tree 用的描述
 *   node scripts/sim-lua.mjs eval  'print(7 // 2, 7 / 2)'     在 Lua 5.3 语义下快速验证一小段代码
 *
 * 控件树来源（三选一，smoke / run / test 都认）：
 *   --gil 关卡.gil [--script 名字] [--owner 控件名]    从存档导入（树 + 布局）
 *   --tree '容器节点:container(背景:image,分数:text@0,350,218x68)'   手写（别名 container/image/text/area/button/…）
 *   --tree-file 文件
 * 常用选项：--seconds 10  --dt 0.0333  --seed N  --canvas 1920x1080  --canvas-ready-frames 3
 *           --module 名字=文件.lua（可重复，给 require 用）  --clicks auto|off|N  --toggle（中途关再开所属控件）
 *           --pairs-order reverse（打乱 pairs 的哈希部分顺序，暴露依赖遍历顺序的脚本）  --json  --echo-logs  --verbose
 *
 * 退出码：0 无 error / 1 有 error / 2 用法错误。
 * 通过 ≠ 真机通过：模拟世界是对引擎的建模，只在官方示例上校准过。边界见 references/formats/lua-sim.md。
 * 依赖：Node >= 22，零第三方依赖。
 */

import { existsSync, readFileSync } from 'node:fs';
import { basename, resolve as pathResolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { check as checkLx } from './check-lua-ui.mjs';
import { lintLua } from './lib/lua/lint.mjs';
import { LuaSyntaxError } from './lib/lua/value.mjs';
import { Sim } from './lib/sim/world.mjs';
import { formatSpec, normalizeSpec, specFromGil, specToDsl } from './lib/sim/level.mjs';
import { formatReport, runSmoke } from './lib/sim/smoke.mjs';
import { runScenario } from './lib/sim/scenario.mjs';

const BOOL = new Set(['json', 'toggle', 'echo-logs', 'no-lx', 'help', 'h', 'verbose', 'dsl']);
const MULTI = new Set(['module']);
const SHORT = { h: 'help' };

class UsageError extends Error {}

function parseArgs(argv) {
  const pos = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-') { pos.push(a); continue; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      const key = a.startsWith('--') ? a.slice(2) : SHORT[a.slice(1)] || a.slice(1);
      if (BOOL.has(key)) flags[key] = true;
      else if (MULTI.has(key)) (flags[key] ??= []).push(argv[++i]);
      else {
        if (i + 1 >= argv.length) throw new UsageError(`选项 --${key} 缺少值`);
        flags[key] = argv[++i];
      }
    } else pos.push(a);
  }
  return { pos, flags };
}

const HELP = `sim-lua.mjs —— 千星奇域客户端 Lua 的离线模拟器

  lint  <脚本.lua|->                          语法 / 作用域 / 标准库 / 数字类型陷阱（LS）+ 客户端用法（LX）
  smoke [脚本.lua|-] [--gil 关卡.gil | --tree …]   冒烟：lint + 整局运行 + 自动点击 + 诊断报告（最常用）
  run   [脚本.lua|-] [--gil | --tree …]            只跑一遍，实时打印日志
  test  [脚本.lua|-] [--gil | --tree …] --scenario 场景.mjs    跑场景测试
  tree  <关卡.gil> [--dsl]                      看 .gil 的控件树（含布局）；--dsl 输出 --tree 可直接用的描述
  eval  <Lua 代码|->                            在 Lua 5.3 语义下验证一小段代码

控件树：--gil 关卡.gil [--script 名字] [--owner 控件名] | --tree '容器节点:container(…)' | --tree-file 文件
常用：--seconds 10 --dt 0.0333 --seed N --canvas 1920x1080 --canvas-ready-frames 3
      --module 名字=文件.lua（可重复）--clicks auto|off|N --toggle --pairs-order reverse
      --json --echo-logs --verbose --no-lx

通过离线模拟 ≠ 真机通过。保真度与边界：references/formats/lua-sim.md`;

// ─────────────────────────── 公共 ───────────────────────────

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);

function readStdinSync() {
  return readFileSync(0, 'utf8');
}

function num(flags, key, def) {
  if (flags[key] === undefined) return def;
  const v = Number(flags[key]);
  if (!Number.isFinite(v)) throw new UsageError(`--${key} 需要数字，收到「${flags[key]}」`);
  return v;
}

function canvasOf(flags) {
  if (!flags.canvas) return undefined;
  const m = /^(\d+)\s*[x×*]\s*(\d+)$/.exec(flags.canvas);
  if (!m) throw new UsageError('--canvas 写成 1920x1080');
  return [Number(m[1]), Number(m[2])];
}

function modulesOf(flags) {
  const out = {};
  for (const spec of flags.module ?? []) {
    const i = spec.indexOf('=');
    if (i < 1) throw new UsageError(`--module 写成 名字=文件.lua，收到「${spec}」`);
    const name = spec.slice(0, i);
    const file = spec.slice(i + 1);
    if (!existsSync(file)) throw new UsageError(`--module ${name}：找不到文件 ${file}`);
    out[name] = stripBom(readFileSync(file, 'utf8'));
  }
  return out;
}

/** 关卡：--gil / --tree / --tree-file */
function levelOf(flags) {
  if (flags.gil) {
    if (!existsSync(flags.gil)) throw new UsageError(`找不到 ${flags.gil}`);
    const g = specFromGil(flags.gil, { script: flags.script, owner: flags.owner });
    return { tree: g.spec, templates: g.templates, gilScript: g.script, notes: g.notes };
  }
  const checked = (dsl) => {
    try { normalizeSpec(dsl); } catch (e) { throw new UsageError(e.message); }       // 树描述写错是用法错误，先于一切报告
    return { tree: dsl };
  };
  if (flags.tree) return checked(flags.tree);
  if (flags['tree-file']) {
    if (!existsSync(flags['tree-file'])) throw new UsageError(`找不到 ${flags['tree-file']}`);
    return checked(readFileSync(flags['tree-file'], 'utf8'));
  }
  return {};
}

/** Lua 源码：位置参数（文件 / -）或 .gil 里嵌着的脚本 */
function sourceOf(pos, level) {
  const a = pos[0];
  if (a === '-') return { source: stripBom(readStdinSync()), file: '(标准输入)', chunk: 'stdin' };
  if (a) {
    if (!existsSync(a)) throw new UsageError(`找不到 ${a}`);
    return { source: stripBom(readFileSync(a, 'utf8')), file: a, chunk: basename(a).replace(/\.lua$/, '') };
  }
  if (level.gilScript) {
    const s = level.gilScript;
    return { source: stripBom(s.source), file: `${level.gilPath ?? '.gil'} 内嵌的脚本「${s.name}」`, chunk: (s.fileName ?? s.name).replace(/\.lua$/, '') };
  }
  throw new UsageError('没有给出脚本：传一个 .lua 文件，或用 --gil 使用存档里嵌着的脚本');
}

function simOptions(flags, level, extra = {}) {
  return {
    tree: level.tree,
    templates: level.templates,
    modules: modulesOf(flags),
    canvas: canvasOf(flags),
    seed: flags.seed !== undefined ? num(flags, 'seed') : undefined,
    canvasReadyAfterFrames: flags['canvas-ready-frames'] !== undefined ? num(flags, 'canvas-ready-frames') : undefined,
    pairsOrder: flags['pairs-order'],
    tzOffsetMinutes: flags.tz !== undefined ? num(flags, 'tz') : undefined,
    stepLimit: flags['step-limit'] !== undefined ? num(flags, 'step-limit') : undefined,
    t0: flags.t0 !== undefined ? num(flags, 't0') : undefined,
    ...extra,
  };
}

// ─────────────────────────── 命令 ───────────────────────────

function cmdLint(pos, flags) {
  const { source, file } = sourceOf(pos, {});
  const chunk = basename(file).replace(/\.lua$/, '');
  const ls = lintLua(source, { chunk });
  const lx = !ls.syntaxError && !flags['no-lx'] ? checkLx(source.replace(/\r\n?/g, '\n')).map((f) => ({ sev: f.severity, code: f.rule, line: f.line, msg: f.message, hint: f.hint })) : [];
  const all = [...ls.findings, ...lx];
  if (flags.json) {
    console.log(JSON.stringify({ file, findings: all }, null, 2));
  } else {
    const mark = { error: '✗', warning: '!', info: '·' };
    const label = { error: '错误', warning: '警告', info: '提示' };
    console.log(`检查：${file}\n${'─'.repeat(64)}`);
    const src = source.replace(/\r\n?/g, '\n').split('\n');
    const order = { error: 0, warning: 1, info: 2 };
    for (const f of [...all].sort((a, b) => a.line - b.line || order[a.sev] - order[b.sev])) {
      console.log(`${mark[f.sev]} [${label[f.sev]} ${f.code}] 第 ${f.line} 行  ${f.msg}`);
      if (f.hint) console.log(`    → ${f.hint}`);
      if (flags.verbose) console.log(`    源码：${(src[f.line - 1] ?? '').trim().slice(0, 100)}`);
    }
    const c = { error: 0, warning: 0, info: 0 };
    for (const f of all) c[f.sev]++;
    console.log(`${all.length ? '─'.repeat(64) : '未发现问题。'}\n合计：${c.error} 错误 / ${c.warning} 警告 / ${c.info} 提示`);
    console.log('静态检查通过 ≠ 真机通过。要看运行时行为用 smoke。');
  }
  return all.some((f) => f.sev === 'error') ? 1 : 0;
}

function cmdSmoke(pos, flags) {
  const level = levelOf(flags);
  level.gilPath = flags.gil;
  const { source, file, chunk } = sourceOf(pos, level);
  const clicks = flags.clicks === undefined || flags.clicks === 'auto' ? 'auto' : flags.clicks === 'off' ? 'off' : num(flags, 'clicks');
  const rep = runSmoke({
    ...simOptions(flags, level),
    source, file, chunk,
    seconds: num(flags, 'seconds', 10),
    dt: num(flags, 'dt', 1 / 30),
    clicks,
    toggle: !!flags.toggle,
    keys: flags.keys ? flags.keys.split(',') : [],
    canvasReadyAfterFrames: flags['canvas-ready-frames'] !== undefined ? num(flags, 'canvas-ready-frames') : 3,
  });
  if (level.notes?.length) for (const n of level.notes) rep.static.ls.push({ sev: 'info', code: 'SIM064', line: 1, msg: `关卡导入：${n}` });
  if (flags.json) {
    const slim = { ...rep, run: rep.run && { ...rep.run, logs: rep.run.logs.map((l) => ({ lvl: l.lvl, text: l.text, t: l.t })) } };
    console.log(JSON.stringify(slim, null, 2));
  } else {
    console.log(formatReport(rep, { source, maxLogs: flags['echo-logs'] ? Infinity : 25, verbose: !!flags.verbose }));
  }
  return rep.ok ? 0 : 1;
}

function cmdRun(pos, flags) {
  const level = levelOf(flags);
  level.gilPath = flags.gil;
  const { source, file, chunk } = sourceOf(pos, level);
  const lines = [];
  const sim = new Sim({
    ...simOptions(flags, level),
    chunkName: chunk,
    canvasReadyAfterFrames: flags['canvas-ready-frames'] !== undefined ? num(flags, 'canvas-ready-frames') : 3,
    onLog: (lvl, text) => { lines.push(text); console.log(`${lvl === 'error' ? '[错误级] ' : ''}${text}`); },
  });
  console.log(`运行：${file}`);
  sim.load(source, { chunk });
  sim.start();
  sim.advance(num(flags, 'seconds', 2), num(flags, 'dt', 1 / 30));
  if (flags.clicks && flags.clicks !== 'off') {
    const n = flags.clicks === 'auto' ? 3 : num(flags, 'clicks');
    for (let i = 0; i < n; i++) {
      const c = sim.all().find((x) => x.alive && x.cursorListeners.get('CursorClick')?.length);
      if (c) sim.click(c);
    }
    sim.advance(0.5);
  }
  sim.destroy();
  sim.finish();
  for (const e of sim.errors) console.log(`✗ 错误 [${e.label}] ${e.message}`);
  for (const d of sim.diags) if (d.sev !== 'info' || flags.verbose) console.log(`${d.sev === 'error' ? '✗' : d.sev === 'warn' ? '!' : '·'} ${d.code}｜${d.evidence} ${d.line ? `第 ${d.line} 行 ` : ''}${d.msg}`);
  if (flags.verbose) console.log(`\n${sim.snapshot()}`);
  return sim.problems().length ? 1 : 0;
}

async function cmdTest(pos, flags) {
  if (!flags.scenario) throw new UsageError('test 需要 --scenario 场景.mjs（导出 default async function (t)；写法见 references/formats/lua-sim.md）');
  const level = levelOf(flags);
  level.gilPath = flags.gil;
  const { source, chunk } = sourceOf(pos, level);
  const scenarioPath = pathResolve(flags.scenario);
  if (!existsSync(scenarioPath)) throw new UsageError(`找不到场景文件 ${flags.scenario}`);
  const mod = await import(pathToFileURL(scenarioPath).href);
  if (typeof mod.default !== 'function') throw new UsageError('场景文件要 export default async function (t) { … }');
  const { pass, fail } = await runScenario(mod, { source, chunk, simOptions: simOptions(flags, level) });
  console.log(`\n场景测试：${pass} 项通过，${fail} 项失败`);
  return fail ? 1 : 0;
}

function cmdTree(pos, flags) {
  if (!pos[0]) throw new UsageError('tree 需要一个 .gil 文件');
  if (!existsSync(pos[0])) throw new UsageError(`找不到 ${pos[0]}`);
  const g = specFromGil(pos[0], { script: flags.script, owner: flags.owner });
  if (flags.dsl) { console.log(specToDsl(g.spec)); return 0; }
  console.log(`脚本所属控件的子树（布局为逆向推断，见 references/formats/lua-sim.md）：\n${formatSpec(g.spec)}`);
  if (g.script) console.log(`\n脚本：「${g.script.name}」(${g.script.fileName}，${Buffer.byteLength(g.script.source)} 字节)`);
  for (const n of g.notes) console.log(`· ${n}`);
  console.log(`\n可复制给 --tree 的描述：\n${specToDsl(g.spec)}`);
  return 0;
}

function cmdEval(pos) {
  const code = pos[0] === '-' ? readStdinSync() : pos.join(' ');
  if (!code.trim()) throw new UsageError('eval 需要一段 Lua 代码');
  const sim = new Sim({});
  try {
    sim.load(code, { chunk: 'eval' });
  } catch (e) {
    if (e instanceof LuaSyntaxError) { console.log(`✗ ${e.message}`); return 1; }
    throw e;
  }
  for (const l of sim.logs) console.log(l.lvl === 'error' ? `[错误级] ${l.text}` : l.text);
  for (const e of sim.errors) console.log(`✗ ${e.message}`);
  return sim.errors.length ? 1 : 0;
}

// ─────────────────────────── 入口 ───────────────────────────

async function main() {
  const { pos, flags } = parseArgs(process.argv.slice(2));
  const cmd = pos.shift();
  if (!cmd || flags.help) { console.log(HELP); return cmd || flags.help ? 0 : 2; }
  switch (cmd) {
    case 'lint': return cmdLint(pos, flags);
    case 'smoke': return cmdSmoke(pos, flags);
    case 'run': return cmdRun(pos, flags);
    case 'test': return cmdTest(pos, flags);
    case 'tree': return cmdTree(pos, flags);
    case 'eval': return cmdEval(pos);
    default: throw new UsageError(`不认识的命令「${cmd}」（lint / smoke / run / test / tree / eval）`);
  }
}

main().then((c) => { process.exitCode = c; }, (e) => {
  if (e instanceof UsageError) { console.error(`用法错误：${e.message}\n（node scripts/sim-lua.mjs --help）`); process.exitCode = 2; return; }
  if (e instanceof LuaSyntaxError) { console.error(`脚本有语法错误：${e.message}`); process.exitCode = 1; return; }
  console.error(`失败：${e.message}`);
  if (process.env.SIM_DEBUG) console.error(e.stack);
  process.exitCode = 2;
});
