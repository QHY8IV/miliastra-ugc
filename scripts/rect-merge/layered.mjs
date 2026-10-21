#!/usr/bin/env node
/**
 * layered.mjs —— 分层重长：允许控件重叠的矩形划分（本技能自研，2026-10-15）
 *
 * 问题：铺满式划分（compress.py 默认）要求矩形互不重叠，大片背景里夹一个小细节时，
 *       背景必须绕着细节切成好几块。但控件可以叠放——后创建的盖在先创建的上面。
 *
 * 算法（从最上层往下逐层确定像素）：
 *   1. 先做与 V1.0 相同的贪心铺满，得到基础块。
 *   2. 按面积从小到大处理基础块（小块 = 细节，放最上层）。维护「已定像素」：
 *      已被更上层矩形确定颜色的像素，对下层来说是通配（反正被盖住）。
 *   3. 处理一块时，从它出发每次向四个方向之一扩一行/一列：只考虑新矩形里「未定像素」的三通道
 *      标准差仍 ≤ T 的方向，选新收进未定像素最多的那个（整行/列都是通配的方向也可选，记 0.5 分）。
 *      扩不动后，矩形里的未定像素全部归它，颜色 = 这些像素的均值；
 *      再把矩形缩到这些像素的外框（不影响画面，只减少重叠绘制）。
 *      若一块的像素早已全部被上层确定，这块直接删除。
 *      若去掉通配后起始块本身超标（少见），改为从块内每个未定像素单独播种。
 *   4. 输出倒序：最后确定的（底层、大块）先画，细节最后画在上面。
 *
 * 不变式（check.mjs 逐项核对）：每个像素恰好由最上面覆盖它的矩形决定颜色；
 *   每个矩形「露出来的像素」的三通道标准差 ≤ T —— 与铺满式同一条画质标准。
 *
 * 【加权（--weights）】给定时判据换成 compress.py 的加权标准差：
 *   σw² = Σ I²(c−μ)² / n，μ = Σ I²c / Σ I²
 * 于是边缘 / 焦点处（I > 1）的容差按 1/I 收紧、平坦区（I < 1）按 1/I 放宽 ——
 * 与纯矩形路径**同一条判据**，只是这里的统计对象换成「露出来的像素」。
 * 权重全为 1 时走与不加权逐字节相同的代码路径（不是近似等价）。
 *
 * 离线实测（同 MAE 比较）：300×300 插画 MAE≈0.31 少 4%、≈1.24 少 10.6%、≈3.7 少 20%；
 *   像素画（原版《死亡细胞》背景图）无损 STD=0 少 36%～42%。
 *
 * 用法（通常由 compress.py --layered 调用）：
 *   node layered.mjs <raw.rgb> <W> <H> <T> [--max-side 511] [--weights <I.f32>]
 *   raw.rgb = W×H×3 字节（行主序 RGB）；weights = W×H 个 float32（小端），I ∈ [0.2, 4]
 *   标准输出 JSON：
 *   {"rects":[[x,y,w,h,r,g,b],...（绘制顺序：先画的在前）],"tiled":基础块数,"ms":耗时}
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

/** 读 compress.py 写出的权重文件（W×H 个 float32）。尺寸不对就明确报错，不猜。 */
export function readWeights(weightsPath, W, H) {
  const buf = fs.readFileSync(weightsPath);
  if (buf.length !== W * H * 4) {
    throw new Error(`权重文件大小 ${buf.length} ≠ ${W}×${H}×4（应当是 float32 的逐像素重要度）`);
  }
  return new Float32Array(buf.buffer, buf.byteOffset, W * H);
}

/**
 * 全部等于 1 的权重视同「没有权重」。
 *
 * 这样 `--edge-boost 0 --smooth-slack 0`（以及 `--focus-gain 0`）会走与原来**逐字节相同**的
 * 代码路径 —— 浮点累加顺序也相同，所以「不加权 = 加权恒等」不是近似成立，是精确成立。
 * check.mjs 用整份 .lua 文件逐字节比较来钉住这一点。
 */
export function uniformWeights(w) {
  if (!w) return null;
  for (let i = 0; i < w.length; i++) if (w[i] !== 1) return w;
  return null;
}

