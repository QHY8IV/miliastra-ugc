#!/usr/bin/env node
/**
 * shapes.mjs —— 旋转矩形 / 椭圆「率失真替换」：在分层矩形结果上长出形状，取代一批小矩形（本技能自研，2026-10-16）
 *
 * 依据【真机 2026-10-16】：旋转后的控件、椭圆（静态图片 100002）边缘有抗锯齿。于是一个形状的边缘像素可以按「覆盖率」
 * 与下面的颜色混合，斜线和圆弧边缘不再需要一排阶梯小矩形。
 *
 * 渲染模型：画家算法，像素 = 逐层 c = c + (形状色 − c) × 覆盖率；覆盖率 = 4×4 超采样的面积占比（内部为 1）。
 * 目标：总 L1 误差 + λ × 形状个数 最小，λ = 基线（纯矩形）每多一个块能少的误差（对 STD 与 1.08×STD 两次分层求差），
 *       再乘强度 strength（默认 1；越大越省控件、误差越大）。
 *
 * 流程（每遍）：种子 = 当前每个矩形（面积大的在前）→ 从种子附近同色区域的主轴得初值 → 对每种形状爬山搜索（量化后的参数）
 *   → 精确评估「放上这个形状，并删掉被它取代的形状」后的总误差变化 → 净收益才接受（至少取代 2 个）。
 * 形状总在当时所有形状的最上面。输出顺序 = 幸存矩形（原顺序）+ 形状（创建顺序）。
 *
 * 参数量化：位置 / 半轴 0.25 个源像素，角度 0.5°（0～180° 之内，矩形与椭圆都是 180° 对称）。形状的包围盒必须在图内
 *   （否则控件会画到图外）。
 *
 * 用法（通常由 compress.py --shapes 调用）：
 *   node shapes.mjs <raw.rgb> <W> <H> <T> [--strength 1] [--passes 2] [--max-eval 250] [--kinds ellipse,rotrect]
 *   标准输出 JSON：{"rects":[[x,y,w,h,r,g,b],...], "shapes":[[kind,cxq,cyq,hwq,hhq,thq,r,g,b],...], "stats":{...}}
 *   kind：1 椭圆（静态图片 100002）、2 旋转矩形（100001）；cxq 等是 0.25 像素为单位的整数，thq 是 0.5° 为单位。
 */
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { layered, readWeights } from './layered.mjs';
import { makeRefiner } from './shapes-refine.mjs';
import { tileGrid, buildTileJobs, makeLocator } from './shapes-tiles.mjs';
import { startGpu } from './shapes-gpu.mjs';
import { Q_POS, Q_ANG, AQ_MAX, Q_FEATHER, SOFT_L, KIND_ELLIPSE, KIND_ROTRECT, KIND_TRIANGLE, KIND_RING, KIND_SOFT, KIND_BY_NAME, IMAGE_ID, SHAPE_CONSTS, coverageInto, shapeParams, insideImage, renderItems, maeOf, makeSearch, normalizeSeedShape } from './shapes-core.mjs';
export { Q_POS, Q_ANG, AQ_MAX, Q_FEATHER, SOFT_L, KIND_ELLIPSE, KIND_ROTRECT, KIND_TRIANGLE, KIND_RING, KIND_SOFT, KIND_BY_NAME, IMAGE_ID, SHAPE_CONSTS, coverageInto, shapeParams, insideImage, renderItems, maeOf, normalizeSeedShape };

function baselineL1(raw, W, H, rects, IW = null) {
  const img = renderItems(W, H, rects, []);
  let s = 0;
  for (let i = 0; i < img.length; i++) { const d = Math.abs(raw[i] - img[i]); s += IW ? d * IW[(i / 3) | 0] : d; }
  return s;
}

