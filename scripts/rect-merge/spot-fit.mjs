#!/usr/bin/env node
/**
 * ================================================================================
 *  spot-fit.mjs —— 「先铺光斑」阶段（千星奇域 / 客户端控件像素渲染）
 * ================================================================================
 *
 * 【做什么】
 *   用**真实图元**（不透明椭圆，kind 1）贪心铺一层低频大色斑，输出形状列表，
 *   交给 `shapes.mjs --seed-shapes` 作为「色块层之下」的预置形状。
 *
 * 【为什么需要这一步】
 *   compress.py 的色块层是自底向上补细节的：大尺度的平滑渐变只能靠很多小矩形去逼近。
 *   先在底下铺几十个椭圆光斑把低频能量一次性吃掉，色块层就只需要补残差 ——
 *   离线实测同画质下控件明显更少（见 rect-merge-playbook §9）。
 *
 * 【为什么用椭圆当光斑，而不是自绘径向遮罩】
 *   · 真机椭圆边缘有抗锯齿（覆盖率模型），大椭圆本身就是一块平滑的径向色斑；
 *   · α=1 的不透明椭圆能整块盖住下层，作为底层是"实实在在的一层"，不需要半透明混合；
 *   · 与 `--no-rotation` 路线一致，不额外花 SetLocalRotation 那约 10 ms/控件的代价。
 *
 * 【光栅化只有一个来源 —— 本文件最要紧的设计】
 *   掩码**只用 shapes-core.mjs 的 coverageInto**，绝不自己再写一份超采样。
 *   拟合用的掩码和 renderItems / 真机用的掩码必须是同一份，否则拟合出来的颜色就是错的。
 *   （本项目已经栽过一次「两份 IMAGE_ID 漂移」的跟头，见 check.mjs 的静默退化回归。）
 *
 *   为了速度，每个半径只**真跑一次** coverageInto：在一张 padded 缓冲上取掩码，存成
 *   「局部整数偏移 + 覆盖率」的 patch。这样做等价是**可证明**的，不是假设：
 *     · coverageInto 按 `x + 0.5 - cx` 采样，中心落在像素中心（cx = 整数 + 0.5）时，
 *       整个掩码关于"中心的整数平移"不变（4×4 超采样同理）；
 *     · 越界像素在 coverageInto 里本来就是被夹取丢弃的（x0/x1/y0/y1），
 *       所以「平移 patch + 越界跳过」与「在真实图上直接调用」逐像素相同。
 *   `--selftest` 会随机抽尺寸 / 半径 / 中心跟直接调用对拍，证明这一点。
 *
 * 【输出格式】
 *   {
 *     img, W, H, n, radii, maeAfter,
 *     shapes: [ { kind, q: [cxq,cyq,hwq,hhq,thq,aq,fxq,fyq], col: [r,g,b] }, ... ],
 *     spots:  [ 同上 ]        // 别名，便于阅读
 *   }
 *   `shapes` 就是 `shapes.mjs --seed-shapes` 的输入格式；数组顺序 = 绘制顺序（后面的压在上面）。
 *
 * 【用法】
 *   node spot-fit.mjs <raw.rgb> <W> <H> <N> [--out spots.json]
 *        [--radii 12,20,32,50,80] [--stride 16] [--stride2 4] [--eval-stride 2]
 *        [--min-r 8] [--aspects 1,0.6,0.35] [--angles 0,45,90,135] [--soft-spots 0.5,1.0] [--allow-outside] [--quiet]
 *   --aspects 候选的长宽比（短半轴 / 长半轴，1 = 圆）；--angles 非圆候选的旋转角（度）。
 *        [--eval-cap 6000] [--exhaustive] [--fine-topk 12] [--no-lazy] [--refresh 25]
 *   --eval-cap 一次评估最多抽多少个 patch 像素（0 = 不封顶）；--exhaustive 精搜回到整窗口逐点完整评估（旧做法，开销 ∝ R⁴）；
 *   --no-lazy 候选表每步立刻重算全部相交项（旧做法）。默认是「封顶 + 精搜抽样扫描 + 惰性候选表」。
 *   增量搜索：候选表里每项只在与新放上的光斑相交时才重算（结果与逐步全重算完全相同）。
 *   node spot-fit.mjs --selftest
 * ================================================================================
 */