/** 与 V1.0 / compress.py 相同的贪心铺满（逐块一致，见 check.mjs 自检） */
export function tile(raw, W, H, T, maxSide = 255, weights = null) {
  const w = uniformWeights(weights);
  return w ? tileWeighted(raw, W, H, T, maxSide, w) : tilePlain(raw, W, H, T, maxSide);
}

function tilePlain(raw, W, H, T, maxSide) {
  const SW = W + 1, S = [], Q = [];
  for (let c = 0; c < 3; c++) {
    const s = new Float64Array(SW * (H + 1)), q = new Float64Array(SW * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0, row2 = 0;
      for (let x = 0; x < W; x++) {
        const v = raw[(y * W + x) * 3 + c]; row += v; row2 += v * v;
        s[(y + 1) * SW + x + 1] = s[y * SW + x + 1] + row; q[(y + 1) * SW + x + 1] = q[y * SW + x + 1] + row2;
      }
    }
    S.push(s); Q.push(q);
  }
  const std = (x, y, w, h) => {
    const n = w * h, a = y * SW + x, b = a + w, cc = (y + h) * SW + x, d = cc + w;
    let m = 0;
    for (let ch = 0; ch < 3; ch++) {
      const mean = (S[ch][d] - S[ch][b] - S[ch][cc] + S[ch][a]) / n;
      const v = (Q[ch][d] - Q[ch][b] - Q[ch][cc] + Q[ch][a]) / n - mean * mean;
      if (v > m) m = v;
    }
    return m > 0 ? Math.sqrt(m) : 0;
  };
  return greedy(raw, W, H, T, maxSide, std);
}

/**
 * 加权版的同类贪心：σw 与 compress.py 的 pack_rects（importance 分支）**同一公式**，
 * 所以「纯矩形路径」和「分层路径」对同一个矩形会给出同一个判据。
 */
function tileWeighted(raw, W, H, T, maxSide, weights) {
  const SW = W + 1, N1 = SW * (H + 1);
  const w2 = new Float64Array(N1);
  const A = [new Float64Array(N1), new Float64Array(N1), new Float64Array(N1)];
  const B = [new Float64Array(N1), new Float64Array(N1), new Float64Array(N1)];
  for (let y = 0; y < H; y++) {
    let rw = 0, r0 = 0, r1 = 0, r2 = 0, s0 = 0, s1 = 0, s2 = 0;
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      const w = weights[y * W + x], ww = w * w;
      const v0 = raw[p], v1 = raw[p + 1], v2 = raw[p + 2];
      rw += ww; r0 += ww * v0; r1 += ww * v1; r2 += ww * v2;
      s0 += ww * v0 * v0; s1 += ww * v1 * v1; s2 += ww * v2 * v2;
      const up = y * SW + x + 1, o = up + SW;
      w2[o] = w2[up] + rw;
      A[0][o] = A[0][up] + r0; A[1][o] = A[1][up] + r1; A[2][o] = A[2][up] + r2;
      B[0][o] = B[0][up] + s0; B[1][o] = B[1][up] + s1; B[2][o] = B[2][up] + s2;
    }
  }
  const std = (x, y, w, h) => {
    const n = w * h, a = y * SW + x, b = a + w, cc = (y + h) * SW + x, d = cc + w;
    const t = w2[d] - w2[b] - w2[cc] + w2[a];
    if (!(t > 0)) return 0;
    let m = 0;
    for (let ch = 0; ch < 3; ch++) {
      const sa = A[ch][d] - A[ch][b] - A[ch][cc] + A[ch][a];
      const sb = B[ch][d] - B[ch][b] - B[ch][cc] + B[ch][a];
      const v = (sb - sa * (sa / t)) / n;      // Σ I²(c−μ)² / n，μ = Σ I²c / Σ I²
      if (v > m) m = v;
    }
    return m > 0 ? Math.sqrt(m) : 0;
  };
  return greedy(raw, W, H, T, maxSide, std);
}

