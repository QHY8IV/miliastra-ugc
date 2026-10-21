/**
 * shapes-tiles.mjs —— 精修的分块并行（2026-10-20）。
 *
 * 思路：精修里每个形状的评估 / 修改只碰自己覆盖的像素。把图切成互不重叠的矩形分块，
 * 「包围盒完全落在某个分块里」的形状，它的所有移动都被限制在这个分块里（makeRefiner 的 bounds），
 * 所以不同分块里的形状互不影响，可以各自丢给一个工作线程并行精修；横跨分块边界的形状留给下一轮
 * 错开半个分块的网格，再剩下的（大光斑、大矩形）由主线程串行处理。
 *
 * 工作线程需要的只是「这个分块里每个像素上有哪些形状」：主线程把每个形状的像素按分块切好、打成几块类型化数组发过去
 * （发 transferable，不复制）；工作线程自己重建局部的像素堆栈，按与串行完全相同的判据精修，把有变化的形状回传。
 * cur / err 在共享内存里，工作线程只写自己分块内的像素（分块互不重叠），所以不会互相踩。
 */
import { makeRefiner } from './shapes-refine.mjs';

/** 把 W×H 切成分块（含端点的像素范围 [x0,y0,x1,y1]）。off > 0 时第一条分界线在 off，后面每隔 ts 一条（x、y 方向各自的偏移） */
export function tileGrid(W, H, ts, offX = 0, offY = offX) {
  const cuts = (L, off) => { const a = [0]; for (let x = off > 0 ? off : ts; x < L; x += ts) a.push(x); a.push(L); return a; };
  const xs = cuts(W, offX), ys = cuts(H, offY), out = [];
  for (let j = 0; j + 1 < ys.length; j++) for (let i = 0; i + 1 < xs.length; i++) out.push([xs[i], ys[j], xs[i + 1] - 1, ys[j + 1] - 1]);
  return { regions: out, xs, ys };
}

/** 定位器：形状包围盒完全落在某个分块里就返回分块序号，横跨分块边界返回 −1 */
export function makeLocator(W, H, grid) {
  const { xs, ys } = grid, nx = xs.length - 1, ny = ys.length - 1;
  const colTile = new Int32Array(W), rowTile = new Int32Array(H);
  for (let i = 0; i < nx; i++) for (let x = xs[i]; x < xs[i + 1]; x++) colTile[x] = i;
  for (let j = 0; j < ny; j++) for (let y = ys[j]; y < ys[j + 1]; y++) rowTile[y] = j;
  return (bb) => {
    const i0 = colTile[Math.max(0, bb[0])], i1 = colTile[Math.min(W - 1, bb[2])], j0 = rowTile[Math.max(0, bb[1])], j1 = rowTile[Math.min(H - 1, bb[3])];
    return i0 === i1 && j0 === j1 ? j0 * nx + i0 : -1;
  };
}

/**
 * 为一批分块一次性打包任务。返回 [{ job, transfer, movable:[id…], load }]（与 regions 同序）。
 * eligible(id)：这个形状本轮还能不能当「可动形状」（已被前一个网格处理过的不再动，只当背景）。
 * 每个形状的像素只遍历一次（按所在分块分桶），所以主线程打包的代价 ≈ 全部形状像素数，与分块个数无关。
 */
export function buildTileJobs(shapes, W, H, grid, eligible) {
  const { regions, xs, ys } = grid, nx = xs.length - 1, ny = ys.length - 1;
  const colTile = new Int32Array(W), rowTile = new Int32Array(H);
  for (let i = 0; i < nx; i++) for (let x = xs[i]; x < xs[i + 1]; x++) colTile[x] = i;
  for (let j = 0; j < ny; j++) for (let y = ys[j]; y < ys[j + 1]; y++) rowTile[y] = j;
  const entries = regions.map(() => []);          // 每个分块：[{ id, s, px, cv, movable }]
  for (let id = 0; id < shapes.length; id++) {
    const s = shapes[id]; if (!s.alive) continue;
    const bb = s.bb;
    const i0 = colTile[Math.max(0, bb[0])], i1 = colTile[Math.min(W - 1, bb[2])], j0 = rowTile[Math.max(0, bb[1])], j1 = rowTile[Math.min(H - 1, bb[3])];
    if (i0 === i1 && j0 === j1) { entries[j0 * nx + i0].push({ id, s, px: s.px, cv: s.cv, movable: eligible(id) }); continue; }
    if (s.kind === 0) {
      // 矩形：每个相交分块里的像素就是包围盒与分块的交，直接按行生成
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const r = regions[j * nx + i], x0 = Math.max(bb[0], r[0]), x1 = Math.min(bb[2], r[2]), y0 = Math.max(bb[1], r[1]), y1 = Math.min(bb[3], r[3]);
        if (x1 < x0 || y1 < y0) continue;
        const px = new Int32Array((x1 - x0 + 1) * (y1 - y0 + 1)); let k = 0;
        for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) px[k++] = y * W + x;
        entries[j * nx + i].push({ id, s, px, cv: null, movable: false });
      }
      continue;
    }
    // 其它形状：按像素所在分块分桶（先数后填，各遍历一次）
    const w = i1 - i0 + 1, h = j1 - j0 + 1, cnt = new Int32Array(w * h), sp = s.px, sc = s.cv, n = sp.length;
    for (let k = 0; k < n; k++) { const p = sp[k]; cnt[(rowTile[(p / W) | 0] - j0) * w + (colTile[p % W] - i0)]++; }
    const bp = [], bc = [], fill = new Int32Array(w * h);
    for (let t = 0; t < w * h; t++) { bp.push(cnt[t] ? new Int32Array(cnt[t]) : null); bc.push(cnt[t] ? new Float32Array(cnt[t]) : null); }
    for (let k = 0; k < n; k++) { const p = sp[k], t = (rowTile[(p / W) | 0] - j0) * w + (colTile[p % W] - i0); bp[t][fill[t]] = p; bc[t][fill[t]++] = sc[k]; }
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) { const t = (j - j0) * w + (i - i0); if (bp[t]) entries[j * nx + i].push({ id, s, px: bp[t], cv: bc[t], movable: false }); }
  }
  return regions.map((region, ti) => {
    const es = entries[ti], m = es.length; let total = 0;
    for (const e of es) total += e.px.length;
    const ids = new Int32Array(m), kinds = new Int8Array(m), movable = new Uint8Array(m), cols = new Float64Array(m * 3), qs = new Int32Array(m * 8),
      bbs = new Int32Array(m * 4), areas = new Int32Array(m), off = new Int32Array(m + 1), pxAll = new Int32Array(total), cvAll = new Float32Array(total);
    const mov = []; let o = 0;
    es.forEach((e, i) => {
      const s = e.s;
      ids[i] = e.id; kinds[i] = s.kind; movable[i] = e.movable ? 1 : 0; if (e.movable) mov.push(e.id);
      cols.set(s.col, i * 3); if (s.q) qs.set(s.q, i * 8); bbs.set(s.bb, i * 4); areas[i] = s.area;
      off[i] = o; pxAll.set(e.px, o);
      if (e.cv) cvAll.set(e.cv, o); else cvAll.fill(1, o, o + e.px.length);
      o += e.px.length;
    });
    off[m] = o;
    const job = { region, ids, kinds, movable, cols, qs, bbs, areas, off, pxAll, cvAll };
    return { job, transfer: [ids.buffer, kinds.buffer, movable.buffer, cols.buffer, qs.buffer, bbs.buffer, areas.buffer, off.buffer, pxAll.buffer, cvAll.buffer], movable: mov, load: total };
  });
}

