/**
 * codec.mjs —— 按 schema（proto.mjs 的产物）在「protobuf 二进制 ⇄ 带名字的 JS 对象」之间转换
 *
 * 设计要点
 *   1. 无损：schema 里没有的字段不丢，收进对象的 `_u` 数组；编码时原样写回。
 *   2. 在场即有效：只有线上出现过的字段才会成为对象的键（不补默认值），
 *      所以「字段在不在」这一信息也被保留（消息型字段 `{}` 与缺省是两回事）。
 *   3. 规范编码：编码时按字段号升序输出、重复字段保持数组顺序。
 *      【实测】50 个官方样本里游戏写出的 protobuf 全部是这种规范形态
 *      （字段升序、不写零值），所以对完全被 schema 覆盖的消息，解码再编码能字节级还原。
 *   4. 数值表示（对 JSON 友好）：32 位整数与枚举 → number；64 位整数在安全范围内 → number，
 *      超出则 → 十进制字符串；bytes → "0x…" 十六进制字符串；枚举有名字时 → 名字字符串。
 *      编码时数值字段接受 number / bigint / 数字字符串，枚举接受名字或数字。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { WT, parseFields, readVarint, serializeField, writeVarint } from './wire.mjs';

const utf8Strict = new TextDecoder('utf-8', { fatal: true });

const VARINT_TYPES = new Set(['int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64', 'bool']);
const FIXED32_TYPES = new Set(['fixed32', 'sfixed32', 'float']);
const FIXED64_TYPES = new Set(['fixed64', 'sfixed64', 'double']);

/** 该字段类型在线上的 wire type（不含打包情形） */
function scalarWireType(fd) {
  if (fd.kind === 'enum') return WT.VARINT;
  if (fd.kind === 'message') return WT.LEN;
  if (VARINT_TYPES.has(fd.type)) return WT.VARINT;
  if (FIXED32_TYPES.has(fd.type)) return WT.I32;
  if (FIXED64_TYPES.has(fd.type)) return WT.I64;
  return WT.LEN; // string / bytes
}

const isPackable = (fd) => fd.repeated && fd.kind !== 'message' && fd.type !== 'string' && fd.type !== 'bytes';

// ─────────────────────────── 数值换算 ───────────────────────────

const bigToJs = (b) => (b >= BigInt(Number.MIN_SAFE_INTEGER) && b <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(b) : b.toString());

function toBig(x, what) {
  if (typeof x === 'bigint') return x;
  if (typeof x === 'number') {
    if (!Number.isInteger(x)) throw new Error(`${what} 需要整数，得到 ${x}`);
    return BigInt(x);
  }
  if (typeof x === 'string' && /^-?\d+$/.test(x)) return BigInt(x);
  if (typeof x === 'boolean') return x ? 1n : 0n;
  throw new Error(`${what} 需要整数，得到 ${JSON.stringify(x)}`);
}

const zigzagDecode = (v) => (v >> 1n) ^ -(v & 1n);
const zigzagEncode = (n, bits) => BigInt.asUintN(bits, (n << 1n) ^ (n >> BigInt(bits - 1)));

const hexOf = (buf) => `0x${Buffer.from(buf).toString('hex')}`;
function bytesFromJs(x, what) {
  if (Buffer.isBuffer(x) || x instanceof Uint8Array) return Buffer.from(x);
  if (typeof x === 'string' && /^0x([0-9a-fA-F]{2})*$/.test(x)) return Buffer.from(x.slice(2), 'hex');
  throw new Error(`${what} 需要 bytes（"0x…" 十六进制字符串或 Buffer）`);
}

// ─────────────────────────── 解码 ───────────────────────────

/**
 * @param {object} schema  parseProto 的结果
 * @param {string|object} msg  消息全名或 MessageDef
 * @param {Buffer|Array} input  二进制，或已解析的 Field[]
 * @param {object} [opts]
 *   onMismatch(path, fieldDef, wireField)  线上类型与 schema 不符时回调（该字段转入 _u）
 *   stats: Map  统计每个消息路径下未知字段的数量与字节
 *   guess: true  未知的 len 字段按嵌套消息/文本结构化展开（无损，见 unknownOf）
 */
export function decodeMessage(schema, msg, input, opts = {}) {
  const def = typeof msg === 'string' ? mustMessage(schema, msg) : msg;
  const fields = Buffer.isBuffer(input) || input instanceof Uint8Array ? parseFields(Buffer.from(input)) : input;
  return decodeFields(schema, def, fields, opts, def.fullName);
}

function mustMessage(schema, name) {
  const def = schema.messages.get(name);
  if (!def) throw new Error(`schema 里没有消息类型 ${name}`);
  return def;
}

