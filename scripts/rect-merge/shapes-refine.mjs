/**
 * shapes-refine.mjs —— 形状拟合的「像素堆栈 + 精修」：修剪 / 矩形边 / 几何微调 / 颜色重拟合。
 * 主线程（fitShapes）与精修工作线程共用同一份实现，所以串行与分块并行的判据完全一致。
 *
 * 状态：每个像素一条按形状 id 升序的堆栈（stId / stCv：形状 id、该形状在这个像素上的有效覆盖率），
 *   渲染 = 画家算法，逐层 c = c + (形状色 − c) × 覆盖率。cur / err 缓存每个像素当前的渲染色与 L1 误差（float32，共享内存）。
 *
 * 分块并行用的 bounds：给定后，几何 / 矩形边的移动必须让新包围盒仍落在 bounds 内（越界的候选直接当作无效）。
 *   一个形状的包围盒完全落在某个分块里时，它的所有移动都不会碰分块外的像素，所以不同分块里的形状互不影响，
 *   可以各自在自己的线程里并行精修（见 shapes.mjs 的 refineRoundParallel）。
 */
import { coverageInto, shapeParams, insideImage, AQ_MAX, KIND_SOFT } from './shapes-core.mjs';

/**
 * env：{ shapes, stId, stCv, vis, topArr, cur, err, raw, bg, IW, W, H, N, LAMBDA, l1, noRotation, alphaOn, track }
 *   track = false 时不维护 vis / topArr（那是给搜索线程读的快照；精修工作线程用自己的局部堆栈，不需要）。
 */
