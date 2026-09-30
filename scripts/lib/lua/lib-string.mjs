/**
 * lib-string.mjs —— string 库（Lua 5.3 语义，字节串）
 *
 * 模式匹配器按 lstrlib.c 逐函数移植（match / max_expand / min_expand / %b / %f / 捕获 / 位置捕获 / 反向引用），
 * 字符类按 C 语言环境（只认 ASCII）。所以 ("圆"):upper() 不会动汉字的字节，("圆"):len() 是 3。
 * string.format 支持 c d i u o x X e E f F g G q s %，带 - + 空格 # 0 标志、宽度与精度。
 * 不提供 string.dump / pack / unpack（真机同样被裁掉）。
 */

import { LuaClosure, LuaTable, fmtG, isTruthy, tostr } from './value.mjs';
import { fmtExp as cExp, fmtFixed as cFixed } from './cfloat.mjs';
import { argError, checkBig, checkInt, checkNum, checkStr, makeLib, optInt, optStr, typeError } from './libutil.mjs';

const L_ESC = 37;                     // '%'
const MAXCAPTURES = 32;
const CAP_UNFINISHED = -1;
const CAP_POSITION = -2;
const MAXCCALLS = 200;

// ───────────────────────── 字符类（C 语言环境） ─────────────────────────

const isalpha = (c) => (c >= 65 && c <= 90) || (c >= 97 && c <= 122);
const isdigit = (c) => c >= 48 && c <= 57;
const islower = (c) => c >= 97 && c <= 122;
const isupper = (c) => c >= 65 && c <= 90;
const isspace = (c) => c === 32 || (c >= 9 && c <= 13);
const iscntrl = (c) => c < 32 || c === 127;
const isgraph = (c) => c >= 33 && c <= 126;
const isalnum = (c) => isalpha(c) || isdigit(c);
const ispunct = (c) => isgraph(c) && !isalnum(c);
const isxdigit = (c) => isdigit(c) || (c >= 65 && c <= 70) || (c >= 97 && c <= 102);

function matchClass(c, cl) {
  const lower = cl >= 65 && cl <= 90 ? cl + 32 : cl;
  let res;
  switch (lower) {
    case 97: res = isalpha(c); break;      // a
    case 99: res = iscntrl(c); break;      // c
    case 100: res = isdigit(c); break;     // d
    case 103: res = isgraph(c); break;     // g
    case 108: res = islower(c); break;     // l
    case 112: res = ispunct(c); break;     // p
    case 115: res = isspace(c); break;     // s
    case 117: res = isupper(c); break;     // u
    case 119: res = isalnum(c); break;     // w
    case 120: res = isxdigit(c); break;    // x
    default: return cl === c;
  }
  return isupper(cl) ? !res : res;
}

// ───────────────────────── 匹配器（移植自 lstrlib.c） ─────────────────────────

class MatchState {
  constructor(interp, src, pat) {
    this.interp = interp;
    this.src = src;
    this.pat = pat;
    this.level = 0;
    this.capture = [];
    this.matchdepth = MAXCCALLS;
  }
  reprep() { this.level = 0; this.matchdepth = MAXCCALLS; }
  err(msg) { return this.interp.rtError(msg); }
}

function classEnd(ms, p) {
  const pat = ms.pat;
  const pend = pat.length;
  const c = pat.charCodeAt(p++);
  if (c === L_ESC) {
    if (p >= pend) throw ms.err("malformed pattern (ends with '%')");
    return p + 1;
  }
  if (c === 91) {                          // [
    if (pat.charCodeAt(p) === 94) p++;     // ^
    do {
      if (p >= pend) throw ms.err("malformed pattern (missing ']')");
      const cc = pat.charCodeAt(p++);
      if (cc === L_ESC && p < pend) p++;
    } while (pat.charCodeAt(p) !== 93);    // ]
    return p + 1;
  }
  return p;
}

