/**
 * stdlib.mjs —— 千星奇域客户端脚本可见的标准库（Lua 5.3 语义）
 *
 * 暴露的集合按官方文档与观测契约（references/api/runtime-contract.md §7、client-ui-api.md §0）：
 *   可用  基础函数、string、table、math（含官方补充的 isnan / isinf）、os.time/date/clock/difftime、
 *         debug.traceback、require（由模拟世界提供加载）、utf8（文档与契约都没说裁掉，按 5.3 标准保留，未确认）
 *   没有  io、coroutine、package、load / loadfile / dofile / collectgarbage、string.dump/pack/unpack、
 *         其它 os.* / debug.*、全局 unpack / loadstring（5.1 的东西）、math.pow / log10 等 5.1 遗留
 *   特殊  getmetatable 对字符串、宿主对象一律返回 nil（契约 §7 / §9）；
 *         typeof(nil) 是字符串 "nil"（契约 §9）；printerr 写错误级日志不抛错（官方文档 §3）
 *
 * 随机数：用可设种子的生成器，序列与真机不同——测试必须对任意种子成立。
 */

import {
  Host, LuaClosure, LuaError, LuaTable, ScriptTimeout,
  isTruthy, luaTypeName, str2num, toInteger, tostr, utf8Decode, utf8Encode, wrap64, INT_MAX, INT_MIN,
} from './value.mjs';
import {
  argError, checkAny, checkBig, checkFloat, checkInt, checkNum, checkStr, checkTable, makeLib, optInt, optStr,
  typeError,
} from './libutil.mjs';
import { createStringLib } from './lib-string.mjs';

const isFn = (v) => v instanceof LuaClosure || typeof v === 'function';
const fitsInt = (f) => Number.isFinite(f) && f >= -9223372036854775808 && f < 9223372036854775808;

// ───────────────────────── table ─────────────────────────

const tget = (it, t, i) => (t.meta === undefined ? t.get(BigInt(i)) : it.index(t, BigInt(i)));
const tset = (it, t, i, v) => { if (t.meta === undefined) t.set(BigInt(i), v); else it.setIndex(t, BigInt(i), v); };
const tlen = (it, t) => (t.meta === undefined ? t.length() : Number(it.len(t)));

function swap(a, i, j) { const x = a[i]; a[i] = a[j]; a[j] = x; }

/** 照 ltablib.c 的 auxsort / partition 移植：相等元素的相对顺序与真机一致 */
function auxsort(a, lo, up, less, it) {
  let rnd = 0;
  while (lo < up) {
    if (less(a[up], a[lo])) swap(a, lo, up);
    if (up - lo === 1) break;
    let p;
    if (up - lo < 100 || rnd === 0) p = Math.floor((lo + up) / 2);
    else { const r4 = Math.floor((up - lo) / 4); p = (rnd % (r4 * 2)) + (lo + r4); }
    if (less(a[p], a[lo])) swap(a, p, lo);
    else if (less(a[up], a[p])) swap(a, p, up);
    if (up - lo === 2) break;
    const P = a[p];
    swap(a, p, up - 1);
    let i = lo;
    let j = up - 1;
    for (;;) {
      while (less(a[++i], P)) { if (i === up - 1) throw it.rtError('invalid order function for sorting'); }
      while (less(P, a[--j])) { if (j < i) throw it.rtError('invalid order function for sorting'); }
      if (j < i) break;
      swap(a, i, j);
    }
    swap(a, up - 1, i);
    p = i;
    let n;
    if (p - lo < up - p) { auxsort(a, lo, p - 1, less, it); n = p - lo; lo = p + 1; }
    else { auxsort(a, p + 1, up, less, it); n = up - p; up = p - 1; }
    if ((up - lo) / 128 > n) rnd = 0x9e3779b9;       // 真机这里取时间做随机种子，这里用常数（结果仍是合法排序）
  }
}

