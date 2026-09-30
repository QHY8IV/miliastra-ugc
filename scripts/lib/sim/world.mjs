/**
 * world.mjs —— 千星奇域「客户端 Lua UI 脚本」的离线模拟世界
 *
 * ┌ 这是什么 ┐ 一个 Lua 5.3 解释器（scripts/lib/lua）+ 一套「我对客户端 API 的建模」：
 *   控件树 / 布局、script / game / Enum / Color、补间、生命周期、光标 / 按键 / 信号事件、虚拟时钟。
 * ┌ 这不是什么 ┐ 它不是游戏引擎。所有「引擎行为」都是模型：
 *   · 有真机出处的（契约里带日期的真机回传）标【真机】；官方文档写了的标【文档】；官方教学示例的标【官方示例】；
 *   · 文档与真机都没写、按常理建模的标【模型】/【未确认】——并且在行为发生时通过 sim.diag 亮出来，不会悄悄当成对的。
 *   通过离线模拟 ≠ 真机通过。第一次真机结果要回填 references/formats/verification-ledger.md。
 *
 * 用法（测试 / 场景脚本）：
 *   const sim = new Sim({ tree: '容器节点:container(…)', canvasReadyAfterFrames: 3 });
 *   sim.load(源码); sim.start(); sim.advance(1);
 *   sim.click('圆圈点击区域'); sim.ctrl('分数文本').read('text'); sim.problems();
 *   sim.destroy(); sim.finish();
 */

import { Interp } from '../lua/interp.mjs';
import { createGlobals } from '../lua/stdlib.mjs';
import { LuaClosure, LuaError, LuaTable, ScriptTimeout, float, isTruthy, toLua, utf8Decode, utf8Encode } from '../lua/value.mjs';
import { API, controlSpec } from './client-api.mjs';
import { buildEnums } from './enums.mjs';
import { Control, CursorEventData } from './control.mjs';
import { GameHost, ScriptHost, makeColorLib, suggest } from './hosts.mjs';
import { buildControls, normalizeSpec } from './level.mjs';

/** 没给树的时候的最小世界：一个容器 */
const DEFAULT_TREE = { name: '容器节点', type: 'container', layout: { anchorMin: [0, 0], anchorMax: [1, 1], position: [0, 0], size: [0, 0] }, children: [] };

const KEY_EVENTS = new Set(API.enums.KeyEventType);

