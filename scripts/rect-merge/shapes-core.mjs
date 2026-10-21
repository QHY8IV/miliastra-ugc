/**
 * shapes-core.mjs —— 形状拟合的纯函数部分（覆盖率、渲染、爬山搜索），主线程与工作线程共用。
 * 这个文件不含命令行入口，所以可以放心被 worker_threads 导入。
 *
 * 形状种类（kind）与对应的静态图片：1 椭圆 100002、2 旋转矩形 100001、3 三角形 100003、4 圆环 100006。
 * 参数 q = [cxq, cyq, hwq, hhq, thq, aq]：中心、半宽、半高（0.25 源像素为单位）、旋转角（0.5° 为单位，屏幕上顺时针）、
 * 不透明度（aq / 32，1～32）。【真机 2026-10-16，28 号校准关卡量出】三角形 = 顶点朝上、撑满包围盒的等腰三角形；
 * 圆环内径 / 外径 = 0.8，水平垂直方向都按比例缩放；颜色 alpha 是标准的直接混合 底 + (色 − 底) × α。
 */

export const Q_POS = 4;          // 位置 / 半轴量化：1 像素 = 4 单位
export const Q_ANG = 2;          // 角度量化：1° = 2 单位；thq ∈ [0, 360)
export const AQ_MAX = 32;        // 不透明度量化：aq / 32
export const KIND_ELLIPSE = 1, KIND_ROTRECT = 2, KIND_TRIANGLE = 3, KIND_RING = 4, KIND_SOFT = 5;
export const KIND_BY_NAME = { ellipse: KIND_ELLIPSE, rotrect: KIND_ROTRECT, triangle: KIND_TRIANGLE, ring: KIND_RING, soft: KIND_SOFT };
/** kind → 真机上该用哪张图（**离线渲染 / 预览用，含 kind 5 软边**）：真机的软边 = 100001 图 + enableSoftEdge + SetSoftEdgeWidth(fx, fy)。
 *  落盘路径不要用这张表——blocks.mjs 的 IMAGE_ID 故意不含 5，因为存档格式还没有 fx/fy 字段，
 *  映射成 100001 只会静默退化成不透明硬边矩形（那里改用抛错）。 */
export const IMAGE_ID = { 1: 100002, 2: 100001, 3: 100003, 4: 100006, 5: 100001 };
export const Q_FEATHER = 2;            // 羽化宽度量化：0.5 源像素；fxq / fyq ∈ [0, 255]
export const SOFT_L = 0.83;             // 渐隐长度 L = SOFT_L × 宽度参数【真机 2026-10-16，29 号校准关卡】
export const SHAPE_CONSTS = { ringRatio: 0.8 };   // 圆环内径 / 外径【真机实测 0.8，2026-10-16】

// 形状覆盖率的热路径（2026-10-20 优化）：搜索线程与几何微调都在反复调它。要点——
//  · Math.hypot 比 Math.sqrt(a*a+b*b) 慢得多，而 sd 只用来分类（< −1 全覆盖、> 1 无、其余 4×4 超采样），所以改用 sqrt；
//    sd 落在 ±1 的刚好边界上时分类可能变一格，但那种像素超采样也给出同样的 0 或 1，输出不变（逐像素对拍见 check.mjs 自检）；
//  · 三角形的 L = hypot(2hh, hw) 每次调用只算一次（旧版每个超采样点都算）；
//  · 超采样的 inside 判断保持原表达式（含除法），不改成乘倒数——采样点恰好落在边界上时舍入差会让结果多 / 少 1/16。
const ellSd = (lx, ly, hw, hh) => {
  const ax = lx / hw, ay = ly / hh, d = Math.sqrt(ax * ax + ay * ay);
  if (d < 1e-9) return -Math.min(hw, hh);
  const gx = lx / (hw * hw), gy = ly / (hh * hh);
  return (d - 1) / (Math.sqrt(gx * gx + gy * gy) / d);
};
const roundKind = (kind) => kind === KIND_ELLIPSE || kind === KIND_RING;

