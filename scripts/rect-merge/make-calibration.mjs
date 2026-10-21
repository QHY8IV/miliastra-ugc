#!/usr/bin/env node
/**
 * make-calibration.mjs —— 形状校准关卡：量出真机里几种静态图片 / 透明度 / 软边的实际表现，供形状拟合建模用。
 *
 *   node scripts/rect-merge/make-calibration.mjs --seed 底关卡.gil -o 校准.gil
 *
 * 关卡里每一项的位置、颜色都是已知的（见下面的 ITEMS），进游戏后截一张**完整的全屏截图**发回来，
 * 可以从像素值里量出：
 *   A 行：三角形 100003（朝向、是否撑满包围盒、非方形时的形状）、圆环 100006（内外径之比、非方形时是否按比例缩放）
 *   B 行：颜色里的透明度（imageColor 的 alpha）是否按 c = c0 + (色 − c0) × α 混合、旋转椭圆带透明度
 *   C 行：软边（enableSoftEdge / softEdgeMode / SetSoftEdgeWidth / enableMask）能不能让一个形状的边缘渐隐
 * 画布 1600×900（unit 1），底板在中间；用底板四角在截图里的位置换算比例。
 */
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { buildGil } = await import(pathToFileURL(path.join(HERE, 'to-gil.mjs')).href);

const W = 1600, H = 900;
const rgb = (r, g, b) => (r << 16) | (g << 8) | b;
const blocks = [];                     // {x,y,w,h,col}，左上角坐标
const shapes = [];                     // 与 blocks 的第 nRects+1.. 个对应：{ ellipse, rotDeg }（这里只有第 1 块是矩形，其余都当形状）
const extra = [];                      // 额外 Lua（按块序号）
const ITEMS = [];                      // 记录每项的说明
function add(x, y, w, h, col, { img = 100001, rotDeg = 0, label = '', lua = '' } = {}) {
  blocks.push({ x, y, w, h, col });
  const k = blocks.length;
  if (k > 1) shapes.push({ img, rotDeg });
  // 每项各自 pcall，某个属性 / 枚举在真机上不存在时只影响这一项，并在日志里写明
  const run = (code) => `do local ok, e = pcall(function() local c = blk(${k}); ${code} end); if not ok then print("[校准] 块${k} 失败: " .. tostring(e)) end end`;
  if (lua) extra.push(run(lua));
  ITEMS.push({ k, x, y, w, h, col: col.toString(16).padStart(6, '0'), img, rotDeg, label });
}

add(0, 0, W, H, rgb(36, 40, 60), { label: '底板' });
const WHITE = rgb(240, 240, 240);

// A 行：三角形、圆环
add(40, 40, 200, 200, WHITE, { img: 100003, label: 'A1 三角形 200×200' });
add(280, 90, 300, 100, WHITE, { img: 100003, label: 'A2 三角形 300×100（非方形）' });
add(620, 40, 200, 200, WHITE, { img: 100003, rotDeg: 90, label: 'A3 三角形 200×200，z 旋转 +90' });
add(900, 40, 200, 200, WHITE, { img: 100006, label: 'A4 圆环 200×200' });
add(1140, 90, 300, 100, WHITE, { img: 100006, label: 'A5 圆环 300×100（非方形）' });
add(1480, 100, 80, 80, WHITE, { img: 100006, label: 'A6 圆环 80×80' });

// B 行：透明度。每组：红底矩形 + 压在上面一半的绿色矩形（alpha = 64 / 128 / 192）
const RED = rgb(220, 40, 40), GREEN = rgb(40, 200, 60);
[[40, 64], [360, 128], [680, 192]].forEach(([x, a], i) => {
  add(x, 300, 200, 140, RED, { label: `B${i + 1}a 红底` });
  add(x + 120, 340, 200, 140, GREEN, { label: `B${i + 1}b 绿，alpha ${a}（压在红底右半和底板上）`, lua: `c.imageColor = Color.FromRGBA(40, 200, 60, ${a})` });
});
// 蓝 / 黄并排，上面压旋转 30° 的半透明白椭圆
add(1020, 300, 160, 180, rgb(60, 110, 230), { label: 'B4a 蓝' });
add(1180, 300, 160, 180, rgb(240, 200, 40), { label: 'B4b 黄' });
add(1000, 330, 360, 120, rgb(255, 255, 255), { img: 100002, rotDeg: 30, label: 'B4c 白椭圆 360×120，旋转 +30，alpha 128', lua: 'c.imageColor = Color.FromRGBA(255, 255, 255, 128)' });

// C 行：软边（羽化）。白色 160×160 矩形，不同设置
const SOFT = [
  ['C1 Pixel 20（不开遮罩）', 'c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Pixel; c:SetSoftEdgeWidth(20, 20)'],
  ['C2 Pixel 20 + enableMask', 'c.enableMask = true; c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Pixel; c:SetSoftEdgeWidth(20, 20)'],
  ['C3 Pixel 60（不开遮罩）', 'c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Pixel; c:SetSoftEdgeWidth(60, 60)'],
  ['C4 Percentage 0.25（不开遮罩）', 'c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Percentage; c:SetSoftEdgeWidth(0.25, 0.25)'],
  ['C5 Percentage 0.25 + enableMask', 'c.enableMask = true; c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Percentage; c:SetSoftEdgeWidth(0.25, 0.25)'],
  ['C6 椭圆 Pixel 40（不开遮罩）', 'c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Pixel; c:SetSoftEdgeWidth(40, 40)'],
  ['C7 Pixel 20 + 范围 0.5', 'c.enableSoftEdge = true; c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Pixel; c:SetSoftEdgeWidth(20, 20); c.horizontalSoftRange = 0.5; c.verticalSoftRange = 0.5'],
  ['C8 对照（无软边）', ''],
];
SOFT.forEach(([label, lua], i) => add(40 + i * 190, 560, 160, 160, WHITE, { img: i === 5 ? 100002 : 100001, label, lua }));

const seed = process.argv[process.argv.indexOf('--seed') + 1];
const out = process.argv[process.argv.indexOf('-o') + 1];
if (!seed || !out) { console.error('用法：node make-calibration.mjs --seed 底关卡.gil -o 校准.gil'); process.exit(1); }
const r = buildGil(seed, blocks, { W, H, unit: 1, margin: 0, name: '形状校准', defaultOnly: true, shapes, nRects: 1, extraLua: extra.join('\n    ') });
fs.writeFileSync(out, Buffer.from(r.bytes));
fs.writeFileSync(out + '.items.json', JSON.stringify(ITEMS, null, 1));
console.log(`已写出 ${out}（${blocks.length} 个控件，${(r.bytes.length / 1048576).toFixed(3)} MiB）；每项的位置与颜色见 ${out}.items.json`);
