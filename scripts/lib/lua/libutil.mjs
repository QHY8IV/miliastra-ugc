/**
 * libutil.mjs —— 标准库原生函数的参数检查（报错文案对齐 lauxlib 的 luaL_argerror / luaL_typeerror）
 *
 * 原生函数签名：(args: any[], interp: Interp) => any[] | undefined
 * 这里的 i 都是 0 起的下标，报错时转成 Lua 习惯的 #1 起。
 */

import { LuaTable, Host, luaTypeName, str2num, toInteger, tostr, utf8Encode } from './value.mjs';

export function luaTypeNameVerbose(v) {
  return v instanceof Host ? v.typeName : luaTypeName(v);
}

/** bad argument #1 to 'insert' (table expected, got nil) */
export function typeError(interp, args, i, fname, expected) {
  const got = i >= args.length ? 'no value' : luaTypeNameVerbose(args[i]);
  return interp.rtError(`bad argument #${i + 1} to '${fname}' (${expected} expected, got ${got})`);
}

export function argError(interp, i, fname, msg) {
  return interp.rtError(`bad argument #${i + 1} to '${fname}' (${msg})`);
}

/** 整数参数 → BigInt（有精确整数值的浮点、可转整数的字符串都接受） */
export function checkBig(interp, args, i, fname) {
  const v = args[i];
  if (typeof v === 'bigint') return v;
  const n = typeof v === 'string' ? str2num(v) : v;
  if (typeof n === 'number' || typeof n === 'bigint') {
    const b = toInteger(n);
    if (b === undefined) throw argError(interp, i, fname, 'number has no integer representation');
    return b;
  }
  throw typeError(interp, args, i, fname, 'number');
}

/** 整数参数 → JS number（位置、长度、次数这类用；超出安全范围时精度会丢，但这类参数不会那么大） */
export function checkInt(interp, args, i, fname) {
  return Number(checkBig(interp, args, i, fname));
}

export function optInt(interp, args, i, fname, def) {
  return args[i] === undefined ? def : checkInt(interp, args, i, fname);
}

/** 数字参数 → bigint | number（字符串按规则转换） */
export function checkNum(interp, args, i, fname) {
  const v = args[i];
  if (typeof v === 'bigint' || typeof v === 'number') return v;
  if (typeof v === 'string') { const n = str2num(v); if (n !== undefined) return n; }
  throw typeError(interp, args, i, fname, 'number');
}

/** 数字参数 → JS number（浮点） */
export function checkFloat(interp, args, i, fname) {
  return Number(checkNum(interp, args, i, fname));
}

/** 字符串参数（数字会被转成字符串，和 lua_tolstring 一样） */
export function checkStr(interp, args, i, fname) {
  const v = args[i];
  if (typeof v === 'string') return v;
  if (typeof v === 'bigint' || typeof v === 'number') return tostr(v);
  throw typeError(interp, args, i, fname, 'string');
}

export function optStr(interp, args, i, fname, def) {
  return args[i] === undefined ? def : checkStr(interp, args, i, fname);
}

export function checkTable(interp, args, i, fname) {
  if (!(args[i] instanceof LuaTable)) throw typeError(interp, args, i, fname, 'table');
  return args[i];
}

export function checkAny(interp, args, i, fname) {
  if (i >= args.length) throw argError(interp, i, fname, 'value expected');
  return args[i];
}

/** 把 JS 对象里的函数登记成 Lua 表（函数自动带上名字，报错用） */
export function makeLib(fns, consts = {}) {
  const t = new LuaTable();
  for (const [k, f] of Object.entries(fns)) { f.lname = k; t.set(utf8Encode(k), f); }
  for (const [k, v] of Object.entries(consts)) t.set(utf8Encode(k), v);
  return t;
}