function createTableLib() {
  return makeLib({
    insert: (a, it) => {
      const t = checkTable(it, a, 0, 'insert');
      const e = tlen(it, t) + 1;
      let pos;
      if (a.length === 2) pos = e;
      else if (a.length === 3) {
        pos = checkInt(it, a, 1, 'insert');
        if (pos < 1 || pos > e) throw argError(it, 1, 'insert', 'position out of bounds');
        for (let i = e; i > pos; i--) tset(it, t, i, tget(it, t, i - 1));
      } else throw it.rtError("wrong number of arguments to 'insert'");
      tset(it, t, pos, a[a.length - 1]);
      return [];
    },
    remove: (a, it) => {
      const t = checkTable(it, a, 0, 'remove');
      const size = tlen(it, t);
      let pos = optInt(it, a, 1, 'remove', size);
      if (a.length > 1 && pos !== size && (pos < 1 || pos > size + 1)) throw argError(it, 1, 'remove', 'position out of bounds');
      const v = tget(it, t, pos);
      for (; pos < size; pos++) tset(it, t, pos, tget(it, t, pos + 1));
      tset(it, t, pos, undefined);
      return [v];
    },
    concat: (a, it) => {
      const t = checkTable(it, a, 0, 'concat');
      const sep = optStr(it, a, 1, 'concat', '');
      const i0 = optInt(it, a, 2, 'concat', 1);
      const last = a[3] === undefined ? tlen(it, t) : checkInt(it, a, 3, 'concat');
      const parts = [];
      for (let i = i0; i <= last; i++) {
        const v = tget(it, t, i);
        if (typeof v !== 'string' && typeof v !== 'bigint' && typeof v !== 'number') {
          throw it.rtError(`invalid value (at index ${i}) in table for 'concat'`);
        }
        parts.push(tostr(v));
      }
      return [parts.join(sep)];
    },
    unpack: (a, it) => unpack(a, it),
    pack: (a) => {
      const t = LuaTable.fromArray(a.slice());
      t.set('n', BigInt(a.length));
      return [t];
    },
    move: (a, it) => {
      const a1 = checkTable(it, a, 0, 'move');
      const f = checkInt(it, a, 1, 'move');
      const e = checkInt(it, a, 2, 'move');
      const t = checkInt(it, a, 3, 'move');
      const tt = a[4] === undefined ? a1 : checkTable(it, a, 4, 'move');
      if (e >= f) {
        if (!(f > 0 || e < Number.MAX_SAFE_INTEGER + f)) throw argError(it, 2, 'move', 'too many elements to move');
        if (t > e || t <= f || tt !== a1) for (let i = 0; i <= e - f; i++) tset(it, tt, t + i, tget(it, a1, f + i));
        else for (let i = e - f; i >= 0; i--) tset(it, tt, t + i, tget(it, a1, f + i));
      }
      return [tt];
    },
    sort: (a, it) => {
      const t = checkTable(it, a, 0, 'sort');
      const n = tlen(it, t);
      if (n > 1) {
        if (n >= 2147483647) throw argError(it, 0, 'sort', 'array too big');
        const comp = a[1];
        if (comp !== undefined && !isFn(comp)) throw typeError(it, a, 1, 'sort', 'function');
        const arr = [undefined];
        for (let i = 1; i <= n; i++) arr.push(tget(it, t, i));
        const less = comp === undefined ? (x, y) => it.lt(x, y) : (x, y) => isTruthy(it.callValue(comp, [x, y])[0]);
        auxsort(arr, 1, n, less, it);
        for (let i = 1; i <= n; i++) tset(it, t, i, arr[i]);
      }
      return [];
    },
  });
}

function unpack(a, it) {
  const t = a[0];
  const i0 = optInt(it, a, 1, 'unpack', 1);
  const j = a[2] === undefined ? (t instanceof LuaTable ? tlen(it, t) : Number(it.len(t))) : checkInt(it, a, 2, 'unpack');
  if (i0 > j) return [];
  if (j - i0 >= 1e7) throw it.rtError('too many results to unpack');
  const out = [];
  for (let i = i0; i <= j; i++) out.push(it.index(t, BigInt(i)));
  return out;
}

