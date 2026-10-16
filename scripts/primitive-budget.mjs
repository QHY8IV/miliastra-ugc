#!/usr/bin/env node
/**
 * primitive-budget.mjs —— 图片图元（矩形拟合）项目的预算体检
 *
 * 两个模式，对应两类问题：
 *
 *   cover <atlas.json>      「我的矩形还能再少吗？」
 *       复现当前贪心分区，再试几种保像素的替代分区（tallest-first / 最大矩形 / 行游程纵向合并 /
 *       列游程横向合并），全部逐像素校验后给出可省比例与天花板。用于判断是否值得换算法。
 *       输入格式（二选一，按 key 存）：
 *         {"key": {"w":W,"h":H,"raw":"xxxxyyyywwwwhhhhRRGGBBAA..."}}   ← 千星项目常用：每矩形 24 个十六进制字符
 *         {"key": {"w":W,"h":H,"rects":[[x,y,w,h,r,g,b,a], ...]}}
 *
 *   frame <controls.json>   「这一帧的图元里有多少是白画的？」
 *       统计重绘倍数、半透明占比、被后面不透明图元完全遮住的图元数（并集口径 + 单个包含口径），
 *       以及「反向扫描 + 粗格覆盖」这种可实现剔除在各格子尺寸下能省多少。用于决定是否值得做遮挡剔除。
 *       输入格式：{"canvas":[W,H],"controls":[{"type":"image","rect":{"x","y","w","h"},
 *                 "color":<打包整数 或 [r,g,b,a]>,"stage":"可选"}]}
 *       打包整数与项目的 render-preview 一致：r=(v>>16)&255, g=(v>>8)&255, b=v&255, a=(v>>24)&255。
 *
 *   --selftest              用合成数据自检（两种模式都有确定答案）
 *
 * 依赖：Node >= 22，零第三方依赖。
 * 口径说明：本工具的结论是「在这个模型里」，不是平台事实；真机帧率与控件上限仍需真机确认。
 */

import { readFileSync } from 'node:fs';
import { basename } from 'node:path';

const TILE_HELP = `用法：
  node primitive-budget.mjs cover <atlas.json> [--top N] [--json]
  node primitive-budget.mjs frame <controls.json> [--json]
  node primitive-budget.mjs --selftest`;

// ─────────────────────────── 公共 ───────────────────────────

function decodeRects(asset) {
  if (Array.isArray(asset.rects)) {
    return asset.rects.map((r) => r.slice(0, 8).map(Number));
  }
  const raw = String(asset.raw ?? '').replace(/\s+/g, '');
  if (raw.length % 24 !== 0) throw new Error(`raw 长度 ${raw.length} 不是 24 的倍数`);
  const out = [];
  for (let i = 0; i < raw.length; i += 24) {
    out.push([
      parseInt(raw.slice(i, i + 4), 16), parseInt(raw.slice(i + 4, i + 8), 16),
      parseInt(raw.slice(i + 8, i + 12), 16), parseInt(raw.slice(i + 12, i + 16), 16),
      parseInt(raw.slice(i + 16, i + 18), 16), parseInt(raw.slice(i + 18, i + 20), 16),
      parseInt(raw.slice(i + 20, i + 22), 16), parseInt(raw.slice(i + 22, i + 24), 16),
    ]);
  }
  return out;
}

