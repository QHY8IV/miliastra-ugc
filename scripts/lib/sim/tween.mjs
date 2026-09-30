/**
 * tween.mjs —— Tween / TweenSequence 的离线模型
 *
 * 【文档】client-ui-api.md §6–§8 / 官方原文 §7、§8：
 *   · game.Tween(对象, {可补间字段 = 目标值}, 时长) 只创建，必须 Play()
 *   · 默认绝对目标值；SetRelative(true) 才是「相对当前值的增量」
 *   · Kill(true) = 先切到结束状态并触发完成回调；Kill(false) = 停在当前状态、不触发回调
 *   · 序列：Append / AppendInterval / AppendCallback / Join / Insert / InsertCallback；序列 Play 才会驱动里面的补间，
 *     Tween 自己不该再 Play
 *   · SetLoops(n)：负数 = 无限循环
 * 【文档 pitfalls D3】补间字段名写错 → 静默无效（这里记一条诊断，不抛错）
 * 【模型】（文档没写，见各处注释）：缓动曲线（easing.mjs）、默认缓动 Linear、起点在补间「轮到」时才取、
 *   循环是「重头再来」而不是往返、播完的补间再 Play 视为无效并给诊断。
 */

import { Host, LuaClosure, toInteger, utf8Decode } from '../lua/value.mjs';
import { EASE } from './easing.mjs';
import { packColor, unpackColor } from './color.mjs';

const isFn = (v) => v instanceof LuaClosure || typeof v === 'function';

/** 读字段的当前值 → { kind: 'num' | 'color', v } */
function readStart(target, field, typ) {
  if (typ === 'ColorValue') return { kind: 'color', v: unpackColor(target.rawGet(field) ?? 0xffffffffn) };
  return { kind: 'num', v: Number(target.rawGet(field) ?? 0) };
}

function writeValue(target, field, typ, kind, v) {
  if (kind === 'color') target.rawSet(field, packColor(v.r, v.g, v.b, v.a));
  else if (typ === 'integer') target.rawSet(field, BigInt(Math.round(v)));
  else target.rawSet(field, v);
}

// ─────────────────────────── Tween ───────────────────────────

export class TweenHost extends Host {
  /** items: [{field, typ, to: number | {r,g,b,a}}] */
  constructor(sim, target, items, duration) {
    super('Tween');
    this.sim = sim;
    this.target = target;
    this.items = items;
    this.duration = duration;
    this.ease = 'Linear';             // 【未确认】文档没写默认缓动
    this.relative = false;
    this.loops = 1;
    this.onComplete = undefined;
    this.onStep = undefined;
    this.state = 'idle';               // idle | playing | paused | done | killed
    this.elapsed = 0;
    this.started = false;
    this.startVals = null;
    this.stepsFired = 0;
    this.completed = false;
    this.inSequence = null;
    this.playedDirectly = false;
    this.createdLine = sim.interp.frame?.line;
    sim.tweens.push(this);
  }

  get totalDuration() { return this.duration * Math.max(this.loops, 1); }

  captureStart() {
    this.startVals = this.items.map((it) => readStart(this.target, it.field, it.typ));
    this.started = true;
    this.stepsFired = 0;
  }

  /** 把「从本补间开始算起 t 秒」的状态写进控件；返回是否已经播完（有限循环） */
  sample(t) {
    if (!this.started) this.captureStart();
    const d = this.duration;
    const loops = this.loops;
    let p;
    let loopIdx = 0;
    let finished = false;
    if (d <= 0) { p = 1; finished = true; }                   // 时长非正：第一次采样就直接到终点
    else {
      const total = loops > 0 ? d * loops : d * 1e9;          // 无限循环：永远播不完，Complete() 也只当作走了很多圈
      const tt = Math.min(Math.max(t, 0), total);
      loopIdx = Math.min(Math.floor(tt / d), loops > 0 ? loops - 1 : 1e9);
      let local = tt - loopIdx * d;
      if (loops > 0 && tt >= total) { local = d; finished = true; }
      p = local / d;
    }
    const eased = (EASE[this.ease] ?? EASE.Linear)(p);
    this.items.forEach((it, i) => {
      const s = this.startVals[i];
      if (s.kind === 'color') {
        const end = it.to;
        const mix = (a, b) => a + (b - a) * eased;
        const to = this.relative ? { r: s.v.r + end.r, g: s.v.g + end.g, b: s.v.b + end.b, a: s.v.a + end.a } : end;
        writeValue(this.target, it.field, it.typ, 'color', { r: mix(s.v.r, to.r), g: mix(s.v.g, to.g), b: mix(s.v.b, to.b), a: mix(s.v.a, to.a) });
      } else {
        const to = this.relative ? s.v + it.to : it.to;
        writeValue(this.target, it.field, it.typ, 'num', s.v + (to - s.v) * eased);
      }
    });
    // 步骤完成回调：每完整走完一圈触发一次（播完时补上最后一圈）
    const stepsDone = finished ? Math.max(loops > 0 ? loops : 1, loopIdx) : loopIdx;
    while (this.stepsFired < stepsDone) {
      this.stepsFired++;
      if (this.onStep) this.sim.callLua('Tween:SetOnStepComplete 回调', this.onStep, []);
    }
    if (finished && !this.completed) {
      this.completed = true;
      if (this.onComplete) this.sim.callLua('Tween:SetOnComplete 回调', this.onComplete, []);
    }
    return finished;
  }

