/**
 * value.mjs —— 离线 Lua 5.3 解释器的值表示与数字/字符串基础
 *
 * 整个 scripts/lib/lua/ 是一个「够用、诚实」的 Lua 5.3 解释器：只为在没有真机的时候先把脚本跑一遍。
 * 它不联网、零依赖、纯 JS。它不是千星奇域客户端本身（见 references/formats/lua-sim.md 的保真度表）。
 *
 * 值表示（与 Lua 5.3 的类型一一对应）：
 *   nil       → undefined（null 也按 nil 处理，但本库只产生 undefined）
 *   boolean   → JS boolean
 *   integer   → JS BigInt（64 位回绕）            ← Lua 5.3 的整数子类型
 *   float     → JS number                          ← Lua 5.3 的浮点子类型
 *   string    → JS string，但每个字符码 0–255 = 一个字节（「字节串」）
 *               所以 #"圆" 是 3，string.sub 会按字节切（与真机一致：切断汉字会得到坏 UTF-8）
 *   table     → LuaTable
 *   function  → LuaClosure（Lua 函数）或 JS 函数 (args:any[]) => any[]（原生函数）
 *   userdata  → Host 子类（控件、Tween、Script …，由 scripts/lib/sim 提供）
 *
 * 为什么整数用 BigInt：Lua 5.3 区分整数与浮点，`4/2` 是 `2.0`、`"HP:"..hp/2` 会得到 "HP:50.0"、
 * `x*1103515245` 这类哈希/线性同余要按 64 位回绕。用 JS number 一把梭会让这些全部「模拟器里没事、真机里不对」。
 */

import { fmtGC } from './cfloat.mjs';

// ─────────────────────────── 错误 ───────────────────────────

/** Lua 运行时错误。value 是 Lua 值（通常是带「块名:行号:」前缀的字节串）。 */
export class LuaError extends Error {
  constructor(value, extra = {}) {
    super(typeof value === 'string' ? utf8Decode(value) : `(error object is a ${luaTypeName(value)} value)`);
    this.value = value;
    this.frame = extra.frame;          // 出错时的调用栈顶帧（供 xpcall 的处理器 / traceback 用）
    this.traceback = extra.traceback;
  }
}

/** 语法错误（加载阶段）。message 形如「main:5: 'end' expected (to close 'function' at line 1) near <eof>」。 */
export class LuaSyntaxError extends Error {
  constructor(message, line) { super(message); this.line = line; }
}

/** 步数预算耗尽（疑似死循环）。不是 LuaError：脚本里的 pcall 拦不住它。 */
export class ScriptTimeout extends Error {}

// ─────────────────────────── 字节串 ↔ JS 字符串 ───────────────────────────

const ASCII_ONLY = /^[\x00-\x7f]*$/;

/** JS 字符串 → 字节串（UTF-8 编码后每个字节一个字符） */
export function utf8Encode(s) {
  if (ASCII_ONLY.test(s)) return s;
  return Buffer.from(s, 'utf8').toString('latin1');
}

/** 字节串 → JS 字符串（按 UTF-8 解码，坏字节变成 U+FFFD） */
export function utf8Decode(b) {
  if (ASCII_ONLY.test(b)) return b;
  return Buffer.from(b, 'latin1').toString('utf8');
}

// ─────────────────────────── 表 ───────────────────────────

let tableCounter = 0;
const I64_MIN_F = -9223372036854775808;
const I64_MAX_F = 9223372036854775808;      // 2^63，浮点里刚好放不进 int64

/** 有整数值的浮点数能否当整数键用 */
function floatIsIntKey(k) {
  return Number.isInteger(k) && k >= I64_MIN_F && k < I64_MAX_F;
}

/**
 * Lua 表：数组部分 arr（下标 1..n）+ 哈希部分 hash（Map）。
 * 键的规范化：值为整数的浮点键（t[1.0]）等同于整数键 t[1]；nil / NaN 不能当键（由调用方检查）。
 * 数组部分不变量：arr 末尾元素非 nil（设 nil 时裁掉尾部空洞）；hash 里不会有键 arr.length+1。
 */