import fs from 'node:fs';
import path from 'node:path';
import { coverageInto, shapeParams, insideImage, KIND_ELLIPSE, KIND_SOFT, Q_POS, Q_FEATHER, AQ_MAX } from './shapes-core.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : d; };
const has = (k) => argv.includes(k);

// ------------------------------------------------------------------------------
// patch：每个半径只真跑一次 coverageInto
// ------------------------------------------------------------------------------
/**
 * 取半轴为 (hw, hh) 源像素的**轴对齐椭圆**掩码，压成局部偏移 patch。
 * 局部坐标的定义：中心像素是 (0, 0)，patch 里 (dx, dy) 对应绝对像素 (ix + dx, iy + dy)。
 * 只在中心落在像素中心（cx = ix + 0.5）时使用 —— 那时平移不变严格成立。
 */
function patchOf(hw, hh, th = 0, kind = KIND_ELLIPSE, fx = 0, fy = 0) {
  const pad = Math.ceil(Math.max(hw, hh)) + 2;
  const S = 2 * pad + 1;
  const buf = { px: new Int32Array(S * S), cv: new Float32Array(S * S), bb: null };
  const n = coverageInto(buf, S, S, kind, pad + 0.5, pad + 0.5, hw, hh, th, fx, fy);
  const xs = new Int32Array(n), ys = new Int32Array(n), cv = new Float32Array(n);
  for (let k = 0; k < n; k++) {
    const p = buf.px[k];
    xs[k] = (p % S) - pad;
    ys[k] = ((p / S) | 0) - pad;
    cv[k] = buf.cv[k];
  }
  return { hw, hh, n, xs, ys, cv };
}

// ------------------------------------------------------------------------------
// --selftest：证明 patch 与直接调用逐像素等价
// ------------------------------------------------------------------------------
function selftest() {
  let fails = 0, checks = 0;
  const ok = (cond, msg) => { checks++; if (cond) { console.error('  ✓ ' + msg); } else { fails++; console.error('  ✗ ' + msg); } };

  console.error('spot-fit selftest — patch 平移等价性');
  for (const [W, H] of [[64, 48], [123, 77], [200, 131]]) {
    for (const hwq of [16, 37, 80, 101]) {           // 含 +1 的奇数，验证非 4 整除的半轴
      const pr = shapeParams([0, 0, hwq, hwq, 0, AQ_MAX, 0, 0]);
      const patch = patchOf(pr.hw, pr.hh);
      const buf = { px: new Int32Array(W * H), cv: new Float32Array(W * H), bb: null };
      // 抽几个中心：贴边、居中、任意
      const cs = [[0, 0], [W - 1, H - 1], [(W >> 1), (H >> 1)], [3, H - 4], [W - 5, 2]];
      for (const [ix, iy] of cs) {
        // 直接调用（真实图尺寸，带夹取）
        const n = coverageInto(buf, W, H, KIND_ELLIPSE, ix + 0.5, iy + 0.5, pr.hw, pr.hh, 0, 0, 0);
        const direct = new Map();
        for (let k = 0; k < n; k++) direct.set(buf.px[k], buf.cv[k]);
        // 平移 patch
        const viaPatch = new Map();
        for (let k = 0; k < patch.n; k++) {
          const x = ix + patch.xs[k], y = iy + patch.ys[k];
          if (x < 0 || y < 0 || x >= W || y >= H) continue;
          viaPatch.set(y * W + x, patch.cv[k]);
        }
        let diff = direct.size !== viaPatch.size;
        if (!diff) for (const [p, v] of direct) { if (Math.abs(viaPatch.get(p) - v) > 1e-6) { diff = true; break; } }
        ok(!diff, `W=${W} H=${H} hwq=${hwq} 中心(${ix},${iy})：直接 ${direct.size} 像素 / patch ${viaPatch.size} 像素`);
      }
    }
  }
  console.error(fails ? `\n✗ selftest 失败 ${fails}/${checks}` : `\n✓ selftest 全部通过（${checks} 项）`);
  return fails ? 1 : 0;
}

if (has('--selftest')) process.exit(selftest());