/** 4×4 超采样的覆盖计数（0～16）。按种类分开写，避免每个采样点都走一遍 switch */
function samples16(kind, x, y, cx, cy, c, s, hw, hh, L) {
  let cnt = 0;
  if (kind === KIND_ELLIPSE) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const sx = x + (i + 0.5) / 4 - cx, sy = y + (j + 0.5) / 4 - cy, ux = sx * c + sy * s, uy = -sx * s + sy * c;
      if ((ux / hw) * (ux / hw) + (uy / hh) * (uy / hh) <= 1) cnt++;
    }
  } else if (kind === KIND_ROTRECT || kind === KIND_SOFT) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const sx = x + (i + 0.5) / 4 - cx, sy = y + (j + 0.5) / 4 - cy, ux = sx * c + sy * s, uy = -sx * s + sy * c;
      if (Math.abs(ux) <= hw && Math.abs(uy) <= hh) cnt++;
    }
  } else if (kind === KIND_TRIANGLE) {
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const sx = x + (i + 0.5) / 4 - cx, sy = y + (j + 0.5) / 4 - cy, ux = sx * c + sy * s, uy = -sx * s + sy * c;
      if (uy <= hh && (-2 * hh * ux - hw * (uy + hh)) / L <= 0 && (2 * hh * ux - hw * (uy + hh)) / L <= 0) cnt++;
    }
  } else {
    const rho = SHAPE_CONSTS.ringRatio;
    for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
      const sx = x + (i + 0.5) / 4 - cx, sy = y + (j + 0.5) / 4 - cy, ux = sx * c + sy * s, uy = -sx * s + sy * c;
      const o = (ux / hw) * (ux / hw) + (uy / hh) * (uy / hh), ii = (ux / (hw * rho)) * (ux / (hw * rho)) + (uy / (hh * rho)) * (uy / (hh * rho));
      if (o <= 1 && ii > 1) cnt++;
    }
  }
  return cnt;
}

/** 形状覆盖率（供实验、核对共用）：逐像素写进 px / cv，返回写入个数 n；参数是源像素单位，不含不透明度 */
export function coverageInto(buf, W, H, kind, cx, cy, hw, hh, th, fx = 0, fy = 0) {
  const c = Math.cos(th), s = Math.sin(th);
  const ex = roundKind(kind) ? Math.hypot(hw * c, hh * s) : Math.abs(hw * c) + Math.abs(hh * s);
  const ey = roundKind(kind) ? Math.hypot(hw * s, hh * c) : Math.abs(hw * s) + Math.abs(hh * c);
  const x0 = Math.max(0, Math.floor(cx - ex - 1)), x1 = Math.min(W - 1, Math.ceil(cx + ex + 1));
  const y0 = Math.max(0, Math.floor(cy - ey - 1)), y1 = Math.min(H - 1, Math.ceil(cy + ey + 1));
  const { px, cv } = buf;
  const L = kind === KIND_TRIANGLE ? Math.hypot(2 * hh, hw) : 0, rho = SHAPE_CONSTS.ringRatio, soft = kind === KIND_SOFT && (fx > 0 || fy > 0);
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, lx = dx * c + dy * s, ly = -dx * s + dy * c;
    let sd;
    switch (kind) {
      case KIND_ELLIPSE: sd = ellSd(lx, ly, hw, hh); break;
      case KIND_ROTRECT: case KIND_SOFT: sd = Math.max(Math.abs(lx) - hw, Math.abs(ly) - hh); break;
      case KIND_TRIANGLE: sd = Math.max(ly - hh, (-2 * hh * lx - hw * (ly + hh)) / L, (2 * hh * lx - hw * (ly + hh)) / L); break;
      default: sd = Math.max(ellSd(lx, ly, hw, hh), -ellSd(lx, ly, hw * rho, hh * rho));
    }
    let a;
    if (sd < -1) a = 1;
    else if (sd > 1) continue;
    else {
      const cnt = samples16(kind, x, y, cx, cy, c, s, hw, hh, L);
      if (!cnt) continue;
      a = cnt / 16;
    }
    if (soft) {
      // 软边：遮罩 = smoothstep(到最近竖边的距离 / Lx) × smoothstep(到最近横边的距离 / Ly)，Lx = SOFT_L × fx（宽度 0 = 该方向不渐隐）
      const ddx = Math.max(0, hw - Math.abs(lx)), ddy = Math.max(0, hh - Math.abs(ly));
      const tx = fx > 0 ? Math.min(1, ddx / (SOFT_L * fx)) : 1, ty = fy > 0 ? Math.min(1, ddy / (SOFT_L * fy)) : 1;
      a *= tx * tx * (3 - 2 * tx) * ty * ty * (3 - 2 * ty);
      if (a < 0.004) continue;
    }
    px[n] = y * W + x; cv[n] = a; n++;
  }
  buf.bb = [x0, y0, x1, y1];
  return n;
}