export async function fitShapes(raw0, W, H, T, rects, { threads = 1, strength = 1, passes = 3, maxEval = 250, kinds = ['ellipse', 'rotrect'], minSeed = 1, noRotation = false, rotCost = 0, preferRot = 0, refit = 4, geom = 4, rectEdges = 3, prune = 3, interleave = true, parallelRefine = true, gpu = false, gpuBatch = 0, gpuPython = 'python', l1 = true, alphaOn = false, residual = true, seedShapes = [], spotCandidates = [], weights = null, maeMask = null, log = () => {} } = {}) {
  const raw = new Uint8Array(new SharedArrayBuffer(raw0.length)); raw.set(raw0);      // 共享一份给工作线程
  // weights：逐像素视觉重要度 I（null = 不加权）。给定后**整个率失真目标函数换成加权 L1**：
  //   λ 由加权基线重新标定，接受/删除判据、修剪、几何微调、颜色重拟合都按 I 加权。
  //   于是边缘 / 焦点处补形状更划算、平坦区省控件 —— 与纯矩形、分层路径同一条预算口径。
  // 拷贝一份到独立的 ArrayBuffer：传到工作线程的 buffer 不能带偏移（fs 读出来的 Buffer 是池化的）
  const IW = weights ? new Float32Array(weights) : null;
  // rotCost：旋转一个形状要多花多少个「控件」的代价（真机：每次 SetLocalRotation 约 10 ms ≈ 12 个普通控件的加载时间）；0 = 只数控件个数
  // noRotation：只出不旋转的椭圆（角度固定 0，不出旋转矩形）——真机里每个 SetLocalRotation 调用很贵（约 10 ms），不旋转就没有这笔开销
  if (noRotation) kinds = kinds.filter((k) => k === 'ellipse' || k === 'soft');
  const N = W * H;
  const t00 = Date.now(), log0 = log;
  log = (m) => log0(`[${((Date.now() - t00) / 1000).toFixed(0)}s] ${m}`);
  // λ：对 1.08×STD 再分层一次，看多省几个块、误差多多少（加权时全部按加权 L1 算）
  const L1b = baselineL1(raw, W, H, rects, IW);
  const r1 = layered(raw, W, H, T * 1.08, { weights: IW }).rects;
  const LAMBDA = Math.max(1, (baselineL1(raw, W, H, r1, IW) - L1b) / Math.max(1, rects.length - r1.length)) * strength;
  log(`λ = ${LAMBDA.toFixed(1)}（强度 ${strength}）；旋转代价 ${rotCost}，旋转补贴 ${preferRot}`);

  const shapes = [];
  const stId = new Array(N), stCv = new Array(N);
  for (let p = 0; p < N; p++) { stId[p] = []; stCv[p] = []; }
  const CAP = (rects.length + 1) * 4 + 4096;               // 形状总数上限（含已删的）；共享数组按它定长
  const sab = (T2, n) => new T2(new SharedArrayBuffer(n * T2.BYTES_PER_ELEMENT));
  const vis = sab(Int32Array, CAP), aliveArr = sab(Uint8Array, CAP), bbArr = sab(Int32Array, CAP * 4);
  const cur = sab(Float32Array, N * 3), err = sab(Float32Array, N), topArr = sab(Int32Array, N).fill(-1);
  const bg = [0, 0, 0];
  const scratch = { px: new Int32Array(N), cv: new Float32Array(N), bb: null };   // 主线程共用一份（预置形状与搜索都要用）
  for (let p = 0; p < N; p++) for (let c = 0; c < 3; c++) bg[c] += raw[p * 3 + c] / N;
  // 像素堆栈与精修（修剪 / 矩形边 / 几何 / 颜色）在 shapes-refine.mjs，主线程与精修工作线程共用
  const R = makeRefiner({ shapes, stId, stCv, vis, topArr, cur, err, raw, bg, IW, W, H, N, LAMBDA, l1, noRotation, alphaOn, track: true });
  const { top, pushP, removeP, insertP, renderPix, recolor, restack } = R;
  // 底板：整图一个均色矩形放在最下面。拿掉矩形可能露出没有任何下层的像素，有了底板，模型里露出的就是这个颜色，
  // 输出里也真有这个控件（多 1 个控件）；否则露出来的会是关卡背景，离线误差就不准了。
  const baseCol = bg.map((v) => Math.round(v));
  [[0, 0, W, H, ...baseCol], ...rects].forEach(([x, y, w, h, r, g, b]) => {
    const px = new Int32Array(w * h); let k = 0;
    for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) px[k++] = yy * W + xx;
    const id = shapes.length; if (id >= CAP) throw new Error('形状数超出容量');
    shapes.push({ kind: 0, col: [r, g, b], px, cv: null, bb: [x, y, x + w - 1, y + h - 1], area: w * h, alive: true });
    for (const p of px) pushP(p, id, 1);
  });
  for (let p = 0; p < N; p++) recolor(p);
  const totalErr = () => { let s = 0; for (let p = 0; p < N; p++) s += err[p]; return s; };
  /** 率失真判据用的加权总误差；stats 里报的 MAE 仍是不加权的，便于和历史结果对比 */
  const totalErrW = () => { let s = 0; for (let p = 0; p < N; p++) s += IW ? err[p] * IW[p] : err[p]; return s; };
  const startN = rects.length + 1, startErr = totalErr();

  /**
   * 预置形状（seedShapes）——"先铺光斑、再补色块"的接口。
   *
   * 【实际画序，2026-10-17 对着代码核过】底板 → **全部矩形** → 光斑 → learned 形状。
   *   底板与矩形在 `fitShapes` 开头（下面 `[[0,0,W,H,...baseCol], ...rects].forEach` 那段）
   *   就已经入栈了，而这批 seed 是那之后才 `pushP` 的，所以光斑压在矩形**之上**。
   *   （旧注释写的是"底板 → 光斑 → 色块"，与代码不符——这里改正，不再描述一个没实现的顺序。）
   *
   *   为什么压在矩形上面也成立：进来的矩形是**完整铺满**的，光斑盖上去之后，被遮住的那些
   *   矩形对误差的贡献变成 0，`pruneSweep` 会把它们当"删掉不花代价"删掉（它按面积升序处理，
   *   小矩形先删、大光斑后被考虑），净效果就是"一个光斑顶掉一片矩形"。
   *   画序在离线模型与真机落盘两侧一致：renderItems 是「矩形再形状」，
   *   to-gil 的绘制循环也是 `k = 1..N` 前 NR 个矩形、NR+1 起形状。
   *
   * 这批形状是**一等公民**：和别的形状一样参与精修（颜色 / 几何 / 修剪）与「被取代就删」的评估，
   * 所以给错了不会卡住——不划算的会被 `pruneSweep` 或 `tryAdd` 的取代逻辑删掉。
   * 每项规范形式 { kind, q:[cxq,cyq,hwq,hhq,thq,aq,fxq,fyq], col:[r,g,b] }，参数口径同 shapes-core 的 shapeParams；
   * 扁平元组（9 / 10 / 12 项）也认，由 normalizeSeedShape 归一化。
   */
  const seedIds = [];
  for (const s0 of seedShapes) {
    const s = normalizeSeedShape(s0, 'seedShapes');
    const pr = shapeParams(s.q);
    const n = coverageInto(scratch, W, H, s.kind, pr.cx, pr.cy, pr.hw, pr.hh, pr.th, pr.fx, pr.fy);
    if (!n) continue;
    const px = scratch.px.slice(0, n), cv = scratch.cv.slice(0, n);
    if (pr.alpha < 0.999) for (let k = 0; k < n; k++) cv[k] *= pr.alpha;
    const id = shapes.length; if (id >= CAP) throw new Error('形状数超出容量');
    shapes.push({ kind: s.kind, q: s.q.slice(), col: s.col.slice(), px, cv, bb: scratch.bb.slice(), area: n, alive: true, seeded: true });
    for (let k = 0; k < n; k++) pushP(px[k], id, cv[k]);
    seedIds.push(id);
  }
  for (let p = 0; p < N; p++) recolor(p);
  if (seedIds.length) log(`预置底层形状 ${seedIds.length} 个（底板之上、矩形之下）；起始 MAE ${(totalErr() / (N * 3)).toFixed(3)}`);

  // 搜索器（主线程自用一份；开了多线程时工作线程各有一份，读同一块共享内存）
  const search = makeSearch({ raw, W, H, T, LAMBDA, cur, err, topArr, vis, aliveArr, bbArr, kinds, noRotation, rotCost, preferRot, maxEval, alphaOn, weights: IW });
  const { meanColor, softColor } = search;

  /** 精确评估并（净收益时）真正放上去；返回 {removed} 或 false */
  function tryAdd(kind, q, rb = 0) {
    const pr = shapeParams(q);
    const n = coverageInto(scratch, W, H, kind, pr.cx, pr.cy, pr.hw, pr.hh, pr.th, pr.fx, pr.fy);
    const softK = kind === KIND_SOFT && (pr.fx > 0 || pr.fy > 0);
    const col = softK ? softColor(scratch.px, scratch.cv, n, pr.alpha) : meanColor(scratch.px, scratch.cv, n, pr.alpha); if (!col) return false;
    if (pr.alpha < 0.999) for (let k = 0; k < n; k++) scratch.cv[k] *= pr.alpha;      // 栈里存「覆盖率 × 不透明度」
    const id = shapes.length;
    const px = scratch.px.slice(0, n), cv = scratch.cv.slice(0, n), bb = scratch.bb.slice();
    if (id >= CAP) throw new Error('形状数超出容量');
    shapes.push({ kind, q: q.slice(), col, px, cv, bb, area: n, alive: true });
    const saved = new Map();
    const save = (p) => { if (!saved.has(p)) saved.set(p, [cur[p * 3], cur[p * 3 + 1], cur[p * 3 + 2], err[p]]); };
    for (let k = 0; k < n; k++) { const p = px[k]; save(p); pushP(p, id, cv[k]); recolor(p); }
    const cand = new Set();
    for (const p of px) for (const s of stId[p]) if (s !== id) { const sh = shapes[s]; if (sh.alive && sh.bb[0] >= bb[0] && sh.bb[1] >= bb[1] && sh.bb[2] <= bb[2] && sh.bb[3] <= bb[3]) cand.add(s); }
    const order = [...cand].sort((a, b) => shapes[a].area - shapes[b].area);
    const removed = [];
    const o = [0, 0, 0];
    for (const s of order) {
      const sh = shapes[s]; let dq = 0;
      for (const p of sh.px) { const e = renderPix(p, s, o) - err[p]; dq += IW ? e * IW[p] : e; }
      if (dq < LAMBDA * 0.999) {
        for (let k = 0; k < sh.px.length; k++) { const p = sh.px[k]; save(p); removeP(p, s); recolor(p); }
        sh.alive = false; removed.push(s);
      }
    }
    let dTotal = 0;
    for (const [p, v] of saved) { const e = err[p] - v[3]; dTotal += IW ? e * IW[p] : e; }
    const pen = q[4] !== 0 ? rotCost - rb : 0;
    if (dTotal < LAMBDA * (removed.length - 1 - pen) - 1e-9) return { removed: removed.length };
    for (const s of removed) { const sh = shapes[s]; sh.alive = true; for (let k = 0; k < sh.px.length; k++) insertP(sh.px[k], s, sh.cv ? sh.cv[k] : 1); }
    for (const p of px) removeP(p, id);
    for (const [p, v] of saved) { cur[p * 3] = v[0]; cur[p * 3 + 1] = v[1]; cur[p * 3 + 2] = v[2]; err[p] = v[3]; }
    shapes[id].alive = false; shapes[id].px = null; shapes[id].cv = null;
    return false;
  }

  let tried = 0, accepted = 0, removedTotal = 0;
  const byKind = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
  // 工作线程池：并行做「种子 → 候选」的搜索（读共享内存快照），主线程再按顺序精确评估并应用。
  let pool = null, metaLen = 0, gpuCli = null, gpuSeeds = 0;
  // GPU 每批种子数：同一批里的种子都在同一份旧快照上算，批越大越快但互相重叠的越多、质量越差（400 px：批 128 与 CPU 的 8 线程完全一致，
  // 256 / 384 批 MAE +1% / +2%）。重叠程度取决于「一批种子占图的面积比」，所以按像素数定：约 N / 1250（400 px → 128，1000 px → 800）。
  const GPU_BATCH = gpuBatch > 0 ? gpuBatch : Math.max(64, Math.round(N / 1250));
  const syncMeta = (full) => {            // 把形状的包围盒、存活标志同步到共享数组（工作线程只读）
    for (let i = full ? 0 : metaLen; i < shapes.length; i++) { const bb = shapes[i].bb, o = i * 4; bbArr[o] = bb[0]; bbArr[o + 1] = bb[1]; bbArr[o + 2] = bb[2]; bbArr[o + 3] = bb[3]; }
    metaLen = shapes.length;
    for (let i = 0; i < shapes.length; i++) aliveArr[i] = shapes[i].alive ? 1 : 0;
  };
  if (threads > 1) {
    const wd = { rawBuf: raw.buffer, W, H, T, LAMBDA, curBuf: cur.buffer, errBuf: err.buffer, topBuf: topArr.buffer, visBuf: vis.buffer,
      aliveBuf: aliveArr.buffer, bbBuf: bbArr.buffer, kinds, noRotation, rotCost, preferRot, maxEval, alphaOn, weightsBuf: IW ? IW.buffer : null, bg, l1 };
    const workers = Array.from({ length: threads }, () => new Worker(new URL('./shapes-worker.mjs', import.meta.url), { workerData: wd }));
    let msgId = 0, fail = null;
    workers.forEach((w) => w.on('error', (e) => { if (fail) fail(e); }));
    pool = {
      run: (seedsAll, type) => new Promise((resolve, reject) => {
        fail = reject;
        const parts = workers.map(() => []);
        seedsAll.forEach((sd, i) => parts[i % threads].push(sd));
        const out = []; let pending = 0; const id = ++msgId;
        workers.forEach((w, wi) => {
          if (!parts[wi].length) return;
          pending++;
          const onMsg = (m) => { if (m.id !== id) return; w.off('message', onMsg); out.push(...m.out); if (--pending === 0) resolve(out); };
          w.on('message', onMsg);
          w.postMessage({ id, type, seeds: parts[wi] });
        });
        if (!pending) resolve(out);
      }),
      // 精修分块任务：队列式派发，哪个线程空了就领下一个（分块大小不一，静态分配会不均衡）
      refine: (jobs, sweeps) => new Promise((resolve, reject) => {
        fail = reject;
        const results = new Array(jobs.length), order = jobs.map((j, i) => i).sort((a, b) => jobs[b].load - jobs[a].load);
        let next = 0, finished = 0;
        if (!jobs.length) { resolve(results); return; }
        const feed = (w) => {
          if (next >= order.length) return;
          const ji = order[next++], id = ++msgId;
          const onMsg = (m) => { if (m.id !== id) return; w.off('message', onMsg); results[ji] = m.res; if (++finished === jobs.length) resolve(results); else feed(w); };
          w.on('message', onMsg);
          w.postMessage({ type: 'refine', id, job: jobs[ji].job, sweeps }, jobs[ji].transfer);
        };
        workers.forEach(feed);
      }),
      close: () => Promise.all(workers.map((w) => w.terminate())),
    };
  }
  // 残差种子：分层时「露出像素标准差 ≤ STD」会把小而亮的细节（鼻尖高光、眼睛反光）并进大块里，它们不属于任何已有的块，
  // 就永远没有种子去长形状。这里把当前误差最大的像素也当种子（间隔 ≥ 3 像素），让搜索去判断补一个形状值不值。
  const resThr = Math.max(30, 7 * T);
  const makeResidualSeeds = () => {
    const cand = [];
    for (let p = 0; p < N; p++) if (err[p] >= resThr) cand.push(p);
    cand.sort((a, b) => err[b] - err[a]);
    const taken = new Uint8Array(N), out = [];
    for (const p of cand) {
      if (taken[p]) continue;
      const x = p % W, y = (p / W) | 0;
      for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const xx = x + dx, yy = y + dy; if (xx >= 0 && yy >= 0 && xx < W && yy < H) taken[yy * W + xx] = 1; }
      out.push({ p, col: [raw[p * 3], raw[p * 3 + 1], raw[p * 3 + 2]], bb: [x, y, x, y], px: Int32Array.of(p) });
      if (out.length >= 30000) break;
    }
    return out;
  };
  // 光斑候选（spotCandidates）：和 seedShapes 的区别是「不是无条件放上去」，而是逐个走 tryAdd 的率失真判据——
  // 放上去、按真实误差判断能不能删掉被它盖住的矩形，净收益（误差增量 < λ × (删掉个数 − 1)）才收。大的在前。
  // 这样对细节多的区域，光斑会因为抹掉矩形的细节而被拒绝，不会像无条件预置那样「先盖住、再被修剪误删矩形、光斑从此删不掉」。
  const spotRD = () => {
    const cands = spotCandidates.map((c) => normalizeSeedShape(c, 'spotCandidates')).sort((a, b) => b.q[2] * b.q[3] - a.q[2] * a.q[3]);
    let ok = 0;
    for (const c of cands) { const r = tryAdd(c.kind, c.q); if (r) { ok++; accepted++; removedTotal += r.removed; byKind[c.kind]++; } }
    log(`光斑候选 ${cands.length} 个，按率失真判据收下 ${ok} 个；当前 MAE ${(totalErr() / (N * 3)).toFixed(3)}，控件 ${shapes.filter((x) => x.alive).length}`);
  };
  const addPass = async (pass) => {
    if (pass === 0 && spotCandidates.length) spotRD();
    syncMeta(true);
    const items = shapes.map((s, i) => i).filter((i) => shapes[i].alive && shapes[i].area >= minSeed).sort((a, b) => shapes[b].area - shapes[a].area).map((i) => ({ i }));
    const nShapeSeeds = items.length;
    if (residual) for (const r of makeResidualSeeds()) items.push({ i: -(items.length + 1), res: r });
    log(`  第 ${pass + 1} 遍：形状种子 ${nShapeSeeds}，残差种子 ${items.length - nShapeSeeds}`);
    if (process.env.DSH_DUMP_STATE && pass === +(process.env.DSH_DUMP_PASS || 0)) {
      // 调试：导出搜索快照 + 一批种子的 CPU 参考结果（GPU 搜索内核的对拍数据），然后退出
      const dir = process.env.DSH_DUMP_STATE; fs.mkdirSync(dir, { recursive: true });
      const wb = (name, arr) => fs.writeFileSync(dir + '/' + name, Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength));
      wb('raw.u8', raw); wb('cur.f32', cur); wb('err.f32', err); wb('top.i32', topArr); wb('vis.i32', vis); wb('alive.u8', aliveArr);
      wb('bb.i32', bbArr.subarray(0, shapes.length * 4)); if (IW) wb('w.f32', IW);
      const K = +(process.env.DSH_DUMP_K || 3000); let rs = 12345; const rnd = () => (rs = (rs * 1664525 + 1013904223) >>> 0) / 4294967296;
      const pick = []; for (let n = 0; n < K && n < items.length; n++) pick.push(items[Math.floor(rnd() * items.length)]);
      const seedsOut = [];
      for (const it of pick) {
        const sd = it.res ? { col: it.res.col, bb: it.res.bb, px: it.res.px } : { col: shapes[it.i].col, bb: shapes[it.i].bb, px: shapes[it.i].kind > 0 ? shapes[it.i].px : null };
        const cand = search.searchSeed(sd);
        const init = search.dbg.initFromRegion({ col: sd.col, bb: sd.bb, px: sd.px || (() => { const [x0, y0, x1, y1] = sd.bb; const px = new Int32Array((x1 - x0 + 1) * (y1 - y0 + 1)); let k = 0; for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) px[k++] = yy * W + xx; return px; })() });
        const tr0 = init.sxx + init.syy, diag = tr0 > 1e-9 ? Math.min(1, Math.abs(2 * init.sxy) / tr0) : 0, rbSeed = preferRot * diag, starts = [];
        for (const name of kinds) {
          const kind = KIND_BY_NAME[name], evalAt = search.dbg.scorer(kind);
          for (const st of search.dbg.initsFor(kind, init)) for (const a0 of (alphaOn ? [AQ_MAX, 14] : [AQ_MAX])) { const v = st.slice(); v[5] = a0; starts.push({ kind, v, sc: evalAt(v, rbSeed) }); }
        }
        seedsOut.push({ col: sd.col, bb: sd.bb, init, rb: rbSeed, starts, cand: cand ? { kind: cand.kind, q: cand.q, j: cand.j, rb: cand.rb || 0 } : null });
      }
      fs.writeFileSync(dir + '/meta.json', JSON.stringify({ W, H, T, LAMBDA, kinds, noRotation, rotCost, preferRot, maxEval, alphaOn, nShapes: shapes.length, hasWeights: !!IW, CAP }));
      fs.writeFileSync(dir + '/seeds.json', JSON.stringify(seedsOut));
      log('已导出搜索快照 ' + dir + '，种子 ' + seedsOut.length + '，有候选 ' + seedsOut.filter((x) => x.cand).length);
      process.exit(0);
    }
    const before = accepted;
    let k = 0;
    const B = gpuCli ? GPU_BATCH : pool ? threads * 16 : 1;
    let tPool = 0, tApply = 0, tSync = 0, tGpu = 0;
    const live = (it) => (it.res ? err[it.res.p] >= resThr : shapes[it.i].alive);
    for (let off = 0; off < items.length; off += B) {
      const batch = items.slice(off, off + B).filter(live);
      if (!batch.length) continue;
      let cands = null;
      const seedOf = (it) => (it.res ? { i: it.i, col: it.res.col, bb: it.res.bb, px: it.res.px } : { i: it.i, col: shapes[it.i].col, bb: shapes[it.i].bb, px: shapes[it.i].kind > 0 ? shapes[it.i].px : null });
      if (gpuCli) {
        // GPU 搜索：起点列表由 JS 算（有线程池就并行），打分 / 挑起点 / 爬山在 GPU 上，tryAdd 仍是 CPU 上的精确判据
        try {
          let t1 = Date.now(); syncMeta(false);
          const seedsIn = batch.map(seedOf);
          const sts = pool ? await pool.run(seedsIn, 'starts') : seedsIn.map((sd) => ({ i: sd.i, st: search.startsFor(sd) }));
          const stMap = new Map(sts.map((r) => [r.i, r.st])); tPool += Date.now() - t1; t1 = Date.now();
          await gpuCli.sync(cur, err, topArr, vis, aliveArr, bbArr, shapes.length); tSync += Date.now() - t1; t1 = Date.now();
          const ordered = batch.map((it) => stMap.get(it.i));
          const res = await gpuCli.search(ordered);
          tGpu += Date.now() - t1; gpuSeeds += batch.length;
          cands = new Map(batch.map((it, bi) => [it.i, res.found[bi] ? { kind: res.kind[bi], q: [res.q[bi * 6], res.q[bi * 6 + 1], res.q[bi * 6 + 2], res.q[bi * 6 + 3], res.q[bi * 6 + 4], res.q[bi * 6 + 5], 0, 0], j: res.j[bi], rb: ordered[bi].rb } : null]));
        } catch (e) {
          log('⚠ GPU 搜索出错，这一批起退回 CPU 线程池：' + e.message);
          try { await gpuCli.close(); } catch { /* 已退出 */ }
          gpuCli = null;
        }
      }
      if (!cands && pool) {
        let t1 = Date.now(); syncMeta(false); tSync += Date.now() - t1; t1 = Date.now();
        const res = await pool.run(batch.map((it) => it.res ? { i: it.i, col: it.res.col, bb: it.res.bb, px: it.res.px } : { i: it.i, col: shapes[it.i].col, bb: shapes[it.i].bb, px: shapes[it.i].kind > 0 ? shapes[it.i].px : null }));
        tPool += Date.now() - t1;
        cands = new Map(res.map((r) => [r.i, r.cand]));
      }
      const t2 = Date.now();
      for (const it of batch) {
        if (++k % 5000 === 0) log(`  第 ${pass + 1} 遍 ${k}/${items.length}，收 ${accepted - before}`);
        if (!live(it)) continue;
        tried++;
        let cand;
        if (cands) cand = cands.get(it.i);
        else if (it.res) cand = search.searchSeed(it.res);
        else { const s = shapes[it.i]; cand = search.searchSeed({ col: s.col, bb: s.bb, px: s.kind > 0 ? s.px : null }); }
        if (!cand) continue;
        const res = tryAdd(cand.kind, cand.q, cand.rb || 0);
        if (res) { accepted++; removedTotal += res.removed; byKind[cand.kind]++; }
      }
      tApply += Date.now() - t2;
    }
    log(`第 ${pass + 1} 遍：收 ${accepted - before}，当前 ${shapes.filter((s) => s.alive).length} 个形状（${gpuCli ? `GPU：起点 ${(tPool / 1000).toFixed(1)}s、搜索 ${(tGpu / 1000).toFixed(1)}s，` : '线程池 ' + (tPool / 1000).toFixed(1) + 's，'}主线程应用 ${(tApply / 1000).toFixed(1)}s，同步 ${(tSync / 1000).toFixed(1)}s）`);
  };
  const { colorSweep, geomSweep, rectSweep, pruneSweep } = R;
  const refineRoundSerial = (r) => {
    const tm = [];
    const timed = (f) => { const t = Date.now(); const v = f(); tm.push(((Date.now() - t) / 1000).toFixed(0)); return v; };
    const pr = r < prune ? timed(pruneSweep) : 0;
    const rm = r < rectEdges ? timed(rectSweep) : 0;
    const gm = r < geom ? timed(geomSweep) : 0;
    const cm = r < refit ? timed(colorSweep) : 0;
    log(`精修第 ${r + 1} 轮：删 ${pr}、矩形边 ${rm}、几何 ${gm}、颜色 ${cm}，MAE ${(totalErr() / (N * 3)).toFixed(3)}，控件 ${shapes.filter((x) => x.alive).length}（耗时 修剪/矩形边/几何/颜色 ${tm.join('/')} s）`);
  };
  // 分块并行精修（shapes-tiles.mjs）：包围盒完全落在某个分块里的形状丢给工作线程并行精修，其余留给下一轮错开半格的网格，
  // 再剩下的（大光斑、大矩形、底板）主线程串行处理。分块边长 ≈ 图边长 / 5（64～256），分块少于 4 个时不值得，走串行。
  const tileSize = Math.max(64, Math.min(256, Math.round(Math.max(W, H) / 5)));
  const useParallelRefine = () => !!pool && parallelRefine && Math.ceil(W / tileSize) * Math.ceil(H / tileSize) >= 4;
  const applyRecs = (recs) => {
    recs.sort((a, b) => a.id - b.id);
    for (const rec of recs) {
      const sh = shapes[rec.id];
      if (!rec.alive) { const px = sh.px; for (let k = 0; k < px.length; k++) removeP(px[k], rec.id); sh.alive = false; continue; }
      if (rec.px) { restack(rec.id, sh, rec.px, rec.cv); sh.bb = rec.bb; sh.area = rec.area; }
      sh.col = rec.col; if (rec.q) sh.q = rec.q;
    }
  };
  /** 调试：从堆栈重算每个像素的渲染色，核对共享内存里的 cur / err（环境变量 DSH_REFINE_CHECK=1 时每轮做一次） */
  const checkConsistency = (tag) => {
    const o = [0, 0, 0]; let bad = 0, worst = 0;
    for (let p = 0; p < N; p++) {
      const e = renderPix(p, -1, o), d = Math.abs(Math.fround(e) - err[p]); if (d > 1e-3) { bad++; if (d > worst) worst = d; }
      const ids = stId[p]; for (let i = 1; i < ids.length; i++) if (ids[i - 1] >= ids[i]) { bad++; break; }
    }
    log(`  [一致性检查 ${tag}] 与堆栈不符的像素 ${bad} 个，最大偏差 ${worst.toFixed(4)}`);
  };
  const refineRoundParallel = async (r) => {
    const sweeps = { prune: r < prune, rect: r < rectEdges, geom: r < geom, color: r < refit };
    const counts = { pr: 0, rm: 0, gm: 0, cm: 0 }, tm = [];
    // 先按包围盒分类：落在哪一种网格的某个分块里（依次试各个错开的网格），都不行的（大光斑、大矩形、底板）留给主线程
    const h2 = tileSize >> 1, gridOffs = (+process.env.DSH_TILE_GRIDS || 4) === 2 ? [[0, 0], [h2, h2]] : [[0, 0], [h2, 0], [0, h2], [h2, h2]];
    const grids = gridOffs.map(([ox, oy]) => tileGrid(W, H, tileSize, ox, oy)), locs = grids.map((g) => makeLocator(W, H, g));
    const which = new Int8Array(shapes.length).fill(-1), left = [];
    for (let id = 1; id < shapes.length; id++) {
      const sh = shapes[id]; if (!sh.alive) continue;
      for (let g = 0; g < locs.length; g++) if (locs[g](sh.bb) >= 0) { which[id] = g; break; }
      if (which[id] < 0) left.push(id);
    }
    // 大形状在画序里多半靠下（光斑、大矩形），串行时本来就是 id 小的先动；所以主线程先处理它们，再让工作线程精修上面的小形状
    const t2 = Date.now();
    const leftRect = left.filter((i) => shapes[i].kind === 0), leftShape = left.filter((i) => shapes[i].kind !== 0);
    if (sweeps.prune) counts.pr += pruneSweep(left);
    if (sweeps.rect) counts.rm += rectSweep(leftRect);
    if (sweeps.geom) counts.gm += geomSweep(leftShape);
    if (sweeps.color) counts.cm += colorSweep([0, ...left]);
    tm.push(`主线程 ${((Date.now() - t2) / 1000).toFixed(0)}`);
    const done = new Uint8Array(shapes.length); let inTiles = 0;
    for (let g = 0; g < grids.length; g++) {
      const grid = grids[g], t0 = Date.now();
      const jobs = buildTileJobs(shapes, W, H, grid, (id) => which[id] === g && !done[id]);
      const tBuild = Date.now() - t0;
      const results = await pool.refine(jobs, sweeps);
      const t1 = Date.now();
      for (let i = 0; i < jobs.length; i++) {
        const res = results[i]; if (!res) continue;
        counts.pr += res.counts.pr; counts.rm += res.counts.rm; counts.gm += res.counts.gm; counts.cm += res.counts.cm;
        applyRecs(res.recs);
        for (const id of jobs[i].movable) done[id] = 1;
        inTiles += jobs[i].movable.length;
      }
      tm.push(`打包 ${(tBuild / 1000).toFixed(0)} 线程 ${((t1 - t0 - tBuild) / 1000).toFixed(0)} 套用 ${((Date.now() - t1) / 1000).toFixed(0)}`);
    }
    log(`精修第 ${r + 1} 轮（分块并行）：删 ${counts.pr}、矩形边 ${counts.rm}、几何 ${counts.gm}、颜色 ${counts.cm}，MAE ${(totalErr() / (N * 3)).toFixed(3)}，控件 ${shapes.filter((x) => x.alive).length}`
      + `（分块 ${inTiles} 个形状 / 主线程 ${left.length} 个；耗时 ${tm.join(' ｜ ')} s）`);
    if (process.env.DSH_REFINE_CHECK) checkConsistency(`第 ${r + 1} 轮`);
  };
  const refineRound = async (r) => { if (useParallelRefine()) await refineRoundParallel(r); else refineRoundSerial(r); };
  const rounds = Math.max(refit, geom, rectEdges, prune);
  try {
    if (gpu) {
      try {
        if (kinds.some((k) => !['ellipse', 'rotrect', 'triangle', 'ring'].includes(k))) throw new Error('GPU 搜索只支持 ellipse / rotrect / triangle / ring');
        if (noRotation) throw new Error('GPU 搜索暂不支持 --no-rotation');
        const meta = { W, H, T, LAMBDA, kinds, rotCost, preferRot, maxEval, alphaOn, CAP, hasWeights: !!IW, nprog: 1024, side: 8, warps: 2 };
        gpuCli = await startGpu({ python: gpuPython, meta, raw, weights: IW, log });
        log(`GPU 搜索已启用（每批 ${GPU_BATCH} 个种子）`);
      } catch (e) { log('⚠ GPU 搜索不可用，退回 CPU 线程池：' + e.message); gpuCli = null; }
    }
    for (let pass = 0; pass < passes; pass++) {
      await addPass(pass);
      if (interleave && pass < passes - 1 && rounds > 0) await refineRound(0);
    }
    for (let r = 0; r < rounds; r++) await refineRound(r);
  } finally {
    if (gpuCli) await gpuCli.close();
    if (pool) await pool.close();
  }
  // 收尾自检：从像素堆栈重算每个像素的渲染色，和缓存的 err 对一遍（分块并行精修把一部分写入交给了工作线程，
  // 这是对「主线程的堆栈」与「共享内存里的 cur / err」没有走偏的兜底；O(像素数 × 堆栈深度)，1000 px 不到 1 秒）
  let stackMismatch = 0;
  { const o = [0, 0, 0]; for (let p = 0; p < N; p++) if (Math.abs(Math.fround(renderPix(p, -1, o)) - err[p]) > 1e-3) stackMismatch++; }
  if (stackMismatch) log(`⚠ 收尾自检：${stackMismatch} 个像素的缓存误差与堆栈重算不符（并行精修的写入出了偏差，结果不可信，请用 --no-parallel-refine 重跑并反馈）`);
  // 输出：幸存矩形（原顺序）+ 形状（创建顺序）；颜色取整
  const outRects = [], outShapes = [];
  const rc = (c) => c.map((v) => Math.max(0, Math.min(255, Math.round(v))));
  shapes.forEach((s, i) => {
    if (!s.alive) return;
    if (s.kind === 0) { const [x0, y0, x1, y1] = s.bb; outRects.push([x0, y0, x1 - x0 + 1, y1 - y0 + 1, ...rc(s.col)]); }
    else outShapes.push(s.q[6] || s.q[7] ? [s.kind, ...s.q, ...rc(s.col)] : [s.kind, ...s.q.slice(0, 6), ...rc(s.col)]);     // 软边形状 12 项，其余 10 项
  });
  // 边缘带 / 其余区域的 MAE 拆分（由 compress.py 传 --mae-mask 时给出）。
  // 用最终模型逐像素的误差算，和 Python 侧纯矩形路径的 mae_split 是同一个口径（每像素每通道）。
  let maeEdge = null, maeOther = null;
  if (maeMask) {
    let se = 0, ce = 0, so = 0, co = 0;
    for (let p = 0; p < N; p++) if (maeMask[p]) { se += err[p]; ce++; } else { so += err[p]; co++; }
    maeEdge = ce ? se / (3 * ce) : 0;
    maeOther = co ? so / (3 * co) : 0;
  }
  const stats = { start: startN, rects: outRects.length, shapes: outShapes.length, total: outRects.length + outShapes.length,
    ellipses: byKind[1], rotrects: byKind[2], triangles: byKind[3], rings: byKind[4], softs: byKind[5], removed: removedTotal, lambda: LAMBDA, startMAE: startErr / (N * 3), mae: totalErr() / (N * 3),
    maeEdge, maeOther, weighted: !!IW,
    seeded: seedIds.filter((i) => shapes[i].alive).length, seededIn: seedIds.length, stackMismatch, gpuSeeds };   // 预置底层形状：活下来的 / 一共放进去的
  return { rects: outRects, shapes: outShapes, stats };
}