// ------------------------------------------------------------------------------
// 主流程
// ------------------------------------------------------------------------------
const [rawPath, Ws, Hs, Ns] = argv;
if (!rawPath || !Ws || !Hs) {
  console.error('用法：node spot-fit.mjs <raw.rgb> <W> <H> <N> [--out x.json] [--radii a,b,c]');
  console.error('      node spot-fit.mjs --selftest');
  process.exit(1);
}
const W = +Ws, H = +Hs, N = W * H;
const N_SPOT = Number(Ns ?? 40);
const RADII = opt('--radii', '12,20,32,50,80').split(',').map(Number).filter((r) => r >= 2);
const STRIDE = Math.max(1, +opt('--stride', 16));
const STRIDE2 = Math.max(1, +opt('--stride2', 4));
const EVAL_STRIDE = Math.max(1, +opt('--eval-stride', 2));
const MIN_R = +opt('--min-r', 8);
const ALLOW_OUTSIDE = has('--allow-outside');
// 光斑的形状族：长宽比（短半轴 / 长半轴）与旋转角（度，仅对非圆有意义）。默认只有圆（与旧版一致）
const ASPECTS = opt('--aspects', '1').split(',').map(Number).filter((a) => a > 0 && a <= 1);
const ANGLES = opt('--angles', '0,45,90,135').split(',').map(Number);
// 软边矩形光斑：羽化宽度占各自边长的比例（空 = 不用）。软边矩形的掩码是 smoothstep×smoothstep，同样只依赖相对偏移，patch 平移等价成立
const SOFTS = (opt('--soft-spots', '') || '').split(',').filter(Boolean).map(Number).filter((f) => f > 0);
// 评估开销封顶（2026-10-20）：一次评估最多抽 ~EVAL_CAP 个 patch 像素（大光斑的 patch 有几十万像素，
// 画布从 500 加到 1000 时开销按 ~R⁴ 涨：1000 px 的光斑阶段曾要 34 分钟）。0 = 不封顶，回到旧行为。
const EVAL_CAP = Math.max(0, +opt('--eval-cap', 6000));
// 精搜：默认「抽样扫描 + 前 FINE_TOPK 个位置完整评估」；--exhaustive 回到旧的整窗口逐点完整评估
const EXHAUSTIVE = has('--exhaustive');
const FINE_TOPK = Math.max(1, +opt('--fine-topk', 12));
// 候选表：默认「惰性」——放上光斑后只把相交的项标脏，等它们浮到堆顶才重算；--no-lazy 回到每步立刻重算全部相交项
const LAZY = !has('--no-lazy');
// 惰性模式下每隔 REFRESH 个光斑把所有脏项重算一遍（0 = 从不）：惰性贪心会漏掉「放上别的光斑之后收益反而变大」的候选，定期刷新补回
const REFRESH = Math.max(0, +opt('--refresh', 25));
const QUIET = has('--quiet');
const OUT = opt('--out', '');
const say = (...m) => { if (!QUIET) console.error(...m); };

const raw = new Uint8Array(fs.readFileSync(rawPath));
if (raw.length !== N * 3) { console.error(`raw 大小 ${raw.length} ≠ ${W}×${H}×3 = ${N * 3}`); process.exit(1); }