export class Sim {
  /**
   * opts:
   *   tree / templates   控件树（DSL 字符串或 spec）/ 可实例化的模板 Map<prefabIndex, spec>
   *   canvas             画布尺寸，默认 [1920, 1080]【未确认】
   *   canvasReadyAfterFrames   前几帧 game.GetUICanvasSize() 返回 (0, 0)（官方示例：OnStart 时画布可能没就绪）；默认 0
   *   t0                 os.time() 的起点（秒，可带小数，用来测整秒边界）
   *   dt                 sim.frame() / sim.advance() 的默认帧间隔（秒），默认 1/60
   *   seed               math.random 种子
   *   modules            { 模块名: Lua 源码 }，给 require 用
   *   chunkName          报错前缀里的块名，默认 'main'
   *   pairsOrder         'insertion' | 'reverse' | 函数：打乱 pairs 的哈希部分顺序，暴露「依赖遍历顺序」的脚本
   *   stepLimit          单次回调的步数预算（死循环保护）
   *   texts / language / stageMode / testPlay / device   game.GetText / GetLanguageType / GetStageMode / IsTestPlay / GetDevice 的返回
   *   onLog(lvl, text)   实时日志回调
   */
  constructor(opts = {}) {
    const given = Object.fromEntries(Object.entries(opts).filter(([, v]) => v !== undefined));      // 调用方传 undefined 表示「没给」，不能盖掉默认值
    this.opts = { canvas: [1920, 1080], t0: 1_780_000_000, seed: 20260930, dt: 1 / 60, canvasReadyAfterFrames: 0, chunkName: 'main', ...given };
    this.t = 0;
    this.frames = 0;
    this.logs = [];
    this.errors = [];                // 未捕获的 Lua 错误 / 死循环：{label, message, traceback, line, chunk, count}（已按回调+文案去重）
    this.errorIndex = new Map();
    this.diags = [];                 // 软诊断：{sev, code, msg, evidence, line, chunk, label, count}
    this.diagIndex = new Map();
    this.sentSignals = [];
    this.tweens = [];
    this.activeTweens = new Set();
    this.updateEnabled = false;
    this.updateEnabledEver = false;
    this.levelPaused = false;
    this.phase = 'new';              // new → loaded → started → destroyed
    this.stats = { updates: 0, levelUpdates: 0 };
    this.startedOnce = false;
    this.wasActive = false;
    this.cbLabel = '';
    this.treePrinted = 0;
    this.customVars = new Map();
    this.audio = new Map();
    this.nextAudio = 1;
    this.cursor = [0, 0];
    this.device = opts.device ?? 'KeyboardAndMouse';
    this.leftStick = [0, 0];
    this.rightStick = [0, 0];
    this.controllerFocus = null;
    this.idCounter = 0;
    this.templates = opts.templates ?? new Map();
    this.modules = new Map(Object.entries(opts.modules ?? {}));
    this.moduleCache = new Map();
    this.unknownSeen = new Set();
    this.noteOnce = new Set();

    this.interp = new Interp({
      onPrint: (lvl, text) => this.log(lvl, text),
      now: () => Math.floor(this.opts.t0 + this.t),
      clock: () => this.t,
      seed: this.opts.seed,
      stepLimit: this.opts.stepLimit,
      pairsOrder: this.opts.pairsOrder,
      tzOffsetMinutes: this.opts.tzOffsetMinutes,
      requireHook: (name) => this.requireModule(name),
    });
    this.enums = buildEnums(API.enums);
    this.root = buildControls(this, normalizeSpec(opts.tree ?? DEFAULT_TREE));
    this.scriptHost = new ScriptHost(this);
    this.gameHost = new GameHost(this);
    this.colorLib = makeColorLib(this);
    this.G = null;
  }

  // ─────────────────────────── 基础设施 ───────────────────────────

  nextControlId() { return ++this.idCounter; }
  enumItem(group, name) { return this.enums.item(group, name); }
  canvasRect() { return { x: 0, y: 0, w: this.opts.canvas[0], h: this.opts.canvas[1] }; }
  canvasReady() { return this.frames >= this.opts.canvasReadyAfterFrames; }
  get now() { return Math.floor(this.opts.t0 + this.t); }

  /** 给 JS 侧传 Lua 浮点：sim.signal('x', sim.float(5)) */
  float(x) { return float(x); }

  log(lvl, text) {
    this.logs.push({ lvl, text, t: this.t, frame: this.frames });
    this.opts.onLog?.(lvl, text);
  }

  logLines() { return this.logs.map((l) => l.text); }

  /** 错误级日志，或带 GAME FAULT 标记的日志 */
  faults() { return this.logs.filter((l) => l.lvl === 'error' || /GAME FAULT/.test(l.text)); }

  /** 软诊断。同一条（码 + 文案 + 行）只记一次，count 累加 */
  diag(sev, code, msg, evidence = '模型') {
    const fr = this.interp.frame;
    const line = fr?.line;
    const chunk = fr?.cl?.proto?.chunkName;
    const key = `${code}|${msg}|${chunk}:${line}`;
    const hit = this.diagIndex.get(key);
    if (hit) { hit.count++; return hit; }
    const d = { sev, code, msg, evidence, line, chunk, label: this.cbLabel, t: this.t, frame: this.frames, count: 1 };
    this.diagIndex.set(key, d);
    this.diags.push(d);
    return d;
  }

  /** 所有 error 级问题（未捕获的 Lua 错误 + error 级诊断） */
  problems() { return [...this.errors, ...this.diags.filter((d) => d.sev === 'error')]; }