/** 把矩形列表栅格化成颜色矩阵（同色不透明重叠视为合法；不同色叠字视为污染）。 */
function rasterize(rects, w, h, opts = {}) {
  const grid = new Array(w * h).fill(null);
  let overlap = 0, outOfBounds = 0;
  for (const r of rects) {
    const [x, y, rw, rh] = r;
    const col = r.slice(4, 8).join(',');
    for (let yy = y; yy < y + rh; yy++) {
      if (yy < 0 || yy >= h) { outOfBounds++; continue; }
      for (let xx = x; xx < x + rw; xx++) {
        if (xx < 0 || xx >= w) { outOfBounds++; continue; }
        const i = yy * w + xx;
        if (grid[i] !== null) { if (grid[i] !== col) overlap++; }
        else grid[i] = col;
      }
    }
  }
  if (opts.strictOverlap) {
    // 严格口径：任何重复覆盖都算（同色重叠在渲染上无害，但会让「分区」不再是分区）
    const seen = new Uint8Array(w * h);
    overlap = 0;
    for (const r of rects) {
      const [x, y, rw, rh] = r;
      for (let yy = y; yy < y + rh; yy++) for (let xx = x; xx < x + rw; xx++) {
        if (yy < 0 || yy >= h || xx < 0 || xx >= w) continue;
        const i = yy * w + xx;
        if (seen[i]) overlap++; else seen[i] = 1;
      }
    }
  }
  return { grid, overlap, outOfBounds };
}

// ─────────────────────────── cover ───────────────────────────

function greedy(rects, w, h, widest) {
  const grid = new Array(w * h).fill(null);
  for (const r of rects) {
    const col = r.slice(4, 8).join(',');
    for (let yy = r[1]; yy < r[1] + r[3]; yy++) for (let xx = r[0]; xx < r[0] + r[2]; xx++) grid[yy * w + xx] = col;
  }
  const dead = new Uint8Array(w * h);
  const eq = (x, y, c) => x >= 0 && x < w && y >= 0 && y < h && grid[y * w + x] === c && !dead[y * w + x];
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = grid[y * w + x];
    if (c === null || dead[y * w + x]) continue;
    let ww = 1, hh = 1;
    if (widest) {
      while (eq(x + ww, y, c)) ww++;
      outer: while (y + hh < h) {
        for (let xx = x; xx < x + ww; xx++) if (!eq(xx, y + hh, c)) break outer;
        hh++;
      }
    } else {
      while (eq(x, y + hh, c)) hh++;
      outer2: while (x + ww < w) {
        for (let yy = y; yy < y + hh; yy++) if (!eq(x + ww, yy, c)) break outer2;
        ww++;
      }
    }
    for (let yy = y; yy < y + hh; yy++) for (let xx = x; xx < x + ww; xx++) dead[yy * w + xx] = 1;
    out.push([x, y, ww, hh]);
  }
  return out;
}

function maximal(rects, w, h) {
  const grid = new Array(w * h).fill(null);
  for (const r of rects) {
    const col = r.slice(4, 8).join(',');
    for (let yy = r[1]; yy < r[1] + r[3]; yy++) for (let xx = r[0]; xx < r[0] + r[2]; xx++) grid[yy * w + xx] = col;
  }
  const dead = new Uint8Array(w * h);
  const out = [];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const c = grid[y * w + x];
    if (c === null || dead[y * w + x]) continue;
    let maxw = 0;
    while (x + maxw < w && grid[y * w + x + maxw] === c && !dead[y * w + x + maxw]) maxw++;
    let bestH = 1, bestW = 1, area = 1;
    for (let hh = 1; hh <= h - y; hh++) {
      if (hh > 1) {
        let k = 0;
        while (k < maxw && grid[(y + hh - 1) * w + x + k] === c && !dead[(y + hh - 1) * w + x + k]) k++;
        maxw = Math.min(maxw, k);
      }
      if (maxw === 0) break;
      if (maxw * hh > area) { area = maxw * hh; bestH = hh; bestW = maxw; }
    }
    for (let yy = y; yy < y + bestH; yy++) for (let xx = x; xx < x + bestW; xx++) dead[yy * w + xx] = 1;
    out.push([x, y, bestW, bestH]);
  }
  return out;
}

