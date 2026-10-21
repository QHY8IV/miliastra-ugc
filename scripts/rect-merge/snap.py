# -*- coding: utf-8 -*-
"""斜边补条（edge strip）：在真实斜边处铺细长旋转矩形，把「矩形拼出来的台阶」修成直边。

为什么是补条而不是调权重
  基底层永远是轴对齐矩形，斜边只能被拼成 1~3 px 的台阶。台阶的**颜色误差很小**，
  但边界形状是错的；提高权重只会让台阶变细，不会变直。
  旋转矩形在真机上的抗锯齿很好（用户实测），所以沿边线放一条 9~13 px 长、
  1~3 px 深的条子，就能把这一段台阶切成一条直边。

怎么决定「铺不铺」
  不靠启发式打分，直接**实测**：把条子按与 preview 逐像素一致的覆盖率模型合成到当前渲染上，
  只统计它盖住的那几十个像素的 L1 变化；变好才落。颜色取「盖住的目标像素中位数」——
  常数色在 L1 下的最优解。位置 / 深度 / 铺哪一侧都在小网格里搜一遍取最好。

用法：
  python snap.py 基底.lua 输出.lua --img 原图.png --render 当前渲染.png \
         [--max-strips 1200] [--min-gain 2]
"""
import argparse
import math
import os
import re
import sys

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from blockcodec import unpack_p64, unpack_shapes  # noqa: E402
import compress  # noqa: E402
import covmodel as CM  # noqa: E402

Q_POS, Q_ANG = CM.Q_POS, CM.Q_ANG


# ───────────────────────────── 基础工具 ─────────────────────────────
def box_sum(a, r):
    c = a.cumsum(0).cumsum(1)
    c = np.pad(c, ((1, 0), (1, 0)))
    H, W = a.shape
    y0 = np.clip(np.arange(H) - r, 0, H)
    y1 = np.clip(np.arange(H) + r + 1, 0, H)
    x0 = np.clip(np.arange(W) - r, 0, W)
    x1 = np.clip(np.arange(W) + r + 1, 0, W)
    return c[y1][:, x1] - c[y0][:, x1] - c[y1][:, x0] + c[y0][:, x0]


def sobel(lum):
    gx = np.zeros_like(lum)
    gy = np.zeros_like(lum)
    gx[1:-1, 1:-1] = (lum[:-2, 2:] + 2 * lum[1:-1, 2:] + lum[2:, 2:]) - \
                     (lum[:-2, :-2] + 2 * lum[1:-1, :-2] + lum[2:, :-2])
    gy[1:-1, 1:-1] = (lum[2:, :-2] + 2 * lum[2:, 1:-1] + lum[2:, 2:]) - \
                     (lum[:-2, :-2] + 2 * lum[:-2, 1:-1] + lum[:-2, 2:])
    return gx, gy


def lum_of(rgb):
    return 0.299 * rgb[..., 0] + 0.587 * rgb[..., 1] + 0.114 * rgb[..., 2]


def bilin(img, u, v):
    """u / v 为数组下标空间坐标（像素 i 的中心是 i）。"""
    H, W = img.shape[:2]
    u = np.clip(u, 0, W - 1.001)
    v = np.clip(v, 0, H - 1.001)
    x0 = np.floor(u).astype(int)
    y0 = np.floor(v).astype(int)
    fx = (u - x0)[..., None]
    fy = (v - y0)[..., None]
    x1 = np.minimum(x0 + 1, W - 1)
    y1 = np.minimum(y0 + 1, H - 1)
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
            + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


def sample(img, U, V):
    """向量化双线性采样（同 bilin，吃整个坐标网格）。"""
    H, W = img.shape[:2]
    U = np.clip(U, 0, W - 1.001)
    V = np.clip(V, 0, H - 1.001)
    x0 = np.floor(U).astype(np.int32)
    y0 = np.floor(V).astype(np.int32)
    fx = (U - x0)[..., None]
    fy = (V - y0)[..., None]
    x1 = np.minimum(x0 + 1, W - 1)
    y1 = np.minimum(y0 + 1, H - 1)
    return (img[y0, x0] * (1 - fx) * (1 - fy) + img[y0, x1] * fx * (1 - fy)
            + img[y1, x0] * (1 - fx) * fy + img[y1, x1] * fx * fy)