function greedy(raw, W, H, T, maxSide, std) {
  const occ = new Array(W).fill(-1), out = [];
  for (let j = 0; j < H; j++) {
    const maxh = Math.min(H - j, maxSide);
    for (let i = 0; i < W; i++) {
      if (occ[i] >= j) continue;
      let w = 1;
      while (i + w < W && w < maxSide && occ[i + w] < j && !(std(i, j, w + 1, 1) > T)) w++;
      const hc = (ww) => { let h = 1; while (h < maxh && !(std(i, j, ww, h + 1) > T)) h++; return h; };
      let bw = w, bh = hc(w);
      for (let w2 = w - 1; w2 >= 1 && w2 * maxh > bw * bh; w2--) { const hh = hc(w2); if (w2 * hh > bw * bh) { bw = w2; bh = hh; } }
      for (let xx = i; xx < i + bw; xx++) occ[xx] = j + bh - 1;
      out.push([i, j, bw, bh]);
      i += bw - 1;
    }
  }
  return out;
}

/**
 * 7 路（不加权）或 14 路（加权）并排的二维树状数组：未定像素的 计数、R/G/B 和、R/G/B 平方和，
 * 加权时再各来一份 Σ I²、Σ I²c、Σ I²c²。
 * 单条树状数组里同时放多条统计，一次前缀查询就能拿到整组数 —— 少一半的循环。
 */
class Stats2D {
  constructor(raw, W, H, weights = null) {
    this.W = W; this.H = H; this.stride = W + 1;
    this.L = weights ? 14 : 7;
    this.w2 = weights ? new Float64Array(W * H) : null;
    const L = this.L;
    const t = this.t = new Float64Array((W + 1) * (H + 1) * L);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const o = ((y + 1) * this.stride + x + 1) * L, p = (y * W + x) * 3;
      t[o] = 1;
      for (let c = 0; c < 3; c++) { const v = raw[p + c]; t[o + 1 + c] = v; t[o + 4 + c] = v * v; }
      if (weights) {
        const w = weights[y * W + x], w2 = w * w;
        this.w2[y * W + x] = w2;
        t[o + 7] = w2;
        for (let c = 0; c < 3; c++) { const v = raw[p + c]; t[o + 8 + c] = w2 * v; t[o + 11 + c] = w2 * v * v; }
      }
    }
    // 线性建树：先逐行、再逐列向父节点累加
    for (let i = 1; i <= H; i++) for (let j = 1; j <= W; j++) {
      const k = j + (j & -j);
      if (k <= W) { const a = (i * this.stride + j) * L, b = (i * this.stride + k) * L; for (let c = 0; c < L; c++) t[b + c] += t[a + c]; }
    }
    for (let j = 1; j <= W; j++) for (let i = 1; i <= H; i++) {
      const k = i + (i & -i);
      if (k <= H) { const a = (i * this.stride + j) * L, b = (k * this.stride + j) * L; for (let c = 0; c < L; c++) t[b + c] += t[a + c]; }
    }
  }
  remove(x, y, v) {   // v = [r,g,b]，把像素 (x,y) 从未定集合里去掉
    const t = this.t, st = this.stride, L = this.L;
    const w2 = this.w2 ? this.w2[y * this.W + x] : 0;
    for (let i = y + 1; i <= this.H; i += i & -i) for (let j = x + 1; j <= this.W; j += j & -j) {
      const o = (i * st + j) * L;
      t[o] -= 1;
      t[o + 1] -= v[0]; t[o + 2] -= v[1]; t[o + 3] -= v[2];
      t[o + 4] -= v[0] * v[0]; t[o + 5] -= v[1] * v[1]; t[o + 6] -= v[2] * v[2];
      if (L > 7) {
        t[o + 7] -= w2;
        for (let c = 0; c < 3; c++) { t[o + 8 + c] -= w2 * v[c]; t[o + 11 + c] -= w2 * v[c] * v[c]; }
      }
    }
  }
  _pre(x, y, sign, out) {
    const t = this.t, st = this.stride, L = this.L;
    for (let i = y; i > 0; i -= i & -i) for (let j = x; j > 0; j -= j & -j) {
      const o = (i * st + j) * L;
      for (let c = 0; c < L; c++) out[c] += sign * t[o + c];
    }
  }
  /** 矩形内未定像素的统计，写进 out（长度 L） */
  rect(x, y, w, h, out) {
    out.fill(0);
    this._pre(x + w, y + h, 1, out); this._pre(x, y + h, -1, out);
    this._pre(x + w, y, -1, out); this._pre(x, y, 1, out);
    return out;
  }
}