export function makeRefiner(env) {
  const { shapes, stId, stCv, vis, topArr, cur, err, raw, bg, IW, W, H, N, LAMBDA, l1 = true, noRotation = false, alphaOn = false, track = true } = env;
  let bounds = null;                      // [x0, y0, x1, y1]（含），null = 不限
  const setBounds = (b) => { bounds = b; };
  const inBounds = (bb) => !bounds || (bb[0] >= bounds[0] && bb[1] >= bounds[1] && bb[2] <= bounds[2] && bb[3] <= bounds[3]);
  const scratch = { px: new Int32Array(N), cv: new Float32Array(N), bb: null };
  const o3 = [0, 0, 0];

  const top = (p) => { const a = stId[p]; return a.length ? a[a.length - 1] : -1; };
  const pushP = (p, id, a) => {
    if (track) { const t = top(p); if (t >= 0) vis[t]--; vis[id]++; topArr[p] = id; }
    stId[p].push(id); stCv[p].push(a);
  };
  const removeP = (p, id) => {
    const ids = stId[p], i = ids.lastIndexOf(id); if (i < 0) return;
    const wasTop = i === ids.length - 1; ids.splice(i, 1); stCv[p].splice(i, 1);
    if (track && wasTop) { vis[id]--; const t = top(p); if (t >= 0) vis[t]++; topArr[p] = t; }
  };
  const insertP = (p, id, a) => {
    const ids = stId[p]; let i = ids.length; while (i > 0 && ids[i - 1] > id) i--;
    if (track && i === ids.length) { const t = top(p); if (t >= 0) vis[t]--; vis[id]++; topArr[p] = id; }
    ids.splice(i, 0, id); stCv[p].splice(i, 0, a);
  };
  const renderPix = (p, skip, out) => {
    let r = bg[0], g = bg[1], b = bg[2]; const ids = stId[p], cs = stCv[p];
    for (let i = 0; i < ids.length; i++) { const id = ids[i]; if (id === skip) continue; const a = cs[i], col = shapes[id].col; r += (col[0] - r) * a; g += (col[1] - g) * a; b += (col[2] - b) * a; }
    out[0] = r; out[1] = g; out[2] = b;
    return Math.abs(r - raw[p * 3]) + Math.abs(g - raw[p * 3 + 1]) + Math.abs(b - raw[p * 3 + 2]);
  };
  const recolor = (p) => { err[p] = renderPix(p, -1, o3); cur[p * 3] = o3[0]; cur[p * 3 + 1] = o3[1]; cur[p * 3 + 2] = o3[2]; };

  // 「假如形状 id 在像素 p 上的覆盖率换成 aNew（0 = 不覆盖）」会渲染成什么颜色，返回 L1 误差；
  // 只读，不动像素堆栈。堆栈按 id 升序，所以新覆盖率应插在第一个比 id 大的形状之前——和 insertP 的位置一致。
  // 算术与 renderPix 逐项相同（同一顺序、同一表达式），所以结果与「先改堆栈、再 recolor」逐位相同。
  const renderAlt = (p, id, aNew, out) => {
    let r = bg[0], g = bg[1], b = bg[2]; const ids = stId[p], cs = stCv[p];
    let pending = aNew > 0; const ccol = shapes[id].col;
    for (let i = 0; i < ids.length; i++) {
      const sid = ids[i];
      if (sid === id) continue;
      if (pending && sid > id) { r += (ccol[0] - r) * aNew; g += (ccol[1] - g) * aNew; b += (ccol[2] - b) * aNew; pending = false; }
      const a = cs[i], col = shapes[sid].col; r += (col[0] - r) * a; g += (col[1] - g) * a; b += (col[2] - b) * a;
    }
    if (pending) { r += (ccol[0] - r) * aNew; g += (ccol[1] - g) * aNew; b += (ccol[2] - b) * aNew; }
    out[0] = r; out[1] = g; out[2] = b;
    // 与 recolor 一样按 float32 存 err，所以这里也 fround：否则「覆盖没变」的无效动作会因 1e-6 级舍入差被误收
    return Math.fround(Math.abs(r - raw[p * 3]) + Math.abs(g - raw[p * 3 + 1]) + Math.abs(b - raw[p * 3 + 2]));
  };
  const oldA = new Float32Array(N), newA = new Float32Array(N);

  /** 把形状 id 的像素集换成 (px2, cv2)（cv2 = null 表示全 1），只动「覆盖率真的变了」的像素的堆栈；不 recolor。
   *  主线程用它套用工作线程回传的结果（cur / err 已经由工作线程写进共享内存）。 */
  const restack = (id, sh, px2, cv2) => {
    const opx = sh.px, ocv = sh.cv, on = opx.length, n = px2.length;
    for (let k = 0; k < on; k++) oldA[opx[k]] = ocv ? ocv[k] : 1;
    for (let k = 0; k < n; k++) newA[px2[k]] = cv2 ? cv2[k] : 1;
    for (let k = 0; k < on; k++) {
      const p = opx[k], a = newA[p];
      if (a === (ocv ? ocv[k] : 1)) continue;
      if (a === 0) removeP(p, id); else stCv[p][stId[p].lastIndexOf(id)] = a;
    }
    for (let k = 0; k < n; k++) { const p = px2[k]; if (oldA[p] === 0) insertP(p, id, cv2 ? cv2[k] : 1); }
    for (let k = 0; k < on; k++) oldA[opx[k]] = 0;
    for (let k = 0; k < n; k++) newA[px2[k]] = 0;
    sh.px = px2; sh.cv = cv2;
  };

  const allIds = (from = 0) => { const a = []; for (let i = from; i < shapes.length; i++) a.push(i); return a; };

  // 颜色重拟合：每个形状的颜色取「给定其它层不动时，使整张图平方误差最小」的值（加权最小二乘，权 = 上层透射率 × 覆盖率）
  const colorSweep = (ids = allIds()) => {
    let moved = 0;
    for (const id of ids) {
      const sh = shapes[id]; if (!sh.alive) continue;
      const px = sh.px, num = [0, 0, 0]; let den0 = 0, den1 = 0, den2 = 0;
      for (let k = 0; k < px.length; k++) {
        const p = px[k], sids = stId[p], cs = stCv[p], i = sids.lastIndexOf(id);
        let b0 = bg[0], b1 = bg[1], b2 = bg[2];
        for (let j = 0; j < i; j++) { const a = cs[j], c = shapes[sids[j]].col; b0 += (c[0] - b0) * a; b1 += (c[1] - b1) * a; b2 += (c[2] - b2) * a; }
        let A0 = 0, A1 = 0, A2 = 0, t = 1;
        for (let j = i + 1; j < sids.length; j++) { const a = cs[j], c = shapes[sids[j]].col; A0 += (c[0] - A0) * a; A1 += (c[1] - A1) * a; A2 += (c[2] - A2) * a; t *= 1 - a; }
        const as = cs[i], w = t * as; if (w < 1e-6) continue;
        // 重要度只加权一次（分子分母各一次）：num = Σ IW·o·w·r、den = Σ IW·o·w²。
        // 旧写法把它并进 w，会让分母多一个 IW（变成 IW²），解出来的颜色整体偏 1/IW —— 是 bug。
        const iw = IW ? IW[p] : 1;
        // l1：迭代重加权（权 = 1 / max(当前该通道残差, 2)）逼近 L1 最优——评估指标是 MAE
        const o0 = l1 ? 1 / Math.max(Math.abs(raw[p * 3] - cur[p * 3]), 2) : 1, o1 = l1 ? 1 / Math.max(Math.abs(raw[p * 3 + 1] - cur[p * 3 + 1]), 2) : 1, o2 = l1 ? 1 / Math.max(Math.abs(raw[p * 3 + 2] - cur[p * 3 + 2]), 2) : 1;
        num[0] += o0 * iw * w * (raw[p * 3] - A0 - t * (1 - as) * b0); num[1] += o1 * iw * w * (raw[p * 3 + 1] - A1 - t * (1 - as) * b1); num[2] += o2 * iw * w * (raw[p * 3 + 2] - A2 - t * (1 - as) * b2);
        den0 += o0 * iw * w * w; den1 += o1 * iw * w * w; den2 += o2 * iw * w * w;
      }
      if (den0 + den1 + den2 < 1e-6) continue;
      const nc = [num[0] / Math.max(den0, 1e-9), num[1] / Math.max(den1, 1e-9), num[2] / Math.max(den2, 1e-9)].map((v) => Math.max(0, Math.min(255, v)));
      if (Math.abs(nc[0] - sh.col[0]) + Math.abs(nc[1] - sh.col[1]) + Math.abs(nc[2] - sh.col[2]) < 0.05) continue;
      sh.col = nc; moved++;
      for (const p of px) recolor(p);
    }
    return moved;
  };

  // 几何微调：对每个旋转 / 椭圆形状，逐个参数试 ±1 量化步，总误差（含被它盖住 / 露出的所有像素）变小就接受。
  // 两处省时间（输出与旧写法逐项相同，见 playbook §2.18）：
  //  · 试探只读——不改像素堆栈，只有被接受的动作才真正改；
  //  · 只处理「覆盖率真的变了」的像素（新旧都是同一个光栅化函数，没变的像素误差增量恰好是 0）。
  //    大光斑（半径几百像素）一次移动只动边缘一圈，其余几十万像素不用碰。
  const geomSweep = (ids = allIds()) => {
    let moved = 0;
    for (const id of ids) {
      const sh = shapes[id]; if (!sh.alive || sh.kind === 0) continue;
      for (const step of [2, 1]) {
        let improved = true, rounds = 0;
        while (improved && rounds++ < 6) {
          improved = false;
          for (const i of [0, 1, 2, 3, ...(noRotation ? [] : [4]), ...(alphaOn || sh.q[5] < AQ_MAX ? [5] : []), ...(sh.kind === KIND_SOFT ? [6, 7] : [])]) for (const sg of [1, -1]) {
            const q = sh.q.slice(); q[i] += sg * (i === 4 ? step * 2 : i >= 6 ? step * 2 : step); if (i === 4) q[4] = ((q[4] % 360) + 360) % 360;
            if (q[2] < 2 || q[3] < 2 || q[5] < 3 || q[5] > AQ_MAX || q[6] < 0 || q[7] < 0 || q[6] > 255 || q[7] > 255) continue;
            const pr = shapeParams(q);
            if (!insideImage(sh.kind, pr, W, H)) continue;
            const n = coverageInto(scratch, W, H, sh.kind, pr.cx, pr.cy, pr.hw, pr.hh, pr.th, pr.fx, pr.fy);
            if (bounds && !inBounds(scratch.bb)) continue;
            if (pr.alpha < 0.999) for (let k = 0; k < n; k++) scratch.cv[k] *= pr.alpha;
            const spx = scratch.px, scv = scratch.cv, opx = sh.px, ocv = sh.cv, on = opx.length;
            for (let k = 0; k < on; k++) oldA[opx[k]] = ocv[k];
            for (let k = 0; k < n; k++) newA[spx[k]] = scv[k];
            // 求和顺序与旧写法一致：先旧覆盖的像素（按原顺序），再只在新覆盖里出现的像素；覆盖率没变的像素增量为 0，跳过
            let d = 0;
            for (let k = 0; k < on; k++) { const p = opx[k]; if (newA[p] === ocv[k]) continue; const e = renderAlt(p, id, newA[p], o3) - err[p]; d += IW ? e * IW[p] : e; }
            for (let k = 0; k < n; k++) { const p = spx[k]; if (oldA[p] !== 0) continue; const e = renderAlt(p, id, scv[k], o3) - err[p]; d += IW ? e * IW[p] : e; }
            if (d < -1e-6) {
              const px2 = spx.slice(0, n), cv2 = scv.slice(0, n), bb2 = scratch.bb.slice();
              // 只改变了的像素：离开 → 摘掉；覆盖率变了 → 原地改堆栈里的值（位置不变）；新进入 → 按 id 序插入
              for (let k = 0; k < on; k++) {
                const p = opx[k], a = newA[p];
                if (a === ocv[k]) continue;
                if (a === 0) removeP(p, id); else stCv[p][stId[p].lastIndexOf(id)] = a;
                recolor(p);
              }
              for (let k = 0; k < n; k++) { const p = px2[k]; if (oldA[p] !== 0) continue; insertP(p, id, cv2[k]); recolor(p); }
              sh.q = q; sh.px = px2; sh.cv = cv2; sh.bb = bb2; sh.area = n; improved = true; moved++;
            }
            for (let k = 0; k < on; k++) oldA[opx[k]] = 0;
            for (let k = 0; k < n; k++) newA[spx[k]] = 0;
          }
        }
      }
    }
    return moved;
  };

  // 矩形边微调：矩形四条边各试 ±1 个像素，总误差变小就接受（分层时只管「露出像素标准差 ≤ STD」，没管真实误差）。
  // 只读评估：只有「旧矩形里有、新矩形里没有」和「新矩形里有、旧矩形里没有」的像素（贴边的一行 / 一列）覆盖率会变，其余不用碰。
  const rectSweep = (ids = allIds(1)) => {
    let moved = 0;
    // 按行主序遍历「a 里有、b 里没有」的像素（顺序与旧写法里 px 列表的顺序一致）
    const forDiff = (a, b, fn) => {
      for (let y = a[1]; y <= a[3]; y++) {
        if (y < b[1] || y > b[3]) { for (let x = a[0]; x <= a[2]; x++) fn(y * W + x); continue; }
        const lx = Math.min(a[2], b[0] - 1); for (let x = a[0]; x <= lx; x++) fn(y * W + x);
        for (let x = Math.max(a[0], b[2] + 1); x <= a[2]; x++) fn(y * W + x);
      }
    };
    for (const id of ids) {          // 0 号是底板，不动
      if (id < 1) continue;
      const sh = shapes[id]; if (!sh.alive || sh.kind !== 0) continue;
      let improved = true, rounds = 0;
      while (improved && rounds++ < 4) {
        improved = false;
        for (let e = 0; e < 4; e++) for (const sg of [1, -1]) {
          const bb = sh.bb.slice(); bb[e] += sg;
          const [x0, y0, x1, y1] = bb;
          if (x0 < 0 || y0 < 0 || x1 >= W || y1 >= H || x1 < x0 || y1 < y0 || x1 - x0 + 1 > 511 || y1 - y0 + 1 > 511) continue;
          if (bounds && !inBounds(bb)) continue;
          const ob = sh.bb;
          let d = 0;
          forDiff(ob, bb, (p) => { const e2 = renderAlt(p, id, 0, o3) - err[p]; d += IW ? e2 * IW[p] : e2; });
          forDiff(bb, ob, (p) => { const e2 = renderAlt(p, id, 1, o3) - err[p]; d += IW ? e2 * IW[p] : e2; });
          if (d < -1e-6) {
            const px2 = new Int32Array((x1 - x0 + 1) * (y1 - y0 + 1)); let k = 0;
            for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) px2[k++] = yy * W + xx;
            forDiff(ob, bb, (p) => { removeP(p, id); recolor(p); });
            forDiff(bb, ob, (p) => { insertP(p, id, 1); recolor(p); });
            sh.px = px2; sh.bb = bb; sh.area = px2.length; improved = true; moved++;
          }
        }
      }
    }
    return moved;
  };

  // 修剪：删掉某个形状 / 矩形后误差增量不到 λ 的，直接删（省一个控件）
  const pruneSweep = (ids = allIds(1)) => {
    const order = ids.filter((i) => i > 0 && shapes[i].alive).sort((a2, b2) => shapes[a2].area - shapes[b2].area);
    let gone = 0; const o = [0, 0, 0];
    for (const id of order) {
      const sh = shapes[id]; if (!sh.alive) continue;
      let d = 0;
      for (const p of sh.px) { const e = renderPix(p, id, o) - err[p]; d += IW ? e * IW[p] : e; }
      if (d < LAMBDA * 0.999) {
        for (let k = 0; k < sh.px.length; k++) { removeP(sh.px[k], id); }
        sh.alive = false; gone++;
        for (const p of sh.px) recolor(p);
      }
    }
    return gone;
  };

  return { top, pushP, removeP, insertP, renderPix, recolor, renderAlt, restack, setBounds, colorSweep, geomSweep, rectSweep, pruneSweep };
}