function decodeFields(schema, def, fields, opts, path) {
  const obj = {};
  const unknown = [];
  for (const f of fields) {
    const fd = def.fields.get(f.fn);
    if (!fd) { unknown.push(unknownOf(f, opts.guess)); noteUnknown(opts, path, f, false); continue; }

    // schema 说是单值、线上却重复出现：后来的不覆盖，转入 _u 保数据，并上报
    if (!fd.repeated && Object.hasOwn(obj, fd.name)) {
      opts.onMismatch?.(`${path}.${fd.name}`, fd, f, new Error('单值字段重复出现'));
      unknown.push(unknownOf(f, opts.guess)); noteUnknown(opts, path, f, true);
      continue;
    }

    const expect = scalarWireType(fd);
    const packed = isPackable(fd) && f.wt === WT.LEN;
    if (f.wt !== expect && !packed) {
      opts.onMismatch?.(`${path}.${fd.name}`, fd, f);
      unknown.push(unknownOf(f, opts.guess)); noteUnknown(opts, path, f, true);
      continue;
    }

    let value;
    try {
      value = packed ? decodePacked(schema, fd, f) : decodeSingle(schema, fd, f, opts, `${path}.${fd.name}`);
    } catch (e) {
      // 例如字符串不是合法 UTF-8、子消息解析失败：不丢数据，转入 _u
      opts.onMismatch?.(`${path}.${fd.name}`, fd, f, e);
      unknown.push(unknownOf(f, opts.guess)); noteUnknown(opts, path, f, true);
      continue;
    }

    if (fd.repeated) {
      (obj[fd.name] ??= []);
      if (packed) obj[fd.name].push(...value); else obj[fd.name].push(value);
    } else {
      obj[fd.name] = value;
    }
  }
  if (unknown.length) obj._u = unknown;
  return obj;
}

function noteUnknown(opts, path, f, mismatch) {
  if (!opts.stats) return;
  const key = `${path}#${f.fn}${mismatch ? '!' : ''}`;
  const e = opts.stats.get(key) || { n: 0, bytes: 0 };
  e.n++;
  e.bytes += f.wt === WT.LEN ? f.raw.length : f.wt === WT.VARINT ? 1 : f.raw.length;
  opts.stats.set(key, e);
}

function decodeSingle(schema, fd, f, opts, path) {
  switch (fd.kind) {
    case 'message': return decodeFields(schema, fd.ref, parseFields(f.raw), opts, path);
    case 'enum': {
      const n = Number(BigInt.asIntN(32, f.v));
      return fd.ref.byNumber.get(n) ?? n;
    }
    default: return decodeScalar(fd.type, f);
  }
}

function decodeScalar(type, f) {
  switch (type) {
    case 'int32': return Number(BigInt.asIntN(32, f.v));
    case 'int64': return bigToJs(BigInt.asIntN(64, f.v));
    case 'uint32': return Number(BigInt.asUintN(32, f.v));
    case 'uint64': return bigToJs(BigInt.asUintN(64, f.v));
    case 'sint32': return Number(BigInt.asIntN(32, zigzagDecode(f.v)));
    case 'sint64': return bigToJs(BigInt.asIntN(64, zigzagDecode(f.v)));
    case 'bool': return f.v !== 0n;
    case 'float': return f.raw.readFloatLE(0);
    case 'double': return f.raw.readDoubleLE(0);
    case 'fixed32': return f.raw.readUInt32LE(0);
    case 'sfixed32': return f.raw.readInt32LE(0);
    case 'fixed64': return bigToJs(f.raw.readBigUInt64LE(0));
    case 'sfixed64': return bigToJs(f.raw.readBigInt64LE(0));
    case 'string': return utf8Strict.decode(f.raw);
    case 'bytes': return hexOf(f.raw);
    default: throw new Error(`未知标量类型 ${type}`);
  }
}

function decodePacked(schema, fd, f) {
  const out = [];
  const raw = f.raw;
  if (fd.kind === 'enum' || VARINT_TYPES.has(fd.type)) {
    let p = 0;
    while (p < raw.length) {
      const [v, np] = readVarint(raw, p);
      p = np;
      out.push(decodeSingle(schema, fd, { fn: f.fn, wt: WT.VARINT, v }, {}, ''));
    }
  } else {
    const size = FIXED32_TYPES.has(fd.type) ? 4 : 8;
    if (raw.length % size) throw new Error(`打包的 ${fd.type} 数组长度 ${raw.length} 不是 ${size} 的倍数`);
    for (let p = 0; p < raw.length; p += size) {
      out.push(decodeScalar(fd.type, { fn: f.fn, wt: size === 4 ? WT.I32 : WT.I64, raw: raw.subarray(p, p + size) }));
    }
  }
  return out;
}