function runMerge(rects, w, h, vertical) {
  const grid = new Array(w * h).fill(null);
  for (const r of rects) {
    const col = r.slice(4, 8).join(',');
    for (let yy = r[1]; yy < r[1] + r[3]; yy++) for (let xx = r[0]; xx < r[0] + r[2]; xx++) grid[yy * w + xx] = col;
  }
  let gw = w, gh = h, g = grid;
  if (!vertical) {
    gw = h; gh = w;
    g = new Array(w * h).fill(null);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) g[x * h + y] = grid[y * w + x];
  }
  const runs = [];
  for (let y = 0; y < gh; y++) {
    const row = []; let x = 0;
    while (x < gw) {
      const c = g[y * gw + x];
      if (c === null) { row.push(null); x++; continue; }
      const s = x;
      while (x < gw && g[y * gw + x] === c) x++;
      row.push([s, x, c]);
    }
    runs.push(row);
  }
  const dead = new Uint8Array(gw * gh);
  const out = [];
  for (let y = 0; y < gh; y++) for (let k = 0; k < runs[y].length; k++) {
    const run = runs[y][k];
    if (run === null || dead[y * gw + run[0]]) continue;
    let hh = 1;
    while (y + hh < gh && k < runs[y + hh].length && runs[y + hh][k] && runs[y + hh][k][0] === run[0] && runs[y + hh][k][1] === run[1] && runs[y + hh][k][2] === run[2]) hh++;
    for (let yy = y; yy < y + hh; yy++) for (let xx = run[0]; xx < run[1]; xx++) dead[yy * gw + xx] = 1;
    out.push(vertical ? [run[0], y, run[1] - run[0], hh] : [y, run[0], hh, run[1] - run[0]]);
  }
  return out;
}

export function coverReport(atlas, { top = 20, cheapOnly = false } = {}) {
  const rows = [];
  let totalNow = 0, totalBest = 0;
  for (const [key, asset] of Object.entries(atlas)) {
    const w = asset.w, h = asset.h;
    if (!w || !h) continue;
    const rects = decodeRects(asset);
    const ref = rasterize(rects, w, h);
    const cand = { tallest: greedy(rects, w, h, false) };
    if (!cheapOnly && w * h <= 40000) {
      cand.maximal = maximal(rects, w, h);
      cand.rowMerge = runMerge(rects, w, h, true);
      cand.colMerge = runMerge(rects, w, h, false);
    }
    // 每个候选都必须逐像素等同原列表：几何来自候选，颜色取自参考栅格（算法只合并同色像素，
    // 因此这样取色是正当的；一旦几何多盖、少盖或跨色，比对必然失败）。
    const verified = {};
    for (const [name, list] of Object.entries(cand)) {
      const colored = list.map((r) => [...r, ...ref.grid[r[1] * w + r[0]].split(',').map(Number)]);
      const rr = rasterize(colored, w, h);
      let ok = rr.overlap === 0 && rr.outOfBounds === 0;
      for (let i = 0; i < w * h && ok; i++) if (rr.grid[i] !== ref.grid[i]) ok = false;
      verified[name] = ok;
    }
    const bestName = Object.keys(cand).filter((n) => verified[n]).sort((a, b) => cand[a].length - cand[b].length)[0];
    const best = bestName ? cand[bestName].length : rects.length;
    totalNow += rects.length;
    totalBest += Math.min(best, rects.length);
    rows.push({ key, w, h, now: rects.length, best, bestAlgo: bestName ?? '-', verified, cand: Object.fromEntries(Object.entries(cand).map(([n, l]) => [n, l.length])) });
  }
  rows.sort((a, b) => (b.now - b.best) - (a.now - a.best));
  return { rows: rows.slice(0, top), allRows: rows, totalNow, totalBest, keys: rows.length };
}

// ─────────────────────────── frame ───────────────────────────

const unpackColor = (v) => {
  if (Array.isArray(v)) return v.map(Number);
  const n = Number(v) || 0;
  return [Math.floor(n / 65536) % 256, Math.floor(n / 256) % 256, n % 256, Math.floor(n / 16777216) % 256];
};

