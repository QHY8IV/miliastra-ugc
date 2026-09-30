/**
 * hosts.mjs —— script / game / ServerSignal / Color 这几个宿主对象
 *
 * 名字与签名来自 client-api.json（官方原文逐表解析）。行为依据：
 *   【真机】契约 §5   game 的函数必须点号调用：冒号调用会多传一个参数，报 bad argument count … (N expected, got N+1)
 *   【真机】契约 §9   getmetatable(script / game / 控件) 恒为 nil；script 的 7 个方法、game 的函数名全部存在
 *   【真机】契约 §1   EnableUpdate 之前不会有 OnUpdate；EnableUpdate(true) 返回 nil
 *   【真机】契约 §8   GetParam 保型；script.path 保留目录（default_import_file/levelScript）
 *   【真机】契约 B1   FindClientUIRoot 对客户端控件容器实测返回 nil
 *   【真机】契约 §2   InstantiateClientUIControl 在 OnInit / OnDestroy 里返回 nil，在 OnStart 里返回控件
 *   【文档】           ServerSignal 的 Add* / SendSignal 都没有返回值（「—」）：s:AddInt(1):SendSignal() 这种链式写法会报错
 *   【文档】           Color(r,g,b,a?)：0–255，a 省略或 nil = 255；Color.FromRGB / FromRGBA / ToRGBA
 *   【模型】           未在文档/真机出现的细节（GetText 的回退、音效实例生命周期、GetClientUIRoots 的内容…）按常理建模并给诊断
 */

import { Host, LuaClosure, LuaTable, luaTypeName, toInteger, tostr, utf8Decode, utf8Encode } from '../lua/value.mjs';
import { API } from './client-api.mjs';
import { Control, checkArgs } from './control.mjs';

import { SequenceHost, TweenHost } from './tween.mjs';
import { packColor, unpackColor } from './color.mjs';

const isNum = (v) => typeof v === 'bigint' || typeof v === 'number';
const isFn = (v) => v instanceof LuaClosure || typeof v === 'function';
const tn = (v) => (v === undefined || v === null ? 'nil' : v instanceof Host ? v.typeName : luaTypeName(v));

/** 极简「你是不是想写」：大小写不同，或编辑距离 ≤ 2 */
export function suggest(name, candidates) {
  const low = String(name).toLowerCase();
  const exact = candidates.filter((c) => c.toLowerCase() === low);
  if (exact.length) return exact;
  const dist = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  return candidates.filter((c) => dist(low, c.toLowerCase()) <= 2).slice(0, 3);
}

// ─────────────────────────── Script ───────────────────────────

const SCRIPT_METHODS = {
  EnableUpdate: {
    sig: ['b'],
    fn: (h, a) => { h.sim.updateEnabled = a[0]; if (a[0]) h.sim.updateEnabledEver = true; },
  },
  GetParam: { sig: ['s'], fn: (h, a, it) => [it.index(h.sim.G, a[0])] },
  Invoke: {
    sig: ['s'],
    fn: (h, a, it, all) => {
      const fn = h.sim.G.get(a[0]);
      if (!isFn(fn)) { h.sim.diag('warn', 'SIM090', `script:Invoke("${utf8Decode(a[0])}")：脚本里没有这个全局函数（local 函数宿主看不到）`, '文档'); return []; }
      return it.callValue(fn, all.slice(2));
    },
  },
  RegisterServerSignalHandler: {
    sig: ['s', 'f'],
    fn: (h, a) => {
      const name = utf8Decode(a[0]);
      const list = h.signalHandlers.get(name) ?? [];
      if (list.length) h.sim.diag('warn', 'SIM030', `信号「${name}」已经注册过处理函数，又注册了一个：是「替换」还是「叠加」文档没写（契约 §10），模拟器按叠加处理`, '未确认');
      list.push(a[1]);
      h.signalHandlers.set(name, list);
    },
  },
  UnregisterServerSignalHandler: { sig: ['s'], fn: (h, a) => { h.signalHandlers.delete(utf8Decode(a[0])); } },
  RegisterCustomVariableChangedHandler: {
    sig: ['e:CustomVariableEntityType', 's', 'f'],
    fn: (h, a) => { h.varHandlers.push({ entity: a[0].name, name: utf8Decode(a[1]), cb: a[2] }); },
  },
  UnregisterCustomVariableChangedHandler: {
    sig: ['e:CustomVariableEntityType', 's'],
    fn: (h, a) => { h.varHandlers = h.varHandlers.filter((x) => !(x.entity === a[0].name && x.name === utf8Decode(a[1]))); },
  },
};