  /** 读了宿主对象上不存在的字段 → nil。【真机】契约 §4：静默 nil，所以这里只给 info，并尽量给出「你是不是想写 X」 */
  noteUnknownField(typeName, name) {
    if (!name) return;
    const key = `${typeName}.${name}`;
    if (this.unknownSeen.has(key)) return;
    this.unknownSeen.add(key);
    let cands;
    const spec = controlSpec(typeName);
    if (spec) cands = [...spec.fields.keys(), ...spec.methods.keys()];
    else if (typeName === 'game') cands = Object.keys(API.game);
    else if (API.types[typeName]) cands = [...Object.keys(API.types[typeName].fields), ...Object.keys(API.types[typeName].methods)];
    else cands = [];
    let hint = '';
    if (name === 'Id') hint = '——大写 Id 在真机读为 nil，标识字段是小写 id（契约 §3）';
    else if (name === 'GetName' || name === 'GetId') hint = '——控件标识是属性不是方法：用 .name / .id（契约 §3c）';
    else {
      const sug = suggest(name, cands);
      if (sug.length) hint = `——你是不是想写：${sug.join(' / ')}`;
    }
    this.diag('info', 'SIM010', `读取了 ${typeName} 上不存在的字段「${name}」→ nil（控件按类型封死，读不存在的字段是静默 nil）${hint}`, '真机');
  }

  noteMissingChild(ctrl, name, how) {
    const have = ctrl.children.map((c) => c.nameStr);
    this.diag('info', 'SIM070', `${how}("${name}")：「${ctrl.nameStr}」下没有这个子控件 → nil（已有：${have.join('、') || '（空）'}；GetChild 只看直接子控件，名字区分大小写）`, '文档');
  }

  // ─────────────────────────── 控件树 ───────────────────────────

  all(from = this.root) {
    const out = [];
    const walk = (c) => { out.push(c); for (const ch of c.children) walk(ch); };
    walk(from);
    return out;
  }

  controlById(id) { return this.all().find((c) => c.id === id && c.alive); }

  /** 按路径（a/b/c，可以带根名）或唯一的名字找控件；找不到或重名会抛错（写测试时要明确） */
  find(target) {
    if (target instanceof Control) return target;
    const s = String(target);
    if (s.includes('/')) {
      let cur = this.root;
      const segs = s.split('/').filter(Boolean);
      if (segs[0] === this.root.nameStr) segs.shift();
      for (const seg of segs) {
        cur = cur?.children.find((c) => c.nameStr === seg);
        if (!cur) throw new Error(`找不到控件路径「${s}」（卡在「${seg}」）`);
      }
      return cur;
    }
    const hits = this.all().filter((c) => c.nameStr === s);
    if (hits.length === 0) throw new Error(`找不到控件「${s}」。现有：${this.all().map((c) => c.nameStr).join('、')}`);
    if (hits.length > 1) throw new Error(`控件名「${s}」有 ${hits.length} 个，请用路径 a/b/c 指定`);
    return hits[0];
  }

  ctrl(target) { return this.find(target); }

  instantiateTemplate(prefabIndex, parent) {
    const spec = this.templates.get(prefabIndex);
    if (!spec) return null;
    return buildControls(this, spec, parent, { dynamic: true });
  }

  /** 控件上挂的脚本：本模拟里只有一个脚本，挂在 script.object 上 */
  scriptOn(ctrl, pred) {
    return ctrl === this.root && pred(this.scriptHost) ? this.scriptHost : undefined;
  }

  // ─────────────────────────── 脚本装载与调用 ───────────────────────────

  newEnv(chunk) {
    const G = createGlobals(this.interp, chunk);
    G.set('Enum', this.enums.table);
    G.set('Color', this.colorLib);
    G.set('game', this.gameHost);
    G.set('script', this.scriptHost);
    return G;
  }

