/**
 * wire.mjs —— 无损 protobuf 线格式（wire format）编解码
 *
 * 只认线格式，不认 schema：任何一段 protobuf 都能解成 Field[] 再原样写回。
 * 上层（codec.mjs）在它之上按 .proto 把字段翻译成有名字的对象。
 *
 * Field 形状（fn = 字段号）：
 *   varint  { fn, wt: 0, v: BigInt }
 *   fixed64 { fn, wt: 1, raw: Buffer(8) }
 *   len     { fn, wt: 2, raw: Buffer }          字符串 / bytes / 嵌套消息 / 打包数组
 *   fixed32 { fn, wt: 5, raw: Buffer(4) }
 * 不支持 group（wt 3/4）——千星奇域的存档里没有出现过。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

export const WT = Object.freeze({ VARINT: 0, I64: 1, LEN: 2, SGROUP: 3, EGROUP: 4, I32: 5 });

export class WireError extends Error {
  constructor(msg, offset) {
    super(offset == null ? msg : `${msg}（偏移 ${offset}）`);
    this.name = 'WireError';
    this.offset = offset;
  }
}

// ─────────────────────────── varint ───────────────────────────

/** 读一个 varint，返回 [BigInt 值, 新位置]。最长 10 字节。 */
export function readVarint(buf, pos, end = buf.length) {
  let result = 0n;
  let shift = 0n;
  const start = pos;
  for (let i = 0; i < 10; i++) {
    if (pos >= end) throw new WireError('varint 被截断', start);
    const b = buf[pos++];
    result |= BigInt(b & 0x7f) << shift;
    if (!(b & 0x80)) return [result, pos];
    shift += 7n;
  }
  throw new WireError('varint 超过 10 字节', start);
}

/** 写 varint。负数按 64 位补码（与 protobuf int32/int64 负数一致，占 10 字节）。 */
export function writeVarint(value) {
  let v = BigInt(value);
  if (v < 0n) v = BigInt.asUintN(64, v);
  const out = [];
  while (v > 0x7fn) {
    out.push(Number(v & 0x7fn) | 0x80);
    v >>= 7n;
  }
  out.push(Number(v));
  return Buffer.from(out);
}

/** varint 编码后的字节数（用于检查是否「规范」编码） */
export function varintLength(buf, pos) {
  let p = pos;
  while (buf[p] & 0x80) p++;
  return p - pos + 1;
}

// ─────────────────────────── 解析 ───────────────────────────

/**
 * 严格解析 buf[start,end) 为 Field[]。
 * 失败抛 WireError（而不是返回半截结果）。
 */
export function parseFields(buf, start = 0, end = buf.length) {
  const fields = [];
  let p = start;
  while (p < end) {
    const tagStart = p;
    const [tag, p1] = readVarint(buf, p, end);
    const fn = Number(tag >> 3n);
    const wt = Number(tag & 7n);
    if (fn < 1 || fn > 0x1fffffff) throw new WireError(`非法字段号 ${fn}`, tagStart);
    p = p1;
    switch (wt) {
      case WT.VARINT: {
        const [v, p2] = readVarint(buf, p, end);
        fields.push({ fn, wt, v });
        p = p2;
        break;
      }
      case WT.I64:
        if (p + 8 > end) throw new WireError('fixed64 被截断', p);
        fields.push({ fn, wt, raw: buf.subarray(p, p + 8) });
        p += 8;
        break;
      case WT.I32:
        if (p + 4 > end) throw new WireError('fixed32 被截断', p);
        fields.push({ fn, wt, raw: buf.subarray(p, p + 4) });
        p += 4;
        break;
      case WT.LEN: {
        const [len, p2] = readVarint(buf, p, end);
        const L = Number(len);
        if (!Number.isSafeInteger(L) || p2 + L > end) throw new WireError(`length-delimited 越界（声明 ${len} 字节）`, p);
        fields.push({ fn, wt, raw: buf.subarray(p2, p2 + L) });
        p = p2 + L;
        break;
      }
      default:
        throw new WireError(`不支持的 wire type ${wt}`, tagStart);
    }
  }
  return fields;
}

/** 不抛异常的 parseFields；解析失败返回 null */
export function tryParseFields(buf, start = 0, end = buf.length) {
  try { return parseFields(buf, start, end); } catch { return null; }
}

// ─────────────────────────── 序列化 ───────────────────────────

/** 一个 Field → Buffer（含 tag）。len 字段若带 sub（已解析的子字段）则以 sub 为准。 */
export function serializeField(f) {
  const tag = writeVarint((BigInt(f.fn) << 3n) | BigInt(f.wt));
  switch (f.wt) {
    case WT.VARINT: return Buffer.concat([tag, writeVarint(f.v)]);
    case WT.I64:
    case WT.I32: return Buffer.concat([tag, f.raw]);
    case WT.LEN: {
      const body = f.sub ? serializeFields(f.sub) : f.raw;
      return Buffer.concat([tag, writeVarint(body.length), body]);
    }
    default: throw new WireError(`不支持的 wire type ${f.wt}`);
  }
}

/** Field[] → Buffer，字段顺序原样保留 */
export function serializeFields(fields) {
  return Buffer.concat(fields.map(serializeField));
}

// ─────────────────────────── 便捷构造 ───────────────────────────

export const fVarint = (fn, v) => ({ fn, wt: WT.VARINT, v: BigInt(v) });
export const fLen = (fn, bytes) => ({ fn, wt: WT.LEN, raw: Buffer.from(bytes) });
export const fStr = (fn, s) => fLen(fn, Buffer.from(s, 'utf8'));
export const fMsg = (fn, sub) => ({ fn, wt: WT.LEN, raw: Buffer.alloc(0), sub });
export const fF32 = (fn, x) => { const b = Buffer.alloc(4); b.writeFloatLE(x); return { fn, wt: WT.I32, raw: b }; };