/**
 * 未知字段 → 可 JSON 化的记录。
 *   { f, w:'varint', v } / { f, w:'i64'|'i32', hex } / { f, w:'len', hex, text? }
 * 猜测模式（decode 选项 guess:true 或 guessUnknown(fields)）会把 len 字段进一步结构化：
 *   { f, w:'len', msg:[…同样的记录…] }   嵌套消息
 *   { f, w:'len', text }                 文本
 * 只有「结构化后重新序列化，字节与原文完全一致」才采用，否则退回 hex——所以猜测永远无损。
 * 编码时优先级：msg > text > hex（`text` 仅展示用时与 hex 并存，此时以 hex 为准）。
 */
function unknownOf(f, guess = false) {
  switch (f.wt) {
    case WT.VARINT: return { f: f.fn, w: 'varint', v: bigToJs(f.v) };
    case WT.I64: return { f: f.fn, w: 'i64', hex: hexOf(f.raw) };
    case WT.I32: return { f: f.fn, w: 'i32', hex: hexOf(f.raw) };
    default: {
      if (guess) {
        const g = guessLen(f.raw);
        if (g) return { f: f.fn, w: 'len', ...g };
      }
      const rec = { f: f.fn, w: 'len', hex: hexOf(f.raw) };
      const s = asPrintableText(f.raw);
      if (s) rec.text = s;
      return rec;
    }
  }
}

function asPrintableText(raw) {
  if (!raw.length) return null;
  try {
    const s = utf8Strict.decode(raw);
    return /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s) ? null : s;
  } catch { return null; }
}

/** 猜一段 len 字段的内容：能无损还原的嵌套消息 → {msg}，可读文本 → {text}，否则 null（调用方落回 hex） */
function guessLen(raw) {
  if (!raw.length) return { text: '' };
  const text = asPrintableText(raw);
  if (text !== null) return { text };
  let fields;
  try { fields = parseFields(raw); } catch { return null; }
  if (!fields.length) return null;
  const msg = fields.map((f) => unknownOf(f, true));
  // 无损检验：结构化后再写回，必须与原文字节一致
  try {
    if (Buffer.compare(serializeUnknownList(msg), raw) !== 0) return null;
  } catch { return null; }
  return { msg };
}

/** 对一组 Field 做猜测式结构化（供检查/导出使用） */
export function guessUnknown(fields) {
  return fields.map((f) => unknownOf(f, true));
}

/** 按记录顺序写回（不排序，以保证猜测出来的嵌套消息字节级还原） */
function serializeUnknownList(list) {
  return Buffer.concat(list.map((u) => serializeField(unknownToField(u))));
}

function unknownToField(u) {
  switch (u.w) {
    case 'varint': return { fn: u.f, wt: WT.VARINT, v: toBig(u.v, '_u.v') };
    case 'i64': return { fn: u.f, wt: WT.I64, raw: bytesFromJs(u.hex, '_u.hex') };
    case 'i32': return { fn: u.f, wt: WT.I32, raw: bytesFromJs(u.hex, '_u.hex') };
    case 'len':
      if (Array.isArray(u.msg)) return { fn: u.f, wt: WT.LEN, raw: serializeUnknownList(u.msg) };
      if (u.hex !== undefined) return { fn: u.f, wt: WT.LEN, raw: bytesFromJs(u.hex, '_u.hex') };
      if (typeof u.text === 'string') return { fn: u.f, wt: WT.LEN, raw: Buffer.from(u.text, 'utf8') };
      throw new Error('_u 的 len 记录需要 msg / hex / text 之一');
    default: throw new Error(`_u 里未知的类型 ${u.w}`);
  }
}

// ─────────────────────────── 编码 ───────────────────────────

/** 对象 → 二进制（不含容器头尾） */
export function encodeMessage(schema, msg, obj) {
  const def = typeof msg === 'string' ? mustMessage(schema, msg) : msg;
  return encodeObject(schema, def, obj, def.fullName);
}