// ───────────────────────── math ─────────────────────────

function createMathLib(seed) {
  let s = (seed >>> 0) || 0x2545f491;
  const rand = () => {                              // mulberry32
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const fl = (name, fn) => (a, it) => [fn(checkFloat(it, a, 0, name))];
  return makeLib({
    abs: (a, it) => { const v = checkNum(it, a, 0, 'abs'); return [typeof v === 'bigint' ? (v < 0n ? wrap64(-v) : v) : Math.abs(v)]; },
    ceil: (a, it) => { const v = checkNum(it, a, 0, 'ceil'); if (typeof v === 'bigint') return [v]; const f = Math.ceil(v); return [fitsInt(f) ? BigInt(f) : f]; },
    floor: (a, it) => { const v = checkNum(it, a, 0, 'floor'); if (typeof v === 'bigint') return [v]; const f = Math.floor(v); return [fitsInt(f) ? BigInt(f) : f]; },
    sqrt: fl('sqrt', Math.sqrt),
    sin: fl('sin', Math.sin),
    cos: fl('cos', Math.cos),
    tan: fl('tan', Math.tan),
    asin: fl('asin', Math.asin),
    acos: fl('acos', Math.acos),
    exp: fl('exp', Math.exp),
    atan: (a, it) => [Math.atan2(checkFloat(it, a, 0, 'atan'), a[1] === undefined ? 1 : checkFloat(it, a, 1, 'atan'))],
    log: (a, it) => {
      const x = checkFloat(it, a, 0, 'log');
      if (a[1] === undefined) return [Math.log(x)];
      const b = checkFloat(it, a, 1, 'log');
      if (b === 2) return [Math.log2(x)];
      if (b === 10) return [Math.log10(x)];
      return [Math.log(x) / Math.log(b)];
    },
    fmod: (a, it) => {
      const x = checkNum(it, a, 0, 'fmod');
      const y = checkNum(it, a, 1, 'fmod');
      if (typeof x === 'bigint' && typeof y === 'bigint') {
        if (y === 0n) throw argError(it, 1, 'fmod', 'zero');
        return [y === -1n ? 0n : x % y];
      }
      return [Number(x) % Number(y)];
    },
    modf: (a, it) => {
      const v = checkNum(it, a, 0, 'modf');
      if (typeof v === 'bigint') return [v, 0];
      const n = v < 0 ? Math.ceil(v) : Math.floor(v);
      return [n, Number.isFinite(v) ? v - n : 0];
    },
    max: (a, it) => {
      let m = checkNum(it, a, 0, 'max');
      for (let i = 1; i < a.length; i++) { const v = checkNum(it, a, i, 'max'); if (m < v) m = v; }
      return [m];
    },
    min: (a, it) => {
      let m = checkNum(it, a, 0, 'min');
      for (let i = 1; i < a.length; i++) { const v = checkNum(it, a, i, 'min'); if (v < m) m = v; }
      return [m];
    },
    tointeger: (a, it) => { checkAny(it, a, 0, 'tointeger'); return [toInteger(a[0])]; },
    type: (a, it) => {
      checkAny(it, a, 0, 'type');
      return [typeof a[0] === 'bigint' ? 'integer' : typeof a[0] === 'number' ? 'float' : undefined];
    },
    ult: (a, it) => [BigInt.asUintN(64, checkBig(it, a, 0, 'ult')) < BigInt.asUintN(64, checkBig(it, a, 1, 'ult'))],
    random: (a, it) => {
      const r = rand();
      if (a.length === 0) return [r];
      let low, up;
      if (a.length === 1) { low = 1n; up = checkBig(it, a, 0, 'random'); }
      else if (a.length === 2) { low = checkBig(it, a, 0, 'random'); up = checkBig(it, a, 1, 'random'); }
      else throw it.rtError('wrong number of arguments');
      if (low > up) throw argError(it, a.length - 1, 'random', 'interval is empty');
      const span = up - low + 1n;
      return [low + BigInt(Math.floor(r * Number(span)))];
    },
    randomseed: (a, it) => { s = Math.trunc(checkFloat(it, a, 0, 'randomseed')) >>> 0 || 1; rand(); return []; },
    isnan: (a, it) => [Number.isNaN(Number(checkNum(it, a, 0, 'isnan')))],
    isinf: (a, it) => { const v = Number(checkNum(it, a, 0, 'isinf')); return [v === Infinity || v === -Infinity]; },
  }, { pi: Math.PI, huge: Infinity, maxinteger: INT_MAX, mininteger: INT_MIN });
}

// ───────────────────────── os ─────────────────────────

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const p2 = (n) => String(n).padStart(2, '0');

function createOsLib(interp) {
  const nowSec = () => (interp.opts.now ? interp.opts.now() : Math.floor(Date.now() / 1000));
  const tzMin = interp.opts.tzOffsetMinutes ?? 0;
  const fields = (sec, utc) => {
    const d = new Date((sec + (utc ? 0 : tzMin * 60)) * 1000);
    const yday = Math.floor((Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - Date.UTC(d.getUTCFullYear(), 0, 1)) / 86400000) + 1;
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), min: d.getUTCMinutes(), sec: d.getUTCSeconds(), wday: d.getUTCDay() + 1, yday };
  };
  const strftime = (fmt, f, it) => fmt.replace(/%(.)/g, (m, c) => {
    switch (c) {
      case 'Y': return String(f.year);
      case 'y': return p2(f.year % 100);
      case 'm': return p2(f.month);
      case 'd': return p2(f.day);
      case 'H': return p2(f.hour);
      case 'M': return p2(f.min);
      case 'S': return p2(f.sec);
      case 'p': return f.hour < 12 ? 'AM' : 'PM';
      case 'I': return p2(f.hour % 12 === 0 ? 12 : f.hour % 12);
      case 'A': return DAYS[f.wday - 1];
      case 'a': return DAYS[f.wday - 1].slice(0, 3);
      case 'B': return MONTHS[f.month - 1];
      case 'b': return MONTHS[f.month - 1].slice(0, 3);
      case 'j': return String(f.yday).padStart(3, '0');
      case 'w': return String(f.wday - 1);
      case 'x': return `${p2(f.month)}/${p2(f.day)}/${p2(f.year % 100)}`;
      case 'X': return `${p2(f.hour)}:${p2(f.min)}:${p2(f.sec)}`;
      case 'c': return `${DAYS[f.wday - 1].slice(0, 3)} ${MONTHS[f.month - 1].slice(0, 3)} ${String(f.day).padStart(2, ' ')} ${p2(f.hour)}:${p2(f.min)}:${p2(f.sec)} ${f.year}`;
      case 'Z': return tzMin === 0 ? 'UTC' : '';
      case '%': return '%';
      default: throw it.rtError(`bad argument #1 to 'date' (invalid conversion specifier '%${c}')`);
    }
  });
  return makeLib({
    time: (a, it) => {
      if (a[0] === undefined) return [BigInt(nowSec())];
      const t = checkTable(it, a, 0, 'time');
      const get = (k, def) => {
        const v = t.get(k);
        if (v === undefined) { if (def === undefined) throw it.rtError(`field '${k}' missing in date table`); return def; }
        const n = toInteger(v);
        if (n === undefined) throw it.rtError(`field '${k}' is not an integer`);
        return Number(n);
      };
      const ms = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour', 12), get('min', 0), get('sec', 0));
      return [BigInt(Math.floor(ms / 1000) - tzMin * 60)];
    },
    clock: () => [interp.opts.clock ? interp.opts.clock() : 0],
    difftime: (a, it) => [Number(checkNum(it, a, 0, 'difftime')) - Number(checkNum(it, a, 1, 'difftime'))],
    date: (a, it) => {
      let fmt = optStr(it, a, 0, 'date', '%c');
      const sec = a[1] === undefined ? nowSec() : checkInt(it, a, 1, 'date');
      let utc = false;
      if (fmt.startsWith('!')) { utc = true; fmt = fmt.slice(1); }
      const f = fields(sec, utc);
      if (fmt.startsWith('*t')) {
        const t = new LuaTable();
        for (const k of ['year', 'month', 'day', 'hour', 'min', 'sec', 'wday', 'yday']) t.set(k, BigInt(f[k]));
        t.set('isdst', false);
        return [t];
      }
      return [strftime(fmt, f, it)];
    },
  });
}

