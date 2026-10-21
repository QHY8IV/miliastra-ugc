#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 compress.py —— 把图片切成轴对齐纯色矩形，编码成千星奇域可渲染的 Lua 数据
================================================================================

【流程】
  载图 → 缩放/补白 → 量化(可选) → 切矩形 → 自检 → 编码 → 写 .lua

  切矩形（默认，互不重叠）
      按行主序扫描，每个还没被占用的像素都能当锚点：
        ① 先只在本行向右扩，得到"本行颜色允许的最大宽度"
        ② 在这个宽度下向下扩，得到"颜色仍然允许的最大高度"
        ③ 再从宽到窄试更窄的宽度，看换来更高的块能不能凑出更大面积
      取面积最大的那一版落块，颜色取该区域的三通道均值，然后标记整块已被占用。
      块的边界永远落在整数像素上，所以相邻块之间不会露缝。
      任意矩形的均值与标准差用积分图 O(1) 算出。

  切矩形（--layered，允许重叠）
      交给 layered.mjs：先铺一层互不重叠的底，再用大块反复覆盖"当前误差最大"的位置。
      同样画质下控件更少；代价是数据里必须显式带坐标，并按绘制顺序排列。

  编码（blockcodec.py）
      块的 x / y 不进数据串 —— 读的一侧重放同一套"行主序扫描"游标就能还原，
      单这一项就省掉约 29% 的体积。三种写法：
        p64  11 字符/块，坐标显式给出，Lua 端算得最少（分层数据只能用这个）
        b64   7 字符/块，体积最省
        hex  10 字符/块，能肉眼读
      为什么不把块写成 Lua 表 {{x,y,w,h,c},...}：那是一个块一个表构造器，实测
      6.2 万个构造器 / 1.23 MB 还能跑，8.9 万个 / 2.01 MB 直接让引擎无日志地编译失败。
      编码成字符串之后，构造器只剩 1 个。

【怎么配】改下面的 CONFIG，或走命令行；优先级：命令行 > --config JSON > CONFIG

  STD          合并容差，0 ~ 1024。0 = 只合并颜色完全相同的相邻像素（无损）。
               经验：MAE ≤ 1.5 一般人看不出，≥ 3.5 明显。
  OUT_W/OUT_H  输出分辨率（源像素）
  LOCK_ASPECT  True = 等比缩放后居中、空白填白；False = 直接拉伸（允许变形）
  COLOR_BITS   每通道位数，8 = 24 位真彩（不量化）
               ⚠ 实测降位数只把误差变大、几乎不减块数，没有特别理由就保持 8
  ENC          块列表编码："p64" | "b64" | "hex"
  INPUT/OUTPUT 输入图片 / 输出 lua
  PREVIEW      是否另存一张重建预览图
  MAX_BLOCKS   块数告警阈值（只警告，不拦）

【常用命令】
  python compress.py --input a.png --output a.lua --std 3 --size 300x300
  python compress.py --std 0 --size 200x200        # 无损（逐像素同色）
  python compress.py --enc hex                     # 肉眼可读
  python compress.py --layered                     # 允许重叠，同画质控件更少
  python compress.py --preset best                 # 推荐配置（见 --help）
  python compress.py --spotted 150                 # 先铺一层低频光斑打底
  python compress.py --focus 焦点.json             # 视觉焦点优先（AI / 人工标出的主体、脸、文字）
  python compress.py --edge-aware --layered        # 边缘优先预算（三条路径通用）

【输出】
  local IMG = {}
  IMG.N / IMG.W / IMG.H   边长 / 逻辑宽 / 逻辑高
  IMG.STD / IMG.ENC       使用的容差与编码
  IMG.NBLK / IMG.NSHP     矩形块数 / 形状个数（总控件数 = 两者相加）
  IMG.MAE                 平均绝对色差（0~255，每像素每通道）
  IMG.LAYERED             true = 数据顺序就是绘制顺序（先画的在下面）
  IMG.DATA / IMG.SHP      编码后的块串 / 形状串
  把整份输出替换进 render.lua 的『数据区』即可。加了 --with-return 才会在末尾补 return ——
  直接粘进 render.lua 时千万别加：Lua 要求 return 是块的最后一条语句。

【依赖】Python 3.8+、numpy、Pillow；--layered / --shapes / --spotted 还需要 Node ≥ 22

【同目录】
  blockcodec.py             编解码与自检（本脚本与 estimate.py 共用）
  render.lua                千星奇域渲染器（读本脚本的输出）
  estimate.py               只估算控件数与 MAE，不写文件
  to-gia.mjs / to-gil.mjs   把结果写成 .gia 素材组 / .gil 关卡