function encodeObject(schema, def, obj, path) {
  const parts = []; // { fn, buf }
  for (const [key, val] of Object.entries(obj)) {
    if (key === '_u' || val === undefined || val === null) continue;
    const fd = def.byName.get(key);
    if (!fd) throw new Error(`${path}: schema 里没有字段 "${key}"（消息 ${def.fullName}）`);
    const here = `${path}.${key}`;
    if (fd.repeated) {
      if (!Array.isArray(val)) throw new Error(`${here} 应为数组`);
      if (isPackable(fd)) {
        if (val.length) parts.push({ fn: fd.number, buf: serializeField({ fn: fd.number, wt: WT.LEN, raw: encodePackedBody(schema, fd, val, here) }) });
      } else {
        val.forEach((el, i) => parts.push({ fn: fd.number, buf: serializeField(toField(schema, fd, el, `${here}[${i}]`)) }));
      }
    } else {
      parts.push({ fn: fd.number, buf: serializeField(toField(schema, fd, val, here)) });
    }
  }
  for (const u of obj._u || []) parts.push({ fn: u.f, buf: serializeField(unknownToField(u)) });
  // 稳定排序：同字段号（重复字段）保持原顺序
  parts.sort((a, b) => a.fn - b.fn);
  return Buffer.concat(parts.map((p) => p.buf));
}

function toField(schema, fd, value, path) {
  if (fd.kind === 'message') {
    if (typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} 应为对象`);
    return { fn: fd.number, wt: WT.LEN, raw: encodeObject(schema, fd.ref, value, path) };
  }
  if (fd.kind === 'enum') return { fn: fd.number, wt: WT.VARINT, v: enumToBig(fd, value, path) };
  return scalarToField(fd.type, fd.number, value, path);
}

function enumToBig(fd, value, path) {
  if (typeof value === 'string' && !/^-?\d+$/.test(value)) {
    if (!fd.ref.values.has(value)) throw new Error(`${path}: 枚举 ${fd.ref.fullName} 没有名字 "${value}"`);
    return BigInt(fd.ref.values.get(value));
  }
  return toBig(value, path);
}

function scalarToField(type, fn, value, path) {
  switch (type) {
    case 'int32': case 'int64': case 'uint32': case 'uint64':
      return { fn, wt: WT.VARINT, v: toBig(value, path) };
    case 'sint32': return { fn, wt: WT.VARINT, v: zigzagEncode(toBig(value, path), 32) };
    case 'sint64': return { fn, wt: WT.VARINT, v: zigzagEncode(toBig(value, path), 64) };
    case 'bool': return { fn, wt: WT.VARINT, v: value ? 1n : 0n };
    case 'float': { const b = Buffer.alloc(4); b.writeFloatLE(Number(value)); return { fn, wt: WT.I32, raw: b }; }
    case 'double': { const b = Buffer.alloc(8); b.writeDoubleLE(Number(value)); return { fn, wt: WT.I64, raw: b }; }
    case 'fixed32': { const b = Buffer.alloc(4); b.writeUInt32LE(Number(value)); return { fn, wt: WT.I32, raw: b }; }
    case 'sfixed32': { const b = Buffer.alloc(4); b.writeInt32LE(Number(value)); return { fn, wt: WT.I32, raw: b }; }
    case 'fixed64': { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt.asUintN(64, toBig(value, path))); return { fn, wt: WT.I64, raw: b }; }
    case 'sfixed64': { const b = Buffer.alloc(8); b.writeBigInt64LE(BigInt.asIntN(64, toBig(value, path))); return { fn, wt: WT.I64, raw: b }; }
    case 'string':
      if (typeof value !== 'string') throw new Error(`${path} 应为字符串`);
      return { fn, wt: WT.LEN, raw: Buffer.from(value, 'utf8') };
    case 'bytes': return { fn, wt: WT.LEN, raw: bytesFromJs(value, path) };
    default: throw new Error(`未知标量类型 ${type}`);
  }
}

function encodePackedBody(schema, fd, list, path) {
  const chunks = [];
  list.forEach((el, i) => {
    const f = fd.kind === 'enum' ? { wt: WT.VARINT, v: enumToBig(fd, el, `${path}[${i}]`) } : scalarToField(fd.type, 1, el, `${path}[${i}]`);
    if (f.wt === WT.VARINT) chunks.push(writeVarint(f.v)); else chunks.push(f.raw);
  });
  return Buffer.concat(chunks);
}

// ─────────────────────────── 工具 ───────────────────────────

/** 深比较两个解码结果（用于测试）：相等返回 null，否则返回第一处差异的路径 */
export function firstDiff(a, b, path = '') {
  if (a === b) return null;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return `${path}: ${JSON.stringify(a)} ≠ ${JSON.stringify(b)}`;
  if (Array.isArray(a) !== Array.isArray(b)) return `${path}: 数组/对象不一致`;
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  for (const k of keys) {
    if (!(k in a)) return `${path}.${k}: 左侧缺失`;
    if (!(k in b)) return `${path}.${k}: 右侧缺失`;
    const d = firstDiff(a[k], b[k], `${path}.${k}`);
    if (d) return d;
  }
  return null;
}

export { parseFields };