function matchBracketClass(ms, c, p, ec) {
  const pat = ms.pat;
  let sig = true;
  if (pat.charCodeAt(p + 1) === 94) { sig = false; p++; }
  while (++p < ec) {
    const pc = pat.charCodeAt(p);
    if (pc === L_ESC) {
      p++;
      if (matchClass(c, pat.charCodeAt(p))) return sig;
    } else if (pat.charCodeAt(p + 1) === 45 && p + 2 < ec) {    // a-z 区间
      p += 2;
      if (pat.charCodeAt(p - 2) <= c && c <= pat.charCodeAt(p)) return sig;
    } else if (pc === c) return sig;
  }
  return !sig;
}

function singleMatch(ms, s, p, ep) {
  if (s >= ms.src.length) return false;
  const c = ms.src.charCodeAt(s);
  const pc = ms.pat.charCodeAt(p);
  switch (pc) {
    case 46: return true;                                       // .
    case L_ESC: return matchClass(c, ms.pat.charCodeAt(p + 1));
    case 91: return matchBracketClass(ms, c, p, ep - 1);
    default: return pc === c;
  }
}

function matchBalance(ms, s, p) {
  if (p >= ms.pat.length - 1) throw ms.err("malformed pattern (missing arguments to '%b')");
  if (s >= ms.src.length || ms.src.charCodeAt(s) !== ms.pat.charCodeAt(p)) return -1;
  const b = ms.pat.charCodeAt(p);
  const e = ms.pat.charCodeAt(p + 1);
  let cont = 1;
  while (++s < ms.src.length) {
    const c = ms.src.charCodeAt(s);
    if (c === e) { if (--cont === 0) return s + 1; } else if (c === b) cont++;
  }
  return -1;
}

function maxExpand(ms, s, p, ep) {
  let i = 0;
  while (singleMatch(ms, s + i, p, ep)) i++;
  while (i >= 0) {
    const res = doMatch(ms, s + i, ep + 1);
    if (res !== -1) return res;
    i--;
  }
  return -1;
}

function minExpand(ms, s, p, ep) {
  for (;;) {
    const res = doMatch(ms, s, ep + 1);
    if (res !== -1) return res;
    if (singleMatch(ms, s, p, ep)) s++; else return -1;
  }
}

function startCapture(ms, s, p, what) {
  const level = ms.level;
  if (level >= MAXCAPTURES) throw ms.err('too many captures');
  ms.capture[level] = { init: s, len: what };
  ms.level = level + 1;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.level--;
  return res;
}

function captureToClose(ms) {
  for (let level = ms.level - 1; level >= 0; level--) if (ms.capture[level].len === CAP_UNFINISHED) return level;
  throw ms.err('invalid pattern capture');
}

function endCapture(ms, s, p) {
  const l = captureToClose(ms);
  ms.capture[l].len = s - ms.capture[l].init;
  const res = doMatch(ms, s, p);
  if (res === -1) ms.capture[l].len = CAP_UNFINISHED;
  return res;
}

function checkCapture(ms, l) {
  l -= 49;                                                      // '1'
  if (l < 0 || l >= ms.level || ms.capture[l].len === CAP_UNFINISHED) throw ms.err(`invalid capture index %${l + 1}`);
  return l;
}

function matchCapture(ms, s, l) {
  l = checkCapture(ms, l);
  const cap = ms.capture[l];
  const text = ms.src.substr(cap.init, cap.len);
  if (ms.src.length - s >= cap.len && ms.src.substr(s, cap.len) === text) return s + cap.len;
  return -1;
}

