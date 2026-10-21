#!/usr/bin/env node
/**
 * make-calibration-soft.mjs —— 软边（边缘羽化）校准关卡，第二轮。
 * 第一轮（make-calibration.mjs，2026-10-16 真机）发现：软边只有在 enableMask = true 时才生效；
 * Pixel 20 + 遮罩 → 边缘约 10 个单位的平滑渐隐（像 smoothstep），向形状内部缩；Percentage 0.25 + 遮罩 → 一个钟形光斑，峰值只有约 0.4。
 * 这一轮把轮廓量清楚，才能把「软边椭圆 / 矩形」当作渐变用的光斑接进拟合：
 *   行 1  Pixel 模式 + 遮罩，宽度 0 / 10 / 20 / 40 / 80 / 160 / 320（160×160 的白方块）→ 渐隐长度与宽度参数的关系
 *   行 2  Percentage 模式 + 遮罩，0.05 / 0.1 / 0.25 / 0.5 / 1.0；以及只设水平（x, 0）的 Percentage 0.5、Pixel 40 → 两个方向是否独立相乘
 *   行 3  Pixel 40 + 遮罩 + 范围 0.25 / 0.5 / 1 / 2（horizontalSoftRange / verticalSoftRange 是什么）
 *   行 4  扁矩形 320×100（Pixel 20 / 40）、竖矩形 100×320、旋转 30° 的矩形、软边椭圆（Pixel 40）、半透明（alpha 128）的软边方块
 * 用法：node make-calibration-soft.mjs --seed 底关卡.gil -o 校准2.gil；进游戏后截一张完整的全屏截图。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { buildGil } = await import(pathToFileURL(path.join(HERE, 'to-gil.mjs')).href);

const W = 1600, H = 900;
const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
const blocks = [], shapes = [], extra = [], ITEMS = [];
function add(x, y, w, h, col, { img = 100001, rotDeg = 0, label = '', lua = '' } = {}) {
  blocks.push({ x, y, w, h, col });
  const k = blocks.length;
  if (k > 1) shapes.push({ img, rotDeg });
  const run = (code) => `do local ok, e = pcall(function() local c = blk(${k}); ${code} end); if not ok then print("[校准2] 块${k} 失败: " .. tostring(e)) end end`;
  if (lua) extra.push(run(lua));
  ITEMS.push({ k, x, y, w, h, col: col.toString(16).padStart(6, '0'), img, rotDeg, label });
}
const WHITE = rgb(240, 240, 240);
const soft = (mode, wx, wy, extraCode = '') =>
  `c.enableMask = true; c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.${mode}; c:SetSoftEdgeWidth(${wx}, ${wy}); ${extraCode}`;

add(0, 0, W, H, rgb(36, 40, 60), { label: '底板' });
// 行 1：Pixel 模式
[0, 10, 20, 40, 80, 160, 320].forEach((w, i) => add(40 + i * 215, 40, 160, 160, WHITE, { label: `R1-${i + 1} Pixel ${w}`, lua: soft('Pixel', w, w) }));
// 行 2：Percentage 模式、单方向
[0.05, 0.1, 0.25, 0.5, 1.0].forEach((w, i) => add(40 + i * 215, 260, 160, 160, WHITE, { label: `R2-${i + 1} Percentage ${w}`, lua: soft('Percentage', w, w) }));
add(40 + 5 * 215, 260, 160, 160, WHITE, { label: 'R2-6 Percentage (0.5, 0) 只水平', lua: soft('Percentage', 0.5, 0) });
add(40 + 6 * 215, 260, 160, 160, WHITE, { label: 'R2-7 Pixel (40, 0) 只水平', lua: soft('Pixel', 40, 0) });
// 行 3：范围
[0.25, 0.5, 1, 2].forEach((r, i) => add(40 + i * 215, 480, 160, 160, WHITE, { label: `R3-${i + 1} Pixel 40 + 范围 ${r}`, lua: soft('Pixel', 40, 40, `c.horizontalSoftRange = ${r}; c.verticalSoftRange = ${r}`) }));
// 行 4：扁 / 竖 / 旋转 / 椭圆 / 半透明
add(40, 700, 320, 100, WHITE, { label: 'R4-1 扁矩形 320×100 Pixel 20', lua: soft('Pixel', 20, 20) });
add(400, 700, 320, 100, WHITE, { label: 'R4-2 扁矩形 320×100 Pixel 40', lua: soft('Pixel', 40, 40) });
add(760, 640, 100, 220, WHITE, { label: 'R4-3 竖矩形 100×220 Pixel 40', lua: soft('Pixel', 40, 40) });
add(900, 690, 220, 120, WHITE, { rotDeg: 30, label: 'R4-4 矩形 220×120 旋转 +30 Pixel 40', lua: soft('Pixel', 40, 40) });
add(1160, 650, 160, 160, WHITE, { img: 100002, label: 'R4-5 椭圆图 160×160 Pixel 40', lua: soft('Pixel', 40, 40) });
add(1360, 650, 160, 160, WHITE, { label: 'R4-6 半透明 alpha 128 Pixel 40', lua: soft('Pixel', 40, 40, 'c.imageColor = Color.FromRGBA(240, 240, 240, 128)') });

const seed = process.argv[process.argv.indexOf('--seed') + 1];
const out = process.argv[process.argv.indexOf('-o') + 1];
if (!seed || !out) { console.error('用法：node make-calibration-soft.mjs --seed 底关卡.gil -o 校准2.gil'); process.exit(1); }
const r = buildGil(seed, blocks, { W, H, unit: 1, margin: 0, name: '软边校准2', defaultOnly: true, shapes, nRects: 1, extraLua: extra.join('\n    ') });
fs.writeFileSync(out, Buffer.from(r.bytes));
fs.writeFileSync(out + '.items.json', JSON.stringify(ITEMS, null, 1));
console.log(`已写出 ${out}（${blocks.length} 个控件）；每项的位置见 ${out}.items.json`);
