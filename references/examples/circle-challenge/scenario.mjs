/**
 * 「圆圈挑战」整局场景测试 —— 在离线模拟世界里把游戏真的跑一遍，逐条断言游戏规则。
 *
 * 运行（在 skill 根目录）：
 *   node scripts/sim-lua.mjs test references/examples/circle-challenge/main.lua \
 *        --tree-file references/examples/circle-challenge/tree.txt \
 *        --scenario references/examples/circle-challenge/scenario.mjs
 *
 * 这份场景同时是「怎么给自己的脚本写场景测试」的范例：
 *   t.fresh()        新开一局（装载 + start + 空转 12 帧）
 *   t.newSim()       自己控制 load / start 的时机，或者在装载前改动世界（改控件名、让某个方法失灵……）
 *   sim.click(名字)   点控件；sim.advance(秒) 推进虚拟时间；sim.ctrl(名字).read(字段) 读控件状态
 *   t.noProblems()   这一局没有 Lua 错误、没有错误级日志
 *
 * 证据：这些断言锁住的是「脚本按我的建模工作」。真机上的视觉 / 手感 / 文字排版 / 补间观感它管不到；
 * 脚本里凡是标了「未在真机验证」的地方，这里通过并不能替代第一次真机试玩。
 */

const pack = (r, g, b, a = 255) => a * 2 ** 24 + (r << 16) + (g << 8) + b;
const NORMAL = pack(80, 190, 255);
const GOLD = pack(255, 213, 74);
const WHITE = pack(255, 255, 255);
const WARN = pack(255, 150, 150);