export class LuaTable {
  constructor() {
    this.arr = [];
    this.hash = new Map();
    this.meta = undefined;              // 元表（LuaTable）
    this.id = ++tableCounter;           // 给 tostring 用的稳定「地址」
  }

  get(k) {
    if (typeof k === 'bigint') {
      const i = Number(k);
      if (i >= 1 && i <= this.arr.length) return this.arr[i - 1];
      return this.hash.get(k);
    }
    if (typeof k === 'number' && floatIsIntKey(k)) return this.get(BigInt(k));
    return this.hash.get(k);
  }

  /** 调用方已保证 k 不是 nil / NaN */
  set(k, v) {
    if (typeof k === 'number' && floatIsIntKey(k)) k = BigInt(k);
    if (typeof k === 'bigint') {
      const i = Number(k);
      const arr = this.arr;
      if (i >= 1 && i <= arr.length) {
        if (v === undefined) {
          if (i === arr.length) {
            arr.pop();
            while (arr.length && arr[arr.length - 1] === undefined) arr.pop();
          } else arr[i - 1] = undefined;
        } else arr[i - 1] = v;
        return;
      }
      if (i === arr.length + 1 && v !== undefined) {
        arr.push(v);
        this.hash.delete(k);
        if (this.hash.size) {           // 把紧接着的整数键从哈希部分迁进数组部分
          let nk = BigInt(arr.length + 1);
          while (this.hash.has(nk)) { arr.push(this.hash.get(nk)); this.hash.delete(nk); nk += 1n; }
        }
        return;
      }
    }
    if (v === undefined) this.hash.delete(k); else this.hash.set(k, v);
  }

  /** 数组部分 + 哈希部分是否都空（next(t)==nil 的快速判断） */
  isEmpty() { return this.arr.length === 0 && this.hash.size === 0; }

  /** 一个合法的「边界」（# 运算符）。表里有洞时，任何边界都合法，与真机可能取到不同的那个。 */
  length() { return this.arr.length; }

  /** 遍历快照：先数组部分 1..n，再哈希部分（order: 'insertion' | 'reverse' | 函数(keys)→keys） */
  keys(order = 'insertion') {
    const out = [];
    for (let i = 0; i < this.arr.length; i++) if (this.arr[i] !== undefined) out.push(BigInt(i + 1));
    let hk = [...this.hash.keys()];
    if (order === 'reverse') hk.reverse();
    else if (typeof order === 'function') hk = order(hk);
    for (const k of hk) out.push(k);
    return out;
  }

  /** 用 JS 数组建序列表（元素已经是 Lua 值） */
  static fromArray(list) {
    const t = new LuaTable();
    t.arr = list.slice();
    while (t.arr.length && t.arr[t.arr.length - 1] === undefined) t.arr.pop();
    return t;
  }
}

// ─────────────────────────── 宿主对象 ───────────────────────────

/**
 * 宿主对象（userdata）：控件、Tween、Script、game 等由模拟世界派生。
 * 解释器对它的所有访问都走 index / newindex / call，方法表对 Lua 侧不可枚举（真机：getmetatable 恒为 nil）。
 */
export class Host {
  constructor(typeName) { this.typeName = typeName; }
  index(_key, _interp) { return undefined; }
  newindex(key, _val, _interp) { throw new LuaError(`cannot set ${luaKeyText(key)}, no such field`); }
  tostring() { return `${this.typeName}: 0x${hostAddr(this)}`; }
}

const hostAddrs = new WeakMap();
let hostAddrCounter = 0x1000;
export function hostAddr(obj) {
  let a = hostAddrs.get(obj);
  if (a === undefined) { a = (hostAddrCounter += 0x40); hostAddrs.set(obj, a); }
  return a.toString(16).padStart(8, '0');
}

// ─────────────────────────── 类型 ───────────────────────────

export class LuaClosure {
  constructor(proto, upcells, G) { this.proto = proto; this.upcells = upcells; this.G = G; }
}