export const shapeParams = (q) => ({ cx: q[0] / Q_POS, cy: q[1] / Q_POS, hw: q[2] / Q_POS, hh: q[3] / Q_POS, th: (q[4] / Q_ANG) * Math.PI / 180, alpha: (q[5] ?? AQ_MAX) / AQ_MAX, fx: (q[6] ?? 0) / Q_FEATHER, fy: (q[7] ?? 0) / Q_FEATHER });
/**
 * 归一化一个「预置形状」（seedShapes 的每一项）为规范形式
 *   { kind, q: [cxq, cyq, hwq, hhq, thq, aq, fxq, fyq], col: [r, g, b] }
 *
 * 【为什么需要在这里统一】
 *   形状的**扁平元组有 9 / 10 / 12 三种长度口径**，而且第 7 位到底是不是 aq 取决于长度
 *   （v1 无 aq、v2 有 aq、v3 还有 fx / fy）。这个歧义在本项目里已经造成过
 *   「软边被静默画成不透明硬边、零报错」的退化，所以长度**只在这一个地方判**。
 *
 * 接受两种写法：
 *   · 对象 { kind, q:[…6~8 项], col:[r,g,b] }  ← spot-fit.mjs 的输出、shapes.mjs 的内部格式
 *   · 扁平数组，口径同 renderItems：9（v1）/ 10（v2）/ 12（v3）
 * 认不出来就抛错，绝不猜一个默认值。
 */
export function normalizeSeedShape(s, where = 'seed') {
  const show = (() => { try { const t = JSON.stringify(s); return t === undefined ? String(s) : t.slice(0, 120); } catch { return String(s); } })();
  const fail = (why) => { throw new Error(`${where} 不是可识别的预置形状（${why}）：${show}`); };
  let kind, q, col;
  if (Array.isArray(s)) {
    const L = s.length;
    if (L !== 9 && L !== 10 && L !== 12) fail(`扁平数组长度 ${L}，只认 9 / 10 / 12`);
    kind = s[0];
    col = s.slice(L - 3);
    const head = s.slice(1, L - 3);          // 5（v1）/ 6（v2）/ 8（v3）项
    const [cxq, cyq, hwq, hhq, thq] = head;
    q = [cxq, cyq, hwq, hhq, thq,
         head.length >= 6 ? head[5] : AQ_MAX,
         head.length >= 8 ? head[6] : 0,
         head.length >= 8 ? head[7] : 0];
  } else if (s && typeof s === 'object') {
    if (!Array.isArray(s.q)) fail('对象形式要求有数组 q');
    if (!Array.isArray(s.col)) fail('对象形式要求有数组 col');
    if (s.q.length < 6 || s.q.length > 8) fail(`q 长度 ${s.q.length} 不在 6~8`);
    if (s.col.length !== 3) fail(`col 长度 ${s.col.length} ≠ 3`);
    kind = s.kind;
    q = [s.q[0], s.q[1], s.q[2], s.q[3], s.q[4], s.q[5],
         s.q[6] ?? 0, s.q[7] ?? 0];
    col = s.col;
  } else {
    fail('既不是数组也不是对象');
  }
  const KINDS = [KIND_ELLIPSE, KIND_ROTRECT, KIND_TRIANGLE, KIND_RING, KIND_SOFT];
  if (!KINDS.includes(kind)) fail(`kind=${kind} 不是已知形状种类（1 椭圆 2 旋转矩形 3 三角形 4 圆环 5 软边）`);
  const nums = [...q, ...col].map(Number);
  if (nums.some((v) => !Number.isFinite(v))) fail('含非有限数值');
  return { kind, q: nums.slice(0, 8), col: nums.slice(8, 11) };
}

/** 形状的几何外延是否在图内（否则控件会画出图外） */
export function insideImage(kind, p, W, H) {
  const c = Math.cos(p.th), s = Math.sin(p.th);
  const ex = roundKind(kind) ? Math.hypot(p.hw * c, p.hh * s) : Math.abs(p.hw * c) + Math.abs(p.hh * s);
  const ey = roundKind(kind) ? Math.hypot(p.hw * s, p.hh * c) : Math.abs(p.hw * s) + Math.abs(p.hh * c);
  return p.cx - ex >= -1e-6 && p.cx + ex <= W + 1e-6 && p.cy - ey >= -1e-6 && p.cy + ey <= H + 1e-6;
}

