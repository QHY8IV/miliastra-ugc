#!/usr/bin/env python3
"""GPU 形状搜索内核（Triton）：shapes-core.mjs 的 scorer / climb / searchSeed 的移植。

约定（与 CPU 版一致）：形状参数 q = [cxq, cyq, hwq, hhq, thq, aq, 0, 0]（0.25 px / 0.5° / 1/32）；
kind 1 椭圆、2 旋转矩形、3 三角形、4 圆环（不支持软边 kind 5）。
快照数组（只读）：raw u8[N*3]、cur f32[N*3]、err f32[N]、top i32[N]、vis i32[CAP]、alive u8[CAP]、bb i32[CAP*4]、可选权重 w f32[N]。
可删数（候选能取代几个现有形状）用「每个持久程序一行私有计数数组」精确数，不用预先枚举候选表。
"""
import math
import numpy as np
import torch
import triton
import triton.language as tl

INF = 1e30


@triton.jit
def _ell_sd(lx, ly, hw, hh):
    ax = lx / hw
    ay = ly / hh
    d = tl.sqrt(ax * ax + ay * ay)
    gx = lx / (hw * hw)
    gy = ly / (hh * hh)
    g = tl.sqrt(gx * gx + gy * gy)
    sd = (d - 1.0) * d / tl.maximum(g, 1e-30)
    return tl.where(d < 1e-9, -tl.minimum(hw, hh), sd)


@triton.jit
def _inside(kind, ux, uy, hw, hh, L):
    ell = (ux / hw) * (ux / hw) + (uy / hh) * (uy / hh)
    in_e = ell <= 1.0
    in_r = (tl.abs(ux) <= hw) & (tl.abs(uy) <= hh)
    in_t = (uy <= hh) & ((-2.0 * hh * ux - hw * (uy + hh)) / L <= 0.0) & ((2.0 * hh * ux - hw * (uy + hh)) / L <= 0.0)
    ell_in = (ux / (hw * 0.8)) * (ux / (hw * 0.8)) + (uy / (hh * 0.8)) * (uy / (hh * 0.8))
    in_g = (ell <= 1.0) & (ell_in > 1.0)
    return tl.where(kind == 1, in_e, tl.where(kind == 3, in_t, tl.where(kind == 4, in_g, in_r)))


@triton.jit
def _coverage(kind, px, py, cx, cy, hw, hh, c, s, L):
    """4×4 超采样覆盖率（shapes-core.mjs coverageInto 的同一套分类）；px、py 是像素整数坐标（float）。返回 [256] 的 a（0 = 不覆盖）"""
    dx = px + 0.5 - cx
    dy = py + 0.5 - cy
    lx = dx * c + dy * s
    ly = -dx * s + dy * c
    sd_e = _ell_sd(lx, ly, hw, hh)
    sd_r = tl.maximum(tl.abs(lx) - hw, tl.abs(ly) - hh)
    sd_t = tl.maximum(ly - hh, tl.maximum((-2.0 * hh * lx - hw * (ly + hh)) / L, (2.0 * hh * lx - hw * (ly + hh)) / L))
    sd_g = tl.maximum(sd_e, -_ell_sd(lx, ly, hw * 0.8, hh * 0.8))
    sd = tl.where(kind == 1, sd_e, tl.where(kind == 3, sd_t, tl.where(kind == 4, sd_g, sd_r)))
    cnt = tl.zeros_like(px)
    band = (sd >= -1.0) & (sd <= 1.0)
    if tl.sum(band.to(tl.int32), axis=0) > 0:
        for j in tl.static_range(4):
            for i in tl.static_range(4):
                sx = px + (i + 0.5) / 4.0 - cx
                sy = py + (j + 0.5) / 4.0 - cy
                ux = sx * c + sy * s
                uy = -sx * s + sy * c
                cnt += tl.where(_inside(kind, ux, uy, hw, hh, L), 1.0, 0.0)
    a_band = cnt / 16.0
    a = tl.where(sd < -1.0, 1.0, tl.where(sd > 1.0, 0.0, a_band))
    return a