  /** 带标签、带兜底的「从宿主进入 Lua」。未捕获的 Lua 错误记进 sim.errors，不抛出（真机同样只是记日志） */
  callLua(label, fn, args = []) {
    if (fn === undefined || fn === null) return [];
    const saved = this.cbLabel;
    this.cbLabel = label;
    try {
      return this.interp.callFromHost(fn, args);
    } catch (e) {
      if (e instanceof LuaError) { this.recordError(label, e); return []; }
      if (e instanceof ScriptTimeout) { this.recordError(label, e, true); return []; }
      throw e;
    } finally {
      this.cbLabel = saved;
    }
  }

  /** 未捕获的 Lua 错误。同一个（回调, 文案）只记一条并累加 count，免得逐帧 / 逐次点击的错误刷屏 */
  recordError(label, e, timeout = false) {
    const key = `${label}|${e.message}`;
    const prev = this.errorIndex.get(key);
    if (prev) { prev.count++; return; }
    const traceback = e.frame ? this.interp.traceback(undefined, 1, e.frame) : '';
    const rec = { label, message: e.message, traceback, line: e.frame?.line, chunk: e.frame?.cl?.proto?.chunkName, timeout, count: 1 };
    this.errorIndex.set(key, rec);
    this.errors.push(rec);
    this.log('error', `[Lua 运行时错误] ${label}：${e.message}${traceback ? `\n${traceback}` : ''}`);
  }

  lifecycleFn(name) {
    const f = this.G?.get(name);
    return f instanceof LuaClosure || typeof f === 'function' ? f : undefined;
  }

  /** 装载脚本：编译（语法错误抛 LuaSyntaxError）并运行顶层代码，但不触发任何生命周期 */
  load(source, { chunk } = {}) {
    if (this.phase !== 'new') throw new Error('Sim.load 只能调用一次（一个 Sim 对应一个脚本）');
    const name = chunk ?? this.opts.chunkName;
    this.G = this.newEnv(name);
    const { closure, ast, info } = this.interp.load(source, name, this.G);
    this.ast = ast;
    this.info = info;
    this.source = source;
    this.phase = 'loaded';
    this.callLua('（脚本顶层代码）', closure, []);
    return this;
  }

  /** 生命周期：OnInit → OnEnable → OnStart（所属控件不激活时等到激活） */
  start() {
    if (this.phase !== 'loaded') throw new Error('先 load 再 start');
    this.phase = 'started';
    this.callLua('OnInit', this.lifecycleFn('OnInit'));
    this.onActiveChanged();
    return this;
  }

  scriptActive() {
    return this.phase === 'started' && this.scriptHost.alive && this.scriptHost.enabled && this.root.activeInHierarchy;
  }

  /**
   * 【真机】契约 §1：SetActive(false) 立刻触发 OnDisable；SetActive(true) 再触发 OnEnable，不重跑 OnStart。
   * 控件的 active 变化 / script.enabled 变化后调用。
   */
  onActiveChanged() {
    if (this.phase !== 'started') return;
    const now = this.scriptActive();
    if (this.wasActive && !now) {
      this.wasActive = false;
      this.callLua('OnDisable', this.lifecycleFn('OnDisable'));
    } else if (!this.wasActive && now) {
      this.wasActive = true;
      this.callLua('OnEnable', this.lifecycleFn('OnEnable'));
      if (!this.startedOnce) {
        this.startedOnce = true;
        this.callLua('OnStart', this.lifecycleFn('OnStart'));
      }
    }
  }

  /** 推进一帧：先脚本的 OnUpdate / OnLevelUpdate，再补间。【真机】EnableUpdate 之前不会有 OnUpdate；PauseLevelTime 只挡 OnLevelUpdate */
  frame(dt = this.opts.dt) {
    this.t += dt;
    this.frames++;
    if (this.phase === 'started' && this.wasActive && this.updateEnabled) {
      if (this.lifecycleFn('OnUpdate')) { this.stats.updates++; this.callLua('OnUpdate', this.lifecycleFn('OnUpdate'), [dt]); }
      // 【未确认】OnLevelUpdate 是否同样要先 EnableUpdate：文档把 EnableUpdate 描述成「脚本逐帧更新」的总开关，这里按需要处理
      if (!this.levelPaused && this.updateEnabled && this.lifecycleFn('OnLevelUpdate')) { this.stats.levelUpdates++; this.callLua('OnLevelUpdate', this.lifecycleFn('OnLevelUpdate'), [dt]); }
    }
    for (const tw of [...this.activeTweens]) tw.advance(dt);
  }