function doMatch(ms, s, p) {
  if (ms.matchdepth-- === 0) throw ms.err('pattern too complex');
  const pat = ms.pat;
  const pend = pat.length;
  const send = ms.src.length;
  for (;;) {
    if (p >= pend) break;
    const pc = pat.charCodeAt(p);
    let dflt = false;
    if (pc === 40) {                                            // (
      s = pat.charCodeAt(p + 1) === 41 ? startCapture(ms, s, p + 2, CAP_POSITION) : startCapture(ms, s, p + 1, CAP_UNFINISHED);
      break;
    } else if (pc === 41) {                                     // )
      s = endCapture(ms, s, p + 1);
      break;
    } else if (pc === 36 && p + 1 === pend) {                   // $ 在末尾
      s = s === send ? s : -1;
      break;
    } else if (pc === L_ESC) {
      const nx = pat.charCodeAt(p + 1);
      if (nx === 98) {                                          // %b
        s = matchBalance(ms, s, p + 2);
        if (s !== -1) { p += 4; continue; }
        break;
      } else if (nx === 102) {                                  // %f
        p += 2;
        if (pat.charCodeAt(p) !== 91) throw ms.err("missing '[' after '%f' in pattern");
        const ep = classEnd(ms, p);
        const prev = s === 0 ? 0 : ms.src.charCodeAt(s - 1);
        const cur = s < send ? ms.src.charCodeAt(s) : 0;
        if (!matchBracketClass(ms, prev, p, ep - 1) && matchBracketClass(ms, cur, p, ep - 1)) { p = ep; continue; }
        s = -1;
        break;
      } else if (nx >= 48 && nx <= 57) {                        // %0-%9 反向引用
        s = matchCapture(ms, s, nx);
        if (s !== -1) { p += 2; continue; }
        break;
      } else dflt = true;
    } else dflt = true;

    if (dflt) {
      const ep = classEnd(ms, p);
      const epc = ep < pend ? pat.charCodeAt(ep) : 0;
      if (!singleMatch(ms, s, p, ep)) {
        if (epc === 42 || epc === 63 || epc === 45) { p = ep + 1; continue; }     // * ? - 允许零次
        s = -1;
        break;
      }
      switch (epc) {
        case 63: {                                              // ?
          const res = doMatch(ms, s + 1, ep + 1);
          if (res !== -1) { s = res; break; }
          p = ep + 1;
          continue;
        }
        case 43: s++; s = maxExpand(ms, s, p, ep); break;       // +
        case 42: s = maxExpand(ms, s, p, ep); break;            // *
        case 45: s = minExpand(ms, s, p, ep); break;            // -
        default: s++; p = ep; continue;
      }
      break;
    }
  }
  ms.matchdepth++;
  return s;
}

function getOneCapture(ms, i, s, e) {
  if (i >= ms.level) {
    if (i !== 0) throw ms.err(`invalid capture index %${i + 1}`);
    return ms.src.slice(s, e);
  }
  const cap = ms.capture[i];
  if (cap.len === CAP_UNFINISHED) throw ms.err('unfinished capture');
  if (cap.len === CAP_POSITION) return BigInt(cap.init + 1);
  return ms.src.substr(cap.init, cap.len);
}

function pushCaptures(ms, s, e, wholeIfNone) {
  const n = ms.level === 0 && wholeIfNone ? 1 : ms.level;
  const out = [];
  for (let i = 0; i < n; i++) out.push(getOneCapture(ms, i, s, e));
  return out;
}