export const isNil = (v) => v === undefined || v === null;
export const isTruthy = (v) => v !== undefined && v !== null && v !== false;
export const isInt = (v) => typeof v === 'bigint';
export const isFloat = (v) => typeof v === 'number';
export const isNumber = (v) => typeof v === 'bigint' || typeof v === 'number';
export const isFunction = (v) => v instanceof LuaClosure || typeof v === 'function';

export function luaTypeName(v) {
  switch (typeof v) {
    case 'undefined': return 'nil';
    case 'boolean': return 'boolean';
    case 'bigint': case 'number': return 'number';
    case 'string': return 'string';
    case 'function': return 'function';
    default:
      if (v === null) return 'nil';
      if (v instanceof LuaTable) return 'table';
      if (v instanceof LuaClosure) return 'function';
      return 'userdata';
  }
}

/** 错误信息里的类型名：宿主对象用它的类型名（bad argument … got ClientUIContainerControl） */
export function luaTypeNameVerbose(v) {
  if (v instanceof Host) return v.typeName;
  return luaTypeName(v);
}

let fnCounter = 0;
const fnAddrs = new WeakMap();
function addrOfFn(f) {
  let a = fnAddrs.get(f);
  if (a === undefined) { a = 0x5000 + (++fnCounter) * 0x20; fnAddrs.set(f, a); }
  return a.toString(16).padStart(8, '0');
}

function luaKeyText(key) {
  return typeof key === 'string' ? utf8Decode(key) : tostr(key);
}

// ─────────────────────────── 数字 ⇄ 文本 ───────────────────────────

/**
 * C 的 %.{prec}g（alt=false：去掉多余的 0）。prec 默认 14，与 Lua 5.3 的 tostring 一致。
 * 舍入走 cfloat.mjs 的精确算法（对精确平局取偶，与 C 一致；JS 的 toPrecision 取较大者，会差一位）。
 */
export function fmtG(x, prec = 14, alt = false) {
  if (Number.isNaN(x)) return 'nan';                   // JS 看不到 NaN 的符号位，真机可能是 -nan
  if (x === Infinity) return 'inf';
  if (x === -Infinity) return '-inf';
  const neg = x < 0 || Object.is(x, -0);
  const body = fmtGC(Math.abs(x), prec, alt);
  return neg ? `-${body}` : body;
}

/** tostring(浮点)：%.14g，且看起来像整数的要补 ".0"（5.3 的规则） */
export function fmtFloat(x) {
  const s = fmtG(x, 14);
  return /^-?\d+$/.test(s) ? `${s}.0` : s;
}

/** tostring 的原始版本（不看元方法） */
export function tostr(v) {
  switch (typeof v) {
    case 'undefined': return 'nil';
    case 'boolean': return v ? 'true' : 'false';
    case 'bigint': return v.toString();
    case 'number': return fmtFloat(v);
    case 'string': return v;
    case 'function': return `function: builtin: 0x${addrOfFn(v)}`;
    default:
      if (v === null) return 'nil';
      if (v instanceof LuaTable) return `table: 0x${(0x600000 + v.id * 0x40).toString(16).padStart(8, '0')}`;
      if (v instanceof LuaClosure) return `function: 0x${addrOfFn(v)}`;
      if (v instanceof Host) return v.tostring();
      return `userdata: 0x${hostAddr(v)}`;
  }
}

/**
 * 把字节串按 Lua 5.3 的 luaO_str2num 规则解析成数字；不合法返回 undefined。
 * 支持：前后空白、十进制整数（溢出退化为浮点）、十进制浮点、0x 十六进制整数（回绕）与十六进制浮点。
 */
