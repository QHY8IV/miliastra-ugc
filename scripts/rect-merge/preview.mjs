#!/usr/bin/env node
/**
 * preview.mjs —— 块数据（含旋转矩形 / 椭圆）→ 预期效果 PNG（按绘制顺序叠放，形状边缘按覆盖率混合）
 *   node scripts/rect-merge/preview.mjs <数据.lua> <输出.png> [--scale 1]
 * 纯 Node，不需要 Python / PIL。形状边缘的混合是模型值（4×4 超采样面积占比），真机的抗锯齿细节可能略有差别。
 */
import fs from 'node:fs';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { parseData, decode, decodeShapes } from './blocks.mjs';
import { renderItems } from './shapes.mjs';

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = (crc >>> 8) ^ c;
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
export function encodePng(rgb, W, H) {
  const row = W * 3, raw = Buffer.alloc((row + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (row + 1)] = 0; rgb.copy(raw, y * (row + 1) + 1, y * row, (y + 1) * row); }
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function previewFromData(text, scale = 1) {
  const info = parseData(text);
  const W = info.W, H = info.H;
  const rects = decode(info).map((b) => [b.x, b.y, b.w, b.h, (b.col >> 16) & 255, (b.col >> 8) & 255, b.col & 255]);
  const shapes = decodeShapes(info.shp || '', info.SHPV ?? 1).map((q) => [q.kind, Math.round(q.cx * 4), Math.round(q.cy * 4), Math.round(q.hw * 4), Math.round(q.hh * 4), q.thq, q.aq, (q.col >> 16) & 255, (q.col >> 8) & 255, q.col & 255]);
  const img = renderItems(W, H, rects, shapes);
  const w = W * scale, h = H * scale, out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = (Math.floor(y / scale) * W + Math.floor(x / scale)) * 3, o = (y * w + x) * 3;
    for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(img[p + c])));
  }
  return { png: encodePng(out, w, h), W, H, blocks: rects.length + shapes.length };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === fs.realpathSync(process.argv[1]).toLowerCase()) {
  const [src, dst] = process.argv.slice(2);
  const si = process.argv.indexOf('--scale');
  if (!src || !dst) { console.error('用法：node preview.mjs <数据.lua> <输出.png> [--scale 1]'); process.exit(1); }
  const r = previewFromData(fs.readFileSync(src, 'utf8'), si > 0 ? Number(process.argv[si + 1]) : 1);
  fs.writeFileSync(dst, r.png);
  console.log(`已写出 ${dst}（${r.W}×${r.H}，${r.blocks} 个控件）`);
}