export class ScriptHost extends Host {
  constructor(sim) {
    super('Script');
    this.sim = sim;
    this.enabled = true;
    this.alive = true;
    this.mappingId = sim.opts.scriptMappingId ?? 1;
    this.pathStr = sim.opts.scriptPath ?? 'default_import_file/levelScript';     // 【真机】契约 §8：保留目录
    this.signalHandlers = new Map();
    this.varHandlers = [];
    this.bound = new Map();
  }

  index(key, interp) {
    const k = typeof key === 'string' ? utf8Decode(key) : '';
    switch (k) {
      case 'alive': return this.alive;
      case 'scriptMappingId': return BigInt(this.mappingId);
      case 'object': return this.sim.root;
      case 'path': return utf8Encode(this.pathStr);
      case 'enabled': return this.enabled;
      default: break;
    }
    if (API.types.Script.methods[k]) return this.method(k, interp);
    this.sim.noteUnknownField('Script', k);          // 【真机】契约 §4：script.tickEnabled 这类读为 nil
    return undefined;
  }

  method(name) {
    let fn = this.bound.get(name);
    if (fn) return fn;
    const m = SCRIPT_METHODS[name];
    fn = (args, interp) => {
      if (args[0] !== this) throw interp.rtError(`bad argument #1 to '${name}' (Script expected, got ${args.length === 0 ? 'no value' : tn(args[0])})`);
      if (!m) { this.sim.diag('error', 'SIM099', `模拟器没有实现 Script:${name}`, '模型'); return []; }
      const a = checkArgs(interp, name, m.sig, args.slice(1));
      return m.fn(this, a, interp, args) ?? [];
    };
    fn.lname = name;
    this.bound.set(name, fn);
    return fn;
  }

  newindex(key, v, interp) {
    const k = typeof key === 'string' ? utf8Decode(key) : tostr(key);
    if (k === 'enabled') {
      if (typeof v !== 'boolean') throw interp.rtError(`bad argument #2 to 'enabled' (boolean expected, got ${tn(v)})`);
      this.enabled = v;
      this.sim.onActiveChanged();
      return;
    }
    throw interp.rtError(`cannot set ${k}, no such field`);      // alive / object / path 等只读字段，以及文档没有的字段
  }
}

export const SCRIPT_METHOD_NAMES = Object.keys(SCRIPT_METHODS);

// ─────────────────────────── ServerSignal ───────────────────────────

/** Add* 方法 → [ParamType 名, 值规格] ；值规格：i 整数 n 数字 s 字符串 b 布尔 v3 三维向量表 list:X X 的序列表 */
const SIGNAL_ADD = {
  AddInt: ['Int', 'i'], AddIntList: ['IntList', 'list:i'],
  AddFloat: ['Float', 'n'], AddFloatList: ['FloatList', 'list:n'],
  AddString: ['String', 's'], AddStringList: ['StringList', 'list:s'],
  AddBool: ['Bool', 'b'], AddBoolList: ['BoolList', 'list:b'],
  AddVector3: ['Vector3', 'v3'], AddVector3List: ['Vector3List', 'list:v3'],
  AddGuid: ['Guid', 'i'], AddGuidList: ['GuidList', 'list:i'],
  AddEntity: ['Entity', 'i'], AddEntityList: ['EntityList', 'list:i'],
  AddPrefabId: ['PrefabId', 'i'], AddPrefabIdList: ['PrefabIdList', 'list:i'],
  AddConfigId: ['ConfigId', 'i'], AddConfigIdList: ['ConfigIdList', 'list:i'],
};
const PARAMTYPE_SPEC = Object.fromEntries(Object.values(SIGNAL_ADD).map(([t, s]) => [t, s]));
export const SIGNAL_METHOD_NAMES = ['AddParam', 'SendSignal', ...Object.keys(SIGNAL_ADD)];

function checkSignalValue(spec, v, it, fname, idx) {
  const bad = (want) => it.rtError(`bad argument #${idx} to '${fname}' (${want} expected, got ${tn(v)})`);
  if (spec.startsWith('list:')) {
    if (!(v instanceof LuaTable)) throw bad('table');
    return v.arr.map((x) => checkSignalValue(spec.slice(5), x, it, fname, idx));
  }
  switch (spec) {
    case 'i': { const b = isNum(v) ? toInteger(v) : undefined; if (b === undefined) throw (typeof v === 'number' ? it.rtError(`bad argument #${idx} to '${fname}' (integer expected, got number)`) : bad('integer')); return Number(b); }
    case 'n': if (!isNum(v)) throw bad('number'); return Number(v);
    case 's': if (typeof v !== 'string') throw bad('string'); return utf8Decode(v);
    case 'b': if (typeof v !== 'boolean') throw bad('boolean'); return v;
    case 'v3': {
      if (!(v instanceof LuaTable)) throw bad('table {x=,y=,z=}');
      const out = {};
      for (const k of ['x', 'y', 'z']) { const c = v.get(k); if (!isNum(c)) throw it.rtError(`bad argument #${idx} to '${fname}' (Vector3 需要数字字段 ${k})`); out[k] = Number(c); }
      return out;
    }
    default: throw new Error(`未知信号值规格 ${spec}`);
  }
}