  advance(seconds, dt = this.opts.dt) {
    const n = Math.max(0, Math.round(seconds / dt));
    for (let i = 0; i < n; i++) this.frame(dt);
  }

  /** 关卡结束：OnDisable → OnDestroy；所有补间直接作废（不触发回调） */
  destroy() {
    if (this.phase !== 'started') return;
    if (this.wasActive) { this.wasActive = false; this.callLua('OnDisable', this.lifecycleFn('OnDisable')); }
    this.callLua('OnDestroy', this.lifecycleFn('OnDestroy'));
    this.scriptHost.alive = false;
    this.phase = 'destroyed';
    for (const tw of this.activeTweens) tw.state = 'killed';
    this.activeTweens.clear();
    const left = this.all().filter((c) => c.cursorListeners.size || c.keyListeners.size || c.navListeners.size);
    if (left.length) {
      this.diag('info', 'SIM061', `OnDestroy 之后还有 ${left.length} 个控件带着事件监听（${left.map((c) => c.nameStr).join('、')}）：官方示例会在 OnDestroy 里逐个 Remove；控件是否随脚本一起销毁文档没写`, '官方示例');
    }
  }

  /** 收尾检查：补间没 Play、OnUpdate 是死代码… 在 destroy() 之后、读 sim.diags 之前调用 */
  finish() {
    for (const tw of this.tweens) {
      const where = tw.createdLine ? `（第 ${tw.createdLine} 行附近创建）` : '';
      if (tw.constructor.name === 'TweenHost' && tw.state === 'idle' && !tw.inSequence) {
        this.diag('warn', 'SIM021', `有补间创建了却从未 Play()${where}：game.Tween(...) 只是创建，不会自己播（文档 D2）`, '文档');
      }
      if (tw.constructor.name === 'TweenHost' && tw.inSequence && tw.inSequence.state === 'idle') {
        this.diag('warn', 'SIM022', `补间放进了序列，但序列从未 Play()${where}：序列不 Play，里面的补间一个都不会动（文档 D6）`, '文档');
      }
      if (tw.constructor.name === 'SequenceHost' && tw.state === 'idle') {
        this.diag('warn', 'SIM022', `创建了 TweenSequence 但从未 Play()${where}`, '文档');
      }
    }
    if (this.G && !this.updateEnabledEver && (this.lifecycleFn('OnUpdate') || this.lifecycleFn('OnLevelUpdate'))) {
      this.diag('warn', 'SIM060', '定义了 OnUpdate / OnLevelUpdate，但整个运行期间没有调用过 script:EnableUpdate(true)：它们是死代码——不报错、不执行（契约 §1，真机确证）', '真机');
    }
    return this;
  }

  // ─────────────────────────── require ───────────────────────────