// 半径池：按半轴量化后的整数单位去重（同一个 hwq 只算一次）
const RADII_Q = [...new Set(RADII.map((R) => Math.round(R * Q_POS)).filter((q) => q >= MIN_R * Q_POS))].sort((a, b) => a - b);
/** 一个 patch 的评估抽样步长：不封顶时 = EVAL_STRIDE；封顶时 = 让一次评估约 ≤ EVAL_CAP 个像素（取奇数，避免和行长同周期） */
function stepFor(n) {
  let s = EVAL_STRIDE;
  if (EVAL_CAP > 0 && n / s > EVAL_CAP) { s = Math.ceil(n / EVAL_CAP); if (s % 2 === 0) s++; }
  return s;
}
// 候选 = 长半轴 × 长宽比 × 旋转角（圆只有一个角度）。每个候选的掩码只真跑一次 coverageInto（旋转不破坏「整数平移不变」）
const patches = [];
for (const hwq of RADII_Q) for (const asp of ASPECTS) {
  const hhq = Math.max(2, Math.round(hwq * asp));
  const angs = asp >= 0.999 ? [0] : ANGLES;
  for (const deg of angs) {
    const thq = Math.round(deg * 2) % 360;               // 0.5° 为单位
    const pr = shapeParams([0, 0, hwq, hhq, thq, AQ_MAX, 0, 0]);
    patches.push({ kind: KIND_ELLIPSE, hwq, hhq, thq, fxq: 0, fyq: 0, R: pr.hw, patch: patchOf(pr.hw, pr.hh, pr.th) });
    // 软边矩形（可选）：半轴取同一组，羽化 = 比例 × 各自全边长（上限 127 像素）
    for (const f of SOFTS) {
      const fxq = Math.min(255, Math.round(f * 2 * pr.hw * Q_FEATHER)), fyq = Math.min(255, Math.round(f * 2 * pr.hh * Q_FEATHER));
      const sp = shapeParams([0, 0, hwq, hhq, thq, AQ_MAX, fxq, fyq]);
      patches.push({ kind: KIND_SOFT, hwq, hhq, thq, fxq, fyq, R: Math.hypot(pr.hw, pr.hh), patch: patchOf(sp.hw, sp.hh, sp.th, KIND_SOFT, sp.fx, sp.fy) });
    }
  }
}

// 状态：从均色底板开始
const cur = new Float32Array(N * 3);
const err = new Float32Array(N);
const bg = [0, 0, 0];
for (let p = 0; p < N; p++) for (let c = 0; c < 3; c++) bg[c] += raw[p * 3 + c] / N;
for (let p = 0; p < N; p++) for (let c = 0; c < 3; c++) cur[p * 3 + c] = bg[c];
const recolor = (p) => { let s = 0; for (let c = 0; c < 3; c++) s += Math.abs(cur[p * 3 + c] - raw[p * 3 + c]); err[p] = s; };
for (let p = 0; p < N; p++) recolor(p);
const totalErr = () => { let s = 0; for (let p = 0; p < N; p++) s += err[p]; return s; };
const mae = () => totalErr() / (N * 3);

/** 解析最优颜色：椭圆（边缘只有一圈抗锯齿）min_u Σ cv·(raw − u)² → u = Σ cv·raw / Σ cv（与旧版 spot-fit 同口径）；
 *  软边矩形的覆盖率处处不是 0 / 1，raw ≈ cur + a·(u − cur) 按 a² 加权 → u = Σ a·(raw − (1−a)·cur) / Σ a² */
function solveColor(pt, ix, iy, soft = false, step = 1) {
  let sw = 0, sr = 0, sg = 0, sb = 0;
  for (let k = 0; k < pt.n; k += step) {
    const x = ix + pt.xs[k], y = iy + pt.ys[k];
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = (y * W + x) * 3, m = pt.cv[k];
    if (soft) {
      if (m < 0.02) continue;
      sw += m * m; sr += m * (raw[p] - (1 - m) * cur[p]); sg += m * (raw[p + 1] - (1 - m) * cur[p + 1]); sb += m * (raw[p + 2] - (1 - m) * cur[p + 2]);
    } else { sw += m; sr += m * raw[p]; sg += m * raw[p + 1]; sb += m * raw[p + 2]; }
  }
  if (sw < 1e-6) return null;
  return [Math.max(0, Math.min(255, sr / sw)), Math.max(0, Math.min(255, sg / sw)), Math.max(0, Math.min(255, sb / sw))];
}
/** ΔL1：把该光斑按覆盖率合成上去后，覆盖范围内误差变化之和。step > 1 时抽样并按比例放大（只用于粗排） */
function evalD(pt, ix, iy, col, step = 1) {
  let d = 0;
  for (let k = 0; k < pt.n; k += step) {
    const x = ix + pt.xs[k], y = iy + pt.ys[k];
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x, al = pt.cv[k];
    let s = 0;
    for (let c = 0; c < 3; c++) s += Math.abs(cur[p * 3 + c] + (col[c] - cur[p * 3 + c]) * al - raw[p * 3 + c]);
    d += s - err[p];
  }
  return step === 1 ? d : d * step;
}
function applySpot(pt, ix, iy, col) {
  for (let k = 0; k < pt.n; k++) {
    const x = ix + pt.xs[k], y = iy + pt.ys[k];
    if (x < 0 || y < 0 || x >= W || y >= H) continue;
    const p = y * W + x, al = pt.cv[k];
    for (let c = 0; c < 3; c++) cur[p * 3 + c] += (col[c] - cur[p * 3 + c]) * al;
    recolor(p);
  }
}
/** 半轴为 hwq × hhq（量化的 0.25 源像素单位）、旋转 thq（0.5°）、中心 (ix,iy) 的椭圆是否完整落在图内。
 *  与 shapes.mjs 用同一个 insideImage，避免"拟合允许出图、落盘控件却画出图外"。 */