@triton.jit
def _eval_cand(kind, q0, q1, q2, q3, q4, q5, rb, fbase, sbase,
               raw_ptr, cur_ptr, err_ptr, top_ptr, vis_ptr, alive_ptr, bb_ptr, w_ptr,
               W, H, LAMBDA, ROTCOST,
               WEIGHTED: tl.constexpr, SIDE: tl.constexpr, SCR: tl.constexpr):
    """一个候选的 scorer 分数（越小越好，无效 / 没颜色 = 1e30）。
    可删数用私有计数数组 fbase[形状 id]（int32，进出时全 0）：先对覆盖率 >= 0.5 的像素给其顶层形状 +1（原子加），
    再对每个这样的像素按 [存活 & 可见 > 0 & 覆盖 >= 90% 可见像素 & 包围盒落在候选盒内] / 计数 求和（每个形状恰好加到 1），最后把计数清零。"""
    cx = q0.to(tl.float32) / 4.0
    cy = q1.to(tl.float32) / 4.0
    hw = q2.to(tl.float32) / 4.0
    hh = q3.to(tl.float32) / 4.0
    th = (q4.to(tl.float32) / 2.0) * 0.017453292519943295
    alpha = q5.to(tl.float32) / 32.0
    c = tl.cos(th)
    s = tl.sin(th)
    is_round = (kind == 1) | (kind == 4)
    ex = tl.where(is_round, tl.sqrt((hw * c) * (hw * c) + (hh * s) * (hh * s)), tl.abs(hw * c) + tl.abs(hh * s))
    ey = tl.where(is_round, tl.sqrt((hw * s) * (hw * s) + (hh * c) * (hh * c)), tl.abs(hw * s) + tl.abs(hh * c))
    valid = (q2 >= 2) & (q3 >= 2) & (q5 >= 3) & (q5 <= 32)
    valid = valid & (cx - ex >= -1e-6) & (cx + ex <= W + 1e-6) & (cy - ey >= -1e-6) & (cy + ey <= H + 1e-6)
    x0 = tl.maximum(0.0, tl.floor(cx - ex - 1.0))
    x1 = tl.minimum(W - 1.0, tl.ceil(cx + ex + 1.0))
    y0 = tl.maximum(0.0, tl.floor(cy - ey - 1.0))
    y1 = tl.minimum(H - 1.0, tl.ceil(cy + ey + 1.0))
    L = tl.sqrt((2.0 * hh) * (2.0 * hh) + hw * hw)
    translucent = alpha < 0.999
    k0 = 1.0 - alpha
    ia = 1.0 / alpha
    lane = tl.arange(0, SIDE * SIDE)
    tx_off = (lane % SIDE).to(tl.float32)
    ty_off = (lane // SIDE).to(tl.float32)
    nx = tl.where(valid, ((x1 - x0 + 1.0) / SIDE + 0.999999).to(tl.int32), 0)
    ny = tl.where(valid, ((y1 - y0 + 1.0) / SIDE + 0.999999).to(tl.int32), 0)
    use_cache = (nx * ny * (SIDE * SIDE)) <= SCR
    # ---- 第 1 遍：形状颜色 = 覆盖率 >= 0.5 的像素的（半透明时按 alpha 修正的）原图均值 ----
    sr = tl.full((), 0.0, tl.float32)
    sg = tl.full((), 0.0, tl.float32)
    sb = tl.full((), 0.0, tl.float32)
    m = tl.full((), 0.0, tl.float32)
    for ty in range(0, ny):
        for tx in range(0, nx):
            px = x0 + tx * SIDE + tx_off
            py = y0 + ty * SIDE + ty_off
            inb = (px <= x1) & (py <= y1)
            a = _coverage(kind, px, py, cx, cy, hw, hh, c, s, L)
            if use_cache:
                tl.store(sbase + (ty * nx + tx) * (SIDE * SIDE) + lane, a)
            sel = inb & (a >= 0.5)
            p = (py.to(tl.int32) * W + px.to(tl.int32))
            rr = tl.load(raw_ptr + p * 3 + 0, mask=sel, other=0).to(tl.float32)
            rg = tl.load(raw_ptr + p * 3 + 1, mask=sel, other=0).to(tl.float32)
            rb_ = tl.load(raw_ptr + p * 3 + 2, mask=sel, other=0).to(tl.float32)
            cr = tl.load(cur_ptr + p * 3 + 0, mask=sel, other=0)
            cg = tl.load(cur_ptr + p * 3 + 1, mask=sel, other=0)
            cb = tl.load(cur_ptr + p * 3 + 2, mask=sel, other=0)
            vr = tl.where(translucent, (rr - k0 * cr) * ia, rr)
            vg = tl.where(translucent, (rg - k0 * cg) * ia, rg)
            vb = tl.where(translucent, (rb_ - k0 * cb) * ia, rb_)
            sr += tl.sum(tl.where(sel, vr, 0.0), axis=0)
            sg += tl.sum(tl.where(sel, vg, 0.0), axis=0)
            sb += tl.sum(tl.where(sel, vb, 0.0), axis=0)
            m += tl.sum(tl.where(sel, 1.0, 0.0), axis=0)
    has = m > 0.5
    inv = 1.0 / tl.maximum(m, 1.0)
    colr = tl.minimum(255.0, tl.maximum(0.0, sr * inv))
    colg = tl.minimum(255.0, tl.maximum(0.0, sg * inv))
    colb = tl.minimum(255.0, tl.maximum(0.0, sb * inv))
    ny2 = tl.where(has, ny, 0)
    count_rem = has & (alpha >= 0.999)
    # ---- 第 2 遍：误差增量；覆盖率 >= 0.5 的像素给顶层形状计数 +1 ----
    d = tl.full((), 0.0, tl.float32)
    for ty in range(0, ny2):
        for tx in range(0, nx):
            px = x0 + tx * SIDE + tx_off
            py = y0 + ty * SIDE + ty_off
            inb = (px <= x1) & (py <= y1)
            if use_cache:
                a0 = tl.load(sbase + (ty * nx + tx) * (SIDE * SIDE) + lane)
            else:
                a0 = _coverage(kind, px, py, cx, cy, hw, hh, c, s, L)
            a = tl.where(translucent, a0 * alpha, a0)
            sel = inb & (a > 0.0)
            p = (py.to(tl.int32) * W + px.to(tl.int32))
            rr = tl.load(raw_ptr + p * 3 + 0, mask=sel, other=0).to(tl.float32)
            rg = tl.load(raw_ptr + p * 3 + 1, mask=sel, other=0).to(tl.float32)
            rb_ = tl.load(raw_ptr + p * 3 + 2, mask=sel, other=0).to(tl.float32)
            cr = tl.load(cur_ptr + p * 3 + 0, mask=sel, other=0)
            cg = tl.load(cur_ptr + p * 3 + 1, mask=sel, other=0)
            cb = tl.load(cur_ptr + p * 3 + 2, mask=sel, other=0)
            er = tl.load(err_ptr + p, mask=sel, other=0)
            nr = cr + (colr - cr) * a
            ng = cg + (colg - cg) * a
            nb = cb + (colb - cb) * a
            e = tl.abs(nr - rr) + tl.abs(ng - rg) + tl.abs(nb - rb_) - er
            if WEIGHTED:
                wt = tl.load(w_ptr + p, mask=sel, other=0)
                e = e * wt
            d += tl.sum(tl.where(sel, e, 0.0), axis=0)
            cs = sel & (a >= 0.5) & count_rem
            t = tl.load(top_ptr + p, mask=cs, other=-1)
            tl.atomic_add(fbase + t, 1, mask=cs & (t >= 0))
    # ---- 第 3 遍：每个「存活 & 可见 & 被覆盖 >= 90% & 包围盒落在候选盒内」的形状恰好加到 1 ----
    rem = tl.full((), 0.0, tl.float32)
    for ty in range(0, tl.where(count_rem, ny, 0)):
        for tx in range(0, nx):
            px = x0 + tx * SIDE + tx_off
            py = y0 + ty * SIDE + ty_off
            inb = (px <= x1) & (py <= y1)
            if use_cache:
                a = tl.load(sbase + (ty * nx + tx) * (SIDE * SIDE) + lane)
            else:
                a = _coverage(kind, px, py, cx, cy, hw, hh, c, s, L)
            p = (py.to(tl.int32) * W + px.to(tl.int32))
            cs = inb & (a >= 0.5)
            t = tl.load(top_ptr + p, mask=cs, other=-1)
            cs = cs & (t >= 0)
            tt = tl.maximum(t, 0)
            ft = tl.load(fbase + tt, mask=cs, other=1).to(tl.float32)
            qv = tl.load(vis_ptr + tt, mask=cs, other=0).to(tl.float32)
            qa = tl.load(alive_ptr + tt, mask=cs, other=0)
            bx0 = tl.load(bb_ptr + tt * 4 + 0, mask=cs, other=0).to(tl.float32)
            by0 = tl.load(bb_ptr + tt * 4 + 1, mask=cs, other=0).to(tl.float32)
            bx1 = tl.load(bb_ptr + tt * 4 + 2, mask=cs, other=0).to(tl.float32)
            by1 = tl.load(bb_ptr + tt * 4 + 3, mask=cs, other=0).to(tl.float32)
            ok = cs & (qa != 0) & (qv > 0.0) & (ft >= 0.9 * qv) & (bx0 >= x0) & (by0 >= y0) & (bx1 <= x1) & (by1 <= y1)
            rem += tl.sum(tl.where(ok, 1.0 / tl.maximum(ft, 1.0), 0.0), axis=0)
    # ---- 第 4 遍：清零计数 ----
    for ty in range(0, tl.where(count_rem, ny, 0)):
        for tx in range(0, nx):
            px = x0 + tx * SIDE + tx_off
            py = y0 + ty * SIDE + ty_off
            inb = (px <= x1) & (py <= y1)
            if use_cache:
                a = tl.load(sbase + (ty * nx + tx) * (SIDE * SIDE) + lane)
            else:
                a = _coverage(kind, px, py, cx, cy, hw, hh, c, s, L)
            p = (py.to(tl.int32) * W + px.to(tl.int32))
            cs = inb & (a >= 0.5)
            t = tl.load(top_ptr + p, mask=cs, other=-1)
            tl.store(fbase + tl.maximum(t, 0), tl.zeros([SIDE * SIDE], dtype=tl.int32), mask=cs & (t >= 0))
    remr = tl.floor(rem + 0.5)
    pen = tl.where(q4 != 0, ROTCOST - rb, 0.0)
    score = d - LAMBDA * (remr - 1.0 - pen)
    return tl.where(valid & has, score, 1e30)


@triton.jit
def score_kernel(kind_ptr, q_ptr, rb_ptr, f_ptr, scr_ptr, ntask,
                 raw_ptr, cur_ptr, err_ptr, top_ptr, vis_ptr, alive_ptr, bb_ptr, w_ptr, out_ptr,
                 W, H, LAMBDA, ROTCOST, CAPF,
                 WEIGHTED: tl.constexpr, SIDE: tl.constexpr, SCR: tl.constexpr):
    """持久内核：pid 号程序依次处理第 pid、pid + 程序数、… 号任务，用自己的那一行私有计数数组 f_ptr[pid * CAPF : ...]"""
    pid = tl.program_id(0)
    nprog = tl.num_programs(0)
    fbase = f_ptr + pid.to(tl.int64) * CAPF
    sbase = scr_ptr + pid.to(tl.int64) * SCR
    for task in range(pid, ntask, nprog):
        kind = tl.load(kind_ptr + task)
        q0 = tl.load(q_ptr + task * 8 + 0)
        q1 = tl.load(q_ptr + task * 8 + 1)
        q2 = tl.load(q_ptr + task * 8 + 2)
        q3 = tl.load(q_ptr + task * 8 + 3)
        q4 = tl.load(q_ptr + task * 8 + 4)
        q5 = tl.load(q_ptr + task * 8 + 5)
        rb = tl.load(rb_ptr + task)
        s = _eval_cand(kind, q0, q1, q2, q3, q4, q5, rb, fbase, sbase, raw_ptr, cur_ptr, err_ptr, top_ptr, vis_ptr,
                       alive_ptr, bb_ptr, w_ptr, W, H, LAMBDA, ROTCOST, WEIGHTED, SIDE, SCR)
        tl.store(out_ptr + task, s)


@triton.jit
def climb_kernel(kind_ptr, v_ptr, best_ptr, rb_ptr, f_ptr, scr_ptr, ntask,
                 raw_ptr, cur_ptr, err_ptr, top_ptr, vis_ptr, alive_ptr, bb_ptr, w_ptr,
                 outv_ptr, outbest_ptr, outevals_ptr,
                 W, H, LAMBDA, ROTCOST, CAPF, MAXEVAL, NPAR,
                 WEIGHTED: tl.constexpr, SIDE: tl.constexpr, SCR: tl.constexpr):
    """shapes-core.mjs climb() 的移植：5 级步长 [位置, 半轴, 角度, 不透明度]，每级反复扫参数，每个参数先试 +步长，没改进再试 −步长，
    某个参数改进后立即接受（不重启扫描）；一整遍没有改进（或评估数用完）就进下一级。只有一个打分调用点（状态机）。
    NPAR = 参与爬山的参数个数：5（x, y, hw, hh, 角度）或 6（再加不透明度）。"""
    pid = tl.program_id(0)
    nprog = tl.num_programs(0)
    fbase = f_ptr + pid.to(tl.int64) * CAPF
    sbase = scr_ptr + pid.to(tl.int64) * SCR
    for task in range(pid, ntask, nprog):
        kind = tl.load(kind_ptr + task)
        v0 = tl.load(v_ptr + task * 8 + 0)
        v1 = tl.load(v_ptr + task * 8 + 1)
        v2 = tl.load(v_ptr + task * 8 + 2)
        v3 = tl.load(v_ptr + task * 8 + 3)
        v4 = tl.load(v_ptr + task * 8 + 4)
        v5 = tl.load(v_ptr + task * 8 + 5)
        best = tl.load(best_ptr + task)
        rb = tl.load(rb_ptr + task)
        evals = tl.full((), 1, tl.int32)
        stage = tl.full((), 0, tl.int32)
        ii = tl.full((), 0, tl.int32)
        phase = tl.full((), 0, tl.int32)
        improved = tl.full((), 0, tl.int32)
        done = tl.full((), 0, tl.int32)
        # 进入第 0 级前的检查：evals < MAXEVAL 才会扫（CPU：while (improved && evals < maxEval)）
        done = tl.where(evals < MAXEVAL, 0, 1)
        while done == 0:
            # 本级的步长
            sp = tl.where(stage == 0, 4, tl.where(stage == 1, 2, 1))
            sa = tl.where(stage == 0, 16, tl.where(stage == 1, 8, tl.where(stage == 2, 4, tl.where(stage == 3, 2, 1))))
            sq = tl.where(stage == 0, 4, tl.where(stage == 1, 2, 1))
            step = tl.where(ii < 4, sp, tl.where(ii == 4, sa, sq))
            # CPU：for ii 的循环条件 evals < maxEval（只在试 +步长之前检查；试 −步长不再检查）
            can = (phase == 1) | (evals < MAXEVAL)
            delta = tl.where(phase == 0, step, -step)
            w0 = v0 + tl.where(ii == 0, delta, 0)
            w1 = v1 + tl.where(ii == 1, delta, 0)
            w2 = v2 + tl.where(ii == 2, delta, 0)
            w3 = v3 + tl.where(ii == 3, delta, 0)
            w4 = v4 + tl.where(ii == 4, delta, 0)
            w4 = ((w4 % 360) + 360) % 360
            w5 = v5 + tl.where(ii == 5, delta, 0)
            s = best + 1.0
            if can:
                s = _eval_cand(kind, w0, w1, w2, w3, w4, w5, rb, fbase, sbase, raw_ptr, cur_ptr, err_ptr, top_ptr, vis_ptr,
                               alive_ptr, bb_ptr, w_ptr, W, H, LAMBDA, ROTCOST, WEIGHTED, SIDE, SCR)
            acc = can & (s < best - 1e-6)
            evals = evals + tl.where(can, 1, 0)
            v0 = tl.where(acc, w0, v0)
            v1 = tl.where(acc, w1, v1)
            v2 = tl.where(acc, w2, v2)
            v3 = tl.where(acc, w3, v3)
            v4 = tl.where(acc, w4, v4)
            v5 = tl.where(acc, w5, v5)
            best = tl.where(acc, s, best)
            improved = tl.where(acc, 1, improved)
            # 状态推进：改进了或已经试过 − 步长 → 下一个参数；否则这个参数再试 − 步长
            nxt = acc | (phase == 1) | (can == 0)
            ii = tl.where(nxt, ii + 1, ii)
            phase = tl.where(nxt, 0, 1)
            # 一遍结束：有改进且评估数没用完 → 再扫一遍；否则进下一级
            end_sweep = ii >= NPAR
            again = end_sweep & (improved != 0) & (evals < MAXEVAL)
            next_stage = end_sweep & (~again)
            ii = tl.where(end_sweep, 0, ii)
            improved = tl.where(end_sweep, 0, improved)
            stage = tl.where(next_stage, stage + 1, stage)
            done = tl.where(next_stage & ((stage >= 5) | (evals >= MAXEVAL)), 1, 0)
        tl.store(outv_ptr + task * 8 + 0, v0)
        tl.store(outv_ptr + task * 8 + 1, v1)
        tl.store(outv_ptr + task * 8 + 2, v2)
        tl.store(outv_ptr + task * 8 + 3, v3)
        tl.store(outv_ptr + task * 8 + 4, v4)
        tl.store(outv_ptr + task * 8 + 5, v5)
        tl.store(outbest_ptr + task, best)
        tl.store(outevals_ptr + task, evals)