if (process.argv[1] && fileURLToPath(import.meta.url).toLowerCase() === fs.realpathSync(process.argv[1]).toLowerCase()) {
  const a = process.argv.slice(2);
  const [rawPath, Ws, Hs, Ts] = a;
  const opt = (k, d) => { const i = a.indexOf(k); return i >= 0 ? a[i + 1] : d; };
  if (!rawPath || !Ws || !Hs || Ts === undefined) { console.error('用法：node shapes.mjs <raw.rgb> <W> <H> <T> [--strength 1] [--passes 3] [--max-eval 250] [--kinds ellipse,rotrect] [--no-refine] [--threads N] [--seed-shapes spots.json] [--weights I.f32] [--mae-mask mask.u8]'); process.exit(1); }
  const W = Number(Ws), H = Number(Hs), T = Number(Ts), raw = fs.readFileSync(rawPath);
  if (raw.length !== W * H * 3) { console.error(`raw 大小 ${raw.length} ≠ ${W}×${H}×3`); process.exit(1); }
  const wPath = opt('--weights', '');
  const weights = wPath ? readWeights(wPath, W, H) : null;
  const maskPath = opt('--mae-mask', '');
  let maeMask = null;
  if (maskPath) {
    maeMask = new Uint8Array(fs.readFileSync(maskPath));
    if (maeMask.length !== W * H) { console.error(`mask 大小 ${maeMask.length} ≠ ${W}×${H}`); process.exit(1); }
  }
  const t0 = Date.now();
  const base = layered(raw, W, H, T, { weights });
  // 预置底层形状：外部（spot-fit.mjs）先铺好的光斑，作为"底板之上、色块之下"的一层
  const seedPath = opt('--seed-shapes', '');
  // 接受三种写法：{shapes:[…]}（spot-fit.mjs 的输出）、{spots:[…]}、或裸数组。
  // 找不到就明确说出来——静默当成"没有预置形状"会白跑一整轮而且看不出原因。
  let seedShapes = [];
  if (seedPath) {
    const doc = JSON.parse(fs.readFileSync(seedPath, 'utf8'));
    seedShapes = Array.isArray(doc) ? doc : (doc.shapes ?? doc.spots ?? []);
    if (!Array.isArray(seedShapes) || !seedShapes.length) {
      console.error(`错误：${seedPath} 里没有可用的 shapes / spots 数组（顶层键：${Object.keys(doc).join(', ') || '无'}）`);
      process.exit(1);
    }
  }
  const fast = a.includes('--no-refine');       // 只做贪心替换，不精修
  const num = (k, d) => Number(opt(k, d));
  const r = await fitShapes(raw, W, H, T, base.rects, { threads: num('--threads', Math.max(1, Math.min(8, os.cpus().length - 2))), strength: num('--strength', 1), passes: num('--passes', 3), maxEval: num('--max-eval', 250),
    kinds: opt('--kinds', 'ellipse,rotrect').split(','), noRotation: a.includes('--no-rotation'), rotCost: num('--rotation-cost', 0), preferRot: num('--prefer-rotation', 0), seedShapes, weights, maeMask,
    refit: fast ? 0 : num('--refit', 4), geom: fast ? 0 : num('--geom', 4), rectEdges: fast ? 0 : num('--rect-edges', 3), prune: fast ? 0 : num('--prune', 3),
    interleave: !fast && !a.includes('--no-interleave'), parallelRefine: !a.includes('--no-parallel-refine'), gpu: a.includes('--gpu'), gpuBatch: num('--gpu-batch', 0), gpuPython: opt('--gpu-python', 'python'), l1: !a.includes('--no-l1'), alphaOn: a.includes('--alpha'), residual: !a.includes('--no-residual'), log: (s) => console.error(s) });
  process.stdout.write(JSON.stringify({ rects: r.rects, shapes: r.shapes, tiled: base.tiled, stats: r.stats, ms: Date.now() - t0 }));
}