function fits(c, ix, iy) {
  if (ALLOW_OUTSIDE) return true;
  if (!(c.hwq > 0)) throw new Error(`fits(): hwq=${c.hwq} 非法`);
  const pr = shapeParams([Math.round((ix + 0.5) * Q_POS), Math.round((iy + 0.5) * Q_POS), c.hwq, c.hhq, c.thq, AQ_MAX, 0, 0]);
  return insideImage(c.kind ?? KIND_ELLIPSE, pr, W, H);
}

say(`图 ${path.basename(rawPath)} ${W}x${H}  初始(均色底板) MAE=${mae().toFixed(3)}  半径池 ${RADII_Q.map((q) => (q / Q_POS).toFixed(2)).join(',')}`);

const spots = [];
// 增量搜索（2026-10-17）：旧版每一步都把「全部候选 × 全部网格中心」重算一遍，光斑一多就慢到不能用。
// 放上一个光斑只会改变它覆盖范围内的像素，所以只有「与它相交」的候选分数会变——其余的沿用上一次的值。
// 候选表 = 每个 (候选形状, 网格中心) 一项；每步取表里最好的，在它附近用 STRIDE2 做精搜（同一族形状的相邻半径一起试），
// 放上去之后只重算相交的那些项。结果与「每步全重算」相同，只是快得多。
const patchIdx = new Map(patches.map((c, i) => [`${c.hwq}|${c.hhq}|${c.thq}`, i]));
const table = [];
for (let pi = 0; pi < patches.length; pi++) {
  for (let iy = 0; iy < H; iy += STRIDE) for (let ix = 0; ix < W; ix += STRIDE) {
    if (fits(patches[pi], ix, iy)) table.push({ pi, ix, iy, d: Infinity });
  }
}
// colStep：求颜色的抽样步长。没触发封顶时（step = EVAL_STRIDE）仍用全量求色，与旧版逐位相同
for (const c of patches) { c.step = stepFor(c.patch.n); c.colStep = c.step > EVAL_STRIDE ? c.step : 1; }
const evalEntry = (e) => {
  const c = patches[e.pi], col = solveColor(c.patch, e.ix, e.iy, c.kind === KIND_SOFT, c.colStep);
  e.d = col ? evalD(c.patch, e.ix, e.iy, col, c.step) : Infinity;
};
for (const e of table) { e.dirty = false; e.ver = 0; evalEntry(e); }
// 小顶堆（按 d）；节点带版本号，过期节点弹出时直接丢弃。只在惰性模式下使用
const heap = [];
const hLess = (a, b) => a.d < b.d;
function hPush(nd) {
  let i = heap.length; heap.push(nd);
  while (i > 0) { const p = (i - 1) >> 1; if (!hLess(heap[i], heap[p])) break; [heap[i], heap[p]] = [heap[p], heap[i]]; i = p; }
}
function hPop() {
  if (!heap.length) return null;
  const top = heap[0], last = heap.pop();
  if (heap.length) {
    heap[0] = last; let i = 0;
    for (;;) {
      const l = 2 * i + 1, r = l + 1; let m = i;
      if (l < heap.length && hLess(heap[l], heap[m])) m = l;
      if (r < heap.length && hLess(heap[r], heap[m])) m = r;
      if (m === i) break;
      [heap[i], heap[m]] = [heap[m], heap[i]]; i = m;
    }
  }
  return top;
}
if (LAZY) for (const e of table) if (e.d < Infinity) hPush({ d: e.d, e, ver: e.ver });
/** 取当前最好的候选项：惰性模式下，浮到堆顶的脏项先重算，直到堆顶是一个干净的项（已弹出，调用方负责放回 / 划掉） */
function popBest() {
  if (!LAZY) {
    let best = null;
    for (const e of table) if (e.d < Infinity && (!best || e.d < best.d)) best = e;
    return best;
  }
  for (;;) {
    const nd = hPop(); if (!nd) return null;
    const e = nd.e;
    if (nd.ver !== e.ver || e.d === Infinity) continue;
    if (e.dirty) { evalEntry(e); e.dirty = false; e.ver++; if (e.d < Infinity) hPush({ d: e.d, e, ver: e.ver }); continue; }
    return e;
  }
}
// 同一族（长宽比、旋转角相同）里相邻半径的候选，精搜时一起试
const family = (c) => patches.filter((o) => o.kind === c.kind && o.thq === c.thq && Math.abs(o.hhq / o.hwq - c.hhq / c.hwq) < 0.02 && (o.kind !== KIND_SOFT || Math.abs(o.fxq / o.hwq - c.fxq / c.hwq) < 0.02))
  .sort((x, y) => x.hwq - y.hwq);

