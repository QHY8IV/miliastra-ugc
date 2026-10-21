// 椭圆可行性实验：在分层矩形结果上做「椭圆替换」后处理，看同 MAE 下能少多少控件。
//   node eprobe.mjs <raw.rgb> <W> <H> <T1,T2,...> [--minseed 4] [--mingain 2]
import fs from 'node:fs';
import { layered } from './layered.mjs';

const [rawPath, Ws, Hs, Ts] = process.argv.slice(2);
const W = +Ws, H = +Hs, raw = fs.readFileSync(rawPath);
const arg = (k, d) => { const i = process.argv.indexOf(k); return i > 0 ? +process.argv[i + 1] : d; };
const MINSEED = arg('--minseed', 4), MINGAIN = arg('--mingain', 2), MAXSIDE = arg('--maxside', 400);

// 每行前缀和：6 路（R G B 的和与平方和）
const PS = new Float64Array(H * (W + 1) * 6);
for (let y = 0; y < H; y++) {
  const base = y * (W + 1) * 6;
  for (let x = 0; x < W; x++) for (let c = 0; c < 3; c++) {
    const v = raw[(y * W + x) * 3 + c], o = base + (x + 1) * 6 + c, p = base + x * 6 + c;
    PS[o] = PS[p] + v; PS[o + 3] = PS[p + 3] + v * v;
  }
}
/** 椭圆 = 包围盒的内切椭圆；每行取中心在椭圆内的像素区间 */
function spanOf(bw, bh, r) {
  const dy = (r + 0.5 - bh / 2) / (bh / 2);
  if (dy <= -1 || dy >= 1) return null;
  const hw = (bw / 2) * Math.sqrt(1 - dy * dy), cx = bw / 2;
  const a = Math.max(0, Math.ceil(cx - hw - 0.5)), b = Math.min(bw - 1, Math.floor(cx + hw - 0.5));
  return b >= a ? [a, b] : null;
}
const acc = new Float64Array(7);
function ellStats(x, y, bw, bh) {
  acc.fill(0);
  for (let r = 0; r < bh; r++) {
    const s = spanOf(bw, bh, r); if (!s) continue;
    const base = (y + r) * (W + 1) * 6, a = base + (x + s[0]) * 6, b = base + (x + s[1] + 1) * 6;
    acc[0] += s[1] - s[0] + 1;
    for (let c = 0; c < 6; c++) acc[1 + c] += PS[b + c] - PS[a + c];
  }
  return acc;
}
function stdAcc(s) {
  let m = 0;
  for (let c = 0; c < 3; c++) { const mean = s[1 + c] / s[0], v = s[4 + c] / s[0] - mean * mean; if (v > m) m = v; }
  return m > 0 ? Math.sqrt(m) : 0;
}