# ───────────────────────────── 候选边 ─────────────────────────────
def candidates(T, R, diag_min=0.15, coh_min=0.5, err_min=0.0, flat=9.0, contrast_min=12.0,
               sample_r=2, max_cand=60000):
    """斜边候选点：目标图里是「斜的、连贯的、两侧较平、有明显色差」的边。"""
    H, W = T.shape[:2]
    lum = lum_of(T)
    gx, gy = sobel(lum)
    Jxx = box_sum(gx * gx, sample_r)
    Jyy = box_sum(gy * gy, sample_r)
    Jxy = box_sum(gx * gy, sample_r)
    tr = np.maximum(Jxx + Jyy, 1e-9)
    coh = np.sqrt(np.maximum((Jxx - Jyy) ** 2 + 4 * Jxy ** 2, 0)) / tr
    th_e = 0.5 * np.arctan2(2 * Jxy, Jxx - Jyy) + math.pi / 2
    diag = np.abs(np.sin(2 * th_e))

    err = np.abs(T - R).mean(2)
    Y, X = np.mgrid[0:H, 0:W].astype(np.float64)
    nx, ny = -np.sin(th_e), np.cos(th_e)
    ux, uy = np.cos(th_e), np.sin(th_e)
    vp, vm = [], []
    for d in (3.0, 4.5, 6.0):
        for t in (-3.0, 0.0, 3.0):
            vp.append(lum_of(sample(T, X + nx * d + ux * t, Y + ny * d + uy * t)))
            vm.append(lum_of(sample(T, X - nx * d + ux * t, Y - ny * d + uy * t)))
    vp = np.stack(vp)
    vm = np.stack(vm)
    mask = ((diag > diag_min) & (coh > coh_min) & (err > err_min)
            & (vp.std(0) < flat) & (vm.std(0) < flat)
            & (np.abs(vp.mean(0) - vm.mean(0)) > contrast_min))
    ys, xs = np.nonzero(mask)
    if ys.size > max_cand:
        top = np.argsort(-err[ys, xs])[:max_cand]
        ys, xs = ys[top], xs[top]
    return sorted([(int(y), int(x), float(err[y, x])) for y, x in zip(ys, xs)],
                  key=lambda t: -t[2]), th_e


# ───────────────────────────── 补条 ─────────────────────────────
def edge_profile(T, x, y, th, s_max=6.0, step=0.25, tang=(-4.0, -2.0, 0.0, 2.0, 4.0)):
    """沿法向的剖面（沿切向取中位数），返回 (ss, prof)。"""
    nx, ny = -math.sin(th), math.cos(th)
    ss = np.arange(-s_max, s_max + 1e-9, step)
    pts = np.zeros((len(ss), len(tang), 3))
    for i, s in enumerate(ss):
        for j, t in enumerate(tang):
            pts[i, j] = bilin(T, x + nx * s + math.cos(th) * t, y + ny * s + math.sin(th) * t)
    return ss, np.median(pts, axis=1)


def strip_geom(x, y, th, s0, s1, L):
    nx, ny = -math.sin(th), math.cos(th)
    smid = (s0 + s1) / 2.0
    return (x + nx * smid + 0.5, y + ny * smid + 0.5, L / 2.0, abs(s1 - s0) / 2.0,
            math.degrees(th))


def fits(W, H, cx, cy, hw, hh, deg):
    t = math.radians(deg)
    ex = abs(hw * math.cos(t)) + abs(hh * math.sin(t))
    ey = abs(hw * math.sin(t)) + abs(hh * math.cos(t))
    return cx - ex >= 0 and cx + ex <= W and cy - ey >= 0 and cy + ey <= H


def evaluate(R, T, strips, W, H, opt_color=True, min_cov=0.5):
    """实测 delta（只在覆盖到的像素上算，不做整图拷贝）。

    strips: [((cx,cy,hw,hh,deg), col 或 None)]；opt_color 时颜色取覆盖像素的中位数。
    返回 (delta, updates, idxs, cols)。
    """
    Rf = R.reshape(-1, 3)
    Tf = T.reshape(-1, 3)
    delta = 0.0
    idxs, cols, updates = [], [], []
    for (cx, cy, hw, hh, deg), col in strips:
        idx, cv, _ = CM.cov_rect(cx, cy, hw, hh, math.radians(deg), W, H)
        if idx.size == 0:
            continue
        if opt_color:
            m = cv > min_cov
            if not m.any():
                continue
            col = tuple(int(round(v)) for v in np.median(Tf[idx[m]], axis=0))
        old = Rf[idx]
        newpix = old + (np.asarray(col, np.float64) - old) * cv[:, None]
        delta += float(np.abs(Tf[idx] - newpix).mean(1).sum()
                       - np.abs(Tf[idx] - old).mean(1).sum())
        idxs.append(idx)
        cols.append(col)
        updates.append((idx, newpix))
    return delta, updates, idxs, cols


def to_tuple(geom, col):
    cx, cy, hw, hh, deg = geom
    return (2, int(round(cx * Q_POS)), int(round(cy * Q_POS)),
            int(round(hw * Q_POS)), int(round(hh * Q_POS)),
            int(round(deg * Q_ANG)) % 360, 32, int(col[0]), int(col[1]), int(col[2]))


