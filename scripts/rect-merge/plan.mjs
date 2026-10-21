#!/usr/bin/env node
/**
 * plan.mjs —— 容量与建立路线的决策器（本技能自研，2026-10-17）
 *
 * 解决的问题：同一张图有两条上传路线，各自的硬上限完全不同，选错就是白做一遍。
 *
 *   路线 A  预建控件写进关卡 .gil（本技能 to-gil.mjs 那条）
 *           · 运行时**不建控件**：开局只填颜色，没有看门狗风险
 *           · 硬上限 = 存档体积（20 MiB）→ 约 4.2 万个控件
 *   路线 B  运行时建控件（数据串 + InstantiateClientUIControl）
 *           · 块数据只占几万字，不受存档上限约束
 *           · 硬上限 = **单次回调约 22 s 被引擎静默截断**（不报错，画面缺一块）
 *           · 建控件耗时随块数**超线性**增长，所以"块数少一半"远不止快一半
 *
 * 本文件的常数分两类，混在一起会误导人：
 *   【实测·本技能真机】0.223 ms/控件、5 万正常 / 61,440 崩溃、3.1 万块 ≈ 15 MiB
 *   【第三方实测】二次项 3.75e-6·N²、22 s 看门狗、可见 15~18 µs/控件/帧、隐藏约 1.7 µs
 *                —— 来源 wwh177/miliastra-image-algorithm，本技能未复验
 *
 * 用法：
 *   node plan.mjs --blocks 40000
 *   node plan.mjs --blocks 31871 --bytes-per-control 496 --fps 60
 *   node plan.mjs --blocks 45000 --json
 *   node plan.mjs --selftest
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const CONST = {
  MS_PER_CONTROL: 0.223,     // 【实测·真机】本技能台账：新建一个控件约 0.223 ms
  QUAD_MS: 3.75e-6,          // 【第三方实测】建控件耗时的二次项
  WATCHDOG_MS: 22000,        // 【第三方实测】单次回调约 22 s 被静默截断（早期文档写 20 s）
  SINGLE_SAFE_MS: 10000,     // 本技能建议：单次回调只用到看门狗的 ~45%，留余量
  VISIBLE_US: 18,            // 【第三方实测】可见控件每帧 15~18 µs，取上界
  HIDDEN_US: 1.7,            // 【第三方实测】父级隐藏时约 1.7 µs
  GIL_CAP_MIB: 20,           // 【实测·真机】脚本版 .gil 导入上限（3.1 万块 ≈ 15 MiB 通过）
  BYTES_PER_CONTROL: 496,    // 【实测反推】脚本版 .gil 每控件字节数（含默认布局）
  CRASH_BLOCKS: 61440,       // 【实测·真机】61,440 个控件会让引擎销毁脚本
  FRAMED_OVERHEAD: 1.34,     // 【第三方实测】分帧建控件比一次建完慢约 34%
};

const MIB = 1024 * 1024;

/** 运行时建控件耗时（毫秒）。线性项是我们自己的实测，二次项是第三方的。 */
export function buildMs(blocks) {
  const n = Math.max(0, blocks);
  return n * CONST.MS_PER_CONTROL + CONST.QUAD_MS * n * n;
}