export class ServerSignalHost extends Host {
  constructor(sim, name) {
    super('ServerSignal');
    this.sim = sim;
    this.name = name;
    this.params = [];
    this.bound = new Map();
  }

  index(key, interp) {
    const k = typeof key === 'string' ? utf8Decode(key) : '';
    if (!API.types.ServerSignal.methods[k]) { this.sim.noteUnknownField('ServerSignal', k); return undefined; }
    let fn = this.bound.get(k);
    if (fn) return fn;
    fn = (args, it) => {
      if (args[0] !== this) throw it.rtError(`bad argument #1 to '${k}' (ServerSignal expected, got ${args.length === 0 ? 'no value' : tn(args[0])})`);
      const rest = args.slice(1);
      if (k === 'SendSignal') {
        this.sim.sentSignals.push({ name: utf8Decode(this.name), params: this.params.map((p) => ({ ...p })), t: this.sim.t, frame: this.sim.frames });
        return [];                                                   // 【文档】没有返回值
      }
      if (k === 'AddParam') {
        const [pt] = checkArgs(it, k, ['e:ParamType'], rest);
        const spec = PARAMTYPE_SPEC[pt.name];
        if (!spec) throw it.rtError(`bad argument #1 to 'AddParam' (ParamType ${pt.name} 不支持)`);
        this.params.push({ type: pt.name, value: checkSignalValue(spec, rest[1], it, 'AddParam', 2) });
        return [];
      }
      const add = SIGNAL_ADD[k];
      if (!add) { this.sim.diag('error', 'SIM099', `模拟器没有实现 ServerSignal:${k}`, '模型'); return []; }
      this.params.push({ type: add[0], value: checkSignalValue(add[1], rest[0], it, k, 1) });
      return [];                                                     // 【文档】Add* 没有返回值
    };
    fn.lname = k;
    this.bound.set(k, fn);
    return fn;
  }

  newindex(key, _v, interp) { throw interp.rtError(`cannot set ${utf8Decode(String(key))}, no such field`); }
}

// ─────────────────────────── game ───────────────────────────

const TWEEN_FIELD_HINT = {
  scale: 'localScaleX / localScaleY / localScaleZ', size: 'sizeDeltaX / sizeDeltaY', width: 'sizeDeltaX', height: 'sizeDeltaY',
  position: 'anchoredPositionX / anchoredPositionY', pos: 'anchoredPositionX / anchoredPositionY', x: 'anchoredPositionX', y: 'anchoredPositionY',
  rotation: 'localRotationX / localRotationY / localRotationZ', rotate: 'localRotationZ', angle: 'localRotationZ',
  alpha: '透明度在颜色里：imageColor / fontColor / bgColor / outlineColor（用 Color(r,g,b,a) 的 a）', opacity: '透明度在颜色里：imageColor / fontColor',
  color: 'imageColor（图片）/ fontColor（文本）', text: 'text 不是 Tweenable 字段',
};