function run(T, useEllipse) {
  const t0 = Date.now();
  const L = layered(raw, W, H, T);
  const sh = L.rects.map(([x, y, w, h, r, g, b]) => ({ k: 'r', x, y, w, h, col: [r, g, b], vis: 0, dead: false }));
  const id = new Int32Array(W * H).fill(-1);
  for (let i = 0; i < sh.length; i++) { const s = sh[i]; for (let yy = s.y; yy < s.y + s.h; yy++) for (let xx = s.x; xx < s.x + s.w; xx++) id[yy * W + xx] = i; }
  for (let k = 0; k < W * H; k++) sh[id[k]].vis++;
  for (const s of sh) if (s.vis === 0) s.dead = true;
  const stat = { tried: 0, accepted: 0, removed: 0, partialBad: 0 };
  if (useEllipse) {
    const seeds = sh.map((s, i) => i).filter((i) => !sh[i].dead && sh[i].w * sh[i].h >= MINSEED).sort((a, b) => sh[b].w * sh[b].h - sh[a].w * sh[a].h);
    const cnt = new Map();
    for (const si of seeds) {
      const s = sh[si]; if (s.dead) continue;
      stat.tried++;
      let x = s.x, y = s.y, w = s.w, h = s.h;
      // 种子太扁太细时椭圆几乎退化，先试着以它为中心
      let cur = ellStats(x, y, w, h); let curN = cur[0];
      if (curN === 0 || stdAcc(cur) > T + 1e-9) continue;
      for (;;) {
        let bd = -1, bg = -1, bs = 0;
        for (let d = 0; d < 4; d++) {
          let nx = x, ny = y, nw = w, nh = h;
          if (d === 0) { if (x + w >= W || w >= MAXSIDE) continue; nw++; }
          else if (d === 1) { if (y + h >= H || h >= MAXSIDE) continue; nh++; }
          else if (d === 2) { if (x === 0 || w >= MAXSIDE) continue; nx--; nw++; }
          else { if (y === 0 || h >= MAXSIDE) continue; ny--; nh++; }
          const st = ellStats(nx, ny, nw, nh), sd = stdAcc(st);
          if (sd > T + 1e-9) continue;
          const g = st[0] - curN;
          if (g > bg || (g === bg && sd < bs)) { bg = g; bd = d; bs = sd; }
        }
        if (bd < 0) break;
        if (bd === 0) w++; else if (bd === 1) h++; else if (bd === 2) { x--; w++; } else { y--; h++; }
        curN = ellStats(x, y, w, h)[0];
      }
      // 评估：落在椭圆里的各形状可见像素数
      cnt.clear();
      let nE = 0;
      for (let r = 0; r < h; r++) {
        const sp = spanOf(w, h, r); if (!sp) continue;
        for (let c = sp[0]; c <= sp[1]; c++) { const q = id[(y + r) * W + x + c]; cnt.set(q, (cnt.get(q) || 0) + 1); nE++; }
      }
      let removable = 0;
      for (const [q, n] of cnt) if (n === sh[q].vis) removable++;
      if (removable - 1 < MINGAIN) continue;
      // 接受
      const st = ellStats(x, y, w, h);
      const col = [Math.round(st[1] / st[0]), Math.round(st[2] / st[0]), Math.round(st[3] / st[0])];
      const ni = sh.length;
      sh.push({ k: 'e', x, y, w, h, col, vis: nE, dead: false });
      for (let r = 0; r < h; r++) {
        const sp = spanOf(w, h, r); if (!sp) continue;
        for (let c = sp[0]; c <= sp[1]; c++) { const p = (y + r) * W + x + c; sh[id[p]].vis--; id[p] = ni; }
      }
      for (const [q] of cnt) if (sh[q].vis === 0) { sh[q].dead = true; stat.removed++; }
      stat.accepted++;
    }
  }
  // 渲染 + MAE，顺便重算每个形状的可见像素标准差
  const sum = new Float64Array(sh.length * 6), num = new Int32Array(sh.length);
  let err = 0;
  for (let p = 0; p < W * H; p++) {
    const q = id[p]; num[q]++;
    for (let c = 0; c < 3; c++) { const v = raw[p * 3 + c]; err += Math.abs(v - sh[q].col[c]); sum[q * 6 + c] += v; sum[q * 6 + 3 + c] += v * v; }
  }
  let bad = 0, worst = 0;
  for (let q = 0; q < sh.length; q++) {
    if (!num[q]) continue;
    let m = 0; for (let c = 0; c < 3; c++) { const mean = sum[q * 6 + c] / num[q], v = sum[q * 6 + 3 + c] / num[q] - mean * mean; if (v > m) m = v; }
    const sd = Math.sqrt(Math.max(m, 0)); if (sd > T + 0.5) bad++; if (sd > worst) worst = sd;
  }
  const alive = sh.filter((s) => !s.dead && num[sh.indexOf(s)] > 0);
  const nE = sh.filter((s, i) => s.k === 'e' && num[i] > 0).length;
  return { T, total: alive.length, ellipses: nE, rects: alive.length - nE, mae: err / (W * H * 3), badStd: bad, worstStd: +worst.toFixed(2), ...stat, ms: Date.now() - t0, shapes: sh.filter((s, i) => num[i] > 0), id };
}

const Tlist = Ts.split(',').map(Number);
const rows = [];
for (const T of Tlist) {
  const a = run(T, false), b = run(T, true);
  const f = (r) => `${r.total} 块 (椭圆 ${r.ellipses}) MAE ${r.mae.toFixed(3)} 超标形状 ${r.badStd} 最差std ${r.worstStd} ${r.ms}ms`;
  console.log(`T=${T}\n  纯矩形: ${f(a)}\n  +椭圆 : ${f(b)}  试 ${b.tried} 收 ${b.accepted} 删 ${b.removed}`);
  rows.push({ T, rect: [a.total, a.mae], ell: [b.total, b.mae, b.ellipses] });
}
fs.writeFileSync(rawPath + '.ellipse.json', JSON.stringify(rows));