/** 给一个块数，算出两条路线各自能不能走、该怎么走。 */
export function plan(opts = {}) {
  const blocks = Math.max(0, Math.floor(opts.blocks ?? 0));
  const bytesPerControl = opts.bytesPerControl ?? CONST.BYTES_PER_CONTROL;
  const capMib = opts.capMib ?? CONST.GIL_CAP_MIB;
  const watchdogMs = opts.watchdogMs ?? CONST.WATCHDOG_MS;
  const safeMs = opts.safeMs ?? CONST.SINGLE_SAFE_MS;
  const fps = opts.fps ?? 60;

  const bytes = blocks * bytesPerControl;
  const mib = bytes / MIB;
  const capBytes = capMib * MIB;
  const gilFits = bytes <= capBytes;
  const capBlocks = Math.floor(capBytes / bytesPerControl);

  const ms = buildMs(blocks);
  const singleOk = ms <= safeMs;
  const overWatchdog = ms > watchdogMs;

  // 分帧：每帧预算取 12 ms（与 render.lua 的 FRAME_BUDGET 默认一致）
  const budgetMs = opts.budgetMs ?? 12;
  const frames = ms > 0 ? Math.ceil(ms / budgetMs) : 0;
  const framedSec = (ms * CONST.FRAMED_OVERHEAD) / 1000;

  const route = gilFits ? 'gil' : 'runtime';
  const notes = [];
  if (!gilFits) {
    notes.push(`存档需要 ${mib.toFixed(1)} MiB > ${capMib} MiB：走不了预建路线，只能运行时建（约 ${blocks - capBlocks} 个控件放不下）`);
  }
  if (overWatchdog) {
    notes.push(`${(ms / 1000).toFixed(1)} s > 看门狗 ${(watchdogMs / 1000).toFixed(0)} s：**一次建完一定会被截断**（画面缺块、不报错），必须分帧`);
  } else if (!singleOk) {
    notes.push(`${(ms / 1000).toFixed(1)} s > 建议上限 ${(safeMs / 1000).toFixed(0)} s：一次建完会长时间定格，建议分帧（总时长约 ${framedSec.toFixed(1)} s）`);
  }
  if (blocks > CONST.CRASH_BLOCKS) {
    notes.push(`${blocks} 个控件超过真机崩溃阈值 ${CONST.CRASH_BLOCKS}（实测），无论哪条路线都别做`);
  }
  const visibleFrameMs = (blocks * CONST.VISIBLE_US) / 1000;
  const hiddenFrameMs = (blocks * CONST.HIDDEN_US) / 1000;
  const fpsVisible = visibleFrameMs > 0 ? 1000 / visibleFrameMs : Infinity;

  let verdict;
  if (blocks > CONST.CRASH_BLOCKS) verdict = '✗ 超真机崩溃阈值';
  else if (route === 'gil') verdict = '✓ 预建（.gil）';
  else if (singleOk) verdict = '✓ 运行时一次建完';
  else verdict = '⚠ 运行时必须分帧';

  return {
    blocks, bytes, mib, capBytes, capBlocks, gilFits,
    ms, singleOk, overWatchdog, route, verdict, notes,
    budgetMs, frames, framedSec,
    visibleFrameMs, hiddenFrameMs, fpsVisible,
    fps,
  };
}

function fmt(p) {
  const L = [];
  L.push('='.repeat(76));
  L.push('容量与建立路线决策');
  L.push('='.repeat(76));
  L.push(`  控件数            : ${p.blocks}`);
  L.push(`  路线 A · .gil 预建: ${p.mib.toFixed(2)} MiB / 上限 20 MiB（最多约 ${p.capBlocks} 个）→ ${p.gilFits ? '可用' : '放不下'}`);
  L.push(`  路线 B · 运行时建 : 预估 ${(p.ms / 1000).toFixed(2)} s = ${(p.blocks * CONST.MS_PER_CONTROL / 1000).toFixed(2)} s（线性，实测 0.223 ms/个） + ${(CONST.QUAD_MS * p.blocks * p.blocks / 1000).toFixed(2)} s（二次项，第三方）`);
  L.push(`                      一次建完 ${p.singleOk ? '可接受' : '不建议'}（建议 ≤ ${(CONST.SINGLE_SAFE_MS / 1000).toFixed(0)} s，看门狗 ${(CONST.WATCHDOG_MS / 1000).toFixed(0)} s）`);
  L.push(`                      分帧 ${p.frames} 帧 ≈ ${(p.frames / p.fps).toFixed(1)} s（每帧 ${p.budgetMs} ms 预算；含 34% 分帧开销 ≈ ${p.framedSec.toFixed(1)} s）`);
  L.push(`  稳态帧开销        : 可见 ${p.visibleFrameMs.toFixed(1)} ms/帧（≈ ${p.fpsVisible.toFixed(1)} fps）／ 隐藏 ${p.hiddenFrameMs.toFixed(1)} ms/帧`);
  L.push('');
  L.push(`  判定              : ${p.verdict}`);
  if (p.notes.length) {
    L.push('');
    for (const n of p.notes) L.push('  ⚠ ' + n);
  }
  L.push('='.repeat(76));
  return L.join('\n');
}