  advance(dt) {
    if (this.state !== 'playing') return;
    this.elapsed += dt;
    if (this.sample(this.elapsed)) { this.state = 'done'; this.sim.activeTweens.delete(this); }
  }

  // —— Lua 侧方法 ——
  index(key, interp) {
    const name = typeof key === 'string' ? utf8Decode(key) : '';
    const m = TWEEN_METHODS[name];
    if (!m) { this.sim.noteUnknownField('Tween', name); return undefined; }
    const fn = (args) => {
      if (args[0] !== this) throw interp.rtError(`bad argument #1 to '${name}' (Tween expected, got ${args[0] === undefined ? 'no value' : args[0] instanceof Host ? args[0].typeName : typeof args[0]})`);
      return m(this, args.slice(1), interp) ?? [];
    };
    fn.lname = name;
    return fn;
  }

  newindex(key, _v, interp) { throw interp.rtError(`cannot set ${utf8Decode(String(key))}, no such field`); }
}

const TWEEN_METHODS = {
  SetEase(tw, a, it) {
    const e = a[0];
    if (!(e instanceof Host) || e.typeName !== 'EnumItem' || e.group !== 'EaseType') {
      throw it.rtError(`bad argument #1 to 'SetEase' (EaseType expected, got ${e instanceof Host ? e.typeName : e === undefined ? 'nil' : typeof e === 'string' ? 'string' : 'value'})`);
    }
    tw.ease = e.name;
    return [tw];
  },
  SetRelative(tw, a, it) {
    if (typeof a[0] !== 'boolean') throw it.rtError(`bad argument #1 to 'SetRelative' (boolean expected, got ${a[0] === undefined ? 'nil' : typeof a[0]})`);
    tw.relative = a[0];
    return [tw];
  },
  SetLoops(tw, a, it) {
    const n = toInteger(a[0]);
    if (n === undefined) throw it.rtError(`bad argument #1 to 'SetLoops' (integer expected, got ${a[0] === undefined ? 'nil' : typeof a[0]})`);
    tw.loops = Number(n);
    return [tw];
  },
  SetOnComplete(tw, a, it) { if (!isFn(a[0])) throw it.rtError("bad argument #1 to 'SetOnComplete' (function expected)"); tw.onComplete = a[0]; return [tw]; },
  SetOnStepComplete(tw, a, it) { if (!isFn(a[0])) throw it.rtError("bad argument #1 to 'SetOnStepComplete' (function expected)"); tw.onStep = a[0]; return [tw]; },
  Play(tw) {
    const sim = tw.sim;
    if (tw.inSequence) sim.diag('warn', 'SIM023', `补间已经放进序列，又单独 Play()：序列才负责播放里面的补间，单独 Play 可能造成双重驱动（文档：「Tween 自己不 Play，序列才 Play」）`, '文档');
    tw.playedDirectly = true;
    if (tw.state === 'done' || tw.state === 'killed') {
      sim.diag('warn', 'SIM024', '对已经播完或已销毁的补间再次 Play()：真机行为未确认（可能已被自动销毁）。要重播请重新创建，或用 Restart()', '未确认');
      return [tw];
    }
    if (tw.state === 'idle' || tw.state === 'paused') { tw.state = 'playing'; sim.activeTweens.add(tw); }
    return [tw];
  },
  Pause(tw) { if (tw.state === 'playing') { tw.state = 'paused'; tw.sim.activeTweens.delete(tw); } },
  Resume(tw) { if (tw.state === 'paused') { tw.state = 'playing'; tw.sim.activeTweens.add(tw); } },
  Restart(tw) {
    // 【文档】Restart：回到初始状态并重新播放。初始状态 = 首次采到的起点，所以不清 started
    tw.elapsed = 0; tw.completed = false; tw.stepsFired = 0;
    tw.state = 'playing'; tw.sim.activeTweens.add(tw);
    if (tw.started) tw.sample(0);
  },
  Complete(tw) {
    if (tw.state === 'killed') return;
    tw.sample(Infinity);
    tw.state = 'done';
    tw.sim.activeTweens.delete(tw);
  },
  Kill(tw, a, it) {
    if (typeof a[0] !== 'boolean') throw it.rtError(`bad argument #1 to 'Kill' (boolean expected, got ${a[0] === undefined ? 'nil' : typeof a[0]})`);
    if (tw.state === 'killed') return;
    if (a[0] && tw.state !== 'done') tw.sample(Infinity);          // true：切到结束状态并触发完成回调
    tw.state = 'killed';
    tw.sim.activeTweens.delete(tw);
  },
};