// ───────────────────────── utf8 ─────────────────────────

/** 从字节位置 i（0 起）解码一个 UTF-8 序列；非法返回 null */
function utf8DecodeAt(s, i, strict = true) {
  const c = s.charCodeAt(i);
  if (c < 0x80) return { cp: c, next: i + 1 };
  if (c < 0xc0) return null;
  let n, cp;
  if (c < 0xe0) { n = 1; cp = c & 0x1f; } else if (c < 0xf0) { n = 2; cp = c & 0x0f; } else if (c < 0xf8) { n = 3; cp = c & 0x07; } else if (c < 0xfc) { n = 4; cp = c & 0x03; } else if (c < 0xfe) { n = 5; cp = c & 0x01; } else return null;
  for (let k = 1; k <= n; k++) {
    const cc = s.charCodeAt(i + k);
    if (Number.isNaN(cc) || (cc & 0xc0) !== 0x80) return null;
    cp = cp * 64 + (cc & 0x3f);
  }
  const limits = [0, 0x80, 0x800, 0x10000, 0x200000, 0x4000000];
  if (cp < limits[n]) return null;
  if (strict && (cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff))) return null;
  return { cp, next: i + n + 1 };
}

function createUtf8Lib() {
  const posrel = (pos, len) => (pos >= 0 ? pos : -pos > len ? 0 : len + pos + 1);
  return makeLib({
    char: (a, it) => {
      let out = '';
      for (let i = 0; i < a.length; i++) {
        const cp = checkInt(it, a, i, 'char');
        if (cp < 0 || cp > 0x7fffffff) throw argError(it, i, 'char', 'value out of range');
        out += cp < 0x110000 && !(cp >= 0xd800 && cp <= 0xdfff) ? utf8Encode(String.fromCodePoint(cp)) : String.fromCharCode(0xef, 0xbf, 0xbd);
      }
      return [out];
    },
    codepoint: (a, it) => {
      const s = checkStr(it, a, 0, 'codepoint');
      const i = posrel(optInt(it, a, 1, 'codepoint', 1), s.length);
      const j = posrel(optInt(it, a, 2, 'codepoint', i), s.length);
      if (i < 1) throw argError(it, 1, 'codepoint', 'out of range');
      if (j > s.length) throw argError(it, 2, 'codepoint', 'out of range');
      const out = [];
      for (let p = i - 1; p < j;) {
        const d = utf8DecodeAt(s, p, !isTruthy(a[3]));
        if (!d) throw it.rtError('invalid UTF-8 code');
        out.push(BigInt(d.cp));
        p = d.next;
      }
      return out;
    },
    len: (a, it) => {
      const s = checkStr(it, a, 0, 'len');
      let i = posrel(optInt(it, a, 1, 'len', 1), s.length);
      const j = posrel(optInt(it, a, 2, 'len', -1), s.length);
      if (!(i >= 1 && i <= s.length + 1)) throw argError(it, 1, 'len', 'initial position out of string');
      if (j > s.length) throw argError(it, 2, 'len', 'final position out of string');
      let n = 0;
      for (let p = i - 1; p < j;) {
        const d = utf8DecodeAt(s, p, !isTruthy(a[3]));
        if (!d) return [undefined, BigInt(p + 1)];
        p = d.next;
        n++;
      }
      return [BigInt(n)];
    },
    offset: (a, it) => {
      const s = checkStr(it, a, 0, 'offset');
      const n = checkInt(it, a, 1, 'offset');
      let i = posrel(optInt(it, a, 2, 'offset', n > 0 ? 1 : s.length + 1), s.length);
      if (!(i >= 1 && i <= s.length + 1)) throw argError(it, 2, 'offset', 'position out of range');
      let p = i - 1;
      const iscont = (q) => q < s.length && (s.charCodeAt(q) & 0xc0) === 0x80;
      let k = n;
      if (k === 0) { while (p > 0 && iscont(p)) p--; return [BigInt(p + 1)]; }
      if (iscont(p)) throw it.rtError('initial position is a continuation byte');
      if (k < 0) {
        while (k < 0 && p > 0) { do { p--; } while (p > 0 && iscont(p)); k++; }
      } else {
        k--;
        while (k > 0 && p < s.length) { do { p++; } while (iscont(p)); k--; }
      }
      return k === 0 ? [BigInt(p + 1)] : [undefined];
    },
    codes: (a, it) => {
      const s = checkStr(it, a, 0, 'codes');
      const iter = (args) => {
        let i = Number(args[1]);
        while (i < s.length && (s.charCodeAt(i) & 0xc0) === 0x80) i++;       // 跳过上一个字符的后续字节
        if (i >= s.length) return [undefined];
        const d = utf8DecodeAt(s, i, true);
        if (!d) throw it.rtError('invalid UTF-8 code');
        return [BigInt(i + 1), BigInt(d.cp)];
      };
      return [iter, s, 0n];
    },
  }, { charpattern: '[\x00-\x7F\xC2-\xF4][\x80-\xBF]*' });
}

