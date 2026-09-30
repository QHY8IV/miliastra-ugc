/**
 * smoke.mjs —— 「冒烟」：不用写任何场景，一条命令把脚本从头到尾跑一遍并出报告
 *
 * 流程：
 *   1. 静态：语法与作用域（lint.mjs，LS 规则）+ 客户端用法（check-lua-ui.mjs，LX 规则）
 *   2. 装载：load → OnInit → OnEnable → OnStart；前几帧画布「未就绪」（默认 3 帧，官方示例专门为此写了重试）
 *   3. 逐帧推进虚拟时间；每隔一会儿自动点一下「注册了 CursorClick 监听」的控件（轮流）
 *   4. 收尾：OnDisable → OnDestroy；检查补间没 Play、OnUpdate 是死代码、监听泄漏……
 *   5. 汇总：未捕获的 Lua 错误（带行号与调用栈）、带证据标签的诊断、日志摘要
 *
 * 通过冒烟 ≠ 真机通过：模拟世界是「我对引擎的建模」（见 references/formats/lua-sim.md 的保真度表）。
 */

import { check as checkLx } from '../../check-lua-ui.mjs';
import { lintLua } from '../lua/lint.mjs';
import { luaChildRefs } from '../ui.mjs';
import { Sim } from './world.mjs';

const SEV_MARK = { error: '✗', warning: '!', info: '·' };
const SEV_LABEL = { error: '错误', warning: '警告', info: '提示' };
const norm = (sev) => (sev === 'warn' ? 'warning' : sev);

/**
 * @param {object} o
 *   source, chunk, tree, templates, modules   脚本与关卡
 *   seconds=10, dt=1/30, clicks='auto'|'off'|数字, clickEvery=0.5, toggle=false, keys=[]
 *   canvasReadyAfterFrames=3, seed, canvas, pairsOrder, tzOffsetMinutes, stepLimit, t0, texts
 */
export function runSmoke(o) {
  const source = o.source;
  const chunk = o.chunk ?? 'main';
  const dt = o.dt ?? 1 / 30;
  const seconds = o.seconds ?? 10;
  const report = {
    file: o.file ?? chunk,
    chunk,
    static: { ls: [], lx: [] },
    run: null,
    counts: { error: 0, warning: 0, info: 0 },
    ok: true,
    syntaxError: null,
  };

  // 1. 静态
  const ls = lintLua(source, { chunk });
  report.static.ls = ls.findings;
  if (ls.syntaxError) {
    report.syntaxError = ls.syntaxError;
  } else {
    report.static.lx = checkLx(source.replace(/\r\n?/g, '\n')).map((f) => ({ sev: f.severity, code: f.rule, line: f.line, msg: f.message, hint: f.hint }));
    if (!o.tree) {
      const { refs } = luaChildRefs(source);
      if (refs.length) {
        const paths = [...new Set(refs.map((r) => r.path.join('/')))];
        report.static.ls.push({
          sev: 'warning', code: 'SIM063', line: refs[0].line,
          msg: `没有提供控件树，但脚本引用了 ${paths.length} 个控件（${paths.slice(0, 6).join('、')}${paths.length > 6 ? '…' : ''}）：它们在模拟里会全部取不到（nil），后面的逻辑基本跑不起来`,
          hint: '用 --gil 关卡.gil 导入真实控件树，或 --tree \'容器节点:container(背景:image,分数:text)\' 手写一棵（scripts/sim-lua.mjs tree 关卡.gil --dsl 可以直接生成）',
        });
      }
    }
  }

  // 2~4. 运行
  if (!report.syntaxError) {
    const sim = new Sim({
      tree: o.tree,
      templates: o.templates,
      modules: o.modules,
      chunkName: chunk,
      seed: o.seed,
      canvas: o.canvas,
      canvasReadyAfterFrames: o.canvasReadyAfterFrames ?? 3,
      pairsOrder: o.pairsOrder,
      tzOffsetMinutes: o.tzOffsetMinutes,
      stepLimit: o.stepLimit,
      t0: o.t0,
      texts: o.texts,
      dt,
    });
    const clicks = { sent: 0, delivered: 0, dropped: 0, targets: new Set() };
    sim.load(source, { chunk });
    sim.start();

    const frames = Math.max(1, Math.round(seconds / dt));
    const clickEvery = Math.max(1, Math.round((o.clickEvery ?? 0.5) / dt));
    const maxClicks = o.clicks === 'off' ? 0 : typeof o.clicks === 'number' ? o.clicks : Infinity;
    let rr = 0;
    for (let i = 1; i <= frames; i++) {
      sim.frame(dt);
      if (o.toggle && i === Math.floor(frames / 2)) {           // 中途关掉再打开所属控件：OnDisable / OnEnable 会不会重复注册监听、重复初始化
        sim.root.setActive(false);
        sim.frame(dt);
        sim.root.setActive(true);
      }
      if (i % clickEvery === 0 && clicks.sent < maxClicks) {
        const cands = sim.all().filter((c) => c.alive && c.cursorListeners.get('CursorClick')?.length);
        if (cands.length) {
          const c = cands[rr++ % cands.length];
          const r = sim.click(c);
          clicks.sent++;
          clicks.targets.add(c.nameStr);
          if (r.delivered) clicks.delivered++; else clicks.dropped++;
        }
      }
      if (o.keys?.length && i % clickEvery === 0) for (const k of o.keys) sim.pressKey(k);
    }
    if (clicks.sent === 0 && o.clicks !== 'off') {
      sim.diag('info', 'SIM062', '整个运行期间没有任何控件注册 CursorClick 监听：脚本里没有可点击的东西，或者初始化根本没走到注册那一步（看上面的错误 / 日志）', '模型');
    }
    sim.destroy();
    sim.finish();

    report.run = {
      frames: sim.frames,
      seconds: sim.t,
      updates: sim.stats.updates,
      errors: sim.errors,
      diags: sim.diags,
      logs: sim.logs,
      signals: sim.sentSignals,
      clicks: { sent: clicks.sent, delivered: clicks.delivered, dropped: clicks.dropped, targets: [...clicks.targets] },
      tree: sim.snapshot(),
      canvas: sim.opts.canvas,
    };
  }

  // 5. 计数
  const tally = (sev) => { report.counts[norm(sev)]++; };
  for (const f of report.static.ls) tally(f.sev);
  for (const f of report.static.lx) tally(f.sev);
  if (report.run) {
    for (const e of report.run.errors) tally('error');
    for (const d of report.run.diags) tally(d.sev);
  }
  report.ok = report.counts.error === 0;
  return report;
}