// ─────────────────────────── TweenSequence ───────────────────────────

export class SequenceHost extends Host {
  constructor(sim) {
    super('TweenSequence');
    this.sim = sim;
    this.entries = [];
    this.total = 0;
    this.lastStart = 0;
    this.loops = 1;
    this.onComplete = undefined;
    this.onStep = undefined;
    this.state = 'idle';
    this.elapsed = 0;
    this.curLoop = 0;
    this.createdLine = sim.interp.frame?.line;
    sim.tweens.push(this);
  }

  resetEntries() {
    for (const e of this.entries) {
      e.fired = false;
      if (e.tween) { e.tween.completed = false; e.tween.stepsFired = 0; }        // 起点保留首次采到的值：每圈都回到同一个起点
    }
  }

  update() {
    const loopLen = this.total;
    const loops = this.loops;
    let loopIdx = 0;
    let local = this.elapsed;
    let finished = false;
    if (loopLen > 0) {
      loopIdx = Math.floor(this.elapsed / loopLen);
      if (loops > 0) loopIdx = Math.min(loopIdx, loops - 1);
      local = this.elapsed - loopIdx * loopLen;
      if (loops > 0 && this.elapsed >= loopLen * loops) { local = loopLen; finished = true; }
    } else finished = loops > 0;
    while (this.curLoop < loopIdx) {                 // 跨圈：先把上一圈收完，再重置
      this.runEntries(Infinity);
      if (this.onStep) this.sim.callLua('TweenSequence:SetOnStepComplete 回调', this.onStep, []);
      this.resetEntries();
      this.curLoop++;
    }
    this.runEntries(finished ? Infinity : local);     // 播完：强制每个子补间落在终点（elapsed 是累加出来的，会差一个浮点误差）
    if (finished) {
      if (this.onStep) this.sim.callLua('TweenSequence:SetOnStepComplete 回调', this.onStep, []);
      this.state = 'done';
      this.sim.activeTweens.delete(this);
      if (this.onComplete) this.sim.callLua('TweenSequence:SetOnComplete 回调', this.onComplete, []);
    }
  }

  runEntries(local) {
    for (const e of this.entries) {
      if (e.kind === 'tween') { if (local >= e.start) e.tween.sample(local - e.start); }
      else if (e.kind === 'callback' && !e.fired && local >= e.time) {
        e.fired = true;
        this.sim.callLua('TweenSequence 回调', e.fn, []);
      }
    }
  }

  advance(dt) {
    if (this.state !== 'playing') return;
    this.elapsed += dt;
    this.update();
  }

  index(key, interp) {
    const name = typeof key === 'string' ? utf8Decode(key) : '';
    const m = SEQ_METHODS[name];
    if (!m) { this.sim.noteUnknownField('TweenSequence', name); return undefined; }
    const fn = (args) => {
      if (args[0] !== this) throw interp.rtError(`bad argument #1 to '${name}' (TweenSequence expected, got ${args[0] === undefined ? 'no value' : args[0] instanceof Host ? args[0].typeName : typeof args[0]})`);
      return m(this, args.slice(1), interp) ?? [];
    };
    fn.lname = name;
    return fn;
  }

  newindex(key, _v, interp) { throw interp.rtError(`cannot set ${utf8Decode(String(key))}, no such field`); }
}