// ───────────────────────── 基础函数 ─────────────────────────

function tonumberImpl(a, it) {
  if (a[1] === undefined) {
    const v = a[0];
    if (typeof v === 'bigint' || typeof v === 'number') return [v];
    if (typeof v === 'string') return [str2num(v)];
    checkAny(it, a, 0, 'tonumber');
    return [undefined];
  }
  const base = checkInt(it, a, 1, 'tonumber');
  if (typeof a[0] !== 'string') throw typeError(it, a, 0, 'tonumber', 'string');
  if (base < 2 || base > 36) throw argError(it, 1, 'tonumber', 'base out of range');
  const m = /^[ \t\n\v\f\r]*(-?)([0-9a-zA-Z]+)[ \t\n\v\f\r]*$/.exec(a[0]);
  if (!m) return [undefined];
  let n = 0n;
  for (const ch of m[2].toLowerCase()) {
    const d = parseInt(ch, 36);
    if (d >= base) return [undefined];
    n = n * BigInt(base) + BigInt(d);
  }
  return [wrap64(m[1] ? -n : n)];
}

function nextImpl(a, it, fname = 'next') {
  const t = a[0];
  if (!(t instanceof LuaTable)) throw typeError(it, a, 0, fname, 'table');
  const k = a[1];
  if (k === undefined) {
    if (t.arr.length) { for (let i = 0; i < t.arr.length; i++) if (t.arr[i] !== undefined) return [BigInt(i + 1), t.arr[i]]; }
    for (const [hk, hv] of t.hash) return [hk, hv];
    return [undefined];
  }
  const keys = t.keys();
  const nk = typeof k === 'number' && Number.isInteger(k) && Math.abs(k) < 2 ** 63 ? BigInt(k) : k;     // t[1.0] 与 t[1] 是同一个键
  const at = keys.indexOf(nk);
  if (at < 0) throw it.rtError("invalid key to 'next'");
  for (let i = at + 1; i < keys.length; i++) { const v = t.get(keys[i]); if (v !== undefined) return [keys[i], v]; }
  return [undefined];
}