/** 工作线程侧：持有局部的像素堆栈与一个 makeRefiner（track = false），按任务重建分块、精修、回传有变化的形状 */
export function makeTileWorker(d) {
  const W = d.W, H = d.H, N = W * H;
  const shapes = [], stId = new Array(N), stCv = new Array(N);
  const cur = new Float32Array(d.curBuf), err = new Float32Array(d.errBuf), raw = new Uint8Array(d.rawBuf), IW = d.weightsBuf ? new Float32Array(d.weightsBuf) : null;
  const R = makeRefiner({ shapes, stId, stCv, vis: null, topArr: null, cur, err, raw, bg: d.bg, IW, W, H, N, LAMBDA: d.LAMBDA, l1: d.l1, noRotation: d.noRotation, alphaOn: d.alphaOn, track: false });
  return function runJob(job, sweeps) {
    const [rx0, ry0, rx1, ry1] = job.region;
    for (let y = ry0; y <= ry1; y++) for (let x = rx0; x <= rx1; x++) { const p = y * W + x; if (stId[p]) { stId[p].length = 0; stCv[p].length = 0; } else { stId[p] = []; stCv[p] = []; } }
    shapes.length = 0;
    const m = job.ids.length, init = [], movIds = [], rectIds = [], shapeIds = [];
    for (let i = 0; i < m; i++) {
      const id = job.ids[i], px = job.pxAll.subarray(job.off[i], job.off[i + 1]), kind = job.kinds[i];
      const cv = kind === 0 ? null : job.cvAll.subarray(job.off[i], job.off[i + 1]);
      const sh = { kind, col: [job.cols[i * 3], job.cols[i * 3 + 1], job.cols[i * 3 + 2]], q: kind === 0 ? undefined : Array.from(job.qs.subarray(i * 8, i * 8 + 8)),
        px, cv, bb: Array.from(job.bbs.subarray(i * 4, i * 4 + 4)), area: job.areas[i], alive: true };
      shapes[id] = sh;
      const cvv = job.cvAll;
      for (let k = 0, o = job.off[i], n = px.length; k < n; k++) R.pushP(px[k], id, cvv[o + k]);
      if (job.movable[i]) { movIds.push(id); (kind === 0 ? rectIds : shapeIds).push(id); init.push([id, sh, sh.px, sh.col, sh.q]); }
    }
    R.setBounds(job.region);
    const counts = { pr: 0, rm: 0, gm: 0, cm: 0 };
    if (sweeps.prune) counts.pr = R.pruneSweep(movIds);
    if (sweeps.rect) counts.rm = R.rectSweep(rectIds);
    if (sweeps.geom) counts.gm = R.geomSweep(shapeIds);
    if (sweeps.color) counts.cm = R.colorSweep(movIds);
    R.setBounds(null);
    const recs = [], transfer = [];
    for (const [id, sh, px0, col0, q0] of init) {
      const geomChanged = sh.px !== px0;
      if (sh.alive && !geomChanged && sh.col === col0 && sh.q === q0) continue;
      const rec = { id, alive: sh.alive, col: sh.col, q: sh.q, bb: sh.bb, area: sh.area, px: null, cv: null };
      if (sh.alive && geomChanged) {
        // 变了的形状 px / cv 都是新分配的数组（不是任务缓冲的切片）；保险起见按需复制成独占缓冲再 transfer
        const own = (a) => (a.byteOffset === 0 && a.buffer.byteLength === a.byteLength ? a : a.slice());
        rec.px = own(sh.px); transfer.push(rec.px.buffer);
        if (sh.cv) { rec.cv = own(sh.cv); transfer.push(rec.cv.buffer); }
      }
      recs.push(rec);
    }
    shapes.length = 0;
    return { res: { counts, recs, movable: movIds.length }, transfer };
  };
}