export function frameReport(doc, { cells = [8, 16, 24, 32], bigRect = 256 } = {}) {
  const [W, H] = doc.canvas ?? [1280, 720];
  const items = [];
  for (const c of doc.controls ?? []) {
    if (c.type !== 'image' || !c.rect) continue;
    const { x, y, w, h } = c.rect;
    if (!(w > 0) || !(h > 0)) continue;
    const [r, g, b, a] = unpackColor(c.color);
    items.push({ x, y, w, h, r, g, b, a, stage: c.stage ?? '' });
  }
  const n = items.length;
  let area = 0, semi = 0;
  for (const it of items) { area += it.w * it.h; if (it.a !== 255) semi++; }

  // 像素级被完全遮住（后面的不透明图元并集）
  const grid = new Uint8Array(W * H);
  const clampRect = (it) => {
    const x0 = Math.max(0, Math.floor(it.x)), y0 = Math.max(0, Math.floor(it.y));
    const x1 = Math.min(W, Math.ceil(it.x + it.w)), y1 = Math.min(H, Math.ceil(it.y + it.h));
    return { x0, y0, x1, y1 };
  };
  let occluded = 0;
  const occlByStage = {};
  for (let i = n - 1; i >= 0; i--) {
    const it = items[i];
    const { x0, y0, x1, y1 } = clampRect(it);
    if (x1 <= x0 || y1 <= y0) continue;
    let full = true;
    for (let y = y0; y < y1 && full; y++) {
      for (let x = x0; x < x1; x++) if (!grid[y * W + x]) { full = false; break; }
    }
    if (full) { occluded++; occlByStage[it.stage] = (occlByStage[it.stage] ?? 0) + 1; }
    if (it.a >= 255) for (let y = y0; y < y1; y++) grid.fill(1, y * W + x0, y * W + x1);
  }

  // 单个后续不透明图元包含
  const opaque = items.map((it, i) => ({ ...it, i })).filter((it) => it.a >= 255);
  let single = 0;
  for (let i = 0; i < n; i++) {
    const it = items[i];
    const l = it.x, r = it.x + it.w, t = it.y, b = it.y + it.h;
    for (const o of opaque) {
      if (o.i <= i) continue;
      if (o.x <= l && o.x + o.w >= r && o.y <= t && o.y + o.h >= b) { single++; break; }
    }
  }

  // 可实现剔除：反向扫描 + 只标记「整格落在不透明矩形内」的格子
  const gridYield = {};
  for (const cell of cells) {
    const GW = Math.ceil(W / cell), GH = Math.ceil(H / cell);
    const mark = new Uint8Array(GW * GH);
    let culled = 0;
    for (let i = n - 1; i >= 0; i--) {
      const it = items[i];
      const x0 = it.x, y0 = it.y, x1 = it.x + it.w, y1 = it.y + it.h;
      if (x1 <= 0 || y1 <= 0 || x0 >= W || y0 >= H) continue;
      if (Math.max(it.w, it.h) <= bigRect) {
        const cx0 = Math.max(0, Math.floor(x0 / cell)), cy0 = Math.max(0, Math.floor(y0 / cell));
        const cx1 = Math.min(GW - 1, Math.ceil(x1 / cell) - 1), cy1 = Math.min(GH - 1, Math.ceil(y1 / cell) - 1);
        let covered = cx1 >= cx0 && cy1 >= cy0;
        for (let cy = cy0; cy <= cy1 && covered; cy++) for (let cx = cx0; cx <= cx1; cx++) if (!mark[cy * GW + cx]) { covered = false; break; }
        if (covered) { culled++; continue; }
      }
      if (it.a >= 255) {
        const mx0 = Math.max(0, Math.ceil(x0 / cell)), my0 = Math.max(0, Math.ceil(y0 / cell));
        const mx1 = Math.min(GW - 1, Math.floor(x1 / cell) - 1), my1 = Math.min(GH - 1, Math.floor(y1 / cell) - 1);
        for (let cy = my0; cy <= my1; cy++) for (let cx = mx0; cx <= mx1; cx++) mark[cy * GW + cx] = 1;
      }
    }
    gridYield[cell] = culled;
  }

  const byStageTotals = {};
  for (const it of items) byStageTotals[it.stage] = (byStageTotals[it.stage] ?? 0) + 1;

  return {
    widgets: n, area, screenArea: W * H, overdraw: area / (W * H), semi, occluded, single,
    occludedShare: occluded / Math.max(1, n), singleShare: single / Math.max(1, n),
    gridYield, occlByStage, byStageTotals, W, H,
  };
}