function needTween(a, fname, it) {
  const tw = a[0];
  if (!(tw instanceof TweenHost)) {
    throw it.rtError(`bad argument #1 to '${fname}' (Tween expected, got ${tw === undefined ? 'nil' : tw instanceof Host ? tw.typeName : typeof tw})`);
  }
  return tw;
}
function needNumber(v, idx, fname, it) {
  if (typeof v !== 'number' && typeof v !== 'bigint') throw it.rtError(`bad argument #${idx} to '${fname}' (number expected, got ${v === undefined ? 'nil' : typeof v})`);
  return Number(v);
}
function addChild(seq, tw, start) {
  if (tw.inSequence && tw.inSequence !== seq) seq.sim.diag('warn', 'SIM025', '同一个补间被放进了两个序列', '文档');
  if (tw.playedDirectly) seq.sim.diag('warn', 'SIM023', '补间已经单独 Play() 过，又放进序列：序列才负责播放里面的补间', '文档');
  tw.inSequence = seq;
  const end = start + tw.totalDuration;
  seq.entries.push({ kind: 'tween', start, end, tween: tw });
  seq.total = Math.max(seq.total, end);
}

const SEQ_METHODS = {
  Append(s, a, it) { const tw = needTween(a, 'Append', it); const start = s.total; addChild(s, tw, start); s.lastStart = start; return [s]; },
  AppendInterval(s, a, it) { const d = needNumber(a[0], 1, 'AppendInterval', it); s.entries.push({ kind: 'interval', start: s.total, end: s.total + d }); s.lastStart = s.total; s.total += d; return [s]; },
  AppendCallback(s, a, it) { if (!isFn(a[0])) throw it.rtError("bad argument #1 to 'AppendCallback' (function expected)"); s.entries.push({ kind: 'callback', time: s.total, fn: a[0], fired: false }); return [s]; },
  Join(s, a, it) { const tw = needTween(a, 'Join', it); addChild(s, tw, s.lastStart); return [s]; },
  Insert(s, a, it) { const t = needNumber(a[0], 1, 'Insert', it); const tw = needTween(a.slice(1), 'Insert', it); addChild(s, tw, t); return [s]; },
  InsertCallback(s, a, it) {
    const t = needNumber(a[0], 1, 'InsertCallback', it);
    if (!isFn(a[1])) throw it.rtError("bad argument #2 to 'InsertCallback' (function expected)");
    s.entries.push({ kind: 'callback', time: t, fn: a[1], fired: false });
    s.total = Math.max(s.total, t);
    return [s];
  },
  Play(s) {
    if (s.state === 'idle' || s.state === 'paused') { s.state = 'playing'; s.sim.activeTweens.add(s); s.update(); }
    else if (s.state === 'done' || s.state === 'killed') s.sim.diag('warn', 'SIM024', '对已经播完或已销毁的序列再次 Play()：真机行为未确认', '未确认');
    return [s];
  },
  Pause(s) { if (s.state === 'playing') { s.state = 'paused'; s.sim.activeTweens.delete(s); } },
  Resume(s) { if (s.state === 'paused') { s.state = 'playing'; s.sim.activeTweens.add(s); } },
  Restart(s) { s.elapsed = 0; s.curLoop = 0; s.resetEntries(); s.state = 'playing'; s.sim.activeTweens.add(s); s.update(); },
  Complete(s) {
    if (s.state === 'killed') return;
    s.elapsed = s.loops > 0 ? s.total * s.loops : s.total;
    s.state = 'playing';
    s.update();
    s.state = 'done';
    s.sim.activeTweens.delete(s);
  },
  Kill(s, a, it) {
    if (typeof a[0] !== 'boolean') throw it.rtError(`bad argument #1 to 'Kill' (boolean expected, got ${a[0] === undefined ? 'nil' : typeof a[0]})`);
    if (s.state === 'killed') return;
    if (a[0] && s.state !== 'done') { s.elapsed = s.loops > 0 ? s.total * s.loops : s.total; s.state = 'playing'; s.update(); }
    s.state = 'killed';
    s.sim.activeTweens.delete(s);
  },
  SetOnComplete(s, a, it) { if (!isFn(a[0])) throw it.rtError("bad argument #1 to 'SetOnComplete' (function expected)"); s.onComplete = a[0]; return [s]; },
  SetOnStepComplete(s, a, it) { if (!isFn(a[0])) throw it.rtError("bad argument #1 to 'SetOnStepComplete' (function expected)"); s.onStep = a[0]; return [s]; },
  SetLoops(s, a, it) {
    const n = toInteger(a[0]);
    if (n === undefined) throw it.rtError(`bad argument #1 to 'SetLoops' (integer expected, got ${a[0] === undefined ? 'nil' : typeof a[0]})`);
    s.loops = Number(n);
    return [s];
  },
};

export const TWEEN_METHOD_NAMES = Object.keys(TWEEN_METHODS);
export const SEQUENCE_METHOD_NAMES = Object.keys(SEQ_METHODS);
