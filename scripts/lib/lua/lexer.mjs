/**
 * lexer.mjs —— Lua 5.3 词法分析（输入是字节串，见 value.mjs）
 *
 * 与 Lua 5.3 的 llex.c 对齐的地方：
 *   · 换行统一：\r\n、\n\r、\r 都算一个换行（先整体规范成 \n，行号因此与真机一致）
 *   · 字符串转义：\a \b \f \n \r \t \v \\ \" \' \换行 \xXX \ddd(≤255) \z \u{XXX}；其它转义是错误
 *   · 长括号字符串/注释，开头紧跟的第一个换行被吞掉
 *   · 数字：整数 / 浮点 / 十六进制（含 p 指数）；数字后面紧跟字母是 malformed number
 *   · 标识符只认 ASCII 字母数字下划线（真机 C 语言环境下同样）——全角括号、中文标点会报 unexpected symbol
 *   · 5.4 才有的 <const> / <close> 在 5.3 里是语法错误，这里不认（真机是 Lua 5.3）
 * 错误信息沿用 Lua 的写法：「块名:行号: 消息 near 'xxx'」。
 */

import { LuaSyntaxError, str2num, utf8Encode } from './value.mjs';

export const KEYWORDS = new Set([
  'and', 'break', 'do', 'else', 'elseif', 'end', 'false', 'for', 'function', 'goto', 'if', 'in',
  'local', 'nil', 'not', 'or', 'repeat', 'return', 'then', 'true', 'until', 'while',
]);

/** 词法错误里「near」后面要显示的文本（对应 Lua 的 txtToken） */
export function tokenText(tok) {
  if (!tok) return '<eof>';
  if (tok.type === 'eof') return '<eof>';
  const raw = tok.raw ?? String(tok.value);
  return `'${printable(raw)}'`;
}

function printable(s) {
  let out = '';
  for (const ch of s) {
    const c = ch.charCodeAt(0);
    out += c >= 32 && c < 127 ? ch : `<\\${c}>`;
  }
  return out;
}

export function normalizeNewlines(src) {
  return src.replace(/\r\n|\n\r|\r/g, '\n');
}

/**
 * @param {string} srcBytes  字节串源码
 * @param {string} chunk     块名（错误信息前缀）
 * @returns {Array<{type:'name'|'kw'|'str'|'num'|'op'|'eof', value:any, line:number, raw:string}>}
 */