for (let it = 0; it < N_SPOT; it++) {
  const best = popBest();
  if (!best) break;
  const bc = patches[best.pi];
  const fam = family(bc), at = fam.indexOf(bc);
  const cands = fam.slice(Math.max(0, at - 1), at + 2);

  // ---- 精搜：粗搜命中的邻域内找最好的位置 ----
  let fine = null;
  const rad = Math.max(STRIDE, Math.round(bc.R * 0.6));
  if (EXHAUSTIVE) {
    // 旧做法：整个窗口按 STRIDE2 逐点完整评估（开销 ∝ R⁴）
    for (const cand of cands) {
      for (let iy = Math.max(0, best.iy - rad); iy <= Math.min(H - 1, best.iy + rad); iy += STRIDE2)
        for (let ix = Math.max(0, best.ix - rad); ix <= Math.min(W - 1, best.ix + rad); ix += STRIDE2) {
          if (!fits(cand, ix, iy)) continue;
          const col = solveColor(cand.patch, ix, iy, cand.kind === KIND_SOFT); if (!col) continue;
          const d = evalD(cand.patch, ix, iy, col, 1);
          if (!fine || d < fine.d) fine = { d, ix, iy, col, c: cand };
        }
    }
  } else {
    // 抽样扫描：整个窗口仍按 STRIDE2 逐点扫，但每个位置只抽 ≤ EVAL_CAP 个像素评估（没触发封顶的小 patch 仍完整评估，与旧版相同），
    // 每个候选保留最好的 FINE_TOPK 个位置，再对这些位置做完整评估后比较。抽样只负责筛位置，决断仍用完整评估。
    const finalists = [];
    for (const cand of cands) {
      const soft = cand.kind === KIND_SOFT, fstep = cand.step > EVAL_STRIDE ? cand.step : 1;
      const top = [];
      for (let iy = Math.max(0, best.iy - rad); iy <= Math.min(H - 1, best.iy + rad); iy += STRIDE2)
        for (let ix = Math.max(0, best.ix - rad); ix <= Math.min(W - 1, best.ix + rad); ix += STRIDE2) {
          if (!fits(cand, ix, iy)) continue;
          const col = solveColor(cand.patch, ix, iy, soft, cand.colStep); if (!col) continue;
          const d = evalD(cand.patch, ix, iy, col, fstep);
          if (top.length < FINE_TOPK || d < top[top.length - 1].d) {
            let j = top.length; top.push({ d, ix, iy });
            while (j > 0 && top[j - 1].d > d) { top[j] = top[j - 1]; j--; }
            top[j] = { d, ix, iy };
            if (top.length > FINE_TOPK) top.pop();
          }
        }
      for (const t of top) finalists.push({ cand, ix: t.ix, iy: t.iy });
    }
    for (const f of finalists) {
      const col = solveColor(f.cand.patch, f.ix, f.iy, f.cand.kind === KIND_SOFT); if (!col) continue;
      const d = evalD(f.cand.patch, f.ix, f.iy, col, 1);
      if (!fine || d < fine.d) fine = { d, ix: f.ix, iy: f.iy, col, c: f.cand };
    }
  }
  // 决断必须用完整评估：粗搜的 d 是按 EVAL_STRIDE 放大过的近似值，不能拿它跟精搜的完整 d 直接比大小
  const bcol = solveColor(bc.patch, best.ix, best.iy, bc.kind === KIND_SOFT);
  const coarse = bcol ? { d: evalD(bc.patch, best.ix, best.iy, bcol, 1), ix: best.ix, iy: best.iy, col: bcol, c: bc } : null;
  const pick = (fine && (!coarse || fine.d < coarse.d)) ? fine : coarse;
  if (!pick || pick.d >= -1e-6) {
    if (best.d >= -1e-6) { say(`第 ${it + 1} 步无净收益（ΔL1=${pick ? pick.d.toFixed(1) : 'n/a'}），停止`); break; }
    best.d = Infinity;   // 这一项抽样评估看着好、完整评估没收益：划掉，继续找下一个（惰性模式下它已弹出堆，不再放回）
    it--; continue;
  }

  applySpot(pick.c.patch, pick.ix, pick.iy, pick.col);
  const col = pick.col.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  const q = [Math.round((pick.ix + 0.5) * Q_POS), Math.round((pick.iy + 0.5) * Q_POS),
             pick.c.hwq, pick.c.hhq, pick.c.thq, AQ_MAX, pick.c.fxq, pick.c.fyq];
  spots.push({ kind: pick.c.kind ?? KIND_ELLIPSE, q, col });
  if ((it + 1) % 10 === 0 || it < 3) {
    say(`  光斑 ${it + 1}: 中心(${pick.ix},${pick.iy}) R=${pick.c.R.toFixed(2)} 色(${col.join(',')}) ΔL1=${pick.d.toFixed(0)} MAE=${mae().toFixed(3)}`);
  }
  // 只处理与这个光斑相交的候选（Chebyshev 距离 ≤ 两者长半轴之和 + 余量）：立刻重算，或（惰性）标脏等它浮到堆顶
  for (const e of table) {
    const c = patches[e.pi];
    if (Math.abs(e.ix - pick.ix) <= c.R + pick.c.R + 2 && Math.abs(e.iy - pick.iy) <= c.R + pick.c.R + 2) {
      if (LAZY) e.dirty = true; else evalEntry(e);
    }
  }
  if (LAZY && best.d < Infinity) hPush({ d: best.d, e: best, ver: best.ver });   // 被选中的那一项在弹出时离开了堆，放回（已是脏项）
  if (LAZY && REFRESH > 0 && spots.length % REFRESH === 0) {
    for (const e of table) if (e.dirty) { evalEntry(e); e.dirty = false; e.ver++; if (e.d < Infinity) hPush({ d: e.d, e, ver: e.ver }); }
  }
}

// 要 N 个却一个都没放上，几乎总是配置或几何出了问题（半径池被 --min-r 滤空、
// insideImage 把所有中心都拒了、图比半径还小……）。明确报错，不要安静地写一个空文件。
if (N_SPOT > 0 && !spots.length) {
  console.error(`错误：要求铺 ${N_SPOT} 个光斑，但一个都没放上。`
    + `检查 --min-r（现 ${MIN_R}）/ --radii（现 ${RADII.join(',')}）是否被图尺寸 ${W}×${H} 容纳，`
    + `或加 --allow-outside 允许光斑贴边。`);
  process.exit(3);
}

const out = {
  img: path.basename(rawPath), W, H, n: spots.length,
  radii: RADII_Q.map((q) => q / Q_POS), aspects: ASPECTS, angles: ANGLES, softSpots: SOFTS,
  maeAfter: +mae().toFixed(4),
  shapes: spots,
  spots,
};
if (OUT) fs.writeFileSync(OUT, JSON.stringify(out));
say(`光斑 ${out.n} 个 → 仅光斑层 MAE=${out.maeAfter}${OUT ? ' → ' + OUT : ''}`);
if (!OUT) process.stdout.write(JSON.stringify(out));