/** 未定像素的（加权）三通道标准差最大值。L = 7 走老路径，L = 14 走加权。 */
function stdOf(s, L = 7) {
  const n = s[0];
  let m = 0;
  if (L <= 7) {
    for (let c = 0; c < 3; c++) {
      const mean = s[1 + c] / n, v = s[4 + c] / n - mean * mean;
      if (v > m) m = v;
    }
  } else {
    const t = s[7];
    if (t > 0) for (let c = 0; c < 3; c++) {
      const sa = s[8 + c];
      const v = (s[11 + c] - sa * (sa / t)) / n;   // 与 compress.py 的 (ΣI²c² − ΣI²c·μ) / n 同式
      if (v > m) m = v;
    }
  }
  return m > 0 ? Math.sqrt(m) : 0;
}

export function layered(raw, W, H, T, { maxSide = 511, weights = null } = {}) {
  const wt = uniformWeights(weights);
  const L = wt ? 14 : 7;
  const base = tile(raw, W, H, T, maxSide, wt);
  const order = base.map((b, i) => i).sort((a, b) => base[a][2] * base[a][3] - base[b][2] * base[b][3] || a - b);
  const stats = new Stats2D(raw, W, H, wt);
  const fin = new Uint8Array(W * H);
  const cur = new Float64Array(L), line = new Float64Array(L), merged = new Float64Array(L), best = new Float64Array(L), px = [0, 0, 0];
  const topFirst = [];
  const EPS = 1e-9;
  const grow = (x, y, w, h) => {
    stats.rect(x, y, w, h, cur);
    if (cur[0] === 0) return;
    // 每一步把四个方向都试一遍，选「新收进未定像素最多」的方向（平局取标准差小的）；
    // 整行/列都是通配的方向记 0.5 分，允许跨过上层细节继续长。比固定顺序轮流扩多省 0.2～4.5 个百分点。
    for (;;) {
      let bd = -1, bGain = -1, bStd = 0;
      for (let d = 0; d < 4; d++) {
        if (d === 0) { if (x + w >= W || w >= maxSide) continue; stats.rect(x + w, y, 1, h, line); }
        else if (d === 1) { if (y + h >= H || h >= maxSide) continue; stats.rect(x, y + h, w, 1, line); }
        else if (d === 2) { if (x === 0 || w >= maxSide) continue; stats.rect(x - 1, y, 1, h, line); }
        else { if (y === 0 || h >= maxSide) continue; stats.rect(x, y - 1, w, 1, line); }
        let gain = 0.5, sd = 0;
        if (line[0] > 0) {
          for (let c = 0; c < L; c++) merged[c] = cur[c] + line[c];
          sd = stdOf(merged, L);
          if (sd > T + EPS) continue;
          gain = line[0];
        }
        if (gain > bGain || (gain === bGain && sd < bStd)) {
          bd = d; bGain = gain; bStd = sd;
          if (line[0] > 0) best.set(merged); else best.set(cur);
        }
      }
      if (bd < 0) break;
      if (bd === 0) w++; else if (bd === 1) h++; else if (bd === 2) { x--; w++; } else { y--; h++; }
      cur.set(best);
    }
    // 归属未定像素，并求它们的外框
    const n = cur[0];
    const col = [Math.round(cur[1] / n), Math.round(cur[2] / n), Math.round(cur[3] / n)];
    let x0 = Infinity, y0 = Infinity, x1 = -1, y1 = -1;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) {
      const k = yy * W + xx;
      if (fin[k]) continue;
      fin[k] = 1;
      px[0] = raw[k * 3]; px[1] = raw[k * 3 + 1]; px[2] = raw[k * 3 + 2];
      stats.remove(xx, yy, px);
      if (xx < x0) x0 = xx; if (xx > x1) x1 = xx; if (yy < y0) y0 = yy; if (yy > y1) y1 = yy;
    }
    topFirst.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1, ...col]);
  };
  let reseeded = 0;
  for (const bi of order) {
    const [bx, by, bw, bh] = base[bi];
    stats.rect(bx, by, bw, bh, cur);
    if (cur[0] === 0) continue;                       // 已被上层完全确定，删除
    if (stdOf(cur, L) <= T + EPS) { grow(bx, by, bw, bh); continue; }
    reseeded++;                                       // 去掉通配后超标：逐个未定像素播种
    for (let yy = by; yy < by + bh; yy++) for (let xx = bx; xx < bx + bw; xx++) if (!fin[yy * W + xx]) grow(xx, yy, 1, 1);
  }
  return { rects: topFirst.reverse(), tiled: base.length, reseeded };
}

