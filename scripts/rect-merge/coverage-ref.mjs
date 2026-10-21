/**
 * coverage-ref.mjs —— 形状覆盖率的「冻结参考实现」（只给自检用，不要在流水线里 import）。
 *
 * 这是 2026-10-20 优化 shapes-core.mjs 的 coverageInto 之前的原始算法，逐字保留：用 Math.hypot 算 sd、
 * 每个超采样点都走一遍 switch。`check.mjs --selftest` 用它对拍当前的 coverageInto（随机形状、逐像素、
 * 覆盖率逐位相同）。以后再改光栅化（提速也好、改模型也好），先让这份对拍保持通过，或者**明确地**更新这份参考。
 */
export const Q_POS = 4;
const SHAPE_CONSTS = { ringRatio: 0.8 };
const KIND_ELLIPSE = 1, KIND_ROTRECT = 2, KIND_TRIANGLE = 3, KIND_RING = 4, KIND_SOFT = 5;
const SOFT_L = 0.83;
const ellSd = (lx, ly, hw, hh) => {
  const d = Math.hypot(lx / hw, ly / hh);
  return d < 1e-9 ? -Math.min(hw, hh) : (d - 1) / (Math.hypot(lx / (hw * hw), ly / (hh * hh)) / d);
};
function sdOf(kind, lx, ly, hw, hh) {
  switch (kind) {
    case KIND_ELLIPSE: return ellSd(lx, ly, hw, hh);
    case KIND_ROTRECT: case KIND_SOFT: return Math.max(Math.abs(lx) - hw, Math.abs(ly) - hh);
    case KIND_TRIANGLE: {
      const L = Math.hypot(2 * hh, hw);
      return Math.max(ly - hh, (-2 * hh * lx - hw * (ly + hh)) / L, (2 * hh * lx - hw * (ly + hh)) / L);
    }
    default: {
      const rho = SHAPE_CONSTS.ringRatio;
      return Math.max(ellSd(lx, ly, hw, hh), -ellSd(lx, ly, hw * rho, hh * rho));
    }
  }
}
function insideOf(kind, ux, uy, hw, hh) {
  switch (kind) {
    case KIND_ELLIPSE: return (ux / hw) * (ux / hw) + (uy / hh) * (uy / hh) <= 1;
    case KIND_ROTRECT: case KIND_SOFT: return Math.abs(ux) <= hw && Math.abs(uy) <= hh;
    case KIND_TRIANGLE: {
      const L = Math.hypot(2 * hh, hw);
      return uy <= hh && (-2 * hh * ux - hw * (uy + hh)) / L <= 0 && (2 * hh * ux - hw * (uy + hh)) / L <= 0;
    }
    default: {
      const rho = SHAPE_CONSTS.ringRatio, o = (ux / hw) * (ux / hw) + (uy / hh) * (uy / hh), i = (ux / (hw * rho)) * (ux / (hw * rho)) + (uy / (hh * rho)) * (uy / (hh * rho));
      return o <= 1 && i > 1;
    }
  }
}
const roundKind = (kind) => kind === KIND_ELLIPSE || kind === KIND_RING;
export function coverageRef(buf, W, H, kind, cx, cy, hw, hh, th, fx = 0, fy = 0) {
  const c = Math.cos(th), s = Math.sin(th);
  const ex = roundKind(kind) ? Math.hypot(hw * c, hh * s) : Math.abs(hw * c) + Math.abs(hh * s);
  const ey = roundKind(kind) ? Math.hypot(hw * s, hh * c) : Math.abs(hw * s) + Math.abs(hh * c);
  const x0 = Math.max(0, Math.floor(cx - ex - 1)), x1 = Math.min(W - 1, Math.ceil(cx + ex + 1));
  const y0 = Math.max(0, Math.floor(cy - ey - 1)), y1 = Math.min(H - 1, Math.ceil(cy + ey + 1));
  const { px, cv } = buf;
  let n = 0;
  for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
    const dx = x + 0.5 - cx, dy = y + 0.5 - cy, lx = dx * c + dy * s, ly = -dx * s + dy * c;
    const sd = sdOf(kind, lx, ly, hw, hh);
    let a;
    if (sd < -1) a = 1;
    else if (sd > 1) continue;
    else {
      let cnt = 0;
      for (let j = 0; j < 4; j++) for (let i = 0; i < 4; i++) {
        const sx = x + (i + 0.5) / 4 - cx, sy = y + (j + 0.5) / 4 - cy;
        if (insideOf(kind, sx * c + sy * s, -sx * s + sy * c, hw, hh)) cnt++;
      }
      if (!cnt) continue;
      a = cnt / 16;
    }
    if (kind === KIND_SOFT && (fx > 0 || fy > 0)) {
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