export default async function (t) {
  const hud = (sim) => sim.ctrl('分数文本').read('text');
  const circle = (sim) => sim.ctrl('圆圈容器');
  const size = (sim) => [circle(sim).read('sizeDeltaX'), sim.ctrl('圆圈点击区域').read('sizeDeltaX'), sim.ctrl('圆圈图片').read('sizeDeltaX')];
  const score = (sim) => Number(/得分：(\d+)/.exec(hud(sim))[1]);

  // ───────────────────────────────────────────────
  t.section('1. 初始化（画布头 4 帧没就绪）');
  {
    const sim = t.newSim({ canvasReadyAfterFrames: 4 });
    sim.load(t.source, { chunk: t.chunk });
    t.eq(sim.root.read('showCursor'), true, '脚本加载时已写 showCursor = true');
    sim.start();
    t.eq(sim.updateEnabled, true, 'OnStart 打开了逐帧更新');
    sim.frame(0.1); sim.frame(0.1); sim.frame(0.1);
    t.eq(sim.ctrl('圆圈点击区域').cursorListeners.size, 0, '画布没就绪时不注册监听（在重试）');
    t.eq(hud(sim), '', '画布没就绪时不动 HUD');
    for (let i = 0; i < 8; i++) sim.frame(0.1);
    t.eq(sim.ctrl('圆圈点击区域').cursorListeners.get('CursorClick')?.length, 1, '画布就绪后恰好注册一次点击监听');
    t.eq(sim.updateEnabled, true, '初始化后保持逐帧更新（倒计时要用）');
    t.eq(hud(sim), '点圆圈开始（30 秒挑战）', '菜单 HUD');
    t.eq(size(sim), [128, 128, 128], '三个控件同尺寸');
    t.eq([circle(sim).read('anchoredPositionX'), circle(sim).read('anchoredPositionY')], [0, 0], '菜单里圆圈在正中间');
    t.eq(sim.ctrl('圆圈点击区域').read('raycastTarget'), true, '点击区可点');
    t.eq(sim.ctrl('圆圈图片').read('imageColor'), NORMAL, '圆圈是蓝色');
    t.ok(sim.ctrl('背景').read('imageColor') === WHITE && sim.ctrl('背景').read('imageId') === 107016, '背景设了官方示例的图片编号与白色');
    t.eq(sim.root.children.map((c) => c.nameStr).join(' > '), '背景 > 分数文本 > 圆圈容器', '根下层级（后面的在上）');
    t.eq(circle(sim).children.map((c) => c.nameStr).join(' > '), '圆圈点击区域 > 圆圈图片', '容器内：点击区在前、图片在最上');
    t.noProblems(sim, '初始化');
  }

  // ───────────────────────────────────────────────
  t.section('2. 开局与前几次点击（普通圈缩小、第 5 个是金圈）');
  {
    const sim = t.fresh();
    sim.click('圆圈点击区域');
    t.eq(hud(sim), '得分：0｜剩余：30 秒', '开局 HUD');
    t.eq(sim.ctrl('圆圈点击区域').read('raycastTarget'), true, '处理完点击后点击区重新可点');
    const seen = [];
    for (let k = 1; k <= 6; k++) {
      const bonusNow = sim.ctrl('圆圈图片').read('imageColor') === GOLD;       // 这一击点的是不是金圈
      const before = score(sim);
      sim.click('圆圈点击区域');
      seen.push({ k, gain: score(sim) - before, bonusNow, size: size(sim)[0], colorNext: sim.ctrl('圆圈图片').read('imageColor') === GOLD ? '金' : '蓝' });
    }
    t.ok(seen.slice(0, 4).every((s) => s.gain === 1 && !s.bonusNow), '第 1~4 个是普通圈，各 +1');
    t.eq(seen[3].colorNext, '金', '点完第 4 个后，第 5 个圈是金色');
    t.ok(seen[4].gain === 3 && seen[4].bonusNow, '第 5 个是金圈，+3');
    t.ok(seen[5].gain === 1 && seen[4].colorNext === '蓝', '第 6 个回到普通圈');
    t.eq(seen.slice(0, 4).map((s) => s.size), [124, 120, 116, 112], '随分数缩小 4px/分');
    t.eq(new Set(size(sim)).size, 1, '每次缩小三个控件保持同尺寸');
    t.noProblems(sim, '前几次点击');
  }

  // ───────────────────────────────────────────────
  t.section('3. 位置：200 次点击，圆圈始终在画布内、且不压分数文本');
  {
    const sim = t.fresh({ seed: 7 });
    const tx = sim.ctrl('分数文本');
    t.eq([tx.read('sizeDeltaX'), tx.read('sizeDeltaY')], [720, 84], '分数文本被加宽（存档里原来是 218×68）');
    t.ok(tx.read('fontSize') === 32, '字号是整数 32（真机传小数会报错）');
    const M = 16;                                              // 与脚本里的 HUD_MARGIN 一致
    const cx = tx.read('anchoredPositionX');
    const cy = tx.read('anchoredPositionY');
    const rect = { x0: cx - 360 - M, x1: cx + 360 + M, y0: cy - 42 - M, y1: cy + 42 + M };
    sim.click('圆圈点击区域');
    let outOfCanvas = 0;
    let overlap = 0;
    let minSize = 999;
    for (let i = 0; i < 200; i++) {
      sim.click('圆圈点击区域');
      const c = circle(sim);
      const half = c.read('sizeDeltaX') / 2;
      const x = c.read('anchoredPositionX');
      const y = c.read('anchoredPositionY');
      minSize = Math.min(minSize, half * 2);
      if (Math.abs(x) > 960 - half + 1e-6 || y < -(540 - half) - 1e-6 || y > 540 - half + 1e-6) outOfCanvas++;
      if (x + half > rect.x0 && x - half < rect.x1 && y + half > rect.y0 && y - half < rect.y1) overlap++;
    }
    t.eq(outOfCanvas, 0, '200 个位置全部在画布内');
    t.eq(overlap, 0, '没有一个压到分数文本');
    t.eq(minSize, 56, '圆圈最小缩到 56px（下限）');
    t.noProblems(sim, '位置压力测试');

    // 兜底：读不到文本位置时，改为避开画布顶部 110px（让 GetAnchoredPosition 什么都不返回来模拟「读不到」）
    const fb = t.newSim({ seed: 9 });
    fb.ctrl('分数文本').bound.set('GetAnchoredPosition', () => []);
    fb.load(t.source, { chunk: t.chunk });
    fb.start();
    for (let i = 0; i < 12; i++) fb.frame(0.1);
    t.ok(fb.logLines().some((l) => /读不到分数文本/.test(l)), '读不到文本位置：日志里说明改用顶部条兜底');
    fb.click('圆圈点击区域');
    let inBand = 0;
    for (let i = 0; i < 100; i++) {
      fb.click('圆圈点击区域');
      const c = circle(fb);
      if (c.read('anchoredPositionY') + c.read('sizeDeltaX') / 2 > 540 - 110 + 1e-6) inBand++;
    }
    t.eq(inBand, 0, '兜底模式下 100 个位置都不进顶部 110px');
    t.eq(fb.errors.length, 0, '兜底模式：没有 Lua 运行时错误');
  }

  // ───────────────────────────────────────────────
  t.section('4. 点中后的「弹一下」：不打断玩法，最终回到原大小');
  {
    const sim = t.fresh();
    sim.click('圆圈点击区域');
    sim.click('圆圈点击区域');
    t.eq(sim.activeTweens.size, 1, '点击后有一段补间序列在播');
    sim.click('圆圈点击区域');
    sim.click('圆圈点击区域');                                  // 连点：应杀掉上一段并重新开始，不报错
    sim.advance(0.5);
    t.eq([circle(sim).read('localScaleX'), circle(sim).read('localScaleY')], [1, 1], '播完后缩放回到 1');
    t.eq(sim.activeTweens.size, 0, '补间都播完了');
    t.noProblems(sim, '弹一下');
  }

  // ───────────────────────────────────────────────
  t.section('5. 倒计时：整秒、最后 5 秒泛红、到点结算（起始时刻带小数，测秒边界）');
  {
    const sim = t.fresh({ t0: 1_780_000_000.7 });
    sim.click('圆圈点击区域');
    const T0 = sim.t;
    const remain = () => Number(/剩余：(\d+) 秒/.exec(hud(sim))?.[1]);
    const seen = [remain()];
    let warnAt = null;
    let overAt = null;
    for (let guard = 0; guard < 400; guard++) {
      sim.frame(0.1);
      const r = remain();
      if (!Number.isNaN(r) && r !== seen[seen.length - 1]) seen.push(r);
      if (warnAt === null && sim.ctrl('背景').read('imageColor') === WARN) warnAt = r;
      if (/时间到/.test(hud(sim))) { overAt = sim.t - T0; break; }
    }
    t.ok(seen[0] === 30 && seen.every((v, i) => i === 0 || v === seen[i - 1] - 1), `HUD 剩余秒每次恰好减 1，没有跳变（${seen.slice(0, 4).join(' ')} …）`);
    t.eq(warnAt, 5, '背景在剩余 5 秒时泛红');
    t.ok(overAt !== null && overAt >= 29.0 && overAt <= 30.1, `结算发生在开局后 ${overAt?.toFixed(1)} 秒（整秒计时，应在 29~30 秒之间）`);
    t.eq(sim.ctrl('背景').read('imageColor'), WHITE, '结算后背景恢复白色');
    t.eq(hud(sim), '时间到！得分 0｜最高 0｜点圆圈再来一局', '结算 HUD');
    t.ok(circle(sim).read('anchoredPositionX') === 0 && circle(sim).read('anchoredPositionY') === 0 && size(sim)[0] === 128, '结算画面：圆圈回到正中间、恢复初始大小');
    t.noProblems(sim, '倒计时');
  }

  // ───────────────────────────────────────────────
  t.section('6. 结算后：防连点、再来一局、最高分保留');
  {
    const sim = t.fresh({ t0: 1_780_000_000.1 });
    sim.click('圆圈点击区域');
    for (let i = 0; i < 12; i++) sim.click('圆圈点击区域');        // 第一局拿分
    const s1 = score(sim);
    sim.advance(31);
    t.ok(/时间到/.test(hud(sim)), '第 1 局结束');
    t.ok(new RegExp(`得分 ${s1}｜最高 ${s1}`).test(hud(sim)), `得分与最高分都是 ${s1}`);
    sim.click('圆圈点击区域');                                      // 刚结算就点 → 应无效
    t.ok(/时间到/.test(hud(sim)), '刚结算时的点击不响应（防连点跳过结算画面）');
    sim.advance(2.5);
    sim.click('圆圈点击区域');
    t.ok(/得分：0｜剩余：30 秒/.test(hud(sim)), '等过锁定期后点圆圈再来一局');
    for (let i = 0; i < 3; i++) sim.click('圆圈点击区域');        // 第二局故意拿少点
    const s2 = score(sim);
    sim.advance(31);
    t.ok(new RegExp(`得分 ${s2}｜最高 ${Math.max(s1, s2)}`).test(hud(sim)), `第 2 局得分 ${s2}，最高分保留 ${Math.max(s1, s2)}`);
    t.ok(sim.logLines().some((l) => /第 2 局开始/.test(l)), '日志里有「第 2 局开始」');
    t.noProblems(sim, '多局');
  }

  // ───────────────────────────────────────────────
  t.section('7. 边界：时间刚到、这一帧的 OnUpdate 还没收尾时来了一次点击');
  {
    const sim = t.fresh({ t0: 1_780_000_000.0 });
    sim.click('圆圈点击区域');
    sim.click('圆圈点击区域');
    sim.t += 31;                                                   // 不走帧，直接把时钟推过 endAt（模拟「帧还没来得及处理」）
    sim.click('圆圈点击区域');
    t.ok(/时间到！得分 1/.test(hud(sim)), `超时点击按结束处理、这一击不算分：「${hud(sim)}」`);
    t.noProblems(sim, '边界');
  }

  // ───────────────────────────────────────────────
  t.section('8. 销毁与清理');
  {
    const sim = t.fresh();
    sim.click('圆圈点击区域');
    sim.click('圆圈点击区域');
    sim.destroy();
    t.eq(sim.ctrl('圆圈点击区域').cursorListeners.size, 0, 'OnDestroy 移除了点击监听');
    t.eq(sim.ctrl('圆圈点击区域').read('raycastTarget'), false, 'OnDestroy 关闭了点击区');
    t.eq(sim.updateEnabled, false, 'OnDestroy 关闭了逐帧更新');
    t.noProblems(sim, '销毁');
  }

  // ───────────────────────────────────────────────
  t.section('9. 出错时降级：画布不就绪 / 控件名写错 / showCursor 改不动');
  {
    const a = t.newSim({ canvasReadyAfterFrames: 1e9 });
    a.load(t.source, { chunk: t.chunk });
    a.start();
    a.advance(8, 0.1);
    t.eq(a.errors.length, 0, '画布一直不就绪：没有 Lua 运行时错误（是 GAME FAULT 日志，不是崩溃）');
    t.ok(a.faults().some((l) => /画布尺寸/.test(l.text)), '给出「画布尺寸…帧都没就绪」的诊断');
    t.eq(a.updateEnabled, false, '重试预算用完后关掉逐帧');

    const b = t.newSim();
    b.ctrl('圆圈点击区域').nameStr = '圆圈点击';                      // 名字写错
    b.load(t.source, { chunk: t.chunk });
    b.start();
    b.advance(0.5, 0.1);
    t.eq(b.errors.length, 0, '控件名写错：没有 Lua 运行时错误');
    t.ok(b.faults().some((l) => /找不到预设界面控件/.test(l.text)), '控件名写错：报「找不到预设界面控件」');
    t.ok(b.treePrinted >= 1, '控件名写错：把控件树打进了日志（正确名字就在里面）');
    t.ok(b.logLines().some((l) => /GetChild\("圆圈点击区域"\) 返回 nil/.test(l)), '日志里点名了是哪个名字对不上');
    t.eq(b.updateEnabled, false, '控件名写错：停止重试');

    const c = t.newSim();
    const proto = Object.getPrototypeOf(c.root);
    c.root.newindex = function patched(key, v, it) { if (key === 'showCursor') return undefined; return proto.newindex.call(this, key, v, it); };   // 写了但没认账
    c.load(t.source, { chunk: t.chunk });
    c.start();
    c.advance(0.5, 0.1);
    t.ok(c.faults().some((l) => /showCursor 改不动/.test(l.text)), 'showCursor 写了没生效：报「showCursor 改不动」并告诉去编辑器里开');
    t.eq(c.errors.length, 0, 'showCursor 改不动：没有 Lua 运行时错误');
  }
}