/**
 * 预算对齐系数 m —— 权重要决定「预算花在哪」，不要决定「预算有多少」。2026-10-18 修
 *
 * 问题（实测，见 rect-merge-playbook.md §2.14）：加权判据把平坦区的容差放宽、边缘收紧，
 * 于是同一个 `--std` 下加权铺满比不加权**块数少**（合成图 1221 → 1004，真图 500px 少 14%）。
 * 用户看到的 `--edge-aware` 就变成「控件变少、边缘没变好」——预算被悄悄缩掉了，不是挪走了。
 *
 * 这里解一个一维方程：找 m 使 `T×m` 下的**加权**铺满块数回到**不加权** `T` 的块数。
 * 调用方拿到 m 之后用 `T×m` 去跑后面所有阶段（纯矩形 / 分层 / 形状），预算就守恒，
 * 加权只改变「同一份预算怎么分」。
 *
 * 单调性：m 越大 → 容差越松 → 块数越少，所以二分。用几何中点（T×m 跨数量级时收敛更均匀）。
 * 无权重 / 权重恒为 1 时直接返回 1（保证与不加权逐字节相同的老路径）。
 */
export function budgetMultiplier(raw, W, H, T, weights, { maxSide = 511, iters = 24, tol = 0.005 } = {}) {
  const w = uniformWeights(weights);
  const target = tile(raw, W, H, T, maxSide, null).length;
  if (!w || target <= 0) return { m: 1, target, n: target, exact: true, iters: 0 };
  const good = (n) => Math.abs(n - target) <= Math.max(2, target * tol);
  let lo = 0.05, hi = 8, best = 1, bestErr = Infinity, used = 0;
  for (let i = 0; i < iters; i++) {
    const m = Math.sqrt(lo * hi);
    const n = tile(raw, W, H, T * m, maxSide, w).length;
    used = i + 1;
    const err = Math.abs(n - target);
    if (err < bestErr) { bestErr = err; best = m; }
    if (good(n)) { best = m; break; }
    if (n > target) lo = m; else hi = m;      // 块太多 → 容差太紧 → 放大 m
  }
  const n = tile(raw, W, H, T * best, maxSide, w).length;
  return { m: best, target, n, exact: good(n), iters: used };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === fs.realpathSync(process.argv[1]).toLowerCase()) {
  const [rawPath, Ws, Hs, Ts] = process.argv.slice(2);
  const ms = process.argv.indexOf('--max-side');
  const ws = process.argv.indexOf('--weights');
  if (!rawPath || !Ws || !Hs || Ts === undefined) {
    console.error('用法：node layered.mjs <raw.rgb> <W> <H> <T> [--max-side 511] [--weights I.f32] [--calibrate]');
    process.exit(1);
  }
  const W = Number(Ws), H = Number(Hs), T = Number(Ts);
  const raw = fs.readFileSync(rawPath);
  if (raw.length !== W * H * 3) { console.error(`raw 大小 ${raw.length} ≠ ${W}×${H}×3`); process.exit(1); }
  const weights = ws > 0 ? readWeights(process.argv[ws + 1], W, H) : null;
  const maxSide = ms > 0 ? Number(process.argv[ms + 1]) : 511;
  const t0 = Date.now();
  if (process.argv.includes('--calibrate')) {
    // 只解预算对齐系数，不做分层（compress.py 用它把 --std 折算成 T×m）
    const b = budgetMultiplier(raw, W, H, T, weights, { maxSide });
    process.stdout.write(JSON.stringify({ ...b, ms: Date.now() - t0 }));
    process.exit(0);
  }
  const r = layered(raw, W, H, T, { maxSide, weights });
  process.stdout.write(JSON.stringify({ rects: r.rects, tiled: r.tiled, reseeded: r.reseeded, ms: Date.now() - t0 }));
}
