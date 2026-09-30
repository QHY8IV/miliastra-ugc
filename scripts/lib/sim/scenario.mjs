/**
 * scenario.mjs —— 场景测试的「测试台」：给你写的场景脚本一个 t 对象
 *
 * 场景脚本是一个 ES 模块，默认导出 async function (t)：
 *
 *   export default async function (t) {
 *     t.section('开局');
 *     const sim = t.fresh();                       // 新开一局：按命令行 / 调用方给的关卡与选项建 Sim、装载脚本、start、空转 12 帧
 *     sim.click('圆圈点击区域');
 *     t.eq(sim.ctrl('分数文本').read('text'), '得分：0｜剩余：30 秒', '开局 HUD');
 *     t.noProblems(sim, '开局');
 *   }
 *
 * t 上有：
 *   section(标题)  ok(条件, 说明)  eq(实际, 期望, 说明)       打印 ✓ / ✗ 并计数
 *   fresh(额外选项?, 空转帧数=12)     新开一局（装载脚本并 start，再以 0.1 秒一帧空转，过掉画布未就绪的重试）
 *   newSim(额外选项?)                 只建 Sim，不装载（要自己控制 load / start 的时机时用）
 *   noProblems(sim, 标签)             断言没有 Lua 运行时错误、没有错误级日志 / GAME FAULT
 *   Sim  source  chunk  float         类与原料
 * Sim 的用法见 scripts/lib/sim/world.mjs 的文件头与 references/formats/lua-sim.md。
 */

import { Sim } from './world.mjs';
import { float } from '../lua/value.mjs';

/**
 * @param {{source: string, chunk: string, simOptions?: object, print?: (s: string) => void}} o
 * @returns {{ t: object, result: () => {pass: number, fail: number} }}
 */
export function createHarness({ source, chunk, simOptions = {}, print = console.log }) {
  let pass = 0;
  let fail = 0;
  const same = (a, b) => Object.is(a, b) || JSON.stringify(a, (_, v) => (typeof v === 'bigint' ? `${v}n` : v)) === JSON.stringify(b, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
  const t = {
    Sim, source, chunk, float,
    section: (title) => print(`\n【${title}】`),
    ok: (cond, msg) => {
      if (cond) { pass++; print(`  ✓ ${msg}`); } else { fail++; print(`  ✗ ${msg}`); }
      return !!cond;
    },
    eq: (actual, expected, msg) => {
      const good = same(actual, expected);
      return t.ok(good, good ? msg : `${msg}（实际 ${JSON.stringify(actual)}，期望 ${JSON.stringify(expected)}）`);
    },
    newSim: (extra = {}) => new Sim({ ...simOptions, chunkName: chunk, ...extra }),
    fresh: (extra = {}, settle = 12) => {
      const sim = t.newSim(extra);
      sim.load(source, { chunk });
      sim.start();
      for (let i = 0; i < settle; i++) sim.frame(0.1);
      return sim;
    },
    noProblems: (sim, label) => {
      t.ok(sim.errors.length === 0, `${label}：没有 Lua 运行时错误${sim.errors.length ? ` ${JSON.stringify(sim.errors.map((e) => e.message))}` : ''}`);
      t.ok(sim.faults().length === 0, `${label}：没有错误级日志 / GAME FAULT${sim.faults().length ? ` ${JSON.stringify(sim.faults().map((l) => l.text))}` : ''}`);
    },
  };
  return { t, result: () => ({ pass, fail }) };
}

/** 跑一个场景模块，返回 { pass, fail } */
export async function runScenario(mod, harnessOpts) {
  if (typeof mod.default !== 'function') throw new Error('场景文件要 export default async function (t) { … }');
  const { t, result } = createHarness(harnessOpts);
  await mod.default(t);
  return result();
}