================================================================================
"""

import argparse
import json
import math
import os
import sys
import time
from typing import List, Tuple

try:
    import numpy as np
    from PIL import Image, ImageFilter
except ImportError:
    print("缺少依赖，请先安装：pip install pillow numpy", file=sys.stderr)
    raise

# Windows 控制台默认是 GBK（CP936），而本脚本会打印 ✓ / ✗ 这类符号，默认 errors 会抛
# UnicodeEncodeError —— 更糟的是它在"跑完整轮压缩、到自检那一行"才崩，整轮白跑。
# 放宽成 replace：中文照原编码输出，编不了的符号退化成 '?'，脚本不再半途死掉。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except (AttributeError, ValueError):
        pass

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

from blockcodec import (pack as codec_pack, sizes as codec_sizes, pack_shapes,   # noqa: E402
                        pack_p64, check_scan_order, compute_mae, reconstruct,
                        P64_MAX_SIDE, lua_long_string, split_oversize)


# ==============================================================================
# 【配置区】—— 直接改这里，或命令行覆盖
# ==============================================================================
CONFIG = {
    "STD": 3,                  # 合并容差，0 ~ 1024（0 = 无损）
    "OUT_W": 300,              # 输出宽（源像素）
    "OUT_H": 300,              # 输出高（源像素）
    "LOCK_ASPECT": False,      # True = 锁定长宽比（不拉伸）
    "COLOR_BITS": 8,           # 每通道位数，8 = 24 位真彩
    "ENC": "p64",              # "p64"（Lua 端计算最少）| "b64"（体积最省）| "hex"（可肉眼读）
    "INPUT": "input.png",
    "OUTPUT": "output.lua",
    "PREVIEW": False,          # 是否另存重建预览图
    "MAX_BLOCKS": 45000,       # 块数告警阈值（实测 5 万正常、61,440 崩溃）
    "VAR_NAME": "IMG",         # 输出的 Lua 变量名
    "WITH_RETURN": False,      # 是否在末尾补 return
    "EDGE_AWARE": False,       # 边缘优先的误差预算（见 edge_importance）
    "EDGE_BOOST": 1.6,         # 明显色差处容差收紧倍率（线性斜坡的斜率）
    "SMOOTH_SLACK": 0.42,       # 色差不大的地方容差放宽倍率（I 最小到 1-slack）
    "EDGE_CAP": 2.2,           # 精细区域的权重上限：I 到此为止，再细也不再收紧
    "EDGE_REF": 95.0,          # 梯度归一化的高分位（百分位）
    "EDGE_FLOOR": 24.0,        # 梯度归一化的绝对下限：弱于它的起伏不算"边缘"
    "EDGE_BALANCE": True,      # 预算对齐（2026-10-18）：加权后把容差折算成 T×m，
                               # 使块数回到不加权 T 的水平 —— 权重只挪预算、不缩预算
    "FOCUS": None,             # 焦点文件（JSON 或热图 PNG）：AI / 人工标出的视觉焦点
    "FOCUS_GAIN": 0.8,         # 焦点处重要度额外抬升（I_eff = clip(I_edge + gain·F)）
    "RESAMPLE": "box",         # 大比例缩小用的重建核：box（默认，2026-10-18 定案）| lanczos | bicubic | bilinear
    "EDGE_SOFT": 0.0,          # 已否决（2026-10-18）：>0 = 只把边界带做柔；0 = 不动。仅为复现旧实验保留
    "EDGE_SOFT_LO": 10.0,      # 边缘掩膜的梯度下限（低于它完全不动）
    "EDGE_SOFT_HI": 30.0,      # 边缘掩膜的梯度上限（高于它完全模糊）
    "EDGE_SOFT_DILATE": 1,     # 掩膜向外扩几圈（1 = 柔化带约 3 px 宽）
}
# ==============================================================================

STD_MIN, STD_MAX = 0.0, 1024.0

# b64 / hex 里 w、h 各占 1 字节，块超过这个边长编码就会回绕成错误尺寸。
MAX_SIDE = 255


# ------------------------------------------------------------------------------
# 载图与预处理
# ------------------------------------------------------------------------------
def load_and_prepare(path: str, out_w: int, out_h: int, lock_aspect: bool,
                     resample: str = "box") -> np.ndarray:
    """读图 → 缩放（可选等比 + 居中补白）→ (H, W, 3) int16 数组。

    `resample` 是 2500→500 这类大比例缩小时用的重建核，不是随便挑的名字：
      box      默认（2026-10-18 定案）：面积平均，不振铃；
      lanczos  锐，但会在硬边两侧各留一条亮 / 暗过冲（振铃）；
      bicubic / bilinear 介于两者之间。
    只换核**消不掉放大后的台阶**（36 图 2500→500 边点实测 maxstep 15.9 / 15.6 / 14.7，
    三种核几乎一样），但全管线跑完 box 是白赚：同参数控件 −15.4%、对连续真值误差 −4.7%、
    假硬边 −16%（48 号）。原因是 lanczos 的过冲被拟合器当成"真结构"，于是多切块、还把
    那条 1 px 亮线硬画出来。—— 见 `references/rect-merge-playbook.md` §2.12。
    """
    if not os.path.exists(path):
        raise FileNotFoundError("找不到输入图片：%s" % path)

    filters = {"lanczos": Image.LANCZOS, "box": Image.BOX,
               "bicubic": Image.BICUBIC, "bilinear": Image.BILINEAR}
    if resample not in filters:
        raise ValueError("未知采样核：%r（可选 %s）" % (resample, ", ".join(sorted(filters))))
    rs = filters[resample]

    src = Image.open(path).convert("RGB")

    if lock_aspect:
        sw, sh = src.size
        scale = min(out_w / sw, out_h / sh)
        tw = max(1, int(round(sw * scale)))
        th = max(1, int(round(sh * scale)))
        shrunk = src.resize((tw, th), rs)
        plate = Image.new("RGB", (out_w, out_h), (255, 255, 255))
        plate.paste(shrunk, ((out_w - tw) // 2, (out_h - th) // 2))
        src = plate
    else:
        src = src.resize((out_w, out_h), rs)

    return np.asarray(src).astype(np.int16)


def soften_edges(arr: np.ndarray, sigma: float, lo: float = 10.0, hi: float = 30.0,
                 dilate: int = 1) -> np.ndarray:
    """只把**边界带**做柔：梯度强的像素按其强度混进高斯模糊版，平坦区原样不动。

    为什么是「边界带」而不是整幅：整幅模糊会连小字、发丝一起糊掉，MAE 也要涨一大截；
    台阶只出现在强边两侧 1~2 px，模糊只该在那儿发生（σ 以「目标像素」为单位）。
    为什么这算改采样而不是改权重：拟合的目标图变了 —— 1 px 硬台阶先被换成 2~3 px 的
    渐变，拟合器再去逼近它，于是同样的控件预算里不再有台阶像素可画。
    """
    if sigma <= 0:
        return arr
    a = np.asarray(arr, np.float64)
    lum = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
    p = np.pad(lum, 1, mode="edge")
    gx = ((p[:-2, 2:] + 2.0 * p[1:-1, 2:] + p[2:, 2:])
          - (p[:-2, :-2] + 2.0 * p[1:-1, :-2] + p[2:, :-2])) / 4.0
    gy = ((p[2:, :-2] + 2.0 * p[2:, 1:-1] + p[2:, 2:])
          - (p[:-2, :-2] + 2.0 * p[:-2, 1:-1] + p[:-2, 2:])) / 4.0
    g = np.sqrt(gx * gx + gy * gy)
    m = np.clip((g - float(lo)) / max(float(hi) - float(lo), 1e-6), 0.0, 1.0)
    for _ in range(max(0, int(dilate))):
        mp = np.pad(m, 1, mode="edge")
        m = np.maximum.reduce([mp[:-2, :-2], mp[:-2, 1:-1], mp[:-2, 2:],
                               mp[1:-1, :-2], mp[1:-1, 1:-1], mp[1:-1, 2:],
                               mp[2:, :-2], mp[2:, 1:-1], mp[2:, 2:]])
    blurred = np.asarray(
        Image.fromarray(np.clip(a, 0, 255).astype(np.uint8))
        .filter(ImageFilter.GaussianBlur(float(sigma))), dtype=np.float64)
    out = a * (1.0 - m[..., None]) + blurred * m[..., None]
    return np.clip(np.round(out), 0, 255).astype(np.int16)


def quantize(arr: np.ndarray, bits: int) -> np.ndarray:
    """每通道压到 2^bits 级（四舍五入）。bits ≥ 8 时原样返回。"""
    if bits >= 8:
        return arr.copy()
    step = 1 << (8 - bits)
    half = step >> 1
    return np.clip(((arr + half) // step) * step, 0, 255).astype(np.int16)


# ------------------------------------------------------------------------------
# 边缘优先的误差预算：逐像素「视觉重要度」
# ------------------------------------------------------------------------------
EDGE_I_MIN, EDGE_I_MAX = 0.2, 4.0


def edge_importance(arr: np.ndarray, boost: float = 1.6, slack: float = 0.42,
                    ref_pct: float = 95.0, min_ref: float = 24.0,
                    blur: float = 1.0, cap: float = 2.2) -> np.ndarray:
    """返回 (H, W) 的视觉重要度 I：边缘处 > 1（收紧容差），平坦 / 缓变处 < 1（放宽容差）。

    判据只有一条 —— 亮度梯度的幅度：
        E = clip(|∇L| / max(P95(|∇L|), min_ref), 0, 1)      归一化到 0~1
        I = clip(1 + boost·E − slack·(1−E), 0.2, cap)     # 上端被 cap 削平
    cap 是「精细区域的权重上限」：斜率按 boost 给，但 I 到 cap 就不再涨 —— 极端细碎
    的纹理（噪点、发丝、星点）不会因此无限吃预算；纯色 / 缓变区则按 slack 往下压。
    I 的用法在 pack_rects：矩形内加权标准差 σw = sqrt(Σ I²(c−μ)² / n)，仍与 STD 比较。
    所以边缘像素的容差按 1/I 收紧、平坦区按 1/I 放宽，而**总预算不变**——
    只是把误差从"看得见的地方"挪到"看不见的地方"。

    为什么用 I² 而不是 I：字节数；σw 里权重是 I²，等价于"每个像素的允许误差是
    STD / I"的 RMS 形式，I² 让表里存的是 I²·c 与 I²·c²，和普通积分图同一套查表法。

    为什么 min_ref 是绝对下限：整张图都很平（比如纯渐变海报）时，P95 会很小，
    梯度归一化后每个像素都像"边缘" → 反而全域收紧、块数暴涨。设下限之后，
    弱于 24 级（约 255 的 9.4%）的起伏一律不算边缘，纯渐变图得到的是"全域放宽"。

    boost = slack = 0 时返回全 1 的图，调用方应直接走不加权的老路径（见 pack_rects）。
    """
    a = np.asarray(arr, dtype=np.float64)
    lum = a[..., 0] * 0.299 + a[..., 1] * 0.587 + a[..., 2] * 0.114
    if blur and blur > 0:
        # 先轻微模糊：单像素噪点不该被当成边缘（否则噪点区会被切得很碎）
        lum = np.asarray(
            Image.fromarray(np.clip(lum, 0, 255).astype(np.uint8))
            .filter(ImageFilter.GaussianBlur(float(blur))),
            dtype=np.float64)

    p = np.pad(lum, 1, mode="edge")
    gx = ((p[:-2, 2:] + 2.0 * p[1:-1, 2:] + p[2:, 2:])
          - (p[:-2, :-2] + 2.0 * p[1:-1, :-2] + p[2:, :-2])) / 4.0
    gy = ((p[2:, :-2] + 2.0 * p[2:, 1:-1] + p[2:, 2:])
          - (p[:-2, :-2] + 2.0 * p[:-2, 1:-1] + p[:-2, 2:])) / 4.0
    g = np.sqrt(gx * gx + gy * gy)

    ref = max(float(np.percentile(g, float(ref_pct))), float(min_ref))
    e = np.clip(g / ref, 0.0, 1.0)
    hi = min(EDGE_I_MAX, float(cap))
    if hi <= EDGE_I_MIN:
        raise ValueError("edge cap %r 必须大于 I 下限 %r" % (cap, EDGE_I_MIN))
    return np.clip(1.0 + float(boost) * e - float(slack) * (1.0 - e),
                   EDGE_I_MIN, hi)


# ------------------------------------------------------------------------------
# 视觉焦点：AI / 人工标出的区域 → 在重要度图上再抬一档
# ------------------------------------------------------------------------------
FOCUS_GAIN_DEFAULT = 0.8
_FOCUS_KEYS = {"space", "boxes", "points", "heatmap", "note"}
_FOCUS_BOX_KEYS = {"x", "y", "w", "h", "feather", "weight"}
_FOCUS_POINT_KEYS = {"x", "y", "radius", "weight"}


def _focus_box_field(W: int, H: int, x0: float, y0: float, x1: float, y1: float,
                     feather: float) -> np.ndarray:
    """矩形内 F = 1；出了矩形按「到矩形的距离」线性衰减，`feather` 像素处降到 0。"""
    xs = np.arange(W, dtype=np.float64) + 0.5
    ys = np.arange(H, dtype=np.float64) + 0.5
    dx = np.maximum(np.maximum(x0 - xs, xs - x1), 0.0)
    dy = np.maximum(np.maximum(y0 - ys, ys - y1), 0.0)
    d = np.hypot(dx[None, :], dy[:, None])
    return np.clip(1.0 - d / max(feather, 1e-6), 0.0, 1.0)


def _focus_point_field(W: int, H: int, cx: float, cy: float, radius: float) -> np.ndarray:
    """圆点：中心 F = 1，到中心 `radius` 像素处降到 0。"""
    xs = np.arange(W, dtype=np.float64) + 0.5
    ys = np.arange(H, dtype=np.float64) + 0.5
    d = np.hypot(xs[None, :] - cx, ys[:, None] - cy)
    return np.clip(1.0 - d / max(radius, 1e-6), 0.0, 1.0)


def _focus_heatmap(path: str, W: int, H: int) -> np.ndarray:
    """图片当热图：灰度归一化到 0~1；尺寸不同时双线性缩放到输出分辨率。"""
    img = Image.open(path).convert("L")
    if img.size != (W, H):
        img = img.resize((W, H), Image.BILINEAR)
    return np.asarray(img, dtype=np.float64) / 255.0


def load_focus(path: str, W: int, H: int) -> np.ndarray:
    """读焦点文件，返回 (H, W) 的 F ∈ [0, 1]。

    两种写法都认：
      · JSON：{"space": "px" | "norm", "boxes": [{"x","y","w","h","feather"?,"weight"?}],
               "points": [{"x","y","radius","weight"?}], "heatmap": "焦点热图.png"}
      · 图片（.png / .jpg …）：直接当热图。

    怎么用：F 会加到重要度上（I_eff = clip(I_edge + gain·F)），焦点处容差按 1/I 收紧 ——
    和边缘是同一条判据，只是「哪里算边缘」换成了「哪里是 AI / 人指定的焦点」。
    多条区域取逐像素最大值；同一处重复标注不会叠加。

    没有「猜一个默认值」的路径：多余的键、缺字段、坐标全在图外，都会报错并指出是哪一项。
    """
    import json as _json
    if not os.path.exists(path):
        raise FileNotFoundError("找不到焦点文件：%s" % path)

    if os.path.splitext(path)[1].lower() != ".json":
        return _focus_heatmap(path, W, H)

    # utf-8-sig：Windows 上 PowerShell 5.1 的 `Set-Content -Encoding utf8` 会写 BOM，
    # 带 BOM 的文件按 utf-8 读进来首字符是 \ufeff，json 直接报「line 1 column 1」。
    # 2026-10-17 真机试时踩到：同样的文件编辑器里看着正常，程序读不了。
    with open(path, encoding="utf-8-sig") as f:
        doc = _json.load(f)
    if not isinstance(doc, dict):
        raise ValueError("焦点 JSON 顶层必须是对象（收到 %s）" % type(doc).__name__)
    extra = set(doc) - _FOCUS_KEYS
    if extra:
        raise ValueError("焦点 JSON 里有多余的键：%s（只认 %s）"
                         % (", ".join(sorted(extra)), ", ".join(sorted(_FOCUS_KEYS))))
    space = doc.get("space", "px")
    if space not in ("px", "norm"):
        raise ValueError("焦点 JSON 的 space 必须是 \"px\" 或 \"norm\"（收到 %r）" % (space,))
    kx = 1.0 if space == "px" else float(W)
    ky = 1.0 if space == "px" else float(H)

    F = np.zeros((H, W), dtype=np.float64)
    used = 0

    for i, bx in enumerate(doc.get("boxes") or []):
        tag = "boxes[%d]" % i
        if not isinstance(bx, dict):
            raise ValueError("%s 必须是对象" % tag)
        extra = set(bx) - _FOCUS_BOX_KEYS
        if extra:
            raise ValueError("%s 里有多余的键：%s（只认 %s）"
                             % (tag, ", ".join(sorted(extra)), ", ".join(sorted(_FOCUS_BOX_KEYS))))
        missing = [k for k in ("x", "y", "w", "h") if k not in bx]
        if missing:
            raise ValueError("%s 缺少字段：%s" % (tag, ", ".join(missing)))
        x, y, w, h = (float(bx[k]) for k in ("x", "y", "w", "h"))
        if w <= 0 or h <= 0:
            raise ValueError("%s 的 w / h 必须 > 0（收到 %r × %r）" % (tag, w, h))
        weight = float(bx.get("weight", 1.0))
        if not (weight >= 0.0):
            raise ValueError("%s 的 weight 必须 ≥ 0（收到 %r）" % (tag, weight))
        x0, y0, x1, y1 = x * kx, y * ky, (x + w) * kx, (y + h) * ky
        feather = float(bx.get("feather", max(4.0, 0.25 * min(w * kx, h * ky))))
        if feather <= 0:
            raise ValueError("%s 的 feather 必须 > 0（收到 %r）" % (tag, feather))
        F = np.maximum(F, weight * _focus_box_field(W, H, x0, y0, x1, y1, feather))
        used += 1

    for i, pt in enumerate(doc.get("points") or []):
        tag = "points[%d]" % i
        if not isinstance(pt, dict):
            raise ValueError("%s 必须是对象" % tag)
        extra = set(pt) - _FOCUS_POINT_KEYS
        if extra:
            raise ValueError("%s 里有多余的键：%s（只认 %s）"
                             % (tag, ", ".join(sorted(extra)), ", ".join(sorted(_FOCUS_POINT_KEYS))))
        missing = [k for k in ("x", "y", "radius") if k not in pt]
        if missing:
            raise ValueError("%s 缺少字段：%s" % (tag, ", ".join(missing)))
        cx, cy, radius = (float(pt[k]) for k in ("x", "y", "radius"))
        if radius <= 0:
            raise ValueError("%s 的 radius 必须 > 0（收到 %r）" % (tag, radius))
        weight = float(pt.get("weight", 1.0))
        if not (weight >= 0.0):
            raise ValueError("%s 的 weight 必须 ≥ 0（收到 %r）" % (tag, weight))
        F = np.maximum(F, weight * _focus_point_field(W, H, cx * kx, cy * ky, radius * min(kx, ky)))
        used += 1

    heat = doc.get("heatmap")
    if heat:
        hp = heat if os.path.isabs(heat) else os.path.join(os.path.dirname(os.path.abspath(path)), heat)
        F = np.maximum(F, _focus_heatmap(hp, W, H))
        used += 1

    if not used:
        raise ValueError("焦点文件里没有任何区域：boxes / points / heatmap 至少要有一项")
    return np.clip(F, 0.0, 1.0)


# ------------------------------------------------------------------------------
# 积分图：任意矩形的均值 / 标准差 O(1)
# ------------------------------------------------------------------------------
def _area_tables(arr: np.ndarray):
    """返回 (stride, sums, squares)：三通道的和、平方和，各自展平成一维列表。

    为什么要展平 + tolist()：内层循环要问几百万次矩形标准差，直接索引 numpy 数组时
    每次取标量都得现构造对象，慢一两个数量级；转成 Python 浮点列表后只剩纯算术。
    """
    h, w = int(arr.shape[0]), int(arr.shape[1])
    stride = w + 1
    sums: List[list] = []
    squares: List[list] = []
    for ch in range(3):
        v = arr[:, :, ch].astype(np.float64)
        s = np.zeros((h + 1, w + 1), dtype=np.float64)
        q = np.zeros((h + 1, w + 1), dtype=np.float64)
        s[1:, 1:] = v.cumsum(0).cumsum(1)
        q[1:, 1:] = (v * v).cumsum(0).cumsum(1)
        sums.append(s.ravel().tolist())
        squares.append(q.ravel().tolist())
    return stride, sums, squares


# ------------------------------------------------------------------------------
# 核心：最大对齐矩形合并
# ------------------------------------------------------------------------------
def pack_rects(arr: np.ndarray, std_tol: float, max_side: int = MAX_SIDE,
               importance: np.ndarray = None
               ) -> List[Tuple[int, int, int, int, int]]:
    """切成互不重叠的轴对齐纯色矩形。

    返回 [(x, y, w, h, color24), ...]，顺序 = 行主序扫描顺序（渲染端靠它推演 x、y）。

    max_side 限制单块的宽与高：b64 / hex 的 w、h 各占 1 字节（255），p64 是 511。
    不设限的话，碰到大片纯色会产出超过 255 的块，编码时回绕成错误尺寸、渲染出错。

    std_tol = 0 时只合并颜色完全相同的相邻像素，结果无损。

    importance 给定时（见 edge_importance）走**边缘优先预算**：判据从
    "矩形内三通道标准差 ≤ std_tol" 变成 "加权标准差 σw ≤ std_tol"，
    其中 σw² = Σ I²(c−μ)² / n、μ = Σ I²c / Σ I²。于是边缘处的允许误差按 1/I 收紧、
    平坦与缓变处按 1/I 放宽，块数总量大体不变而误差位置移动。
    importance 为 None 时是**逐字节兼容**的老路径（不是"权重恒为 1"的近似：
    两条路径的浮点运算顺序不同，不能混用）。
    """
    h_img, w_img = int(arr.shape[0]), int(arr.shape[1])
    sqrt = math.sqrt
    tol = float(std_tol)
    side_limit = int(max_side)
    use_w = importance is not None

    if not use_w:
        stride, sums, squares = _area_tables(arr)
        s0, s1, s2 = sums
        q0, q1, q2 = squares

        def worst_std(x: int, y: int, w: int, h: int) -> float:
            """矩形内三通道标准差的**最大值**。

            三个通道各算一次 sqrt(E[x²] − E[x]²)，取最大的那个当判据。运算顺序固定：
            先按面积求均值，再算方差 —— 与渲染端一致的顺序，换顺序浮点结果会差最后几位，
            块边界就可能挪动。
            """
            n = w * h
            a = y * stride + x
            b = a + w
            c = (y + h) * stride + x
            d = c + w
            mean = (s0[d] - s0[b] - s0[c] + s0[a]) / n
            var = (q0[d] - q0[b] - q0[c] + q0[a]) / n - mean * mean
            worst = sqrt(var) if var > 0.0 else 0.0
            mean = (s1[d] - s1[b] - s1[c] + s1[a]) / n
            var = (q1[d] - q1[b] - q1[c] + q1[a]) / n - mean * mean
            if var > 0.0:
                sd = sqrt(var)
                if sd > worst:
                    worst = sd
            mean = (s2[d] - s2[b] - s2[c] + s2[a]) / n
            var = (q2[d] - q2[b] - q2[c] + q2[a]) / n - mean * mean
            if var > 0.0:
                sd = sqrt(var)
                if sd > worst:
                    worst = sd
            return worst

        def block_color(x: int, y: int, w: int, h: int):
            """区域三通道均值。"""
            n = w * h
            a = y * stride + x
            b = a + w
            c = (y + h) * stride + x
            d = c + w
            return (int(round((s0[d] - s0[b] - s0[c] + s0[a]) / n)),
                    int(round((s1[d] - s1[b] - s1[c] + s1[a]) / n)),
                    int(round((s2[d] - s2[b] - s2[c] + s2[a]) / n)))

    else:
        # 加权积分表：W2 = ΣI²、A = ΣI²·c、B = ΣI²·c²（c 为通道值）。
        # 查表方式与不加权那套完全一样，只是每个矩形多算一个 "ΣI²(c−μ)²"。
        iw = np.asarray(importance, dtype=np.float64)
        if iw.shape != (h_img, w_img):
            raise ValueError("importance 形状 %r 与图像 %r 不一致" % (iw.shape, (h_img, w_img)))
        i2 = iw * iw
        stride = w_img + 1

        def _integral(v: np.ndarray) -> list:
            s = np.zeros((h_img + 1, w_img + 1), dtype=np.float64)
            s[1:, 1:] = v.cumsum(0).cumsum(1)
            return s.ravel().tolist()

        w2 = _integral(i2)
        acc = [arr[:, :, ch].astype(np.float64) for ch in range(3)]
        ai = [_integral(i2 * acc[ch]) for ch in range(3)]
        bi = [_integral(i2 * acc[ch] * acc[ch]) for ch in range(3)]

        def worst_std(x: int, y: int, w: int, h: int) -> float:
            """加权标准差 σw 的最大值：σw² = Σ I²(c−μ)² / n，μ = Σ I²c / Σ I²。

            I 在边缘处 > 1 → σw 被放大 → 同样的色差会先撞上容差，块被切得更细；
            I 在平坦 / 缓变处 < 1 → σw 被压小 → 允许更大的色差，块长得更大。
            """
            n = w * h
            a = y * stride + x
            b = a + w
            c = (y + h) * stride + x
            d = c + w
            wt = w2[d] - w2[b] - w2[c] + w2[a]
            if wt <= 0.0:
                return 0.0
            worst = 0.0
            for ch in range(3):
                A = ai[ch]
                B = bi[ch]
                sa = A[d] - A[b] - A[c] + A[a]
                sb = B[d] - B[b] - B[c] + B[a]
                mu = sa / wt
                var = (sb - sa * mu) / n
                if var > 0.0:
                    sd = sqrt(var)
                    if sd > worst:
                        worst = sd
            return worst

        def block_color(x: int, y: int, w: int, h: int):
            """加权均值：平坦区与普通均值一致，边缘区会略微偏向边缘的颜色。"""
            a = y * stride + x
            b = a + w
            c = (y + h) * stride + x
            d = c + w
            wt = w2[d] - w2[b] - w2[c] + w2[a]
            if wt <= 0.0:
                return (0, 0, 0)
            out = []
            for ch in range(3):
                A = ai[ch]
                out.append(int(round((A[d] - A[b] - A[c] + A[a]) / wt)))
            return (out[0], out[1], out[2])

    # covered_to[c] = 第 c 列已经被占到第几行。和渲染端推演坐标时用的是同一套结构，
    # 所以数据串里可以不放 x、y。
    covered_to = [-1] * w_img
    blocks: List[Tuple[int, int, int, int, int]] = []

    for row in range(h_img):
        room = min(h_img - row, side_limit)     # 从这一行往下最多能长多高
        col = 0
        while col < w_img:
            if covered_to[col] >= row:
                col += 1
                continue

            # ① 只在本行向右扩：高度视为 1，所以判据是单行的标准差
            wide = 1
            while (col + wide < w_img and wide < side_limit
                   and covered_to[col + wide] < row):
                if worst_std(col, row, wide + 1, 1) > tol:
                    break
                wide += 1

            # ② 在这个宽度下，颜色还允许往下长多高
            tall = 1
            while tall < room:
                if worst_std(col, row, wide, tall + 1) > tol:
                    break
                tall += 1

            best_w, best_h, best_area = wide, tall, wide * tall

            # ③ 收窄宽度去换高度。只有面积严格变大才采纳 —— 并列时保留更宽的那版，
            #    这样块数不会因为"同面积换个形状"而变多。
            alt_w = wide - 1
            while alt_w >= 1 and alt_w * room > best_area:
                alt_h = 1
                while alt_h < room:
                    if worst_std(col, row, alt_w, alt_h + 1) > tol:
                        break
                    alt_h += 1
                if alt_w * alt_h > best_area:
                    best_w, best_h, best_area = alt_w, alt_h, alt_w * alt_h
                alt_w -= 1

            bottom = row + best_h - 1
            for xx in range(col, col + best_w):
                covered_to[xx] = bottom

            red, grn, blu = block_color(col, row, best_w, best_h)

            blocks.append((col, row, best_w, best_h, (red << 16) | (grn << 8) | blu))
            col += best_w

    return blocks


# ------------------------------------------------------------------------------
# 分层重长 / 形状替换 / 光斑打底：计算都在 Node 侧，这里只负责转交像素与收结果
# ------------------------------------------------------------------------------
def _node_binary(what: str) -> str:
    """找到 node 命令；找不到就给出统一的报错。"""
    import shutil
    node = shutil.which("node")
    if not node:
        raise RuntimeError("%s 需要 Node ≥ 22（找不到 node 命令）" % what)
    return node


def _dump_rgb(arr: np.ndarray):
    """把 (H, W, 3) 数组写成临时 .rgb 原始文件，返回 (fd 路径, 宽, 高)。"""
    import tempfile
    h, w = int(arr.shape[0]), int(arr.shape[1])
    fd, path = tempfile.mkstemp(suffix=".rgb")
    with os.fdopen(fd, "wb") as f:
        f.write(np.clip(arr, 0, 255).astype(np.uint8).tobytes())
    return path, w, h


def _dump_weights(imp: np.ndarray):
    """把逐像素重要度写成 float32 原始文件（Node 侧 --weights 读它）。"""
    import tempfile
    fd, path = tempfile.mkstemp(suffix=".f32")
    with os.fdopen(fd, "wb") as f:
        f.write(np.ascontiguousarray(imp, dtype=np.float32).tobytes())
    return path


def _run_json(cmd: list, what: str, drop=()):
    """跑一个 Node 工具并解析它的 stdout JSON；失败时抛出带 stderr 的错误。"""
    import subprocess
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    finally:
        for path in drop:
            if path and os.path.exists(path):
                os.remove(path)
    if proc.returncode != 0:
        raise RuntimeError("%s 失败：%s" % (what, proc.stderr or proc.stdout or "(无输出)"))
    if proc.stderr.strip():
        print(proc.stderr.rstrip(), file=sys.stderr)
    return json.loads(proc.stdout)


def calibrate_budget(arr: np.ndarray, std_tol: float, importance: np.ndarray):
    """预算对齐系数 m：加权铺满在 T×m 下的块数回到不加权 T 的块数（2026-10-18 修）。

    为什么需要它（实测，见 references/rect-merge-playbook.md §2.14）：加权判据把平坦区容差放宽、
    边缘收紧，同一个 `--std` 下加权铺满的块数比不加权**少**（合成图 1221 → 1004；真图 500px 的
    形状路径 32,011 → 27,509）。于是 `--edge-aware` 变成"控件变少、边缘没变好"：预算被悄悄缩掉了。
    解出 m 之后用 T×m 跑后面所有阶段，预算就守恒，权重只决定「同一份预算怎么分」。

    返回 (m, 目标块数, 实际块数)；无权重时恒为 (1.0, None, None)。
    """
    node = _node_binary("--edge-aware")
    raw_path, w, h = _dump_rgb(arr)
    w_path = _dump_weights(importance)
    cmd = [node, os.path.join(_HERE, "layered.mjs"),
           raw_path, str(w), str(h), str(float(std_tol)),
           "--weights", w_path, "--calibrate"]
    try:
        data = _run_json(cmd, "layered.mjs --calibrate", drop=(raw_path, w_path))
    except Exception:
        for p in (raw_path, w_path):
            if p and os.path.exists(p):
                os.remove(p)
        raise
    return float(data["m"]), int(data["target"]), int(data["n"])


def pack_layered(arr: np.ndarray, std_tol: float, importance: np.ndarray = None):
    """分层重长（允许重叠）。返回 (blocks, 基础铺满块数)。

    blocks 的**列表顺序 = 绘制顺序**（先画的在下面、后画的盖上去）。需要 Node ≥ 22。
    importance 给定时，底层的贪心铺满与逐层生长都用加权标准差判据（与纯矩形路径同一条）。
    """
    node = _node_binary("--layered")
    raw_path, w, h = _dump_rgb(arr)
    w_path = _dump_weights(importance) if importance is not None else None
    cmd = [node, os.path.join(_HERE, "layered.mjs"),
           raw_path, str(w), str(h), str(float(std_tol))]
    if w_path:
        cmd += ["--weights", w_path]
    try:
        data = _run_json(cmd, "layered.mjs", drop=(raw_path, w_path))
    except Exception:
        for p in (raw_path, w_path):
            if p and os.path.exists(p):
                os.remove(p)
        raise
    blocks = [(x, y, ww, hh, (rr << 16) | (gg << 8) | bb)
              for (x, y, ww, hh, rr, gg, bb) in data["rects"]]
    return blocks, data["tiled"]


def run_spot_fit(arr: np.ndarray, n_spots: int, radii: str = "auto",
                 stride: int = 16, stride2: int = 4, min_r: str = "auto",
                 allow_outside: bool = False, quiet: bool = False,
                 aspects: str = "1,0.6,0.35", angles: str = "0,45,90,135"):
    """「先铺光斑」阶段：调 spot-fit.mjs 铺一层低频椭圆（不透明，kind 1）。

    返回 (json_path, doc)。**调用方负责删除 json_path** —— 这份结果后面要交给
    shapes.mjs 的 --seed-shapes，所以不能在这里就删掉。

    这一步为什么划算：色块层是自底向上补细节的，大尺度的平滑渐变只能靠很多小矩形去逼近。
    先在底下铺几十个椭圆把低频能量吃掉，色块层就只需要补残差了。光斑与形状共用同一套
    覆盖率模型（shapes-core.mjs 的 coverageInto）。
    """
    node = _node_binary("--spotted")
    h, w = int(arr.shape[0]), int(arr.shape[1])
    side = max(w, h)

    # 半径池 auto：按长边取固定比例。这组比例是在 256 边长上调出来的最好配置
    # 6,10,16,24,36,56,80 ≈ 长边的 2.5% ~ 31%。
    if str(radii) == "auto":
        radii = ",".join(str(round(side * f, 1))
                         for f in (0.025, 0.04, 0.0625, 0.095, 0.14, 0.22, 0.31))
    if str(min_r) == "auto":
        min_r = max(3.0, round(side * 0.02, 1))

    raw_path, w, h = _dump_rgb(arr)
    import tempfile
    fd2, json_path = tempfile.mkstemp(suffix=".json")
    os.close(fd2)

    cmd = [node, os.path.join(_HERE, "spot-fit.mjs"), raw_path, str(w), str(h),
           str(int(n_spots)), "--radii", radii, "--stride", str(int(stride)),
           "--stride2", str(int(stride2)), "--min-r", str(float(min_r)),
           "--aspects", aspects, "--angles", angles, "--out", json_path]
    if allow_outside:
        cmd.append("--allow-outside")

    import subprocess
    try:
        proc = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8")
    finally:
        if os.path.exists(raw_path):
            os.remove(raw_path)
    if proc.returncode != 0:
        if os.path.exists(json_path):
            os.remove(json_path)
        raise RuntimeError("spot-fit.mjs 失败：" + (proc.stderr or proc.stdout or "(无输出)"))
    if proc.stderr.strip() and not quiet:
        print(proc.stderr.rstrip(), file=sys.stderr)
    with open(json_path, encoding="utf-8") as f:
        doc = json.load(f)
    return json_path, doc


def pack_layered_shapes(arr: np.ndarray, std_tol: float, strength: float = 1.0,
                        passes: int = 3, no_rotation: bool = False,
                        rotation_cost: float = 0.0, no_refine: bool = False,
                        kinds: str = "ellipse,rotrect", alpha: bool = False,
                        threads: int = 0, seed_shapes_path: str = None,
                        importance: np.ndarray = None, mae_mask: np.ndarray = None,
                        prefer_rotation: float = 0.0, gpu: bool = False, gpu_batch: int = 0):
    """分层矩形 + 旋转矩形 / 椭圆 / 三角形 / 圆环 / 软边（shapes.mjs 做率失真替换）。

    返回 (blocks, tiled, shapes, stats)。绘制顺序 = blocks（先画的在下面）之后才是 shapes。
    seed_shapes_path 给定时，那批形状先入栈（= 铺在下面），学出来的形状画在它上面。
    importance 给定时，整条率失真目标函数换成加权 L1（边缘 / 焦点处补形状更划算）。
    mae_mask 给定时，stats 里额外给出边缘带 / 其余区域的 MAE 拆分。
    需要 Node ≥ 22。
    """
    node = _node_binary("--shapes")
    raw_path, w, h = _dump_rgb(arr)
    w_path = _dump_weights(importance) if importance is not None else None
    m_path = None
    if mae_mask is not None:
        import tempfile
        fd, m_path = tempfile.mkstemp(suffix=".u8")
        with os.fdopen(fd, "wb") as f:
            f.write(np.ascontiguousarray(np.asarray(mae_mask, dtype=bool), dtype=np.uint8).tobytes())
    cmd = [node, os.path.join(_HERE, "shapes.mjs"), raw_path, str(w), str(h),
           str(float(std_tol)), "--strength", str(float(strength)),
           "--passes", str(int(passes))]
    if no_rotation:
        cmd.append("--no-rotation")
    if rotation_cost:
        cmd += ["--rotation-cost", str(float(rotation_cost))]
    if prefer_rotation:
        cmd += ["--prefer-rotation", str(float(prefer_rotation))]
    if no_refine:
        cmd.append("--no-refine")
    cmd += ["--kinds", kinds]
    if alpha:
        cmd.append("--alpha")
    if threads:
        cmd += ["--threads", str(threads)]
    if gpu:
        # GPU 搜索：shapes.mjs 会起 gpu_search_server.py（用当前这个 Python，需要 torch + CUDA + triton）；起不来就自动退回 CPU 线程池
        cmd += ["--gpu", "--gpu-python", sys.executable]
        if gpu_batch:
            cmd += ["--gpu-batch", str(int(gpu_batch))]
    if seed_shapes_path:
        cmd += ["--seed-shapes", seed_shapes_path]
    if w_path:
        cmd += ["--weights", w_path]
    if m_path:
        cmd += ["--mae-mask", m_path]

    try:
        data = _run_json(cmd, "shapes.mjs", drop=(raw_path, w_path, m_path))
    except Exception:
        for p in (raw_path, w_path, m_path):
            if p and os.path.exists(p):
                os.remove(p)
        raise

    blocks = [(x, y, ww, hh, (rr << 16) | (gg << 8) | bb)
              for (x, y, ww, hh, rr, gg, bb) in data["rects"]]
    shapes = [tuple(s) for s in data["shapes"]]
    # 元组长度按形状逐个决定：10 项走 v2，软边多 fxq / fyq 两项 → 12 项走 v3（19 字符的形状串）。
    # 【离线实测 2026-10-16】软边只在低频内容（平滑渐变、插画的皮肤与背景）上既省控件又降 MAE，
    # 在像素画 / 线稿这类高频图上净亏；所以它不在默认的 --shape-kinds 里，要用得显式加 soft。
    if any(len(t) not in (10, 12) for t in shapes):
        raise RuntimeError("shapes.mjs 给的形状元组长度既不是 10（v2）也不是 12（v3 软边）：%r"
                           % (shapes[:1],))
    return blocks, data["tiled"], shapes, data["stats"]


# ------------------------------------------------------------------------------
# 几何自检
# ------------------------------------------------------------------------------
def validate_blocks(blocks, W: int, H: int) -> Tuple[int, int, int]:
    """不重叠数据用：(空洞数, 重叠数, 越界数)，三者都应等于 0。"""
    cover = np.zeros((H, W), dtype=np.int32)
    oob = 0
    for (x, y, w, h, _c) in blocks:
        if x < 0 or y < 0 or x + w > W or y + h > H or w <= 0 or h <= 0:
            oob += 1
            continue
        cover[y:y + h, x:x + w] += 1
    return int((cover == 0).sum()), int((cover > 1).sum()), oob


def validate_layered(blocks, W: int, H: int) -> Tuple[int, int]:
    """分层数据用：(空洞数, 越界数)，两者都应等于 0 —— 重叠是允许的。"""
    cover = np.zeros((H, W), dtype=bool)
    oob = 0
    for (x, y, w, h, _c) in blocks:
        if x < 0 or y < 0 or x + w > W or y + h > H or w <= 0 or h <= 0:
            oob += 1
            continue
        cover[y:y + h, x:x + w] = True
    return int((~cover).sum()), oob


# ------------------------------------------------------------------------------
# 画质拆分：边缘带 / 平坦带的 MAE 分开算
# ------------------------------------------------------------------------------
def mae_split(arr: np.ndarray, blocks, W: int, H: int, edge_mask: np.ndarray) -> Tuple[float, float]:
    """返回 (边缘带 MAE, 其余区域 MAE)，都是"每像素每通道"的平均绝对色差。

    这个拆分是边缘优先预算的验收口径：预算挪对了位置，边缘 MAE 应当下降、
    平坦区 MAE 允许上升（甚至块数下降）。只报一个全图 MAE 会把两者混在一起，
    看不出预算到底挪没挪。
    """
    rec = reconstruct(blocks, W, H).astype(np.float64)
    diff = np.abs(rec - np.asarray(arr, dtype=np.float64)).mean(axis=2)
    mask = np.asarray(edge_mask, dtype=bool)
    e = float(diff[mask].mean()) if mask.any() else 0.0
    s = float(diff[~mask].mean()) if (~mask).any() else 0.0
    return e, s


# ------------------------------------------------------------------------------
# 写 Lua
# ------------------------------------------------------------------------------
def write_lua(path: str, blocks, W: int, H: int, std: float, bits: int, enc: str,
              mae: float, var_name: str = "IMG", with_return: bool = False,
              layered: bool = False, shapes=None) -> None:
    """按 render.lua 的数据区格式写出 Lua 数据表。

    ★ with_return 默认 False：这份输出通常要**整份粘进 render.lua 的数据区**，
      而 Lua 规定 return 只能是块的最后一条语句 —— 粘在中间会编译失败
      （报 '<eof>' expected near 'local'），表现是进关卡后既没日志也没画面。
    """
    if enc == "p64" and any(b[2] > P64_MAX_SIDE or b[3] > P64_MAX_SIDE for b in blocks):
        blocks, nsplit = split_oversize(blocks)
        print("  超宽块拆分: %d 个块边长超过 %d，已按 ≤%d 切条（像素等价，绘制顺序不变）；矩形层现共 %d 块"
              % (nsplit, P64_MAX_SIDE, P64_MAX_SIDE, len(blocks)))
    if layered:
        if enc != "p64":
            raise ValueError("分层数据只能用 p64 编码（坐标必须显式给出，且顺序就是绘制顺序）")
        data = pack_p64(blocks, keep_order=True)
    else:
        data = codec_pack(blocks, enc)

    lines = [
        "-- 由 compress.py 生成（最大对齐矩形合并压缩）",
        "-- STD=%s  COLOR_BITS=%d  分辨率=%dx%d  编码=%s  块数=%d  MAE=%.2f"
        % (std, bits, W, H, enc, len(blocks), mae),
        "-- 用法：把本文件【全部内容】替换进 render.lua 的『数据区』",
        "local %s = {}" % var_name,
        "%s.N = %d" % (var_name, W),
        "%s.W = %d" % (var_name, W),
        "%s.H = %d" % (var_name, H),
        "%s.STD = %s" % (var_name, std),
        "%s.ENC = \"%s\"" % (var_name, enc),
        "%s.NBLK = %d" % (var_name, len(blocks)),
        "%s.MAE = %.2f" % (var_name, mae),
        "%s.LAYERED = %s   -- true = 允许重叠，数据顺序就是绘制顺序（先画的在下面）"
        % (var_name, "true" if layered else "false"),
        ("%s.DATA = %s" % (var_name, lua_long_string(data))) if enc == "p64"
        else ("%s.DATA = \"%s\"" % (var_name, data)),
    ]

    if shapes:
        # 形状串版本按内容自动选：只要有软边（12 项元组）就必须 v3（多 fxq / fyq），否则留 v2
        shp_ver = 3 if any(len(t) >= 12 for t in shapes) else 2
        at = lines.index("%s.MAE = %.2f" % (var_name, mae)) + 1
        lines.insert(at, "%s.NSHP = %d   -- 形状个数（旋转矩形 / 椭圆 / 三角形 / 圆环 / 软边，可半透明）；"
                         "总控件数 = NBLK + NSHP，绘制顺序 = 矩形再形状" % (var_name, len(shapes)))
        lines.insert(at + 1, "%s.SHPV = %d   -- 形状串版本：%s" % (var_name, shp_ver,
                     "每个 19 个字符（v3：含不透明度 + 软边羽化宽度 fx / fy）" if shp_ver >= 3
                     else "每个 15 个字符（v2：含不透明度）"))
        lines.append("%s.SHP = %s" % (var_name, lua_long_string(pack_shapes(shapes, shp_ver))))

    if with_return:
        lines.append("return %s" % var_name)

    with open(path, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


# ------------------------------------------------------------------------------
# 命令行
# ------------------------------------------------------------------------------
def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="最大对齐矩形合并压缩器（输出千星奇域可渲染的 Lua 块数据）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python compress.py --input a.png --output a.lua --std 3 --size 300x300\n"
               "  python compress.py --std 0 --size 200x200        # 无损\n"
               "  python compress.py --enc hex                     # 肉眼可读\n")
    ap.add_argument("--input", help="输入图片路径")
    ap.add_argument("--output", help="输出 lua 路径")
    ap.add_argument("--std", type=float, help="合并容差，0~1024 任意值（0 = 无损）")
    ap.add_argument("--size", help="输出分辨率，形如 300x300")
    ap.add_argument("--lock-aspect", action="store_true", help="锁定长宽比（不拉伸）")
    ap.add_argument("--no-lock-aspect", action="store_true", help="允许变形（默认）")
    ap.add_argument("--bits", type=int, help="每通道位数，8 = 24 位真彩（推荐）")
    ap.add_argument("--enc", choices=["p64", "b64", "hex"],
                    help="块列表编码：p64（Lua 计算最少，默认）/ b64（体积最省）/ hex")
    ap.add_argument("--preview", action="store_true", help="另存一张重建预览图")
    ap.add_argument("--edge-aware", action="store_true",
                    help="边缘优先的误差预算：边缘处容差按 1/I 收紧（锯齿更细），"
                         "平坦与缓变处放宽。纯矩形 / --layered / --shapes 都支持，"
                         "三条路用同一条加权判据。2026-10-18 起预算守恒：容差自动折算成 T×m，加权后块数回到不加权水平（--std 决定预算、权重只决定花在哪）；旧行为用 --edge-unbalanced 复现")
    ap.add_argument("--edge-boost", type=float, default=None,
                    help="明显色差处的收紧斜率（默认 1.8；无封顶时最多收紧到 1/(1+boost) 倍容差）")
    ap.add_argument("--edge-cap", type=float, default=None,
                    help="精细区域的权重上限：I 涨到 cap 就不再收紧（默认 2.2；越小越省控件、"
                         "极端细节越糊；上限 ≤ 4）")
    ap.add_argument("--edge-unbalanced", action="store_true",
                    help="关掉预算对齐（2026-10-18 之前的旧行为）：加权后不再把容差折算回 T×m，"
                         "于是 --edge-aware 会同时**减少块数**。只用于复现旧结果 / 想主动缩预算时")
    ap.add_argument("--smooth-slack", type=float, default=None,
                    help="色差不大处最多放宽到 1/(1−slack) 倍容差（默认 0.5，即 2.0 倍）")
    ap.add_argument("--edge-ref", type=float, default=None,
                    help="梯度归一化的高分位（百分位，默认 95）")
    ap.add_argument("--edge-floor", type=float, default=None,
                    help="梯度归一化的绝对下限（默认 24；弱于它的起伏不算边缘）")
    ap.add_argument("--focus", metavar="FILE",
                    help="视觉焦点文件：AI / 人工标出的「最该看清楚的地方」。"
                         "JSON（boxes / points / heatmap，space 可 px 或 norm）或直接给一张热图 PNG；"
                         "焦点处重要度 += --focus-gain·F，于是容差收紧、控件往那里集中")
    ap.add_argument("--focus-gain", type=float, default=None,
                    help="焦点处重要度额外抬升量（默认 0.8，即容差收紧到 1/(1+0.8)=0.56 倍）")
    ap.add_argument("--resample", choices=["lanczos", "box", "bicubic", "bilinear"], default=None,
                    help="源图缩到 --size 时的重建核（默认 box，2026-10-18 定案）。box = 面积平均、不振铃："
                         "同参数控件 −15.4%%、对连续真值误差 −4.7%%、假硬边 −16%%（48 号），"
                         "因为 lanczos 的振铃过冲会被拟合器当成真结构多切块。"
                         "注意：**只换核消不掉放大后的台阶**（边点 maxstep 15.9 / 15.6 / 14.7 几乎一样），"
                         "换核只解决边缘干不干净。要复现 2026-10-18 之前的旧结果，显式加 --resample lanczos")
    ap.add_argument("--edge-soft", type=float, default=None, metavar="SIGMA",
                    help="【已否决 2026-10-18】只把边界带做柔：梯度强的像素混进高斯模糊（σ 以目标像素计）。"
                         "台阶确实降 35%%~57%%，但那是拿锐度换平滑，对连续真值的偏离 +21%%~+49%%，"
                         "而且糊掉发丝 / 小字。仅为复现 49/50/51/52 保留，不建议新项目使用。默认 0 = 关闭")
    ap.add_argument("--edge-soft-lo", type=float, default=None,
                    help="柔化掩膜的梯度下限（默认 10）：弱于它的起伏完全不动")
    ap.add_argument("--edge-soft-hi", type=float, default=None,
                    help="柔化掩膜的梯度上限（默认 30）：强于它的地方完全按 σ 模糊")
    ap.add_argument("--edge-soft-dilate", type=int, default=None,
                    help="柔化掩膜外扩圈数（默认 1，柔化带约 3 px 宽；2 更宽更糊）")
    ap.add_argument("--layered", action="store_true",
                    help="分层重长：允许控件重叠，同画质下控件更少（需要 Node；只能用 p64）")
    ap.add_argument("--shapes", action="store_true",
                    help="在分层矩形上再加旋转矩形 / 椭圆（率失真替换，同 MAE 下少约 20%% 控件；"
                         "需要 Node；只能配 --layered 的 p64；旋转 / 椭圆边缘抗锯齿已在真机确认）")
    ap.add_argument("--shape-strength", type=float, default=None,
                    help="形状替换强度（默认 1；--preset best 时默认 0.6。越大越省控件、误差越大）")
    ap.add_argument("--shape-passes", type=int, default=3,
                    help="形状替换遍数（默认 3，每遍之后还有一轮精修）")
    ap.add_argument("--shape-no-refine", action="store_true",
                    help="跳过精修（颜色重拟合、形状几何微调、矩形边微调、修剪），只做贪心替换；"
                         "快 2~3 倍，但同画质多约 20%% 控件")
    ap.add_argument("--shape-rotation-cost", type=float, default=0.0,
                    help="旋转一个形状相当于几个普通控件的加载代价（真机约 12）；默认 0 = 只数控件个数。"
                         "大于 0 时只在能替掉很多矩形的地方才旋转")
    ap.add_argument("--shape-prefer-rotation", type=float, default=None,
                    help="旋转形状的**加分**（单位同旋转代价 = 控件数，默认 0 关闭；--preset best 时默认 8）。"
                         "按种子的对角强度缩放：斜边区域（书页、手指、头发）拿满，轴对齐区域拿不到。"
                         "斜边上的台阶是矩形拼出来的，旋转矩形/椭圆能把边压在斜线上——"
                         "这一项就是让拟合在『差不多划算』时优先用旋转图形，而不是把台阶留在那儿。"
                         "建议 4~8；再大就会为了转而在平坦区硬塞形状")
    ap.add_argument("--shape-kinds", default=None,
                    help="用哪些形状（默认 ellipse,rotrect；--preset best 时 "
                         "ellipse,rotrect,triangle,ring），逗号分隔：ellipse（椭圆）rotrect（旋转矩形）"
                         "triangle（三角形）ring（圆环）soft（软边矩形，羽化渐变）。"
                         "triangle / ring 的几何要先拿 28 号校准关卡在真机里量过。"
                         "soft 会写 SHPV = 3（每形状 19 字符），并由 to-gil 生成 "
                         "enableMask / enableSoftEdge / SetSoftEdgeWidth；"
                         "【离线实测 2026-10-16】只在平滑渐变的低频内容上划算，像素画和线稿会净亏控件")
    ap.add_argument("--shape-alpha", action="store_true",
                    help="允许半透明形状（真机混合方式要先拿 28 号校准关卡确认）")
    ap.add_argument("--shape-threads", type=int, default=0,
                    help="形状搜索的线程数（默认自动：核数 − 2，最多 8）")
    ap.add_argument("--gpu", action="store_true",
                    help="形状搜索（占构建时间约 60%%）放到 GPU 上：需要 PyTorch(CUDA) + Triton；比 8 线程 CPU 快约 2～3 倍，结果与 CPU 几乎一致；起不来自动退回 CPU（实验性）")
    ap.add_argument("--gpu-batch", type=int, default=0,
                    help="GPU 每批种子数（默认 0 = 按图面积自动：像素数 / 1250；批越大越快但质量略降）")
    ap.add_argument("--shape-no-rotation", action="store_true",
                    help="只出不旋转的椭圆（真机里每个 SetLocalRotation 约 10 ms，会明显拖慢加载）")
    ap.add_argument("--preset", choices=["best"],
                    help="推荐配置（2026-10-17 在两张插画上调出来、各部件的组合已在真机验证）："
                         "best = --shapes --spotted 150 --shape-kinds ellipse,rotrect,triangle,ring "
                         "--shape-alpha --shape-strength 0.6。单独写出的选项优先。"
                         "控件数由 --std 和 --shape-strength 一起决定：先用 --std 粗定，"
                         "再用强度压到 4.0 万控件以内（20 MiB 存档上限）")
    ap.add_argument("--spotted", type=int, metavar="N", nargs="?", const=150,
                    help="「先铺光斑」：先铺 N 个低频椭圆打底，色块层再补残差（隐含 --shapes；需要 Node）。"
                         "离线实测（256×256 插画 STD 3）：150 个光斑在同误差下控件少约 19%%、"
                         "误差超过 40 的像素少约 29%%；光斑越多收益越小（30 → 11%%，80 → 16%%，"
                         "150 → 19%%，300 → 20%%），推荐 150 左右。收益看图，越平滑越划算")
    ap.add_argument("--spot-radii", default="auto",
                    help="光斑长半轴池，源像素、逗号分隔；默认 auto = 长边的 2.5%%、4%%、6.25%%、"
                         "9.5%%、14%%、22%%、31%%")
    ap.add_argument("--spot-aspects", default="1,0.6,0.35",
                    help="光斑长宽比池（短半轴 / 长半轴，1 = 圆），默认 1,0.6,0.35")
    ap.add_argument("--spot-angles", default="0,45,90,135",
                    help="非圆光斑的旋转角池（度），默认 0,45,90,135")
    ap.add_argument("--spot-stride", type=int, default=16, help="光斑粗搜中心步长（默认 16；越小越慢越细）")
    ap.add_argument("--spot-stride2", type=int, default=4, help="光斑精搜步长（默认 4）")
    ap.add_argument("--spot-min-r", default="auto", help="光斑最小半径（默认 auto = 长边的 2%%，至少 3）")
    ap.add_argument("--spot-allow-outside", action="store_true",
                    help="允许光斑几何外延出图。默认要求完整落在图内，与形状层的 insideImage 判断一致")
    ap.add_argument("--max-blocks", type=int, help="块数告警阈值")
    ap.add_argument("--var-name", help="输出 Lua 变量名（默认 IMG）")
    ap.add_argument("--with-return", action="store_true",
                    help="在输出末尾补 return（仅当把输出当独立 Lua 模块用时；直接粘进 render.lua 时不要加）")
    ap.add_argument("--config", help="JSON 配置文件")
    return ap


def main():
    args = build_parser().parse_args()

    cfg = dict(CONFIG)
    if args.config:
        with open(args.config, encoding="utf-8") as f:
            cfg.update(json.load(f))
    if args.input: cfg["INPUT"] = args.input
    if args.output: cfg["OUTPUT"] = args.output
    if args.std is not None: cfg["STD"] = args.std
    if args.size:
        w, h = args.size.lower().split("x")
        cfg["OUT_W"], cfg["OUT_H"] = int(w), int(h)
    if args.lock_aspect: cfg["LOCK_ASPECT"] = True
    if args.no_lock_aspect: cfg["LOCK_ASPECT"] = False
    if args.bits is not None: cfg["COLOR_BITS"] = args.bits
    if args.enc: cfg["ENC"] = args.enc
    if args.preview: cfg["PREVIEW"] = True
    if args.max_blocks is not None: cfg["MAX_BLOCKS"] = args.max_blocks
    if args.var_name: cfg["VAR_NAME"] = args.var_name
    if args.edge_aware: cfg["EDGE_AWARE"] = True
    if args.edge_unbalanced: cfg["EDGE_BALANCE"] = False
    if args.edge_boost is not None: cfg["EDGE_BOOST"] = args.edge_boost
    if args.edge_cap is not None: cfg["EDGE_CAP"] = args.edge_cap
    if args.smooth_slack is not None: cfg["SMOOTH_SLACK"] = args.smooth_slack
    if args.edge_ref is not None: cfg["EDGE_REF"] = args.edge_ref
    if args.edge_floor is not None: cfg["EDGE_FLOOR"] = args.edge_floor
    if args.focus: cfg["FOCUS"] = args.focus
    if args.focus_gain is not None: cfg["FOCUS_GAIN"] = args.focus_gain
    if args.resample: cfg["RESAMPLE"] = args.resample
    if args.edge_soft is not None: cfg["EDGE_SOFT"] = args.edge_soft
    if args.edge_soft_lo is not None: cfg["EDGE_SOFT_LO"] = args.edge_soft_lo
    if args.edge_soft_hi is not None: cfg["EDGE_SOFT_HI"] = args.edge_soft_hi
    if args.edge_soft_dilate is not None: cfg["EDGE_SOFT_DILATE"] = args.edge_soft_dilate

    # --preset best：推荐组合（单独写出的选项优先，不覆盖用户显式给的值）
    if args.preset == "best":
        args.shapes = True
        if args.spotted is None:
            args.spotted = 150
        if args.shape_kinds is None:
            args.shape_kinds = "ellipse,rotrect,triangle,ring"
        args.shape_alpha = True
        if args.shape_strength is None:
            args.shape_strength = 0.6
        if args.shape_prefer_rotation is None:
            # 「推荐配置」默认把旋转图形排在普通矩形前面（2026-10-18 实测：400px 书页/手指裁片里
            # 旋转形状 +34%、控件 −6%、MAE +0.06，斜边台阶明显变少；再往上加收益就没了）
            args.shape_prefer_rotation = 8.0
    if args.shape_kinds is None:
        args.shape_kinds = "ellipse,rotrect"
    if args.shape_strength is None:
        args.shape_strength = 1.0
    if args.shape_prefer_rotation is None:
        args.shape_prefer_rotation = 0.0

    std = float(cfg["STD"])
    if std < STD_MIN or std > STD_MAX:
        print("错误：STD 必须在 %s ~ %s 之间（你给了 %s）" % (STD_MIN, STD_MAX, std),
              file=sys.stderr)
        return 1

    enc = cfg["ENC"]
    # --spotted 隐含 --shapes：光斑本身就是形状（不透明椭圆，kind 1），必须走 shapes 那条路
    shapes_on = bool(args.shapes or args.spotted is not None)
    layered = bool(args.layered or cfg.get("LAYERED", False) or shapes_on)
    if layered and enc != "p64":
        print("错误：--layered 只能配 p64 编码（你给了 %s）" % enc, file=sys.stderr)
        return 1

    edge_aware = bool(cfg.get("EDGE_AWARE", False))
    if edge_aware:
        if not (0.0 <= float(cfg["EDGE_BOOST"]) <= 8.0):
            print("错误：--edge-boost 必须在 0 ~ 8 之间（收到 %s）" % cfg["EDGE_BOOST"], file=sys.stderr)
            return 1
        if not (EDGE_I_MIN < float(cfg["EDGE_CAP"]) <= EDGE_I_MAX):
            print("错误：--edge-cap 必须在 %s ~ %s 之间（收到 %s）"
                  % (EDGE_I_MIN, EDGE_I_MAX, cfg["EDGE_CAP"]), file=sys.stderr)
            return 1
        if not (0.0 <= float(cfg["SMOOTH_SLACK"]) < 1.0):
            print("错误：--smooth-slack 必须在 0 ~ 1 之间且小于 1（收到 %s）；"
                  "≥1 会让平坦区容差变成无穷大" % cfg["SMOOTH_SLACK"], file=sys.stderr)
            return 1
    if not (0.0 <= float(cfg["FOCUS_GAIN"]) <= 4.0):
        print("错误：--focus-gain 必须在 0 ~ 4 之间（收到 %s）" % cfg["FOCUS_GAIN"], file=sys.stderr)
        return 1
    if not (0.0 <= float(cfg["EDGE_SOFT"]) <= 4.0):
        print("错误：--edge-soft 必须在 0 ~ 4 之间（收到 %s）" % cfg["EDGE_SOFT"], file=sys.stderr)
        return 1
    if float(cfg["EDGE_SOFT"]) > 0 and not (float(cfg["EDGE_SOFT_HI"]) > float(cfg["EDGE_SOFT_LO"])):
        print("错误：--edge-soft-hi 必须大于 --edge-soft-lo（收到 %s / %s）"
              % (cfg["EDGE_SOFT_HI"], cfg["EDGE_SOFT_LO"]), file=sys.stderr)
        return 1
    imp = None

    print("=" * 78)
    print("最大对齐矩形合并压缩")
    print("=" * 78)
    print("  输入      : %s" % cfg["INPUT"])
    print("  输出      : %s" % cfg["OUTPUT"])
    print("  分辨率    : %d x %d" % (cfg["OUT_W"], cfg["OUT_H"]))
    print("  锁定比例  : %s" % cfg["LOCK_ASPECT"])
    print("  STD 容差  : %s%s" % (std, "（无损：只合并同色相邻像素）" if std == 0 else ""))
    print("  颜色位数  : %d%s" % (cfg["COLOR_BITS"],
          "（24 位真彩，不量化）" if cfg["COLOR_BITS"] >= 8 else ""))
    print("  块列表编码: %s" % enc)
    if edge_aware:
        print("  边缘优先  : 开（boost %.2f / slack %.2f / cap %.2f / 分位 %.0f / 下限 %.0f）"
              % (cfg["EDGE_BOOST"], cfg["SMOOTH_SLACK"], cfg["EDGE_CAP"], cfg["EDGE_REF"],
             cfg["EDGE_FLOOR"]))
    if cfg.get("FOCUS"):
        print("  视觉焦点  : %s（gain %.2f；JSON 里 boxes / points / heatmap 取其最大值）"
              % (cfg["FOCUS"], cfg["FOCUS_GAIN"]))
    print("  采样核    : %s（box = 面积平均，2026-10-18 起的默认）" % cfg.get("RESAMPLE", "box"))
    if float(cfg.get("EDGE_SOFT", 0) or 0) > 0:
        print("  边界做柔  : σ=%.2f（掩膜 %.0f~%.0f，外扩 %d；平坦区不动）"
              % (float(cfg["EDGE_SOFT"]), float(cfg["EDGE_SOFT_LO"]),
                 float(cfg["EDGE_SOFT_HI"]), int(cfg["EDGE_SOFT_DILATE"])))

    t0 = time.time()
    arr = load_and_prepare(cfg["INPUT"], cfg["OUT_W"], cfg["OUT_H"], cfg["LOCK_ASPECT"],
                           cfg.get("RESAMPLE", "box"))
    if float(cfg.get("EDGE_SOFT", 0) or 0) > 0:
        ts = time.time()
        arr = soften_edges(arr, float(cfg["EDGE_SOFT"]), float(cfg["EDGE_SOFT_LO"]),
                           float(cfg["EDGE_SOFT_HI"]), int(cfg["EDGE_SOFT_DILATE"]))
        print("  边界柔化  : %.2f s" % (time.time() - ts))
    q = quantize(arr, cfg["COLOR_BITS"])
    print("  图像载入+预处理: %.2f s" % (time.time() - t0))

    if edge_aware and (float(cfg["EDGE_BOOST"]) > 0 or float(cfg["SMOOTH_SLACK"]) > 0):
        te = time.time()
        imp = edge_importance(q, cfg["EDGE_BOOST"], cfg["SMOOTH_SLACK"],
                              cfg["EDGE_REF"], cfg["EDGE_FLOOR"],
                              cap=cfg["EDGE_CAP"])
        print("  边缘重要度: 收紧 %.1f%% / 放宽 %.1f%% 像素  （%.2f s）"
              % (100.0 * float((imp > 1.2).mean()), 100.0 * float((imp < 0.9).mean()),
                 time.time() - te))

    # AI / 人工指定的视觉焦点：叠加到同一条重要度图上（取逐像素最大值 → 再统一 clip）
    if cfg.get("FOCUS"):
        tf = time.time()
        F = load_focus(cfg["FOCUS"], cfg["OUT_W"], cfg["OUT_H"])
        base = imp if imp is not None else np.ones((cfg["OUT_H"], cfg["OUT_W"]), dtype=np.float64)
        imp = np.clip(base + float(cfg["FOCUS_GAIN"]) * F, EDGE_I_MIN, EDGE_I_MAX)
        print("  焦点覆盖  : %.1f%% 像素（F>0.5），重要度上限 %.2f（%.2f s）"
              % (100.0 * float((F > 0.5).mean()), float(EDGE_I_MAX), time.time() - tf))

    # 权重全为 1 时传 None：走与不加权**逐字节相同**的老代码路径（不是"近似等价"）
    weights = imp if (imp is not None and not bool(np.all(imp == 1.0))) else None
    emask = (imp > 1.2) if imp is not None else None

    # ---- 预算对齐（2026-10-18 修）----
    # 加权判据把平坦区放宽容差、边缘收紧，同一条 --std 下加权铺满的块数会**变少**，
    # 于是 --edge-aware 的实际效果变成"控件少了一截、边缘却没变好"。这里解出 m，把容差折算成
    # T×m 再交给后面所有阶段，块数回到不加权 T 的水平：权重只挪预算，不缩预算。
    std_eff = std
    if edge_aware and weights is not None and bool(cfg.get("EDGE_BALANCE", True)):
        tb = time.time()
        m, kt_target, kt_got = calibrate_budget(q, std, weights)
        std_eff = std * m
        print("  预算对齐  : m=%.3f → 实际容差 %.3f（不加权 %d 块目标 / 加权 %d 块，%.2f s）"
              % (m, std_eff, kt_target, kt_got, time.time() - tb))

    if cfg["OUT_W"] != cfg["OUT_H"]:
        print("  注意：输出不是正方形（%dx%d）；render.lua 按正方形摆放块。"
              % (cfg["OUT_W"], cfg["OUT_H"]), file=sys.stderr)

    # ---- 「先铺光斑」：在色块层之前铺一层低频椭圆（可选）----
    spot_doc = None
    spot_json = None
    if args.spotted is not None:
        ts = time.time()
        spot_json, spot_doc = run_spot_fit(q, args.spotted, args.spot_radii, args.spot_stride,
                                           args.spot_stride2, args.spot_min_r, args.spot_allow_outside,
                                           aspects=args.spot_aspects, angles=args.spot_angles)
        print("  光斑铺设  : %d 个椭圆（低频打底），仅光斑层 MAE=%.3f，耗时 %.1f s"
              % (spot_doc["n"], spot_doc.get("maeAfter", float("nan")), time.time() - ts))

    t0 = time.time()
    tiled = None
    shapes = []
    shape_stats = None
    try:
        if shapes_on:
            blocks, tiled, shapes, shape_stats = pack_layered_shapes(
                q, std_eff, args.shape_strength, args.shape_passes, args.shape_no_rotation,
                args.shape_rotation_cost, args.shape_no_refine, args.shape_kinds,
                args.shape_alpha, args.shape_threads, seed_shapes_path=spot_json,
                importance=weights, mae_mask=emask,
                prefer_rotation=args.shape_prefer_rotation, gpu=args.gpu, gpu_batch=args.gpu_batch)
        elif layered:
            blocks, tiled = pack_layered(q, std_eff, weights)
        else:
            blocks = pack_rects(q, std_eff, P64_MAX_SIDE if enc == "p64" else MAX_SIDE,
                                importance=weights)
    finally:
        if spot_json and os.path.exists(spot_json):
            os.remove(spot_json)
    pack_t = time.time() - t0
    nblk = len(blocks) + len(shapes)          # 控件总数 = 矩形 + 形状

    if layered:
        # 分层数据：允许重叠，只要求铺满、不越界；坐标是显式的，不需要扫描顺序
        holes, oob = validate_layered(blocks, cfg["OUT_W"], cfg["OUT_H"])
        overlap = 0
        geo_ok = (holes == 0 and oob == 0)
        order_bad, order_ok = 0, True
    else:
        # 自检 1：几何（铺满、不重叠、不越界）
        holes, overlap, oob = validate_blocks(blocks, cfg["OUT_W"], cfg["OUT_H"])
        geo_ok = (holes == 0 and overlap == 0 and oob == 0)
        # 自检 2：扫描顺序（决定 x、y 能不能省掉）
        order_bad = check_scan_order(blocks, cfg["OUT_W"])
        order_ok = (order_bad == 0)

    if tiled is not None:
        baseline = shape_stats["start"] - 1 if shapes_on else nblk
        print("  分层重长  : 基础铺满 %d 块 → 分层 %d 块（少 %.1f%%；同 STD 下画质会略降，比较要看同 MAE）"
              % (tiled, baseline, 100.0 * (1 - baseline / max(1, tiled))))
    if shapes_on:
        print("  形状替换  : 矩形 %d + 椭圆 %d + 旋转矩形 %d + 三角形 %d + 圆环 %d = %d 个控件"
              "（只用分层矩形是 %d 个，含 1 个均色底板）；MAE %.2f → %.2f（λ=%.1f，强度 %s）"
              % (len(blocks), shape_stats["ellipses"], shape_stats["rotrects"],
                 shape_stats.get("triangles", 0), shape_stats.get("rings", 0), nblk,
                 shape_stats["start"], shape_stats["startMAE"], shape_stats["mae"],
                 shape_stats["lambda"], args.shape_strength))
        if spot_doc is not None:
            print("  光斑存活  : %d / %d 个（没活下来的说明形状层取代它更划算，已自动删掉）"
                  % (shape_stats.get("seeded", 0), shape_stats.get("seededIn", 0)))

    # ---- MAE（矩形合并造成的色差）----
    if shapes_on:
        mae_q, maxerr_q = shape_stats["mae"], 0
        mae_orig, maxerr_orig = shape_stats["mae"], 0   # 带覆盖率混合的模型值，不含最大单点误差
    else:
        mae_q, maxerr_q = compute_mae(q, blocks, cfg["OUT_W"], cfg["OUT_H"])
        mae_orig, maxerr_orig = compute_mae(arr, blocks, cfg["OUT_W"], cfg["OUT_H"])

    # ---- 编码体积对比 ----
    sz = codec_sizes(blocks)
    print()
    print("  压缩耗时  : %.2f s" % pack_t)
    print("  块数      : %d  （= 需要的控件数）" % nblk)
    print("  压缩率    : %.2fx" % ((cfg["OUT_W"] * cfg["OUT_H"]) / max(1, nblk)))
    print("  平均块面积: %.1f 像素" % ((cfg["OUT_W"] * cfg["OUT_H"]) / max(1, nblk)))
    print("  ---- 画质（矩形合并误差）----")
    print("  MAE       : %.2f （%s）  %s"
          % (mae_orig,
             "带覆盖率混合的模型值，无最大单点误差" if shapes_on else "最大单点误差 %d" % maxerr_orig,
             "无损" if mae_orig == 0 else
             ("几乎无损" if mae_orig <= 1.5 else
              ("轻微" if mae_orig <= 3.0 else "可见块状"))))
    if imp is not None:
        emask = imp > 1.2
        smask = imp < 0.9
        me = ms = None
        if shapes_on:
            if shape_stats.get("maeEdge") is not None:
                me, ms = shape_stats["maeEdge"], shape_stats["maeOther"]
        else:
            me, ms = mae_split(arr, blocks, cfg["OUT_W"], cfg["OUT_H"], emask)
        label = "边缘 / 焦点" if cfg.get("FOCUS") else "边缘"
        if me is not None:
            print("  ── 视觉预算（%s优先） ──" % label)
            print("  重要度    : 高权重 %.1f%% 像素（收紧）/ 低权重 %.1f%%（放宽）/ 中间 %.1f%%"
                  % (100.0 * emask.mean(), 100.0 * smask.mean(),
                     100.0 * (1.0 - emask.mean() - smask.mean())))
            print("  MAE 拆分  : 高权重区 %.2f ／ 其余 %.2f   （boost %.2f  slack %.2f gain %.2f；"
                  "高权重区更准、其余允许更糊）"
                  % (me, ms, cfg["EDGE_BOOST"], cfg["SMOOTH_SLACK"], cfg["FOCUS_GAIN"]))
    if cfg["COLOR_BITS"] < 8:
        print("  （其中量化贡献 %.2f，合并贡献 %.2f）" % (max(0.0, mae_orig - mae_q), mae_q))
    print("  ---- 块数据体积（编码方式可省空间）----")
    print("  hex       : %d 字符（%.1f 万）" % (sz["hex_chars"], sz["hex_chars"] / 10000))
    print("  b64       : %d 字符（%.1f 万）  相对 hex 省 %.0f%%"
          % (sz["b64_chars"], sz["b64_chars"] / 10000, (1 - sz["b64_vs_hex"]) * 100))
    print("  对比旧写法（Lua 表 {x=..,y=..}）: 约 %d 字符 → b64 省 %.0f%%"
          % (sz["table_chars"], (1 - sz["b64_vs_table"]) * 100))
    print("  ---- 自检 ----")
    print("  几何      : 空洞 %d / 重叠 %d / 越界 %d  %s"
          % (holes, overlap, oob, "✓ 通过" if geo_ok else "✗ 失败"))
    print("  扫描顺序  : 坐标推演不一致 %d 处  %s（决定 x,y 可省略）"
          % (order_bad, "✓" if order_ok else "✗ 失败（编码会出错）"))
    print("  预估建立耗时: %.1f s（按实测 0.223 ms/控件）" % (nblk * 0.223 / 1000))

    if nblk > cfg["MAX_BLOCKS"]:
        print("  ⚠️ 警告：块数 %d 超过阈值 %d。实测 50,000 正常、61,440 崩溃，"
              % (nblk, cfg["MAX_BLOCKS"]), file=sys.stderr)
        print("     建议提高 STD 或降低分辨率。", file=sys.stderr)

    out_dir = os.path.dirname(os.path.abspath(cfg["OUTPUT"]))
    if out_dir:
        os.makedirs(out_dir, exist_ok=True)
    write_lua(cfg["OUTPUT"], blocks, cfg["OUT_W"], cfg["OUT_H"], std_eff,
              cfg["COLOR_BITS"], enc, mae_orig, cfg.get("VAR_NAME", "IMG"),
              with_return=args.with_return or bool(cfg.get("WITH_RETURN", False)),
              layered=layered, shapes=shapes)
    print("  已写出    : %s （%.1f KB）"
          % (cfg["OUTPUT"], os.path.getsize(cfg["OUTPUT"]) / 1024))

    if cfg.get("PREVIEW"):
        prev = os.path.splitext(cfg["OUTPUT"])[0] + "_preview.png"
        Image.fromarray(reconstruct(blocks, cfg["OUT_W"], cfg["OUT_H"]).astype(np.uint8)).save(prev)
        print("  重建预览  : %s" % prev)

    print("=" * 78)
    return 0 if (geo_ok and order_ok) else 2


if __name__ == "__main__":
    sys.exit(main())