export function str2num(s) {
  const t = s.replace(/^[ \t\n\v\f\r]+|[ \t\n\v\f\r]+$/g, '');
  if (t === '') return undefined;
  let m = /^([+-]?)0[xX]([0-9a-fA-F]+)$/.exec(t);
  if (m) {
    let v = BigInt.asIntN(64, BigInt('0x' + m[2]));
    if (m[1] === '-') v = BigInt.asIntN(64, -v);
    return v;
  }
  m = /^([+-]?)0[xX]([0-9a-fA-F]*)(?:\.([0-9a-fA-F]*))?(?:[pP]([+-]?\d+))?$/.exec(t);
  if (m && (m[2] !== '' || (m[3] ?? '') !== '')) {
    let mant = 0;
    for (const c of m[2]) mant = mant * 16 + parseInt(c, 16);
    let scale = 1;
    for (const c of m[3] ?? '') { scale /= 16; mant += parseInt(c, 16) * scale; }
    const e = m[4] ? parseInt(m[4], 10) : 0;
    const v = mant * 2 ** e;
    return m[1] === '-' ? -v : v;
  }
  if (/^[+-]?\d+$/.test(t)) {
    const b = BigInt(t);
    if (b >= -(2n ** 63n) && b < 2n ** 63n) return b;
    return Number(t);
  }
  if (/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(t)) return Number(t);
  return undefined;
}

/** 数字（整数/浮点）或能转成数字的字符串 → 数字；否则 undefined */
export function toNumber(v) {
  if (typeof v === 'bigint' || typeof v === 'number') return v;
  if (typeof v === 'string') return str2num(v);
  return undefined;
}

/** 转整数：整数直通；有精确整数值的浮点 → 整数；字符串先转数字；否则 undefined */
export function toInteger(v) {
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return floatIsIntKey(v) ? BigInt(v) : undefined;
  if (typeof v === 'string') { const n = str2num(v); return n === undefined ? undefined : toInteger(n); }
  return undefined;
}

export const INT_MIN = -(2n ** 63n);
export const INT_MAX = 2n ** 63n - 1n;
export const wrap64 = (b) => BigInt.asIntN(64, b);

/** 宿主 API 常用：把 JS 值转成 Lua 值（字符串编码成字节串；整数值的 JS number → Lua 整数） */
export function toLua(v) {
  if (v === undefined || v === null) return undefined;
  switch (typeof v) {
    case 'string': return utf8Encode(v);
    case 'number': return Number.isInteger(v) && Math.abs(v) <= Number.MAX_SAFE_INTEGER ? BigInt(v) : v;
    case 'boolean': case 'bigint': case 'function': return v;
    default:
      if (Array.isArray(v)) return LuaTable.fromArray(v.map(toLua));
      if (v instanceof LuaTable || v instanceof LuaClosure || v instanceof Host) return v;
      if (v && v.__luaFloat !== undefined) return v.__luaFloat;        // 见 float()
      if (typeof v === 'object') {
        const t = new LuaTable();
        for (const [k, x] of Object.entries(v)) t.set(utf8Encode(k), toLua(x));
        return t;
      }
      return undefined;
  }
}

/** 强制按 Lua 浮点传给 toLua：sim.signal('x', float(5)) → 5.0 */
export function float(x) { return { __luaFloat: Number(x) }; }

/** Lua 值 → 便于测试断言的 JS 值（整数→Number，字符串解码；表保持为 LuaTable，用 tableToJs 深拷贝） */
export function fromLua(v) {
  switch (typeof v) {
    case 'bigint': return v >= BigInt(Number.MIN_SAFE_INTEGER) && v <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(v) : v;
    case 'string': return utf8Decode(v);
    default: return v === null ? undefined : v;
  }
}

/** LuaTable → 普通 JS 对象/数组（深拷贝；纯序列表转数组） */
export function tableToJs(t, seen = new Set()) {
  if (!(t instanceof LuaTable)) return fromLua(t);
  if (seen.has(t)) return '[循环引用]';
  seen.add(t);
  let out;
  if (t.hash.size === 0) out = t.arr.map((x) => tableToJs(x, seen));
  else {
    out = {};
    for (const k of t.keys()) out[typeof k === 'string' ? utf8Decode(k) : String(k)] = tableToJs(t.get(k), seen);
  }
  seen.delete(t);
  return out;
}