/** 按绘制顺序（矩形再形状）渲染成 Float32Array(W*H*3)，用来核对。形状项：[kind,cxq,cyq,hwq,hhq,thq,aq,r,g,b]（旧的 9 项没有 aq，按不透明） */
export function renderItems(W, H, rects, shapes, bg = [0, 0, 0]) {
  const N = W * H, out = new Float32Array(N * 3);
  for (let p = 0; p < N; p++) { out[p * 3] = bg[0]; out[p * 3 + 1] = bg[1]; out[p * 3 + 2] = bg[2]; }
  for (const [x, y, w, h, r, g, b] of rects) for (let yy = y; yy < y + h; yy++) for (let xx = x; xx < x + w; xx++) { const p = (yy * W + xx) * 3; out[p] = r; out[p + 1] = g; out[p + 2] = b; }
  const buf = { px: new Int32Array(W * H), cv: new Float32Array(W * H) };
  for (const sh of shapes) {
    // v1：[kind,cx,cy,hw,hh,th,r,g,b]（9）；v2：…,th,aq,r,g,b（10）；v3：…,th,aq,fx,fy,r,g,b（12）
    const [kind, cxq, cyq, hwq, hhq, thq] = sh;
    const aq = sh.length >= 10 ? sh[6] : AQ_MAX, fxq = sh.length >= 12 ? sh[7] : 0, fyq = sh.length >= 12 ? sh[8] : 0;
    const [r, g, b] = sh.slice(-3);
    const q = shapeParams([cxq, cyq, hwq, hhq, thq, aq, fxq, fyq]);
    const n = coverageInto(buf, W, H, kind, q.cx, q.cy, q.hw, q.hh, q.th, q.fx, q.fy);
    for (let k = 0; k < n; k++) { const p = buf.px[k] * 3, a = buf.cv[k] * q.alpha; out[p] += (r - out[p]) * a; out[p + 1] += (g - out[p + 1]) * a; out[p + 2] += (b - out[p + 2]) * a; }
  }
  return out;
}
export function maeOf(raw, img) { let s = 0; for (let i = 0; i < img.length; i++) s += Math.abs(raw[i] - img[i]); return s / img.length; }

/**
 * 搜索器：给定一个种子（col、bb、px），在共享状态（cur / err / topArr / vis / aliveArr / bbArr，都是只读快照）上
 * 做区域主轴初值 + 爬山，返回最好的候选 {kind, q, j}（j < 0 才值得试）或 null。
 * env：{ raw, W, H, T, LAMBDA, cur, err, topArr, vis, aliveArr, bbArr, kinds, noRotation, rotCost, maxEval, alphaOn }
 */
