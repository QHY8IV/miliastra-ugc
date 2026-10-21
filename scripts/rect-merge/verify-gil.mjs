#!/usr/bin/env node
/**
 * verify-gil.mjs —— 用技能自带的离线模拟器打开 to-gil.mjs 生成的关卡，运行里面的填色脚本，
 * 再按模拟器里每个图片控件的实际位置、尺寸、颜色（按兄弟顺序叠放）还原画面，与块数据逐像素比对。
 *
 *   node scripts/rect-merge/verify-gil.mjs <输出.gil> <数据.lua> [--unit 2] [--static]
 *   --static：全静态关卡（老式布局图片），直接读存档里的布局与颜色核对，不跑模拟器
 *
 * 口径：离线模拟（布局解码【逆向推断】已用官方样本核对；兄弟顺序 = 叠放顺序是模型假设），不代表真机。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseData, decode, decodeShapes } from './blocks.mjs';
import { coverageInto, renderItems } from './shapes.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = (p) => import(pathToFileURL(path.join(HERE, '..', 'lib', p)).href);
const { specFromGil } = await lib('sim/level.mjs');
const { runScenario } = await lib('sim/scenario.mjs');

export async function verifyGil(gilPath, dataPath, unit = 2, margin = 0) {
  const info = parseData(fs.readFileSync(dataPath, 'utf8'));
  const blocks = decode(info);
  const W = info.W, H = info.H;
  const expect = new Int32Array(W * H).fill(-1);
  for (const b of blocks) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) expect[y * W + x] = b.col;
  const level = specFromGil(gilPath, {});
  let result = null;
  const mod = { default: async (t) => {
    const sim = t.fresh({ canvas: [1920, 1080] });
    sim.advance(0.1, 0.05);
    // 找到填色脚本的宿主（批容器的父节点）
    let owner = null;
    (function walk(c) { if (owner) return; if (c.children.some((ch) => /^批\d+$/.test(ch.nameStr))) { owner = c; return; } c.children.forEach(walk); })(sim.root);
    if (!owner) { result = { error: '模拟器里找不到「批」容器' }; return; }
    const o = owner.worldRect(), ocx = o.x + o.w / 2, ocy = o.y + o.h / 2;
    if (info.NSHP > 0) {
      // 带旋转矩形 / 椭圆：按模拟器里每个控件的位置、尺寸、颜色、图片 ID、旋转角，用覆盖率混合模型还原，和数据直接渲染的画面比
      const rects = blocks.map((b) => [b.x, b.y, b.w, b.h, (b.col >> 16) & 255, (b.col >> 8) & 255, b.col & 255]);
      const shp = decodeShapes(info.shp, info.SHPV ?? 1).map((q) => [q.kind, Math.round(q.cx * 4), Math.round(q.cy * 4), Math.round(q.hw * 4), Math.round(q.hh * 4), q.thq, q.aq, (q.col >> 16) & 255, (q.col >> 8) & 255, q.col & 255]);
      const want = renderItems(W, H, rects, shp);
      const img = new Float32Array(W * H * 3);
      const buf = { px: new Int32Array(W * H), cv: new Float32Array(W * H) };
      let images2 = 0, rotated = 0, ellipses = 0, tris = 0, rings = 0, translucent = 0;
      for (const g of owner.children) for (const c of g.children) {
        if (c.typeName !== 'ClientUIImageControl') continue;
        images2++;
        const r = c.worldRect(), colv = c.read('imageColor');
        let packed, alphaByte = 255;
        if (typeof colv === 'number' || typeof colv === 'bigint') { const b = BigInt(colv); packed = Number(b & 0xffffffn) & 0xffffff; alphaByte = Number((b >> 24n) & 255n); }
        else { packed = (Math.round(colv.r) << 16) | (Math.round(colv.g) << 8) | Math.round(colv.b); alphaByte = colv.a === undefined ? 255 : Math.round(colv.a); }
        // 数据里形状几何是 1/4 像素量化的；存档位置 / 尺寸是 float32，unit 不精确（1.6、10/9…）时会带 1e-4 级噪声，
        // 落在覆盖率采样的阈值边上就会多出零星像素差异。先吸附回 1/4 像素再还原，和生成端用同一份量化几何。
        const q4 = (v) => Math.round(v * 4) / 4;
        const w = q4((r.w - 2 * margin) / unit), h = q4((r.h - 2 * margin) / unit);
        const cx = q4((r.x + r.w / 2 - ocx) / unit + W / 2), cy = q4(H / 2 - (r.y + r.h / 2 - ocy) / unit);
        const imageId = Number(c.read('imageId') ?? 0n), rotZ = c.layout?.rot?.[2] ?? 0;
        const kind = imageId === 100002 ? 1 : imageId === 100003 ? 3 : imageId === 100006 ? 4 : 2;
        if (kind === 1) ellipses++; else if (kind === 3) tris++; else if (kind === 4) rings++;
        if (rotZ) rotated++;
        const alpha = alphaByte / 255;
        if (alphaByte !== 255) translucent++;
        const n = coverageInto(buf, W, H, kind, cx, cy, w / 2, h / 2, -rotZ * Math.PI / 180);
        const cr = (packed >> 16) & 255, cg = (packed >> 8) & 255, cb = packed & 255;
        for (let k = 0; k < n; k++) { const p = buf.px[k] * 3, a = buf.cv[k] * alpha; img[p] += (cr - img[p]) * a; img[p + 1] += (cg - img[p + 1]) * a; img[p + 2] += (cb - img[p + 2]) * a; }
      }
      let diff = 0, maxDiff = 0;
      for (let i = 0; i < img.length; i += 3) { const d = Math.max(Math.abs(img[i] - want[i]), Math.abs(img[i + 1] - want[i + 1]), Math.abs(img[i + 2] - want[i + 2])); if (d > maxDiff) maxDiff = d; if (d > 4) diff++; }
      const logs2 = (sim.logs || []).map((l) => l.text ?? String(l)).filter((t) => t.includes('rect-merge'));
      result = { images: images2, white: 0, holes: 0, diff, overlap: 0, rotated, ellipses, triangles: tris, rings, translucent, maxDiff: +maxDiff.toFixed(2), logs: logs2, shapesExpected: info.NSHP, rotatedExpected: shp.filter((q) => q[5] !== 0).length, ellipsesExpected: shp.filter((q) => q[0] === 1).length, trianglesExpected: shp.filter((q) => q[0] === 3).length, ringsExpected: shp.filter((q) => q[0] === 4).length, translucentExpected: shp.filter((q) => q[6] < 32).length };
      sim.destroy(); sim.finish();
      return;
    }
    const got = new Int32Array(W * H).fill(-1);
    let images = 0, white = 0, overlap = 0;
    for (const g of owner.children) for (const c of g.children) {
      if (c.typeName !== 'ClientUIImageControl') continue;
      images++;
      const r = c.worldRect();
      const col = c.read('imageColor');
      // 模拟器里 imageColor 是打包的 ARGB 整数（也兼容 {r,g,b} 对象）
      const packed = typeof col === 'number' || typeof col === 'bigint' ? Number(BigInt(col) & 0xffffffn) & 0xffffff
        : ((Math.round(col.r) << 16) | (Math.round(col.g) << 8) | Math.round(col.b));
      if (packed === 0xffffff) white++;
      // 取整前加 TIE：存档里的位置 / 尺寸是 float32，unit 不是 2 的幂次或 0.25 的倍数时（1.6、10/9…），
      // 本该恰好落在 k+0.5 的值会带 ±1e-4 的噪声，Math.round 随噪声往上或往下掉，造成零星 1 px 的假差异
      // （2026-10-20 在 900 px / unit 10/9 上复现）。偏置 1e-3 > 噪声，且对 unit 2 / 1.25 这类精确值不改变结果。
      const TIE = 1e-3;
      const w = Math.round((r.w - 2 * margin) / unit + TIE), h = Math.round((r.h - 2 * margin) / unit + TIE);
      const x = Math.round((r.x + r.w / 2 - ocx) / unit + W / 2 - w / 2 + TIE);
      const y = Math.round(H / 2 - (r.y + r.h / 2 - ocy) / unit - h / 2 + TIE);
      for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        if (got[yy * W + xx] >= 0) overlap++;
        got[yy * W + xx] = packed;
      }
    }
    let holes = 0, diff = 0;
    for (let k = 0; k < W * H; k++) { if (got[k] < 0) holes++; else if (got[k] !== expect[k]) diff++; }
    const logs = (sim.logs || []).map((l) => l.text ?? String(l)).filter((s) => s.includes('rect-merge'));
    result = { images, white, holes, diff, overlap, logs };
    sim.destroy(); sim.finish();
  } };
  await runScenario(mod, { source: level.script.source, chunk: 'main', simOptions: { tree: level.spec, templates: level.templates, canvas: [1920, 1080] }, print: () => {} });
  return { ...result, expected: blocks.length + (info.NSHP || 0), layered: info.layered };
}

/** 全静态关卡（老式布局图片）：不跑模拟器，直接读存档里的布局与颜色，按列表顺序（靠前的在上）叠放后逐像素比对 */
export async function verifyStaticGil(gilPath, dataPath, unit = 2, margin = 0) {
  const { readGi } = await lib('gifile.mjs');
  const { layoutOfNode } = await lib('ui.mjs');
  const info = parseData(fs.readFileSync(dataPath, 'utf8'));
  const blocks = decode(info);
  const W = info.W, H = info.H;
  const expect = new Int32Array(W * H).fill(-1);
  for (const b of blocks) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) expect[y * W + x] = b.col;
  const root = readGi(gilPath).root;
  const byGuid = new Map(root.ui.nodes.map((n) => [n.guid, n]));
  const isImg = (n) => n?.slots?.some((s) => s.slot_id === 21 && s.slot_type === 38);
  const layout = root.ui.nodes.find((n) => (n.children || []).some((g) => isImg(byGuid.get(g))));
  if (!layout) return { error: '存档里没有老式图片控件' };
  const got = new Int32Array(W * H).fill(-1);
  let images = 0, overlap = 0, badImage = 0;
  const first = (l, f) => l?.find((u) => u.f === f);
  // 老式布局图片：列表靠前的在上面【真机 2026-10-16】，所以倒着画
  for (const g of [...layout.children].reverse()) {
    const n = byGuid.get(g);
    if (!isImg(n)) continue;
    images++;
    const L = layoutOfNode(n);
    const img = first(first(n.slots.find((s) => s.slot_id === 21 && s.slot_type === 38)._u, 503).msg, 31).msg;
    if (first(img, 2)?.v !== 100001) badImage++;
    const col = Number(first(img, 4)?.v ?? 0) & 0xffffff;
    const w = Math.round((L.size[0] - 2 * margin) / unit), h = Math.round((L.size[1] - 2 * margin) / unit);
    const x = Math.round(L.position[0] / unit + W / 2 - w / 2), y = Math.round(H / 2 - L.position[1] / unit - h / 2);
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
      if (got[yy * W + xx] >= 0) overlap++;
      got[yy * W + xx] = col;
    }
  }
  let holes = 0, diff = 0;
  for (let k = 0; k < W * H; k++) { if (got[k] < 0) holes++; else if (got[k] !== expect[k]) diff++; }
  return { images, holes, diff, overlap, badImage, expected: blocks.length, layered: info.layered };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const [gil, data] = process.argv.slice(2);
  const ui = process.argv.indexOf('--unit');
  const unit = ui > 0 ? Number(process.argv[ui + 1]) : 2;
  const r = process.argv.includes('--static') ? await verifyStaticGil(gil, data, unit) : await verifyGil(gil, data, unit);
  console.log(JSON.stringify(r));
  const shapesOk = r.shapesExpected === undefined || (r.rotated === r.rotatedExpected && r.ellipses === r.ellipsesExpected && r.triangles === r.trianglesExpected && r.rings === r.ringsExpected && r.translucent === r.translucentExpected);
  const ok = !r.error && r.images === r.expected && r.holes === 0 && r.diff === 0 && !r.badImage && shapesOk;
  console.log(ok ? '✓ 离线模拟：控件数、覆盖与逐像素颜色全部一致（不代表真机）' : '✗ 有不一致');
  process.exit(ok ? 0 : 1);
}