const GAME = {
  PrintClientUITree: { sig: [], fn: (sim) => { sim.treePrinted++; sim.log('log', sim.root.describeTree()); } },
  InstantiateClientUIControl: {
    sig: ['i', 'c'],
    fn: (sim, a) => {
      if (sim.cbLabel === 'OnInit' || sim.cbLabel === 'OnDestroy') return [undefined];      // 【真机】契约 §2
      const c = sim.instantiateTemplate(Number(a[0]), a[1]);
      if (!c) sim.diag('warn', 'SIM092', `找不到控件模板 prefabIndex=${a[0]}：离线模拟里只有 .gil 导入的控件 / 你在 templates 里提供的模板才能实例化（返回 nil）`, '模型');
      return [c ?? undefined];
    },
  },
  DestroyClientUIControl: { sig: ['c'], fn: (sim, a) => { a[0].destroy(); } },
  GetClientUIControl: { sig: ['i'], fn: (sim, a) => [sim.controlById(Number(a[0]))] },
  FindClientUIRoot: {
    sig: ['s'],
    fn: (sim) => { sim.diag('info', 'SIM083', 'FindClientUIRoot 对客户端控件容器实测返回 nil（契约 B1）；脚本挂在容器上时入口是 script.object', '真机'); return [undefined]; },
  },
  GetClientUIRoots: { sig: [], fn: (sim) => [LuaTable.fromArray([sim.root])] },              // 【未确认】内容
  GetUICanvasSize: {
    sig: [],
    fn: (sim) => (sim.canvasReady() ? [sim.opts.canvas[0], sim.opts.canvas[1]] : [0, 0]),  // 官方示例：OnStart 时可能还没就绪
  },
  GetCursorUIPos: { sig: [], fn: (sim) => [...sim.cursor] },
  GetDevice: { sig: [], fn: (sim) => [sim.enumItem('Device', sim.device)] },
  SetControllerFocus: { sig: ['c'], fn: (sim, a) => { sim.controllerFocus = a[0]; } },
  GetControllerFocus: { sig: [], fn: (sim) => [sim.controllerFocus ?? undefined] },
  GetControllerLeftStickAxis: { sig: [], fn: (sim) => [...sim.leftStick] },
  GetControllerRightStickAxis: { sig: [], fn: (sim) => [...sim.rightStick] },
  Tween: {
    sig: ['a', 'a', 'n'],
    fn: (sim, a, it) => {
      const [obj, tbl, dur] = a;
      if (!(obj instanceof Control)) throw it.rtError(`bad argument #1 to 'Tween' (ClientUIBaseControl expected, got ${tn(obj)})`);
      if (!(tbl instanceof LuaTable)) throw it.rtError(`bad argument #2 to 'Tween' (table expected, got ${tn(tbl)})`);
      const duration = Number(dur);
      if (!(duration > 0)) sim.diag('warn', 'SIM026', `补间时长 ${duration}：非正数时长的行为文档没写，模拟器按「第一次采样就到终点」处理`, '未确认');
      const items = [];
      const tweenable = [...obj.spec.fields].filter(([, d]) => d.tween).map(([n]) => n);
      for (const k of tbl.keys()) {
        const name = typeof k === 'string' ? utf8Decode(k) : tostr(k);
        const def = typeof k === 'string' ? obj.spec.fields.get(name) : undefined;
        if (!def || !def.tween) {
          const hint = TWEEN_FIELD_HINT[name] ?? (suggest(name, tweenable).join(' / ') || '');
          sim.diag('warn', 'SIM020', `补间字段「${name}」不是 ${obj.typeName} 的 Tweenable 字段——真机静默无效（这个键被忽略）${hint ? `。应该是：${hint}` : ''}`, '文档');
          continue;
        }
        const v = tbl.get(k);
        if (def.type === 'ColorValue') {
          if (typeof v !== 'bigint') throw it.rtError(`bad argument #2 to 'Tween' (字段 ${name} 需要 Color 值，got ${tn(v)})`);
          items.push({ field: name, typ: def.type, to: unpackColor(v) });
        } else {
          if (!isNum(v)) throw it.rtError(`bad argument #2 to 'Tween' (字段 ${name} 需要数字，got ${tn(v)})`);
          if (!Number.isFinite(Number(v))) sim.diag('warn', 'SIM040', `补间字段 ${name} 的目标值不是有限数（NaN / inf）：建议先用 math.isnan / math.isinf 校验（官方文档 §3）`, '文档');
          items.push({ field: name, typ: def.type, to: Number(v) });
        }
      }
      return [new TweenHost(sim, obj, items, duration)];
    },
  },
  TweenSequence: { sig: [], fn: (sim) => [new SequenceHost(sim)] },
  ServerSignal: { sig: ['s'], fn: (sim, a) => [new ServerSignalHost(sim, a[0])] },
  GetGlobalCustomVariableValue: {
    sig: ['e:CustomVariableEntityType', 's'],
    fn: (sim, a) => [sim.customVars.get(`${a[0].name}/${utf8Decode(a[1])}`)],
  },
  PauseLevelTime: { sig: ['b'], fn: (sim, a) => { sim.levelPaused = a[0]; } },
  IsLevelTimePaused: { sig: [], fn: (sim) => [sim.levelPaused] },
  PlayAudio2D: {
    sig: ['i'],
    fn: (sim, a) => { const id = sim.nextAudio++; sim.audio.set(id, { audioId: Number(a[0]), alive: true }); return [BigInt(id)]; },
  },
  StopAudio: { sig: ['i'], fn: (sim, a) => { const x = sim.audio.get(Number(a[0])); if (x) x.alive = false; } },
  IsAudioAlive: { sig: ['i'], fn: (sim, a) => [sim.audio.get(Number(a[0]))?.alive ?? false] },
  GetLanguageType: { sig: [], fn: (sim) => [sim.enumItem('LanguageType', sim.opts.language ?? 'LanguageChs')] },
  GetStageMode: { sig: [], fn: (sim) => [sim.enumItem('StageMode', sim.opts.stageMode ?? 'Beyond')] },
  IsTestPlay: { sig: [], fn: (sim) => [sim.opts.testPlay ?? true] },
  GetText: {
    sig: ['s'],
    fn: (sim, a) => {
      const id = utf8Decode(a[0]);
      const t = sim.opts.texts?.[id];
      if (t === undefined) sim.diag('info', 'SIM084', `game.GetText("${id}")：离线模拟没有本地化表，原样返回这个 ID（用 opts.texts 提供译文）`, '模型');
      return [utf8Encode(t ?? id)];
    },
  },
};