export function makeSearch(env) {
  const { raw, W, H, T, LAMBDA, cur, err, topArr, vis, aliveArr, bbArr, kinds, noRotation, rotCost, preferRot = 0, maxEval, alphaOn = false, weights = null } = env;
  // preferRot：旋转形状的**加分**（单位同 rotCost = 控件数）。rotCost 是"转一下多花几个控件"的代价，
  // preferRot 反过来给"转了才对得上斜边"的区域发补贴。按种子的对角强度 diag∈[0,1] 缩放：
  // 轴对齐的区域 diag≈0 拿不到补贴（否则会凭空乱转，白花 SetLocalRotation），斜边区域 diag≈1 拿满。
  // weights：逐像素视觉重要度 I（null = 不加权）。目标函数里的误差按 I 加权 ——
  // 边缘 / 焦点处一个像素的误差算得贵，搜索就更愿意在那里补形状、在平坦区省控件。
  const N = W * H;
  const scratch = { px: new Int32Array(N), cv: new Float32Array(N), bb: null };
  /** 形状该用的颜色：不透明时 = 覆盖像素的均值；半透明时 = 让 (1−α)·现有颜色 + α·色 平均等于原图 */
  const meanColor = (px, cv, n, alpha = 1) => {
    let r = 0, g = 0, b = 0, m = 0;
    const ia = 1 / alpha, k0 = 1 - alpha;
    for (let k = 0; k < n; k++) if (cv[k] >= 0.5) {
      const p = px[k];
      if (alpha >= 0.999) { r += raw[p * 3]; g += raw[p * 3 + 1]; b += raw[p * 3 + 2]; }
      else { r += (raw[p * 3] - k0 * cur[p * 3]) * ia; g += (raw[p * 3 + 1] - k0 * cur[p * 3 + 1]) * ia; b += (raw[p * 3 + 2] - k0 * cur[p * 3 + 2]) * ia; }
      m++;
    }
    if (!m) return null;
    const cl = (v) => Math.max(0, Math.min(255, v / m));
    return [cl(r), cl(g), cl(b)];
  };
  const cnt = new Map();
  const coverIdx = new Int32Array(N);          // 本次打分里「当前候选形状」的覆盖值，按 patch 下标索引
  const coverSum = new Map();                  // 候选可删块：Σ 候选遮罩透明度
  const coverGood = new Map();                 // 候选可删块：透明度 ≥ 0.9 的像素数
  // 诊断探针默认关闭（DSH_SOFT_DIAG=1 才统计；只在单线程时统计准确，工作线程各有一份不汇总）
  const diag = { softCalls: 0, withRem: 0, remHist: {}, candGeo: 0, rejFull: 0, rejGood: 0 };
  const DIAG = !!process.env.DSH_SOFT_DIAG;
  /**
   * 爬山用的快速打分：误差增量 − λ × (估计可删数 − 1)，越小越好。
   *
   * translucent 分两种，别混为一谈（2026-10-16 修正）：
   *  - 真半透明（α<1）盖不住别人 → 不估可删数（保持原行为）；
   *  - **软边（α 可为 1）**：边缘是"渐隐"不是"半透明"，中心照样是不透明的，能整块盖住下面的块。
   *    旧代码把它和半透明一起跳过估计，于是软边在**代理打分**里白拿不到可删数收益、比不过硬形状；
   *    可删数估计「有没有」不影响 tryAdd 的正确性（那里用真实透明度精确评估），只影响排序，所以这里可以量化判。
   *    判据：一块 s 算可删 ⟺ s 的像素里 ≥95% 的候选遮罩透明度 ≥ 0.9（真实 α 由 coverageInto 预乘后写入）。
   */
  function proxyScore(n, bb, col, pen = 0, translucent = false, soft = false) {
    const { px, cv } = scratch;
    let d = 0; cnt.clear();
    if (soft) { coverSum.clear(); coverGood.clear(); }
    for (let k = 0; k < n; k++) {
      const p = px[k], a = cv[k];
      const r = cur[p * 3] + (col[0] - cur[p * 3]) * a, g = cur[p * 3 + 1] + (col[1] - cur[p * 3 + 1]) * a, b = cur[p * 3 + 2] + (col[2] - cur[p * 3 + 2]) * a;
      const e = Math.abs(r - raw[p * 3]) + Math.abs(g - raw[p * 3 + 1]) + Math.abs(b - raw[p * 3 + 2]) - err[p];
      d += weights ? e * weights[p] : e;
      if (soft) coverIdx[p] = a;
      if ((!translucent || soft) && a >= 0.5) {
        const t = topArr[p];
        if (t >= 0) {
          cnt.set(t, (cnt.get(t) || 0) + 1);
          if (soft) { coverSum.set(t, (coverSum.get(t) || 0) + a); if (a >= 0.9) coverGood.set(t, (coverGood.get(t) || 0) + 1); }
        }
      }
    }
    let rem = 0;
    if (DIAG && soft) diag.softCalls++;
    for (const [q, m] of cnt) {
      if (!aliveArr[q] || vis[q] <= 0 || m < 0.9 * vis[q]) continue;
      const o = q * 4;
      if (!(bbArr[o] >= bb[0] && bbArr[o + 1] >= bb[1] && bbArr[o + 2] <= bb[2] && bbArr[o + 3] <= bb[3])) continue;
      if (DIAG && soft) diag.candGeo++;
      if (soft) {
        // 用真实遮罩判定：整块几乎都被近不透明地盖住，才算「这个形状能取代它」
        const tot = vis[q];
        if (tot <= 0 || m < 0.98 * tot) { if (DIAG) diag.rejFull++; continue; }             // 覆盖不全 → 不算
        if ((coverGood.get(q) || 0) < 0.95 * tot) { if (DIAG) diag.rejGood++; continue; }   // 透明度不够 → 不算
      }
      rem++;
    }
    if (DIAG && soft) { diag.remHist[rem] = (diag.remHist[rem] || 0) + 1; if (rem > 0) diag.withRem++; }
    return d - LAMBDA * (rem - 1 - pen);
  }
  if (DIAG) {
    const t = setInterval(() => {
      console.error(`[soft-diag] 软边打分 ${diag.softCalls} 次；可删数>0: ${diag.withRem}；几何候选 ${diag.candGeo}（因覆盖不全否 ${diag.rejFull}、因透明度否 ${diag.rejGood}）；rem 分布 ${JSON.stringify(diag.remHist)}`);
    }, 5000);
    t.unref?.();
  }

  const mark = new Int32Array(N).fill(-1);
  let markGen = 0;
  /** 种子附近同色区域（容差 2×STD）的矩 → 初值 */
  function initFromRegion(seed) {
    const gen = ++markGen, c0 = seed.col, tol = Math.max(2 * T, 6);
    const qq = [], pts = [];
    for (const p of seed.px) { mark[p] = gen; qq.push(p); }
    const cx0 = (seed.bb[0] + seed.bb[2] + 1) / 2, cy0 = (seed.bb[1] + seed.bb[3] + 1) / 2;
    const lim = Math.max(seed.bb[2] - seed.bb[0], seed.bb[3] - seed.bb[1]) + 40;
    for (let qi = 0; qi < qq.length && qq.length < 5000; qi++) {
      const p = qq[qi], x = p % W, y = (p / W) | 0;
      pts.push(p);
      for (let d = 0; d < 4; d++) {
        const nx = x + (d === 0) - (d === 1), ny = y + (d === 2) - (d === 3);
        if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
        const np = ny * W + nx; if (mark[np] === gen) continue;
        if (Math.abs(nx - cx0) > lim || Math.abs(ny - cy0) > lim) continue;
        const m = Math.max(Math.abs(raw[np * 3] - c0[0]), Math.abs(raw[np * 3 + 1] - c0[1]), Math.abs(raw[np * 3 + 2] - c0[2]));
        if (m <= tol) { mark[np] = gen; qq.push(np); }
      }
    }
    let mx = 0, my = 0; for (const p of pts) { mx += p % W; my += (p / W) | 0; } mx = mx / pts.length + 0.5; my = my / pts.length + 0.5;
    let sxx = 0, syy = 0, sxy = 0;
    for (const p of pts) { const dx = (p % W) + 0.5 - mx, dy = ((p / W) | 0) + 0.5 - my; sxx += dx * dx; syy += dy * dy; sxy += dx * dy; }
    sxx /= pts.length; syy /= pts.length; sxy /= pts.length;
    const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
    const tr = sxx + syy, det = sxx * syy - sxy * sxy, disc = Math.sqrt(Math.max(0, tr * tr / 4 - det));
    return { cx: mx, cy: my, th, l1: Math.max(tr / 2 + disc, 0.25), l2: Math.max(tr / 2 - disc, 0.25), sxx, syy, sxy };
  }

  const normAng = (a) => ((a % 360) + 360) % 360;
  const toQ = (cx, cy, hw, hh, thDeg, aq, fxq = 0, fyq = 0) => [Math.round(cx * Q_POS), Math.round(cy * Q_POS), Math.max(2, Math.round(hw * Q_POS)), Math.max(2, Math.round(hh * Q_POS)), normAng(Math.round(thDeg * Q_ANG)), aq, fxq, fyq];
  /** 某个种类的若干个初始参数 */
  function initsFor(kind, init) {
    const deg = init.th * 180 / Math.PI;
    if (kind === KIND_TRIANGLE) {
      // 三角形：局部 x / y 轴方向未知，试 4 个朝向；中心 = 重心沿局部 y 轴往上挪 hh/3
      const out = [];
      for (let k = 0; k < 4; k++) {
        const th = init.th + k * Math.PI / 2, c = Math.cos(th), s = Math.sin(th);
        const vu = init.sxx * c * c + 2 * init.sxy * c * s + init.syy * s * s, vv = init.sxx * s * s - 2 * init.sxy * c * s + init.syy * c * c;
        const hw = Math.sqrt(6 * Math.max(vu, 0.25)), hh = Math.sqrt(4.5 * Math.max(vv, 0.25));
        // 重心在局部 (0, +hh/3)（顶点在 −hh，底边在 +hh）→ 中心 = 重心 − (−s, c)·hh/3
        out.push(toQ(init.cx + s * hh / 3, init.cy - c * hh / 3, hw, hh, deg + k * 90, AQ_MAX));
      }
      return out;
    }
    if (kind === KIND_RING) {
      const f = 2 / Math.sqrt(1 + SHAPE_CONSTS.ringRatio ** 2);
      return [noRotation ? toQ(init.cx, init.cy, f * Math.sqrt(Math.max(init.sxx, 0.25)), f * Math.sqrt(Math.max(init.syy, 0.25)), 0, AQ_MAX)
        : toQ(init.cx, init.cy, f * Math.sqrt(init.l1), f * Math.sqrt(init.l2), deg, AQ_MAX)];
    }
    if (kind === KIND_SOFT) {
      // 软边矩形：尺寸同旋转矩形再放大一点；羽化起点 = 各边长的 0.35（渐隐长度约 0.29 倍边长）
      const hwp = 1.3 * Math.sqrt(3) * Math.sqrt(noRotation ? Math.max(init.sxx, 0.25) : init.l1), hhp = 1.3 * Math.sqrt(3) * Math.sqrt(noRotation ? Math.max(init.syy, 0.25) : init.l2);
      const fx0 = Math.round(0.35 * 2 * hwp * Q_FEATHER), fy0 = Math.round(0.35 * 2 * hhp * Q_FEATHER);
      return [toQ(init.cx, init.cy, hwp, hhp, noRotation ? 0 : deg, AQ_MAX, fx0, fy0)];
    }
    const sc = kind === KIND_ELLIPSE ? 2 : Math.sqrt(3);
    return [noRotation ? toQ(init.cx, init.cy, sc * Math.sqrt(Math.max(init.sxx, 0.25)), sc * Math.sqrt(Math.max(init.syy, 0.25)), 0, AQ_MAX)
      : toQ(init.cx, init.cy, sc * Math.sqrt(init.l1), sc * Math.sqrt(init.l2), deg, AQ_MAX)];
  }

  /** 软边形状的颜色：覆盖率随位置变化（遮罩），每个像素 raw ≈ cur + a·(色 − cur)，按 a² 加权的最小二乘 → 色 = Σ a·(raw − (1−a)·cur) / Σ a² */
  const softColor = (px, cv, n, alpha) => {
    const num = [0, 0, 0]; let den = 0;
    for (let k = 0; k < n; k++) {
      const a = cv[k] * alpha; if (a < 0.02) continue;
      const p = px[k];
      num[0] += a * (raw[p * 3] - (1 - a) * cur[p * 3]); num[1] += a * (raw[p * 3 + 1] - (1 - a) * cur[p * 3 + 1]); num[2] += a * (raw[p * 3 + 2] - (1 - a) * cur[p * 3 + 2]);
      den += a * a;
    }
    if (den < 1e-6) return null;
    return num.map((v) => Math.max(0, Math.min(255, v / den)));
  };
  /** 某种形状的打分函数：参数向量 q（+ 该种子的旋转补贴 rb）→ 爬山用的快速分数（越小越好，Infinity = 不可用） */
  const scorer = (kind) => (q, rb = 0) => {
    if (q[2] < 2 || q[3] < 2 || q[5] < 3 || q[5] > AQ_MAX || q[6] < 0 || q[7] < 0 || q[6] > 255 || q[7] > 255) return Infinity;
    const pr = shapeParams(q);
    if (!insideImage(kind, pr, W, H)) return Infinity;
    const n = coverageInto(scratch, W, H, kind, pr.cx, pr.cy, pr.hw, pr.hh, pr.th, pr.fx, pr.fy);
    const soft = kind === KIND_SOFT && (pr.fx > 0 || pr.fy > 0);
    const col = soft ? softColor(scratch.px, scratch.cv, n, pr.alpha) : meanColor(scratch.px, scratch.cv, n, pr.alpha); if (!col) return Infinity;
    if (pr.alpha < 0.999) for (let k = 0; k < n; k++) scratch.cv[k] *= pr.alpha;
    return proxyScore(n, scratch.bb, col, q[4] !== 0 ? rotCost - rb : 0, soft || pr.alpha < 0.999, soft);
  };
  function climb(kind, evalAt, v0, best0, rb = 0) {
    let v = v0.slice(), best = best0, evals = 1;
    const stages = [[4, 4, 16, 4, 8], [2, 2, 8, 2, 4], [1, 1, 4, 1, 2], [1, 1, 2, 1, 1], [1, 1, 1, 1, 1]];   // [位置步, 半轴步, 角度步, 不透明度步, 羽化步]（量化单位）
    const idx = [0, 1, 2, 3, ...(noRotation ? [] : [4]), ...(alphaOn || kind === KIND_SOFT ? [5] : []), ...(kind === KIND_SOFT ? [6, 7] : [])];
    for (const [sp, sz, sa, sq, sf] of stages) {
      const steps = [sp, sp, sz, sz, sa, sq, sf, sf];
      let improved = true;
      while (improved && evals < maxEval) {
        improved = false;
        for (let ii = 0; ii < idx.length && evals < maxEval; ii++) for (const sg of [1, -1]) {
          const i = idx[ii];
          const w = v.slice(); w[i] += sg * steps[i]; if (i === 4) w[4] = normAng(w[4]);
          const s = evalAt(w, rb); evals++;
          if (s < best - 1e-6) { v = w; best = s; improved = true; break; }
        }
      }
    }
    if (roundKind(kind) && v[2] === v[3]) v[4] = 0;      // 圆转不转都一样，不花旋转的代价
    return best < 0 ? { kind, q: v, j: best, rb } : null;
  }

  /** GPU 搜索用：只做 searchSeed 的前半（initFromRegion + initsFor），返回 { rb, starts: [{ kind, v }] }（顺序同 searchSeed：
   *  先按 kinds 的顺序，再按各种类的初始参数，最后按不透明度起点）；打分、挑起点、爬山都在 GPU 上（gpu_search_server.py）。 */
  function startsFor(seed) {
    let px = seed.px;
    if (!px) {
      const [x0, y0, x1, y1] = seed.bb; px = new Int32Array((x1 - x0 + 1) * (y1 - y0 + 1)); let k = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) px[k++] = yy * W + xx;
    }
    const init = initFromRegion({ col: seed.col, bb: seed.bb, px });
    const tr0 = init.sxx + init.syy;
    const rb = preferRot * (tr0 > 1e-9 ? Math.min(1, Math.abs(2 * init.sxy) / tr0) : 0);
    const starts = [];
    for (const name of kinds) {
      const kind = KIND_BY_NAME[name];
      for (const st of initsFor(kind, init)) for (const a0 of (alphaOn ? [AQ_MAX, 14] : [AQ_MAX])) { const v = st.slice(0, 6); v[5] = a0; starts.push({ kind, v }); }
    }
    return { rb, starts };
  }

  /** 一个种子 → 最好的候选或 null。seed：{ col, bb, px }（px 为空时按 bb 的整数矩形展开）。
   *  每种形状先对所有初始参数（三角形的 4 个朝向、不透明 / 半透明两种起点）各打一次分，只从最好的 1 个（三角形 2 个）开始爬山，省时间。 */
  function searchSeed(seed) {
    let px = seed.px;
    if (!px) {
      const [x0, y0, x1, y1] = seed.bb; px = new Int32Array((x1 - x0 + 1) * (y1 - y0 + 1)); let k = 0;
      for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) px[k++] = yy * W + xx;
    }
    const init = initFromRegion({ col: seed.col, bb: seed.bb, px });
    // 对角强度：|2·sxy| / (sxx+syy) —— 各向异性只给方向不给"斜不斜"，这个比值才是。
    // 轴对齐的长条 ≈ 0，45° 的斜条 ≈ 1。旋转补贴按它缩放，避免轴对齐区域被无端旋转。
    const tr0 = init.sxx + init.syy;
    const diag = tr0 > 1e-9 ? Math.min(1, Math.abs(2 * init.sxy) / tr0) : 0;
    const rb = preferRot * diag;
    let best = null;
    for (const name of kinds) {
      const kind = KIND_BY_NAME[name], evalAt = scorer(kind);
      const starts = [];
      for (const st of initsFor(kind, init)) for (const a0 of kind === KIND_SOFT ? [AQ_MAX, 20, 12] : alphaOn ? [AQ_MAX, 14] : [AQ_MAX]) { const v = st.slice(); v[5] = a0; starts.push({ v, sc: evalAt(v, rb) }); }
      starts.sort((x, y) => x.sc - y.sc);
      for (const st of starts.slice(0, kind === KIND_TRIANGLE ? 2 : 1)) {
        if (!Number.isFinite(st.sc)) continue;
        const r = climb(kind, evalAt, st.v, st.sc, rb);
        if (r && (!best || r.j < best.j)) best = r;
      }
    }
    return best;
  }
  return { searchSeed, startsFor, scratch, meanColor, softColor, dbg: { scorer, initFromRegion, initsFor, proxyScore } };
}