export function lex(srcBytes, chunk = 'main') {
  const src = normalizeNewlines(srcBytes);
  const n = src.length;
  const toks = [];
  let i = 0;
  let line = 1;

  const fail = (msg, near, atLine = line) => {
    throw new LuaSyntaxError(`${chunk}:${atLine}: ${msg}${near === undefined ? '' : ` near ${near}`}`, atLine);
  };
  const push = (type, value, raw, atLine = line) => toks.push({ type, value, line: atLine, raw });

  // 长括号 [==[ ... ]==]：返回 {level, start}（start 是内容起点）或 null
  const longOpen = (at) => {
    let j = at + 1;
    let level = 0;
    while (src[j] === '=') { level++; j++; }
    return src[j] === '[' ? { level, start: j + 1 } : null;
  };
  const readLong = (lb, what) => {
    const close = `]${'='.repeat(lb.level)}]`;
    const end = src.indexOf(close, lb.start);
    const startLine = line;
    if (end < 0) {
      line += (src.slice(lb.start).match(/\n/g) || []).length;
      fail(`unfinished long ${what} (starting at line ${startLine})`, '<eof>');
    }
    let s = src.slice(lb.start, end);
    line += (s.match(/\n/g) || []).length;
    if (s.startsWith('\n')) s = s.slice(1);
    i = end + close.length;
    return s;
  };

  while (i < n) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    if (c === ' ' || c === '\t' || c === '\v' || c === '\f') { i++; continue; }

    // 注释
    if (c === '-' && src[i + 1] === '-') {
      i += 2;
      if (src[i] === '[') {
        const lb = longOpen(i);
        if (lb) { readLong(lb, 'comment'); continue; }
      }
      while (i < n && src[i] !== '\n') i++;
      continue;
    }

    // 短字符串
    if (c === '"' || c === "'") {
      const startLine = line;
      const startAt = i;
      let j = i + 1;
      let out = '';
      for (;;) {
        if (j >= n) fail('unfinished string', '<eof>');
        const ch = src[j];
        if (ch === c) break;
        if (ch === '\n') fail('unfinished string', `'${printable(src.slice(startAt, j))}'`);
        if (ch !== '\\') { out += ch; j++; continue; }
        j++;
        const e = src[j];
        const simple = { a: '\x07', b: '\b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', '"': '"', "'": "'" };
        if (e !== undefined && e in simple) { out += simple[e]; j++; }
        else if (e === '\n') { out += '\n'; line++; j++; }
        else if (e === 'x') {
          const h = /^[0-9a-fA-F]{2}/.exec(src.slice(j + 1, j + 3));
          if (!h) fail('hexadecimal digit expected', `'${printable(src.slice(startAt, j + 3))}'`);
          out += String.fromCharCode(parseInt(h[0], 16));
          j += 3;
        } else if (e === 'z') {
          j++;
          while (j < n && /[ \t\v\f\n]/.test(src[j])) { if (src[j] === '\n') line++; j++; }
        } else if (e === 'u') {
          const m = /^\{([0-9a-fA-F]+)\}/.exec(src.slice(j + 1));
          if (!m) fail("missing '{' in \\u{xxxx}", `'${printable(src.slice(startAt, j + 2))}'`);
          const cp = parseInt(m[1], 16);
          if (cp > 0x7fffffff) fail('UTF-8 value too large', `'${printable(src.slice(startAt, j + 1 + m[0].length))}'`);
          out += utf8Bytes(cp);
          j += 1 + m[0].length;
        } else if (e !== undefined && e >= '0' && e <= '9') {
          const m = /^\d{1,3}/.exec(src.slice(j));
          const v = parseInt(m[0], 10);
          if (v > 255) fail('decimal escape too large', `'${printable(src.slice(startAt, j + m[0].length))}'`);
          out += String.fromCharCode(v);
          j += m[0].length;
        } else {
          fail('invalid escape sequence', `'${printable(src.slice(startAt, j + 1))}'`);
        }
      }
      push('str', out, src.slice(startAt, j + 1), startLine);
      i = j + 1;
      continue;
    }

    // 长字符串
    if (c === '[') {
      const lb = longOpen(i);
      if (lb) {
        const startLine = line;
        const startAt = i;
        const s = readLong(lb, 'string');
        push('str', s, src.slice(startAt, i), startLine);
        continue;
      }
      if (src[i + 1] === '=') fail('invalid long string delimiter', `'${src.slice(i, i + 2)}'`);
    }

    // 数字
    if ((c >= '0' && c <= '9') || (c === '.' && src[i + 1] >= '0' && src[i + 1] <= '9')) {
      let j = i;
      const hex = c === '0' && (src[i + 1] === 'x' || src[i + 1] === 'X');
      if (hex) j += 2;
      const expChars = hex ? 'pP' : 'eE';
      for (;;) {
        const ch = src[j];
        if (ch === undefined) break;
        if (expChars.includes(ch) && (src[j + 1] === '+' || src[j + 1] === '-')) { j += 2; continue; }
        if (/[0-9a-zA-Z_.]/.test(ch)) { j++; continue; }
        break;
      }
      const text = src.slice(i, j);
      const v = str2num(text);
      if (v === undefined) fail('malformed number', `'${text}'`);
      push('num', v, text);
      i = j;
      continue;
    }

    // 标识符 / 关键字
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_') {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_]/.test(src[j])) j++;
      const word = src.slice(i, j);
      push(KEYWORDS.has(word) ? 'kw' : 'name', word, word);
      i = j;
      continue;
    }

    // 运算符
    const three = src.slice(i, i + 3);
    if (three === '...') { push('op', '...', '...'); i += 3; continue; }
    const two = src.slice(i, i + 2);
    if (two === '==' || two === '~=' || two === '<=' || two === '>=' || two === '//' || two === '..'
      || two === '<<' || two === '>>' || two === '::') {
      push('op', two, two); i += 2; continue;
    }
    if ('+-*/%^#&~|<>=(){}[];:,.'.includes(c)) { push('op', c, c); i++; continue; }

    fail('unexpected symbol', `'${printable(c)}'`);
  }

  toks.push({ type: 'eof', value: '<eof>', line, raw: '<eof>' });
  return toks;
}

/** 码点 → UTF-8 字节串（\u{...}，最多 6 字节形式，与 Lua 一致） */
function utf8Bytes(cp) {
  if (cp < 0x80) return String.fromCharCode(cp);
  if (cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff)) return utf8Encode(String.fromCodePoint(cp));
  const bytes = [];
  let mfb = 0x3f;
  let x = cp;
  do { bytes.unshift(0x80 | (x & 0x3f)); x >>= 6; mfb >>= 1; } while (x > mfb);
  bytes.unshift(((~mfb << 1) & 0xff) | x);
  return String.fromCharCode(...bytes);
}