def search_trim(T, R, x, y, th, s_line, W, H, lengths, depths, offsets):
    """在一个候选点上小网格搜「铺哪侧 / 多深 / 偏多少 / 多长」，返回最好的 (-gain, geom, col)。"""
    best = (0.0, None, None)
    for L in lengths:
        for side in (1, -1):
            for off in offsets:
                for dep in depths:
                    s0 = s_line + off if side > 0 else s_line + off - dep
                    s1 = s0 + dep
                    geom = strip_geom(x, y, th, s0, s1, L)
                    if not fits(W, H, *geom):
                        continue
                    d, upd, idxs, cols = evaluate(R, T, [(geom, None)], W, H)
                    if d < best[0]:
                        best = (d, geom, cols[0] if cols else None)
    return best


def search_ridge(T, R, x, y, th, s_line, W, H, lengths, depths, offsets):
    """骑在线上铺（居中）：把细线（书页白边、手指轮廓线）拉成一条直线。

    颜色取盖住像素的中位数（居中时基本就是线色）。形状优先：允许最多 --max-loss 的 L1 损失。
    """
    best = (0.0, None)
    for L in lengths:
        for off in offsets:
            for dep in depths:
                s0 = s_line + off - dep / 2.0
                s1 = s0 + dep
                geom = strip_geom(x, y, th, s0, s1, L)
                if not fits(W, H, *geom):
                    continue
                d, upd, idxs, cols = evaluate(R, T, [(geom, None)], W, H)
                if cols and d < best[0]:
                    best = (d, [(geom, cols[0])])
    return best


def search_pair(T, R, x, y, th, s_line, W, H, lengths, depths, offsets):
    """两侧成对铺：把台阶换成一条直边。颜色取两侧「外侧一半」的中位数（避开过渡带）。"""
    ss, prof = edge_profile(T, x, y, th)
    best = (0.0, None)
    for L in lengths:
        for off in offsets:
            sp = s_line + off
            for dep in depths:
                strips = []
                for s0, s1, minus in ((sp - dep, sp, True), (sp, sp + dep, False)):
                    lo, hi = (s0 + 0.25, s1 - 1.25) if minus else (s0 + 1.25, s1 - 0.25)
                    sel = (ss >= lo) & (ss <= hi)
                    if sel.sum() < 2:
                        strips = None
                        break
                    col = tuple(int(round(v)) for v in np.median(prof[sel], axis=0))
                    geom = strip_geom(x, y, th, s0, s1, L)
                    if not fits(W, H, *geom):
                        strips = None
                        break
                    strips.append((geom, col))
                if not strips:
                    continue
                d, upd, idxs, cols = evaluate(R, T, strips, W, H, opt_color=False)
                if d < best[0]:
                    best = (d, strips)
    return best