// ─────────────────────────── 文本报告 ───────────────────────────

function lineOf(srcLines, n) { return (srcLines[n - 1] ?? '').trim().slice(0, 100); }

export function formatReport(rep, { source = '', maxLogs = 25, verbose = false } = {}) {
  const out = [];
  const src = source.replace(/\r\n?/g, '\n').split('\n');
  const push = (s = '') => out.push(s);
  push(`冒烟：${rep.file}`);
  push('─'.repeat(64));

  const printStatic = (title, list) => {
    if (!list.length) return;
    push(`\n【${title}】`);
    const order = { error: 0, warning: 1, info: 2 };
    for (const f of [...list].sort((a, b) => a.line - b.line || order[norm(a.sev)] - order[norm(b.sev)])) {
      const sev = norm(f.sev);
      push(`${SEV_MARK[sev]} [${SEV_LABEL[sev]} ${f.code}] 第 ${f.line} 行  ${f.msg}`);
      if (f.hint) push(`    → ${f.hint}`);
      const s = lineOf(src, f.line);
      if (s && verbose) push(`    源码：${s}`);
    }
  };
  printStatic('静态检查 · 语法与作用域 LS', rep.static.ls);
  printStatic('静态检查 · 客户端用法 LX', rep.static.lx);

  if (rep.syntaxError) {
    push('\n语法错误，脚本无法加载，没有继续运行。');
  } else if (rep.run) {
    const r = rep.run;
    push(`\n【运行】${r.frames} 帧 / ${r.seconds.toFixed(1)} 秒（画布 ${r.canvas[0]}×${r.canvas[1]}）；OnUpdate 调用 ${r.updates} 次`
      + `；自动点击 ${r.clicks.sent} 次（送达 ${r.clicks.delivered}，未送达 ${r.clicks.dropped}${r.clicks.targets.length ? `；目标：${r.clicks.targets.join('、')}` : ''}）`
      + `；发出服务端信号 ${r.signals.length} 个`);

    if (r.errors.length) {
      push('\n【运行时错误】这些是 Lua 抛出、脚本没接住的错误（真机同样只是记一条日志，该回调的后半段不再执行）');
      for (const e of r.errors) {
        push(`✗ [${e.timeout ? '死循环' : '错误'}] 在 ${e.label}${e.count > 1 ? ` ×${e.count}` : ''}：${e.message}`);
        if (e.traceback) push(`    ${e.traceback.split('\n').join('\n    ')}`);
      }
    }
    const diags = [...r.diags].sort((a, b) => ({ error: 0, warn: 1, info: 2 })[a.sev] - ({ error: 0, warn: 1, info: 2 })[b.sev]);
    if (diags.length) {
      push('\n【运行时诊断】方括号里是证据等级：真机 / 文档 / 官方示例 = 有出处；模型 / 未确认 = 模拟器对引擎的猜测');
      for (const d of diags) {
        const sev = norm(d.sev);
        const where = d.line ? `第 ${d.line} 行` : d.label || '';
        push(`${SEV_MARK[sev]} [${SEV_LABEL[sev]} ${d.code}｜${d.evidence}]${where ? ` ${where}` : ''}${d.count > 1 ? ` ×${d.count}` : ''}  ${d.msg}`);
      }
    }
    if (r.logs.length) {
      const shown = r.logs.slice(0, maxLogs);
      push(`\n【日志】共 ${r.logs.length} 行${r.logs.length > maxLogs ? `，只显示前 ${maxLogs} 行（--echo-logs 看全部）` : ''}`);
      for (const l of shown) push(`  ${l.lvl === 'error' ? '[错误级] ' : ''}${String(l.text).split('\n').join('\n  ')}`);
    }
    if (verbose) { push('\n【结束时的控件树】'); push(r.tree); }
  }

  push(`\n${'─'.repeat(64)}`);
  push(`合计：${rep.counts.error} 错误 / ${rep.counts.warning} 警告 / ${rep.counts.info} 提示`);
  push(rep.ok
    ? '无 error。离线模拟通过 ≠ 真机通过：模拟世界是对引擎的建模，只在官方示例上校准过；请导入编辑器验证，并把结果回填 references/formats/verification-ledger.md。'
    : '有 error：先修这些，再谈真机。');
  return out.join('\n');
}