// ─────────────────────────── CLI ───────────────────────────

function printCover(res, json) {
  if (json) { console.log(JSON.stringify(res, null, 2)); return; }
  const saved = res.totalNow - res.totalBest;
  console.log(`资源 ${res.keys} 个，当前矩形合计 ${res.totalNow}，替代分区最好合计 ${res.totalBest} → 可省 ${saved}（${(saved * 100 / Math.max(1, res.totalNow)).toFixed(2)}%）`);
  console.log(`结论：若可省比例只有个位数百分比，说明当前贪心已接近下限，不值得为它引入新算法。\n`);
  console.log(`${'key'.padEnd(34)}${'size'.padStart(11)}${'now'.padStart(8)}${'best'.padStart(8)}${'省'.padStart(7)}  algo`);
  for (const r of res.rows) {
    console.log(`${r.key.padEnd(34)}${`${r.w}x${r.h}`.padStart(11)}${String(r.now).padStart(8)}${String(r.best).padStart(8)}${String(r.now - r.best).padStart(7)}  ${r.bestAlgo}`);
  }
}

function printFrame(res, json) {
  if (json) { console.log(JSON.stringify(res, null, 2)); return; }
  console.log(`图元 ${res.widgets}，覆盖面积 ${Math.round(res.area)} px²（屏幕 ${res.W}x${res.H} = ${res.screenArea} px²，重绘 ${res.overdraw.toFixed(2)}x）`);
  console.log(`半透明图元 ${res.semi}（${(res.semi * 100 / Math.max(1, res.widgets)).toFixed(1)}%）`);
  console.log(`被后面不透明图元完全遮住：${res.occluded}（${(res.occludedShare * 100).toFixed(1)}%）；其中能被单个后续不透明图元包含：${res.single}（${(res.singleShare * 100).toFixed(1)}%）`);
  console.log('可实现剔除（反向扫描 + 整格覆盖）在各格子尺寸下可省：' + Object.entries(res.gridYield).map(([c, v]) => `${c}px=${v}(${(v * 100 / Math.max(1, res.widgets)).toFixed(1)}%)`).join(' '));
  const stages = Object.entries(res.occlByStage).sort((a, b) => b[1] - a[1]).slice(0, 6);
  if (stages.length) console.log('不可见图元按阶段：' + stages.map(([s, v]) => `${s || '(未标)'}=${v}/${res.byStageTotals[s] ?? '?'}`).join(' '));
  console.log('\n读法：并集口径是不可逾越的上限；格子口径才是能落地的近似。若格子口径只有几个百分点，别为它写剔除代码。');
}