# ───────────────────────────── 主流程 ─────────────────────────────
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('src')
    ap.add_argument('dst')
    ap.add_argument('--img', required=True)
    ap.add_argument('--render', required=True)
    ap.add_argument('--max-strips', type=int, default=1200)
    ap.add_argument('--mode', choices=['trim', 'ridge', 'pair'], default='trim',
                    help='trim = 单侧细修剪（只求 L1 变好）；ridge = 骑在线上的细条（拉直细线，允许少量 L1 损失）；'
                         'pair = 两侧成对铺成直边')
    ap.add_argument('--min-gain', type=float, default=2.0,
                    help='trim 模式下一条补条至少要减少这么多 L1 才落')
    ap.add_argument('--max-loss', type=float, default=30.0,
                    help='pair 模式下一条边最多允许增加的 L1（越大铺得越多）')
    ap.add_argument('--len', default='9,13')
    ap.add_argument('--depth', default='1,1.5,2,3')
    ap.add_argument('--offset', default='-1,-0.5,0,0.5,1')
    ap.add_argument('--diag-min', type=float, default=0.15)
    ap.add_argument('--err-min', type=float, default=0.0)
    ap.add_argument('--flat', type=float, default=9.0)
    ap.add_argument('--contrast-min', type=float, default=12.0)
    ap.add_argument('--dbg', default=None)
    ap.add_argument('--verbose', action='store_true')
    a = ap.parse_args()

    text = open(a.src, encoding='utf-8').read()
    info = parse_lua(text)
    W, H = info['W'], info['H']
    blocks = unpack_p64(info['DATA'])
    shapes = list(unpack_shapes(info['SHP'], info['SHPV'])) if info['SHP'] else []

    T = np.asarray(Image.open(a.img).convert('RGB').resize((W, H), Image.LANCZOS), np.float64)
    R0 = np.asarray(Image.open(a.render).convert('RGB'), np.float64)
    R = R0.copy()
    mae0 = np.abs(T - R0).mean()
    print('基线 MAE %.4f' % mae0)

    cand, th_e = candidates(T, R0, diag_min=a.diag_min, err_min=a.err_min, flat=a.flat,
                            contrast_min=a.contrast_min)
    print('斜边候选点 %d' % len(cand))

    lengths = [float(v) for v in a.len.split(',')]
    depths = [float(v) for v in a.depth.split(',')]
    offsets = [float(v) for v in a.offset.split(',')]

    covered = np.zeros((H, W), bool)
    added = []
    gain_total = 0.0
    for (y, x, e) in cand:
        if len(added) >= a.max_strips:
            break
        if covered[y, x]:
            continue
        th = th_e[y, x]
        ss, prof = edge_profile(T, x, y, th)
        s_line = float(ss[int(np.argmax(np.abs(np.gradient(lum_of(prof), ss))))])
        if abs(s_line) > 3.5:
            continue
        if a.mode == 'trim':
            d, geom, col = search_trim(T, R, x, y, th, s_line, W, H, lengths, depths, offsets)
            if geom is None or d > -a.min_gain:
                continue
            new = [(geom, col)]
        elif a.mode == 'ridge':
            d, strips = search_ridge(T, R, x, y, th, s_line, W, H, lengths, depths, offsets)
            if strips is None or d > a.max_loss:
                continue
            new = strips
        else:
            d, strips = search_pair(T, R, x, y, th, s_line, W, H, lengths, depths, offsets)
            if strips is None or d > a.max_loss:
                continue
            new = strips
        for geom, col in new:
            idx, cv, _ = CM.cov_rect(geom[0], geom[1], geom[2], geom[3], math.radians(geom[4]),
                                     W, H)
            Rf = R.reshape(-1, 3)
            Rf[idx] = Rf[idx] + (np.asarray(col, np.float64) - Rf[idx]) * cv[:, None]
            added.append(to_tuple(geom, col))
            ys = np.clip(idx // W, 0, H - 1)
            xs = np.clip(idx % W, 0, W - 1)
            covered[ys, xs] = True
            covered[np.clip(ys + 1, 0, H - 1), xs] = True
            covered[np.clip(ys - 1, 0, H - 1), xs] = True
            covered[ys, np.clip(xs + 1, 0, W - 1)] = True
            covered[ys, np.clip(xs - 1, 0, W - 1)] = True
        gain_total += -d
        if a.verbose and len(added) % 100 < len(new):
            print('  已铺 %d 条，模型 MAE %.4f' % (len(added), np.abs(T - R).mean()))

    print('补条 %d 条（%d 个控件），模型 MAE %.4f → %.4f（−%.4f），累计减少 L1 %.0f'
          % (len(added), len(added), mae0, np.abs(T - R).mean(), mae0 - np.abs(T - R).mean(),
             gain_total))

    allshapes = shapes + added
    compress.write_lua(a.dst, blocks, W, H, info['STD'], 8, info['ENC'], info['MAE'],
                       layered=info['LAYERED'], shapes=allshapes)
    print('已写出 %s：矩形 %d + 形状 %d = %d 个控件'
          % (a.dst, len(blocks), len(allshapes), len(blocks) + len(allshapes)))

    if a.dbg:
        from PIL import ImageDraw
        im = Image.fromarray(CM.to_u8(R)).convert('RGB')
        dd = ImageDraw.Draw(im)
        for t in added:
            cx, cy = t[1] / Q_POS, t[2] / Q_POS
            hw, hh = t[3] / Q_POS, t[4] / Q_POS
            th = math.radians(t[5] / Q_ANG)
            c, s = math.cos(th), math.sin(th)
            poly = [(cx + sx * hw * c - sy * hh * s, cy + sx * hw * s + sy * hh * c)
                    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1))]
            dd.polygon(poly, outline=(255, 0, 255))
        im.save(a.dbg)


def parse_lua(text):
    def num(key):
        mm = re.search(r'IMG\.' + key + r'\s*=\s*(-?[\d.]+)', text)
        return mm.group(1) if mm else None

    def body(key):
        mm = re.search(r'IMG\.' + key + r'\s*=\s*\[(=*)\[(.*?)\]\1\]', text, re.S)
        return mm.group(2) if mm else None

    return {
        'W': int(num('W')), 'H': int(num('H')), 'STD': float(num('STD')),
        'ENC': re.search(r'IMG\.ENC\s*=\s*"(\w+)"', text).group(1),
        'NBLK': int(num('NBLK')), 'MAE': float(num('MAE') or 0),
        'LAYERED': re.search(r'IMG\.LAYERED\s*=\s*(\w+)', text).group(1) == 'true',
        'NSHP': int(num('NSHP') or 0), 'SHPV': int(num('SHPV') or 2),
        'DATA': body('DATA'), 'SHP': body('SHP'),
    }


if __name__ == '__main__':
    main()