function selftest() {
  let ok = true;
  const chk = (name, pass, detail) => {
    console.log(`  ${pass ? '✓' : '✗'} ${name}${detail ? `（${detail}）` : ''}`);
    ok = ok && pass;
  };
  console.log('== plan.mjs 自检（常数与判定，不连真机）');

  chk('0 个控件 = 0 ms', buildMs(0) === 0);
  chk('buildMs 单调递增', buildMs(10000) < buildMs(20000) && buildMs(20000) < buildMs(40000));
  chk('buildMs(20000) ≈ 5.96 s', Math.abs(buildMs(20000) - 5960) < 1, `${buildMs(20000).toFixed(0)} ms`);

  const a = plan({ blocks: 31871 });
  chk('3.1871 万块：.gil 放得下', a.gilFits === true, `${a.mib.toFixed(2)} MiB`);
  chk('3.1871 万块：不需要运行时（预建优先）', a.route === 'gil');
  chk('3.1871 万块：可见帧开销 ≈ 574 ms（≈1.7 fps）', Math.abs(a.visibleFrameMs - 573.7) < 1, `${a.visibleFrameMs.toFixed(1)} ms`);

  const b = plan({ blocks: 20000 });
  chk('2 万块：一次建完可接受', b.singleOk === true && b.overWatchdog === false, `${(b.ms / 1000).toFixed(2)} s`);
  chk('2 万块：.gil 放得下', b.gilFits === true, `${b.mib.toFixed(2)} MiB`);

  const c = plan({ blocks: 45000 });
  chk('4.5 万块：.gil 放不下', c.gilFits === false, `${c.mib.toFixed(2)} MiB`);
  chk('4.5 万块：必须运行时', c.route === 'runtime');
  chk('4.5 万块：一次建完不建议', c.singleOk === false, `${(c.ms / 1000).toFixed(2)} s`);
  chk('4.5 万块：没超看门狗（还能靠分帧救）', c.overWatchdog === false);

  const d = plan({ blocks: 100000 });
  chk('10 万块：超看门狗（一次建完必被截断）', d.overWatchdog === true, `${(d.ms / 1000).toFixed(1)} s`);
  chk('10 万块：判定为超真机崩溃阈值', d.verdict.startsWith('✗'), d.verdict);
  chk('10 万块：仍给出分帧帧数（作参考）', d.frames > 0, `${d.frames} 帧`);

  chk('存档上限边界：42281 个放得下', plan({ blocks: 42281 }).gilFits === true);
  chk('存档上限边界：42282 个放不下', plan({ blocks: 42282 }).gilFits === false);

  const cap = plan({ blocks: 70000 });
  chk('超崩溃阈值被点名', cap.verdict.startsWith('✗') && cap.notes.some((s) => s.includes('61440')));

  // 自定义上限：只给 9 MiB 时，2 万块（9.46 MiB）就放不下
  chk('--cap-mib 可覆盖', plan({ blocks: 20000, capMib: 9 }).gilFits === false);

  console.log(ok ? '\n自检全部通过' : '\n有失败项');
  return ok;
}

const isMain = (() => {
  try { return fileURLToPath(import.meta.url).toLowerCase() === fs.realpathSync(process.argv[1]).toLowerCase(); }
  catch { return false; }
})();

if (isMain) {
  const argv = process.argv.slice(2);
  const num = (flag, dflt) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? Number(argv[i + 1]) : dflt;
  };
  if (argv.includes('--selftest')) {
    process.exit(selftest() ? 0 : 1);
  }
  if (argv.includes('--help') || argv.length === 0) {
    console.log('用法：node plan.mjs --blocks <控件数> [--bytes-per-control 496] [--cap-mib 20]\n'
      + '                [--watchdog-ms 22000] [--safe-ms 10000] [--budget-ms 12] [--fps 60]\n'
      + '                [--json] [--selftest]');
    process.exit(argv.length === 0 ? 1 : 0);
  }
  const blocks = num('--blocks', NaN);
  if (!Number.isFinite(blocks) || blocks < 0) {
    console.error('需要 --blocks <控件数>（非负整数）');
    process.exit(1);
  }
  const p = plan({
    blocks,
    bytesPerControl: num('--bytes-per-control', CONST.BYTES_PER_CONTROL),
    capMib: num('--cap-mib', CONST.GIL_CAP_MIB),
    watchdogMs: num('--watchdog-ms', CONST.WATCHDOG_MS),
    safeMs: num('--safe-ms', CONST.SINGLE_SAFE_MS),
    budgetMs: num('--budget-ms', 12),
    fps: num('--fps', 60),
  });
  console.log(argv.includes('--json') ? JSON.stringify(p, null, 2) : fmt(p));
}