export class GameHost extends Host {
  constructor(sim) {
    super('game');
    this.sim = sim;
    this.bound = new Map();
  }

  index(key) {
    const k = typeof key === 'string' ? utf8Decode(key) : '';
    const decl = API.game[k];
    if (!decl) { this.sim.noteUnknownField('game', k); return undefined; }
    let fn = this.bound.get(k);
    if (fn) return fn;
    const impl = GAME[k];
    const declared = decl.params.length;
    fn = (args, it) => {
      if (args.length > declared) {
        // 【真机】契约 §5：game:GetClientUIRoots() → bad argument count … (0 expected, got 1)
        const colon = args[0] === this;
        throw it.rtError(`bad argument count to '${k}' (${declared} expected, got ${args.length})${colon ? ` —— game 的函数要用点号调用：game.${k}(…)，冒号会把 game 自己当成第一个参数` : ''}`);
      }
      if (!impl) { this.sim.diag('error', 'SIM099', `模拟器没有实现 game.${k}（文档里有这个函数）——这次调用被当成空操作`, '模型'); return []; }
      const a = checkArgs(it, k, impl.sig, args);
      return impl.fn(this.sim, a, it) ?? [];
    };
    fn.lname = k;
    this.bound.set(k, fn);
    return fn;
  }

  newindex(key, _v, interp) { throw interp.rtError(`cannot set ${utf8Decode(String(key))}, no such field`); }
}

export const GAME_FUNCTION_NAMES = Object.keys(GAME);

// ─────────────────────────── Color ───────────────────────────

/** Color 既能调用（Color(r,g,b,a)）又有 FromRGB / FromRGBA / ToRGBA：做成带 __call 的表 */
export function makeColorLib(sim) {
  const lib = new LuaTable();
  const comps = (it, name, args, n) => {
    const out = [];
    for (let i = 0; i < n; i++) {
      const v = args[i];
      if (i === 3 && (v === undefined)) { out.push(255); continue; }                 // 【文档】a 省略或 nil = 255
      if (!isNum(v)) throw it.rtError(`bad argument #${i + 1} to '${name}' (number expected, got ${i >= args.length ? 'no value' : tn(v)})`);
      const x = Number(v);
      if (!(x >= 0 && x <= 255)) sim.diag('warn', 'SIM042', `${name} 的分量 ${x} 超出 0–255，模拟器取整后夹到范围内（真机怎么处理文档没写）`, '未确认');
      out.push(x);
    }
    return out;
  };
  const def = (name, fn) => { fn.lname = name; lib.set(name, fn); };
  def('FromRGB', (a, it) => { const [r, g, b] = comps(it, 'FromRGB', a, 3); return [packColor(r, g, b, 255)]; });
  def('FromRGBA', (a, it) => { const [r, g, b, al] = comps(it, 'FromRGBA', a, 4); return [packColor(r, g, b, al)]; });
  def('ToRGBA', (a, it) => {
    if (typeof a[0] !== 'bigint') throw it.rtError(`bad argument #1 to 'ToRGBA' (Color expected, got ${a.length === 0 ? 'no value' : tn(a[0])})`);
    const c = unpackColor(a[0]);
    return [BigInt(c.r), BigInt(c.g), BigInt(c.b), BigInt(c.a)];
  });
  const meta = new LuaTable();
  const call = (a, it) => { const [r, g, b, al] = comps(it, 'Color', a.slice(1), 4); return [packColor(r, g, b, al)]; };
  call.lname = 'Color';
  meta.set('__call', call);
  lib.meta = meta;
  return lib;
}
