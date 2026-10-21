# -*- coding: utf-8 -*-
"""旋转矩形覆盖率模型（与 shapes-core.mjs 的 coverageInto 逐式对齐）+ 小图对拍。"""
import math
import numpy as np
from PIL import Image

Q_POS, Q_ANG, AQ_MAX = 4, 2, 32
W_IDX = np.arange(0)


def params(q):
    cx = q[0] / Q_POS
    cy = q[1] / Q_POS
    hw = q[2] / Q_POS
    hh = q[3] / Q_POS
    th = (q[4] / Q_ANG) * math.pi / 180.0
    al = (q[5] if len(q) > 5 else AQ_MAX) / AQ_MAX
    return cx, cy, hw, hh, th, al


def cov_rect(cx, cy, hw, hh, th, W, H):
    """返回 (idx 数组, cov 数组, bbox)，cov 是面积占比（不含不透明度）。"""
    c, s = math.cos(th), math.sin(th)
    ex = abs(hw * c) + abs(hh * s)
    ey = abs(hw * s) + abs(hh * c)
    x0 = max(0, math.floor(cx - ex - 1))
    x1 = min(W - 1, math.ceil(cx + ex + 1))
    y0 = max(0, math.floor(cy - ey - 1))
    y1 = min(H - 1, math.ceil(cy + ey + 1))
    xs = np.arange(x0, x1 + 1)
    ys = np.arange(y0, y1 + 1)
    X, Y = np.meshgrid(xs, ys)
    dx = X + 0.5 - cx
    dy = Y + 0.5 - cy
    lx = dx * c + dy * s
    ly = -dx * s + dy * c
    sd = np.maximum(np.abs(lx) - hw, np.abs(ly) - hh)
    full = sd < -1.0
    band = (sd >= -1.0) & (sd <= 1.0)
    if not (full.any() or band.any()):
        return np.zeros(0, np.int64), np.zeros(0), [x0, y0, x1, y1]
    # 4x4 超采样，只在 |sd| <= 1 的带内做
    by, bx = np.nonzero(band)
    cnt = np.zeros(bx.size, np.int32)
    for j in range(4):
        for i in range(4):
            sx = X[by, bx] + (i + 0.5) / 4 - cx
            sy = Y[by, bx] + (j + 0.5) / 4 - cy
            slx = sx * c + sy * s
            sly = -sx * s + sy * c
            cnt += (np.abs(slx) <= hw) & (np.abs(sly) <= hh)
    keep = cnt > 0
    fy, fx = np.nonzero(full)
    idx_f = (ys[fy] * W + xs[fx]).astype(np.int64)
    val_f = np.ones(fx.size)
    idx_b = (ys[by[keep]] * W + xs[bx[keep]]).astype(np.int64)
    val_b = cnt[keep] / 16.0
    return np.concatenate([idx_f, idx_b]), np.concatenate([val_f, val_b]), [x0, y0, x1, y1]


def paint(out, idx, cov, col, alpha=1.0):
    """就地 alpha 混合：out 是 (N,3) float。"""
    a = cov * alpha
    c = np.asarray(col, np.float64)
    out[idx] = out[idx] + (c - out[idx]) * a[:, None]


def render(W, H, rects, shapes):
    out = np.zeros((W * H, 3), np.float64)
    for rc in rects:
        if len(rc) == 5:
            x, y, w, h, col = rc
            col = ((col >> 16) & 255, (col >> 8) & 255, col & 255)
        else:
            x, y, w, h, r, g, b = rc
            col = (r, g, b)
        out.reshape(H, W, 3)[y:y + h, x:x + w] = col
    for sh in shapes:
        cx, cy, hw, hh, th, al = params(sh[1:])
        idx, cv, _ = cov_rect(cx, cy, hw, hh, th, W, H)
        if idx.size:
            paint(out, idx, cv, sh[-3:], al)
    return out


def to_u8(a):
    """与 preview.mjs 一致：Math.round 是「floor(x+0.5)」，不是 numpy 的银行家舍入。"""
    return np.clip(np.floor(a + 0.5), 0, 255).astype(np.uint8)