const SPECIALS = /[\^$*+?.([%-]/;

function posrelatStart(pos, len) {              // 5.3 的 posrelat：0 与过负都归到 1
  if (pos > 0) return pos;
  if (pos === 0) return 1;
  if (pos < -len) return 1;
  return len + pos + 1;
}

function strFindAux(args, interp, find) {
  const fname = find ? 'find' : 'match';
  const s = checkStr(interp, args, 0, fname);
  const p = checkStr(interp, args, 1, fname);
  const init = posrelatStart(optInt(interp, args, 2, fname, 1), s.length) - 1;
  if (init > s.length) return [undefined];
  if (find && (isTruthy(args[3]) || !SPECIALS.test(p))) {
    const at = s.indexOf(p, init);
    return at >= 0 ? [BigInt(at + 1), BigInt(at + p.length)] : [undefined];
  }
  const anchor = p.charCodeAt(0) === 94;
  const ms = new MatchState(interp, s, anchor ? p.slice(1) : p);
  let s1 = init;
  do {
    ms.reprep();
    const e = doMatch(ms, s1, 0);
    if (e !== -1) {
      if (find) return [BigInt(s1 + 1), BigInt(e), ...pushCaptures(ms, -1, -1, false)];
      return pushCaptures(ms, s1, e, true);
    }
  } while (s1++ < s.length && !anchor);
  return [undefined];
}

function gmatch(args, interp) {
  const s = checkStr(interp, args, 0, 'gmatch');
  const p = checkStr(interp, args, 1, 'gmatch');
  const ms = new MatchState(interp, s, p);
  let src = 0;
  let lastmatch = -1;
  return [() => {
    for (; src <= s.length; src++) {
      ms.reprep();
      const e = doMatch(ms, src, 0);
      if (e !== -1 && e !== lastmatch) {
        const start = src;
        src = lastmatch = e;
        return pushCaptures(ms, start, e, true);
      }
    }
    return [undefined];
  }];
}

function addS(ms, s, e, repl) {
  let out = '';
  for (let i = 0; i < repl.length; i++) {
    const ch = repl[i];
    if (ch !== '%') { out += ch; continue; }
    i++;
    const d = repl[i];
    if (d === '%') out += '%';
    else if (d !== undefined && d >= '0' && d <= '9') {
      if (d === '0') out += ms.src.slice(s, e);
      else {
        const v = getOneCapture(ms, d.charCodeAt(0) - 49, s, e);
        out += typeof v === 'bigint' ? v.toString() : v;
      }
    } else throw ms.err("invalid use of '%' in replacement string");
  }
  return out;
}

function gsub(args, interp) {
  const src = checkStr(interp, args, 0, 'gsub');
  const p = checkStr(interp, args, 1, 'gsub');
  const repl = args[2];
  const tr = repl instanceof LuaTable ? 'table' : repl instanceof LuaClosure || typeof repl === 'function' ? 'function'
    : typeof repl === 'string' || typeof repl === 'bigint' || typeof repl === 'number' ? 'string' : null;
  if (tr === null) throw typeError(interp, args, 2, 'gsub', 'string/function/table');
  const replStr = tr === 'string' ? tostr(repl) : null;
  const maxS = args[3] === undefined ? src.length + 1 : checkInt(interp, args, 3, 'gsub');
  const anchor = p.charCodeAt(0) === 94;
  const ms = new MatchState(interp, src, anchor ? p.slice(1) : p);
  let out = '';
  let n = 0;
  let s = 0;
  let lastmatch = -1;
  while (n < maxS) {
    ms.reprep();
    const e = doMatch(ms, s, 0);
    if (e !== -1 && e !== lastmatch) {
      n++;
      // add_value
      let val;
      if (tr === 'string') val = addS(ms, s, e, replStr);
      else {
        let r;
        if (tr === 'function') r = interp.callValue(repl, pushCaptures(ms, s, e, true))[0];
        else r = interp.index(repl, getOneCapture(ms, 0, s, e));
        if (r === undefined || r === false) val = src.slice(s, e);
        else if (typeof r === 'string') val = r;
        else if (typeof r === 'bigint' || typeof r === 'number') val = tostr(r);
        else throw interp.rtError(`invalid replacement value (a ${r instanceof LuaTable ? 'table' : typeof r === 'function' || r instanceof LuaClosure ? 'function' : 'userdata'})`);
      }
      out += val;
      s = lastmatch = e;
    } else if (s < src.length) out += src[s++];
    else break;
    if (anchor) break;
  }
  if (s < src.length) out += src.slice(s);
  return [out, BigInt(n)];
}

// ───────────────────────── string.format ─────────────────────────

function pad(sign, body, width, flags, zeroOk) {
  let s = sign + body;
  if (width !== undefined && s.length < width) {
    if (flags.includes('-')) s += ' '.repeat(width - s.length);
    else if (flags.includes('0') && zeroOk) s = sign + '0'.repeat(width - s.length) + body;
    else s = ' '.repeat(width - s.length) + s;
  }
  return s;
}

// %e / %f 走 cfloat.mjs：对精确平局取偶，与 C 的 printf 一致（JS 的 toFixed / toExponential 取较大者）
function fmtExp(x, prec, upper) {
  const s = cExp(x, prec);
  return upper ? s.toUpperCase() : s;
}

function fmtFixed(x, prec) { return cFixed(x, prec); }

function quoted(interp, v) {
  if (typeof v === 'string') {
    let out = '"';
    for (let i = 0; i < v.length; i++) {
      const c = v[i];
      const code = v.charCodeAt(i);
      if (c === '"') out += '\\"';
      else if (c === '\\') out += '\\\\';
      else if (c === '\n') out += '\\\n';
      else if (c === '\r') out += '\\r';
      else if (code === 0) out += /\d/.test(v[i + 1] ?? '') ? '\\000' : '\\0';
      else if (code < 32 || code === 127) out += /\d/.test(v[i + 1] ?? '') ? `\\${String(code).padStart(3, '0')}` : `\\${code}`;
      else out += c;
    }
    return `${out}"`;
  }
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'number') {       // 真实 Lua 用十六进制浮点（%a）；这里取 17 位有效数字，足够无损往返
    if (Number.isNaN(v)) return '(0/0)';
    if (!Number.isFinite(v)) return v > 0 ? '1e9999' : '-1e9999';
    return fmtG(v, 17);
  }
  if (v === undefined || typeof v === 'boolean') return tostr(v);
  throw interp.rtError("bad argument to 'format' (value has no literal form)");
}

function format(args, interp) {
  const fmt = checkStr(interp, args, 0, 'format');
  let argi = 0;
  let out = '';
  for (let i = 0; i < fmt.length;) {
    const c = fmt[i++];
    if (c !== '%') { out += c; continue; }
    if (fmt[i] === '%') { out += '%'; i++; continue; }
    const specStart = i;
    let flags = '';
    while (i < fmt.length && '-+ #0'.includes(fmt[i])) flags += fmt[i++];
    let w = '';
    while (i < fmt.length && isdigit(fmt.charCodeAt(i)) && w.length < 2) w += fmt[i++];
    let prec;
    if (fmt[i] === '.') {
      i++;
      let pr = '';
      while (i < fmt.length && isdigit(fmt.charCodeAt(i)) && pr.length < 2) pr += fmt[i++];
      prec = pr === '' ? 0 : parseInt(pr, 10);
    }
    const width = w === '' ? undefined : parseInt(w, 10);
    const conv = fmt[i++];
    if (conv === undefined) throw interp.rtError(`invalid option '%${fmt.slice(specStart)}' to 'format'`);
    argi++;
    if (argi >= args.length && conv !== '%') throw argError(interp, argi, 'format', 'no value');
    switch (conv) {
      case 'c': out += pad('', String.fromCharCode(Number(checkBig(interp, args, argi, 'format')) & 255), width, flags, false); break;
      case 'd': case 'i': {
        const v = checkBig(interp, args, argi, 'format');
        const neg = v < 0n;
        let digits = (neg ? -v : v).toString();
        if (prec !== undefined) digits = digits.padStart(prec, '0');
        const sign = neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        out += pad(sign, digits, width, flags, prec === undefined);
        break;
      }
      case 'u': case 'o': case 'x': case 'X': {
        const v = BigInt.asUintN(64, checkBig(interp, args, argi, 'format'));
        let digits = v.toString(conv === 'u' ? 10 : conv === 'o' ? 8 : 16);
        if (conv === 'X') digits = digits.toUpperCase();
        if (prec !== undefined) digits = digits.padStart(prec, '0');
        let prefix = '';
        if (flags.includes('#') && v !== 0n) prefix = conv === 'x' ? '0x' : conv === 'X' ? '0X' : conv === 'o' ? '0' : '';
        out += pad(prefix, digits, width, flags, prec === undefined);
        break;
      }
      case 'e': case 'E': case 'f': case 'F': case 'g': case 'G': {
        const x = Number(checkNum(interp, args, argi, 'format'));
        const upper = conv === 'E' || conv === 'F' || conv === 'G';
        const neg = x < 0 || Object.is(x, -0);
        const sign = neg ? '-' : flags.includes('+') ? '+' : flags.includes(' ') ? ' ' : '';
        const ax = Math.abs(x);
        let body;
        if (!Number.isFinite(x)) body = Number.isNaN(x) ? 'nan' : 'inf';
        else if (conv === 'f' || conv === 'F') body = fmtFixed(ax, prec ?? 6);
        else if (conv === 'e' || conv === 'E') body = fmtExp(ax, prec ?? 6, false);
        else body = fmtG(ax, prec === undefined ? 6 : prec === 0 ? 1 : prec, flags.includes('#'));
        if (upper) body = body.toUpperCase();
        out += pad(Number.isNaN(x) ? (flags.includes('+') ? '+' : '') : sign, body, width, flags, Number.isFinite(x));
        break;
      }
      case 's': {
        let s = interp.tostringValue(args[argi]);
        if (prec !== undefined) s = s.slice(0, prec);
        out += pad('', s, width, flags.replace('0', ''), false);
        break;
      }
      case 'q': out += quoted(interp, args[argi]); break;
      default: throw interp.rtError(`invalid option '%${fmt.slice(specStart, i)}' to 'format'`);
    }
  }
  return [out];
}

// ───────────────────────── 库 ─────────────────────────

function posrelat(pos, len) {
  if (pos >= 0) return pos;
  if (-pos > len) return 0;
  return len + pos + 1;
}
function endpos(pos, len) {
  if (pos > len) return len;
  if (pos >= 0) return pos;
  if (pos < -len) return 0;
  return len + pos + 1;
}

const upperAscii = (s) => s.replace(/[a-z]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 32));
const lowerAscii = (s) => s.replace(/[A-Z]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 32));