function selectImpl(a, it) {
  const n = a[0];
  if (n === '#') return [BigInt(a.length - 1)];
  let i = checkInt(it, a, 0, 'select');
  if (i < 0) i = a.length + i;
  else if (i > a.length - 1) i = a.length;     // 超出 → 没有返回值
  if (i < 1) throw argError(it, 0, 'select', 'index out of range');
  return a.slice(i);
}

/** 引擎约定：typeof(nil) 是字符串 "nil"；宿主对象返回类型名；普通值同 type */
export function typeofImpl(v) {
  if (v instanceof Host) return v.typeName;
  return luaTypeName(v);
}

export function createLibs(interp) {
  const libs = {
    string: createStringLib(),
    table: createTableLib(),
    math: createMathLib(interp.opts.seed ?? 0x2545f491),
    os: createOsLib(interp),
    utf8: createUtf8Lib(),
    debug: makeLib({
      traceback: (a, it) => {
        const msg = a[0];
        if (msg !== undefined && typeof msg !== 'string' && typeof msg !== 'bigint' && typeof msg !== 'number') return [msg];
        const level = a[1] === undefined ? 1 : checkInt(it, a, 1, 'traceback');
        return [it.traceback(msg === undefined ? undefined : tostr(msg), level)];
      },
    }),
  };
  interp.stringLib = libs.string;
  interp.libs = libs;
  return libs;
}