function selftest() {
  const fails = [];
  const eq = (a, b, msg) => { if (JSON.stringify(a) !== JSON.stringify(b)) fails.push(`${msg}：得到 ${JSON.stringify(a)}，期望 ${JSON.stringify(b)}`); };

  // cover：4x4 双色棋盘，贪心应给出确定值，且替代分区必须逐像素一致
  const checker = { w: 4, h: 4, rects: [] };
  for (let y = 0; y < 4; y++) for (let x = 0; x < 4; x++) checker.rects.push([x, y, 1, 1, (x + y) % 2 ? 255 : 0, 0, 0, 255]);
  const cover = coverReport({ checker }, { top: 5 });
  eq(cover.totalNow, 16, '棋盘现有矩形数');
  const widest = greedy(checker.rects, 4, 4, true).length;
  eq(widest, 16, '棋盘贪心（宽优先）');
  const merged = runMerge(checker.rects, 4, 4, true).length;
  eq(merged, 16, '棋盘行游程纵向合并');
  // 单色 4x4：任何算法都应收成 1 个
  const solid = { w: 4, h: 4, rects: [[0, 0, 4, 4, 9, 8, 7, 255]] };
  eq(greedy(solid.rects, 4, 4, true).length, 1, '单色块贪心');
  eq(runMerge(solid.rects, 4, 4, false).length, 1, '单色块列合并');
  eq(maximal(solid.rects, 4, 4).length, 1, '单色块最大矩形');
  // L 形：5 格，宽优先 2 块
  const ell = { w: 2, h: 2, rects: [[0, 0, 2, 1, 1, 2, 3, 255], [0, 1, 1, 1, 1, 2, 3, 255]] };
  eq(greedy(ell.rects, 2, 2, true).length, 2, 'L 形贪心');
  eq(rasterize(decodeRects(ell), 2, 2).overlap, 0, 'L 形无重叠');

  // frame：上层不透明完全盖住下层 → 恰好 1 个不可见；半透明不算遮蔽
  const doc = {
    canvas: [64, 64],
    controls: [
      { type: 'image', rect: { x: 0, y: 0, w: 10, h: 10 }, color: [0, 0, 255, 255], stage: 'bg' },
      // 打包整数口径：a<<24 | b<<16 | g<<8 | r，与项目 render-preview 一致
      { type: 'image', rect: { x: 0, y: 0, w: 10, h: 10 }, color: 0xff000000, stage: 'fg' },
    ],
  };
  const fr = frameReport(doc, { cells: [8] });
  eq(fr.widgets, 2, 'frame 图元数');
  eq(unpackColor(0xff123456), [0x12, 0x34, 0x56, 0xff], '打包整数解包（与项目 render-preview 同口径）');
  eq(fr.occluded, 1, 'frame 并集口径不可见数');
  eq(fr.single, 1, 'frame 单包含口径不可见数');
  eq(fr.semi, 0, 'frame 半透明计数（打包整数口径）');
  const translucent = frameReport({ canvas: [64, 64], controls: [
    { type: 'image', rect: { x: 0, y: 0, w: 10, h: 10 }, color: [255, 0, 0, 128] },
    { type: 'image', rect: { x: 0, y: 0, w: 10, h: 10 }, color: [0, 0, 0, 255] },
  ] }, { cells: [8] });
  eq(translucent.occluded, 1, '半透明在下、不透明在上仍算被遮住');
  eq(translucent.semi, 1, '半透明计数');
  const apart = frameReport({ canvas: [64, 64], controls: [
    { type: 'image', rect: { x: 0, y: 0, w: 10, h: 10 }, color: [1, 2, 3, 255] },
    { type: 'image', rect: { x: 20, y: 20, w: 10, h: 10 }, color: [1, 2, 3, 255] },
  ] }, { cells: [8] });
  eq(apart.occluded, 0, '不重叠时没有不可见图元');
  eq(Math.round(apart.overdraw * 100) / 100, 0.05, '重绘倍数');

  if (fails.length) { console.error('自检失败：'); for (const f of fails) console.error('  ✗ ' + f); process.exit(1); }
  console.log('自检通过：cover 与 frame 的口径在合成数据上都给出确定答案');
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--selftest') || argv.length === 0) {
    if (argv.length === 0) { console.log(TILE_HELP); process.exit(2); }
    selftest(); return;
  }
  const json = argv.includes('--json');
  const mode = argv[0];
  const file = argv[1];
  if (!file) { console.error(TILE_HELP); process.exit(2); }
  const doc = JSON.parse(readFileSync(file, 'utf8'));
  if (mode === 'cover') {
    const ti = argv.indexOf('--top');
    printCover(coverReport(doc, { top: ti >= 0 ? Number(argv[ti + 1]) : 20 }), json);
  } else if (mode === 'frame') {
    printFrame(frameReport(doc), json);
  } else {
    console.error(`未知模式 ${mode}`);
    console.error(TILE_HELP);
    process.exit(2);
  }
  console.error(`\n数据来源：${basename(file)}；结论只在这个模型内成立，真机需另测。`);
}

if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('primitive-budget.mjs')) main();