  /** 【真机】契约 §7：require 可用；独立环境、有返回值、有缓存、不跑 OnInit/OnStart。模块名 → 源码由 opts.modules 提供 */
  requireModule(nameBytes) {
    const name = utf8Decode(nameBytes);
    if (this.moduleCache.has(name)) return this.moduleCache.get(name);
    const key = [name, name.replace(/\.lua$/, ''), name.replace(/\//g, '.'), name.replace(/\./g, '/')].find((k) => this.modules.has(k));
    if (key === undefined) throw this.interp.rtError(`module '${name}' not found（离线模拟里用 modules 选项 / --module 名字=文件 提供）`);
    this.diag('info', 'SIM050', `require("${name}")：模块环境的细节（模块里的 script 是谁、全局是否真的隔离）文档没写，模拟器给模块一张独立的全局表、共用同一个 script`, '未确认');
    const G = this.newEnv(key);
    const { closure } = this.interp.load(this.modules.get(key), key, G);
    this.moduleCache.set(name, true);             // 防循环 require：先占位
    const r = this.interp.callValue(closure, [nameBytes])[0];
    const val = r === undefined ? true : r;
    this.moduleCache.set(name, val);
    return val;
  }

  // ─────────────────────────── 事件 ───────────────────────────

  /** 光标事件为什么送不到（空数组 = 能送到）。listenerEvent 给出时还检查有没有对应监听 */
  cursorBlockers(ctrl, listenerEvent) {
    const why = [];
    if (!ctrl.alive) why.push('控件已销毁');
    if (!ctrl.spec.methods.has('AddCursorEventListener')) why.push(`${ctrl.typeName} 不是预设按钮 / 光标检测区域，挂不上光标监听（契约 §8）`);
    if (!ctrl.activeInHierarchy) why.push('控件不在激活的层级里（activeInHierarchy=false）');
    else if (!ctrl.visibleInHierarchy) why.push('控件不可见（visible=false）【模型】');
    if (ctrl.values.get('raycastTarget') !== true) why.push('raycastTarget 不是 true（文档 C2）');
    if (ctrl.values.get('interactable') === false) why.push('interactable=false【模型】');
    // 【文档】CursorEvent 相关方法都需要先把容器的 showCursor 设为真；【真机】新建容器默认 false
    let hasCursor = false;
    for (let c = ctrl; c; c = c.parent) if (c.values.get('showCursor') === true) { hasCursor = true; break; }
    if (!hasCursor) why.push('所在容器的 showCursor 不是 true——光标事件一律收不到（文档 C1；真机新建容器默认 false）');
    if (listenerEvent && !(ctrl.cursorListeners.get(listenerEvent)?.length)) why.push(`没有注册 ${listenerEvent} 监听`);
    return why;
  }

  fireCursor(ctrl, evName, data) {
    for (const cb of [...(ctrl.cursorListeners.get(evName) ?? [])]) this.callLua(`${evName} 回调（${ctrl.nameStr}）`, cb, [data()]);
  }

  /**
   * 点一个控件：按顺序发 CursorDown / CursorUp / CursorClick（与 SimulateCursorClick 的文档描述一致）。
   * 送不送得到按 cursorBlockers 的规则判定；送不到时返回原因并记一条 info 诊断。
   * @returns {{delivered: boolean, reasons: string[]}}
   */
  click(target, { x, y } = {}) {
    const ctrl = this.find(target);
    const why = this.cursorBlockers(ctrl, 'CursorClick');
    if (why.length) {
      this.diag('info', 'SIM031', `点击「${ctrl.nameStr}」没有送达：${why.join('；')}`, '文档');
      return { delivered: false, reasons: why };
    }
    const r = ctrl.worldRect();
    const pos = [x ?? r.x + r.w / 2, y ?? r.y + r.h / 2];
    this.cursor = [...pos];
    const data = () => new CursorEventData(this, { pos, pressPos: pos });
    for (const ev of ['CursorDown', 'CursorUp', 'CursorClick']) this.fireCursor(ctrl, ev, data);
    return { delivered: true, reasons: [] };
  }

  /** 给 Lua 侧 ctrl:SimulateCursorClick() 用 */
  simulateCursorClick(ctrl) { this.click(ctrl); }

  /** 低层：只发一种光标事件（CursorEnter / CursorDrag …），不检查「有没有监听」 */
  cursorEvent(target, evName, data = {}) {
    const ctrl = this.find(target);
    const why = this.cursorBlockers(ctrl);
    if (why.length) return { delivered: false, reasons: why };
    const r = ctrl.worldRect();
    const pos = data.pos ?? [r.x + r.w / 2, r.y + r.h / 2];
    this.fireCursor(ctrl, evName, () => new CursorEventData(this, { pos, pressPos: data.pressPos ?? pos, delta: data.delta ?? [0, 0], dragging: data.dragging ?? false }));
    return { delivered: true, reasons: [] };
  }

  /** 画布坐标里有哪个控件能接到光标（渲染顺序：后出现 / 同级索引大 / 子孙在上；图片不挡射线——文本框是否挡射线文档未写） */
  hitTest(x, y) {
    let hit = null;
    for (const c of this.all()) {
      if (!c.spec.methods.has('AddCursorEventListener') || this.cursorBlockers(c).length) continue;
      const r = c.worldRect();
      if (x >= r.x && x <= r.x + r.w && y >= r.y && y <= r.y + r.h) hit = c;
    }
    return hit;
  }

  clickAt(x, y) {
    const c = this.hitTest(x, y);
    if (!c) return { delivered: false, reasons: [`(${x}, ${y}) 处没有能接光标的控件`] };
    return this.click(c, { x, y });
  }

  /**
   * 按键事件：从渲染顺序靠上的控件往下派发；回调返回 true 表示已处理，中断后续派发（契约 §8 / 文档 §13）。
   * @param {string} eventName  Enum.KeyEventType 的值名，如 'KeyboardJumpKeyDown'
   */
  pressKey(eventName) {
    if (!KEY_EVENTS.has(eventName)) throw new Error(`Enum.KeyEventType 里没有 ${eventName}`);
    const order = this.all().reverse();
    for (const c of order) {
      if (!c.alive || !c.activeInHierarchy) continue;
      for (const cb of [...(c.keyListeners.get(eventName) ?? [])]) {
        const r = this.callLua(`${eventName} 回调（${c.nameStr}）`, cb, []);
        if (isTruthy(r[0])) return { handled: true, by: c.nameStr };
      }
    }
    return { handled: false };
  }

  /** 手柄导航事件（Confirm / Cancel / Focus …）投递给指定控件 */
  navigate(target, eventName) {
    const ctrl = this.find(target);
    for (const cb of [...(ctrl.navListeners.get(eventName) ?? [])]) this.callLua(`导航事件 ${eventName}（${ctrl.nameStr}）`, cb, []);
  }

  /** 服务端信号到达：回调 fun(signalName, signalParams)，signalParams 是 Lua 数组（下标从 1 开始，文档 E1） */
  signal(name, ...params) {
    if (!this.scriptActive()) return { delivered: false };
    const list = this.scriptHost.signalHandlers.get(name) ?? [];
    for (const cb of [...list]) this.callLua(`信号「${name}」回调`, cb, [utf8Encode(name), LuaTable.fromArray(params.map(toLua))]);
    return { delivered: list.length > 0 };
  }

  /** 改全局自定义变量，并触发已注册的变化回调（回调只给实体类型与变量名，值要自己读——文档 E4） */
  setCustomVariable(entityType, name, value) {
    this.customVars.set(`${entityType}/${name}`, toLua(value));
    for (const h of [...this.scriptHost.varHandlers]) {
      if (h.entity === entityType && h.name === name && this.scriptActive()) {
        this.callLua(`自定义变量「${name}」变化回调`, h.cb, [this.enumItem('CustomVariableEntityType', entityType), utf8Encode(name)]);
      }
    }
  }

  // ─────────────────────────── 观察 ───────────────────────────

  /** 整棵树的文本快照（名字 / 类型 / 位置 / 尺寸 / 文本） */
  snapshot() {
    return this.all().map((c) => {
      let depth = 0;
      for (let p = c.parent; p; p = p.parent) depth++;
      const r = c.worldRect();
      const text = c.values.has('text') ? `  text=${JSON.stringify(c.read('text'))}` : '';
      return `${'  '.repeat(depth)}${c.nameStr} [${c.typeName.replace(/^ClientUI|Control$/g, '')}]  rect=(${r.x.toFixed(0)},${r.y.toFixed(0)} ${r.w.toFixed(0)}×${r.h.toFixed(0)})${c.active ? '' : '  inactive'}${text}`;
    }).join('\n');
  }
}