export function createStringLib() {
  return makeLib({
    len: (a, it) => [BigInt(checkStr(it, a, 0, 'len').length)],
    sub: (a, it) => {
      const s = checkStr(it, a, 0, 'sub');
      let start = posrelat(checkInt(it, a, 1, 'sub'), s.length);
      const end = endpos(optInt(it, a, 2, 'sub', -1), s.length);
      if (start < 1) start = 1;
      return [start <= end ? s.slice(start - 1, end) : ''];
    },
    upper: (a, it) => [upperAscii(checkStr(it, a, 0, 'upper'))],
    lower: (a, it) => [lowerAscii(checkStr(it, a, 0, 'lower'))],
    rep: (a, it) => {
      const s = checkStr(it, a, 0, 'rep');
      const n = checkInt(it, a, 1, 'rep');
      const sep = optStr(it, a, 2, 'rep', '');
      if (n <= 0) return [''];
      if ((s.length + sep.length) * n > 1 << 28) throw it.rtError('resulting string too large');
      return [sep === '' ? s.repeat(n) : (s + sep).repeat(n - 1) + s];
    },
    reverse: (a, it) => [[...checkStr(it, a, 0, 'reverse')].reverse().join('')],
    byte: (a, it) => {
      const s = checkStr(it, a, 0, 'byte');
      const i0 = optInt(it, a, 1, 'byte', 1);
      let start = posrelat(i0, s.length);
      let end = endpos(optInt(it, a, 2, 'byte', start), s.length);
      if (start < 1) start = 1;
      const out = [];
      for (let k = start; k <= end; k++) out.push(BigInt(s.charCodeAt(k - 1)));
      return out;
    },
    char: (a, it) => {
      let out = '';
      for (let i = 0; i < a.length; i++) {
        const c = checkInt(it, a, i, 'char');
        if (c < 0 || c > 255) throw argError(it, i, 'char', 'value out of range');
        out += String.fromCharCode(c);
      }
      return [out];
    },
    format,
    find: (a, it) => strFindAux(a, it, true),
    match: (a, it) => strFindAux(a, it, false),
    gmatch,
    gsub,
  });
}
