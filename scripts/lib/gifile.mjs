/**
 * gifile.mjs —— .gil / .gia 文件的读写（容器 + schema 解码/编码），以及对象路径的读写
 *
 * readGi   读文件 → { kind, container, root }   root 是 codec 解码出的对象（未知部分在 _u，猜测模式下已结构化）
 * encodeGi 对象 → 完整文件字节（含容器头尾）
 * writeGi  写文件；默认拒绝覆盖已存在的文件（避免误伤存档），--force 才覆盖，且先留一份 .bak
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { copyFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { GI_TYPE_NAME, buildContainer, parseContainer, typeFromExt } from './container.mjs';
import { decodeMessage, encodeMessage } from './codec.mjs';
import { ROOT_MESSAGE, getSchema } from './schema.mjs';

export class GiError extends Error {
  /** code 是检查器规则号（如 GG001），命令行据此在报错里带上规则编号 */
  constructor(msg, code = null) { super(msg); this.code = code; }
}

/** 读文件并解码。opts.guess 默认 true（未知 len 字段结构化展开，无损）。 */
export function readGi(path, opts = {}) {
  const buf = readFileSync(path);
  return decodeGi(buf, { ...opts, path });
}

export function decodeGi(buf, opts = {}) {
  const container = parseContainer(buf);
  if (!container.payload) throw new GiError(`容器无法解析：${container.errors.join('；')}`, 'GG001');
  if (!container.ok && !opts.lenient) {
    throw new GiError(`容器校验失败：${container.errors.join('；')}`, 'GG001');
  }
  const kind = container.typeName || (opts.path ? GI_TYPE_NAME[typeFromExt(opts.path)] : null);
  const rootName = ROOT_MESSAGE[kind];
  if (!rootName) throw new GiError(`不支持的文件类型 ${kind ?? container.type}（目前只处理 .gil 与 .gia）`);
  const schema = getSchema();
  const mismatches = [];
  const root = decodeMessage(schema, rootName, container.payload, {
    guess: opts.guess !== false,
    stats: opts.stats,
    onMismatch: (p, fd, wf, e) => mismatches.push(`${p}${e ? '：' + e.message : ''}`),
  });
  return { kind, container, root, rootName, mismatches, bytes: buf.length, path: opts.path };
}

/** 对象 → 完整文件字节 */
export function encodeGi({ kind, root, version = 1 }) {
  const schema = getSchema();
  const payload = encodeMessage(schema, ROOT_MESSAGE[kind], root);
  return buildContainer({ type: kind, payload, version });
}

/** 写文件。已存在则需要 force，并先备份成 <path>.bak（不覆盖已有的 .bak，改用 .bak1、.bak2…） */
export function writeGi(path, bytes, { force = false } = {}) {
  if (existsSync(path)) {
    if (!force) throw new GiError(`${path} 已存在。换个 -o 路径，或加 --force（会先把旧文件备份成 .bak）`);
    let bak = `${path}.bak`;
    for (let i = 1; existsSync(bak); i++) bak = `${path}.bak${i}`;
    copyFileSync(path, bak);
  }
  writeFileSync(path, bytes);
}

// ─────────────────────────── 对象路径 ───────────────────────────

/**
 * 路径语法（与 dump.mjs 的 pathGet 一致，并支持写）：
 *   node_graphs.graphs[2].graph.nodes[0]     已知字段用名字，[i] 是数组下标
 *   #15[0]                                   未知字段用 #字段号，[i] 是「该字段号第几次出现」
 */
function parseSegs(path) {
  return path.split('.').filter(Boolean).map((seg) => {
    const m = /^(#?)([A-Za-z0-9_]+)(?:\[(\d+)\])?$/.exec(seg);
    if (!m) throw new GiError(`路径段无法解析：${seg}`);
    return { unknown: m[1] === '#', key: m[2], idx: m[3] == null ? null : Number(m[3]) };
  });
}

function stepGet(cur, seg) {
  if (cur == null) return undefined;
  if (Array.isArray(cur.msg)) cur = { _u: cur.msg };
  if (seg.unknown) {
    const hits = (cur._u || []).filter((u) => u.f === Number(seg.key));
    return hits[seg.idx ?? 0];
  }
  const v = cur[seg.key];
  if (Array.isArray(v)) return seg.idx == null ? v : v[seg.idx];
  return seg.idx == null || seg.idx === 0 ? v : undefined;
}

export function getPath(root, path) {
  return parseSegs(path).reduce((cur, seg) => stepGet(cur, seg), root);
}

/** 把 value 写到路径上（路径必须已存在；用于替换一个子树/字段）。返回旧值。 */
export function setPath(root, path, value) {
  const segs = parseSegs(path);
  let cur = root;
  for (let i = 0; i < segs.length - 1; i++) {
    cur = stepGet(cur, segs[i]);
    if (cur == null) throw new GiError(`路径不存在：${path}（停在第 ${i + 1} 段 ${segs[i].key}）`);
  }
  const last = segs[segs.length - 1];
  if (Array.isArray(cur.msg)) cur = { _u: cur.msg };
  if (last.unknown) {
    const list = cur._u || [];
    let n = -1;
    for (let k = 0; k < list.length; k++) {
      if (list[k].f === Number(last.key) && ++n === (last.idx ?? 0)) { const old = list[k]; list[k] = value; return old; }
    }
    throw new GiError(`路径不存在：${path}`);
  }
  const old = cur[last.key];
  if (Array.isArray(old) && last.idx != null) {
    if (last.idx >= old.length) throw new GiError(`路径不存在：${path}（数组只有 ${old.length} 项）`);
    const prev = old[last.idx];
    old[last.idx] = value;
    return prev;
  }
  if (old === undefined) throw new GiError(`路径不存在：${path}`);
  cur[last.key] = value;
  return old;
}
