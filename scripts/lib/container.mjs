/**
 * container.mjs —— .gil / .gia 等存档文件的外层容器
 *
 * 【官方示例】48 个 .gil + 2 个 .gia 全部符合下面的布局（大端序）：
 *
 *   偏移  长度  内容
 *   0x00  4     文件长度 - 4（不含末尾 4 字节尾标）
 *   0x04  4     版本号，恒为 1
 *   0x08  4     头标 0x00000326            ← 游戏严格校验
 *   0x0C  4     文件类型：1=.gip 2=.gil 3=.gia 4=.gir
 *   0x10  4     载荷长度 = 文件长度 - 24
 *   0x14  N     载荷（protobuf）
 *   末尾  4     尾标 0x00000679            ← 游戏严格校验
 *
 * 【第三方】script-1024/genshin-miliastra-file-format 文档给出同一布局，
 * 并指出：头标/尾标被游戏严格校验，版本号改成别的值也能加载但建议保持 1。
 * 最小的合法 .gia（空载荷）就是这 24 字节，能通过校验但不会出现任何资产。
 */

export const GI_TYPE = Object.freeze({ GIP: 1, GIL: 2, GIA: 3, GIR: 4 });
export const GI_TYPE_NAME = Object.freeze({ 1: 'gip', 2: 'gil', 3: 'gia', 4: 'gir' });
export const HEAD_MAGIC = 0x0326;
export const TAIL_MAGIC = 0x0679;
export const HEADER_LEN = 20;
export const TAIL_LEN = 4;

/** 按扩展名猜类型；猜不出返回 null */
export function typeFromExt(path) {
  const m = /\.(gip|gil|gia|gir)$/i.exec(path || '');
  return m ? GI_TYPE[m[1].toUpperCase()] : null;
}

/**
 * 解析容器。返回 { ok, errors[], warnings[], version, type, typeName, payload }。
 * 只要能定位载荷，errors 为空之外仍会给出 payload，方便对损坏文件做诊断。
 */
export function parseContainer(buf) {
  const errors = [];
  const warnings = [];
  const out = { ok: false, errors, warnings, version: null, type: null, typeName: null, payload: null };

  if (buf.length < HEADER_LEN + TAIL_LEN) {
    errors.push(`文件只有 ${buf.length} 字节，小于最小容器 ${HEADER_LEN + TAIL_LEN} 字节`);
    return out;
  }
  const size = buf.readUInt32BE(0);
  const version = buf.readUInt32BE(4);
  const head = buf.readUInt32BE(8);
  const type = buf.readUInt32BE(12);
  const plen = buf.readUInt32BE(16);
  const tail = buf.readUInt32BE(buf.length - 4);
  Object.assign(out, { version, type, typeName: GI_TYPE_NAME[type] || null });

  if (head !== HEAD_MAGIC) errors.push(`头标应为 0x0326，实际 0x${head.toString(16)}（游戏会拒绝加载）`);
  if (tail !== TAIL_MAGIC) errors.push(`尾标应为 0x0679，实际 0x${tail.toString(16)}（游戏会拒绝加载）`);
  if (size !== buf.length - 4) errors.push(`长度字段 ${size} 与实际（文件长度-4 = ${buf.length - 4}）不符`);
  if (plen !== buf.length - HEADER_LEN - TAIL_LEN) {
    errors.push(`载荷长度字段 ${plen} 与实际 ${buf.length - HEADER_LEN - TAIL_LEN} 不符`);
  }
  if (version !== 1) warnings.push(`版本号 ${version} ≠ 1（官方样本恒为 1；改动后是否可加载未在真机确认）`);
  if (!out.typeName) warnings.push(`未知文件类型 ${type}`);

  out.payload = buf.subarray(HEADER_LEN, buf.length - TAIL_LEN);
  out.ok = errors.length === 0;
  return out;
}

/** 组装容器。type 用 GI_TYPE 常量或 'gil'/'gia' 字符串。 */
export function buildContainer({ type, payload, version = 1 }) {
  const t = typeof type === 'string' ? GI_TYPE[type.toUpperCase()] : type;
  if (!t) throw new Error(`未知文件类型：${type}`);
  const out = Buffer.alloc(HEADER_LEN + payload.length + TAIL_LEN);
  out.writeUInt32BE(out.length - 4, 0);
  out.writeUInt32BE(version, 4);
  out.writeUInt32BE(HEAD_MAGIC, 8);
  out.writeUInt32BE(t, 12);
  out.writeUInt32BE(payload.length, 16);
  payload.copy(out, HEADER_LEN);
  out.writeUInt32BE(TAIL_MAGIC, out.length - 4);
  return out;
}