/**
 * 给一张新的全局表装上标准库。每个脚本（主脚本、require 进来的模块）各有一张自己的全局表，
 * 但 string / table / math … 这些库表在同一个 Interp 里共享。
 */
export function createGlobals(interp, chunkName = 'main') {
  const libs = interp.libs ?? createLibs(interp);
  const G = new LuaTable();
  G.chunkName = chunkName;
  const def = (name, fn) => { fn.lname = name; G.set(name, fn); };

  for (const [k, v] of Object.entries(libs)) G.set(k, v);
  G.set('_G', G);
  G.set('_VERSION', 'Lua 5.3');

  def('type', (a, it) => { checkAny(it, a, 0, 'type'); return [luaTypeName(a[0])]; });
  def('typeof', (a) => [typeofImpl(a[0])]);
  def('tostring', (a, it) => { checkAny(it, a, 0, 'tostring'); return [it.tostringValue(a[0])]; });
  def('tonumber', tonumberImpl);
  def('print', (a, it) => { it.opts.onPrint?.('log', utf8Decode(a.map((v) => it.tostringValue(v)).join('\t'))); return []; });
  def('printerr', (a, it) => { it.opts.onPrint?.('error', utf8Decode(a.map((v) => it.tostringValue(v)).join('\t'))); return []; });
  def('assert', (a, it) => {
    if (isTruthy(a[0])) return a;
    checkAny(it, a, 0, 'assert');
    const msg = a.length > 1 ? a[1] : 'assertion failed!';
    const value = typeof msg === 'string' ? utf8Encode(it.whereOf(1)) + msg : msg;
    throw new LuaError(value, { frame: it.frame });
  });
  def('error', (a, it) => {
    const level = optInt(it, a, 1, 'error', 1);
    let value = a[0];
    if (typeof value === 'string' && level > 0) value = utf8Encode(it.whereOf(level)) + value;
    throw new LuaError(value, { frame: it.frame });
  });
  def('pcall', (a, it) => {
    checkAny(it, a, 0, 'pcall');
    try { return [true, ...it.callValue(a[0], a.slice(1))]; } catch (e) { return pcallCatch(e, it); }
  });
  def('xpcall', (a, it) => {
    checkAny(it, a, 1, 'xpcall');
    const handler = a[1];
    try { return [true, ...it.callValue(a[0], a.slice(2))]; } catch (e) {
      const r = pcallCatch(e, it);
      const saved = it.frame;
      if (e instanceof LuaError && e.frame) it.frame = e.frame;          // 处理器里 debug.traceback 要看到出错时的栈
      try { return [false, it.callValue(handler, [r[1]])[0]]; } finally { it.frame = saved; }
    }
  });
  def('select', selectImpl);
  def('next', (a, it) => nextImpl(a, it));
  def('rawget', (a, it) => [checkTable(it, a, 0, 'rawget').get(a[1])]);
  def('rawset', (a, it) => { const t = checkTable(it, a, 0, 'rawset'); it.rawSet(t, a[1], a[2]); return [t]; });
  def('rawequal', (a) => {
    const x = a[0], y = a[1];
    const nums = (typeof x === 'bigint' || typeof x === 'number') && (typeof y === 'bigint' || typeof y === 'number');
    return [x === y || (nums && x == y)];   // eslint-disable-line eqeqeq
  });
  def('rawlen', (a, it) => {
    if (a[0] instanceof LuaTable) return [BigInt(a[0].length())];
    if (typeof a[0] === 'string') return [BigInt(a[0].length)];
    throw argError(it, 0, 'rawlen', 'table or string expected');
  });
  def('setmetatable', (a, it) => {
    const t = checkTable(it, a, 0, 'setmetatable');
    if (a[1] !== undefined && !(a[1] instanceof LuaTable)) throw typeError(it, a, 1, 'setmetatable', 'nil or table');
    if (a.length < 2) throw typeError(it, a, 1, 'setmetatable', 'nil or table');
    if (t.meta !== undefined && t.meta.get('__metatable') !== undefined) throw it.rtError('cannot change a protected metatable');
    t.meta = a[1];
    return [t];
  });
  def('getmetatable', (a, it) => {
    checkAny(it, a, 0, 'getmetatable');
    const t = a[0];
    if (!(t instanceof LuaTable) || t.meta === undefined) return [undefined];     // 字符串 / 宿主对象：一律 nil（契约 §7、§9）
    const prot = t.meta.get('__metatable');
    return [prot !== undefined ? prot : t.meta];
  });
  def('pairs', (a, it) => {
    checkAny(it, a, 0, 'pairs');
    const t = a[0];
    const mm = it.metamethod(t, '__pairs');
    if (mm !== undefined) { const r = it.callValue(mm, [t]); return [r[0], r[1], r[2]]; }
    // 与真机一致：pairs 本身不检查类型，迭代器在第一次调用时报「bad argument #1 to 'for iterator'」
    let keys = null;
    let i = 0;
    const iter = (args) => {
      if (!(t instanceof LuaTable)) throw typeError(it, [t], 0, 'for iterator', 'table');
      if (keys === null) keys = t.keys(interp.opts.pairsOrder ?? 'insertion');
      while (i < keys.length) {
        const k = keys[i++];
        const v = t.get(k);
        if (v !== undefined) return [k, v];
      }
      return [undefined];
    };
    iter.lname = 'for iterator';
    return [iter, t, undefined];
  });
  def('ipairs', (a, it) => {
    checkAny(it, a, 0, 'ipairs');
    const iter = (args) => {
      const t = args[0];
      const i = (typeof args[1] === 'bigint' ? args[1] : 0n) + 1n;
      if (!(t instanceof LuaTable) && !(t instanceof Host)) throw typeError(it, [t], 0, 'for iterator', 'table');
      const v = it.index(t, i);
      return v === undefined ? [undefined] : [i, v];
    };
    iter.lname = 'for iterator';
    return [iter, a[0], 0n];
  });
  def('require', (a, it) => {
    const name = checkStr(it, a, 0, 'require');
    if (!it.opts.requireHook) throw it.rtError(`module '${utf8Decode(name)}' not found`);
    return [it.opts.requireHook(name, it)];
  });
  return G;
}

/** pcall / xpcall 共用：把捕获到的 JS 异常还原成 (false, 错误值)；拦不住的（步数预算、内部错误）重新抛出 */
function pcallCatch(e, it) {
  if (e instanceof LuaError) return [false, e.value];
  if (e instanceof RangeError) return [false, it.stackOverflow().value];
  if (e instanceof ScriptTimeout) throw e;
  throw e;
}
