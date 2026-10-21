#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 estimate.py —— 控件数与 MAE 估算器（只算，不写文件）
================================================================================

【用途】
  给定图片 + STD + 分辨率，先算清楚"要用多少控件、画质到什么程度"，
  不产出任何 lua 文件。正式压缩之前拿它试参数。

  ★ 它直接用 compress.py 里的同一套切块函数，所以**块数与 MAE 是精确值**，
    跟 compress.py 真正跑出来的结果一致，不是估算曲线。


【配置】
  STD            合并容差，0 ~ 1024（0 = 只合并同色相邻像素，无损）
  OUT_W/OUT_H    输出分辨率
  LOCK_ASPECT    是否锁定长宽比
  COLOR_BITS     每通道位数，8 = 24 位真彩
  INPUT          输入图片
  SAFE_LIMIT     控件数安全上限（判定列用；实测 50,000 正常、61,440 崩溃）
  MS_PER_CONTROL 每个控件的建立耗时（实测 0.223 ms）


【命令行】
  python estimate.py --input a.png --size 300x300 --std 3
  python estimate.py --input a.png --size 300x300 --scan-std 1,2,3,4,6,8
  python estimate.py --input a.png --scan-size 200,300,400 --std 3
  python estimate.py --input a.png --size 300x300 --std 3 --preview    # 另存预览图
  python estimate.py --config config.json


【输出表的列】
  分辨率 | STD | 块数 | 压缩率 | MAE | 最大误差 | 平均块面积 | 预估建立耗时 | 判定

  MAE = 合并之后每像素每通道的平均绝对色差（0~255）
        经验：0 = 无损；≤1.5 一般人看不出；≥3.5 明显


【依赖】pip install pillow numpy
================================================================================
"""

import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
if _HERE not in sys.path:
    sys.path.insert(0, _HERE)

try:
    import numpy as np
    from PIL import Image
except ImportError:
    print("缺少依赖：pip install pillow numpy", file=sys.stderr)
    raise

from compress import (load_and_prepare, quantize, pack_rects, pack_layered,   # noqa: E402
                      validate_blocks, edge_importance, load_focus, mae_split,
                      EDGE_I_MIN, EDGE_I_MAX)
from blockcodec import compute_mae, check_scan_order, sizes as codec_sizes, reconstruct  # noqa: E402


# ==============================================================================
# 【配置区】
# ==============================================================================
CONFIG = {
    "STD": 3,                  # 合并容差，0 ~ 1024
    "OUT_W": 300,
    "OUT_H": 300,
    "LOCK_ASPECT": False,
    "COLOR_BITS": 8,
    "INPUT": "input.png",
    "SAFE_LIMIT": 45000,       # 控件数安全上限（50,000 实测正常，61,440 崩溃）
    "MS_PER_CONTROL": 0.223,   # 实测：每个控件的建立耗时（毫秒）
    "SHOW_GEOMETRY_CHECK": False,   # 是否顺带做几何 / 扫描顺序自检
    "PREVIEW": False,               # 是否为每一档另存重建预览图
    "PREVIEW_PATH": "estimate_preview",   # 预览图文件名前缀
    "EDGE_AWARE": False,            # 边缘优先的误差预算
    "EDGE_BOOST": 1.6,
    "SMOOTH_SLACK": 0.42,
    "EDGE_CAP": 2.2,
    "EDGE_REF": 95.0,
    "EDGE_FLOOR": 24.0,
    "EDGE_SPLIT": False,            # 是否另报「边缘带 MAE / 其余 MAE」
    "FOCUS": None,                  # 视觉焦点文件（AI / 人工标注）
    "FOCUS_GAIN": 0.8,
}
# ==============================================================================

STD_MIN, STD_MAX = 0.0, 1024.0

ROW_FMT = "%-11s %7s %8d %8.2fx %7.2f %7d %9.1f %12.1f %10s"
HEADER = ("%-11s %7s %8s %9s %7s %7s %9s %12s %10s"
          % ("分辨率", "STD", "块数", "压缩率", "MAE", "最大误差",
             "平均块面积", "预估建立耗时", "判定"))


def verdict(n: int, safe_limit: int) -> str:
    """按控件数给一个直观判定。"""
    if n <= safe_limit:
        return "✓ 安全"
    if n <= 55000:
        return "⚠ 接近上限"
    return "✗ 超限"


def fmt_row(w, h, std, n, mae, maxerr, avg, safe_limit, ms_per):
    return ROW_FMT % ("%dx%d" % (w, h), std, n, (w * h) / max(1, n), mae, maxerr,
                      avg, n * ms_per / 1000.0, verdict(n, safe_limit))


def build_parser() -> argparse.ArgumentParser:
    ap = argparse.ArgumentParser(
        description="控件数与 MAE 估算器（与 compress.py 同一套切块算法，只算不写文件）",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="示例:\n"
               "  python estimate.py --input a.png --size 300x300 --std 3\n"
               "  python estimate.py --input a.png --size 300x300 --scan-std 1,2,3,4,6,8\n"
               "  python estimate.py --input a.png --scan-size 200,300,400 --std 3\n")
    ap.add_argument("--input", help="输入图片路径")
    ap.add_argument("--size", help="输出分辨率，形如 300x300")
    ap.add_argument("--std", type=float, help="合并容差，0~1024 任意值")
    ap.add_argument("--scan-std", help="扫描多个 STD，逗号分隔，如 1,2,3,4,6,8,12")
    ap.add_argument("--scan-size", help="扫描多个分辨率（正方形边长），如 200,300,400")
    ap.add_argument("--lock-aspect", action="store_true", help="锁定长宽比")
    ap.add_argument("--bits", type=int, help="每通道位数（8 = 24 位真彩）")
    ap.add_argument("--safe-limit", type=int, help="控件数安全上限")
    ap.add_argument("--geometry-check", action="store_true", help="顺带检查几何与扫描顺序")
    ap.add_argument("--preview", action="store_true", help="为每一档另存重建预览图")
    ap.add_argument("--layered", action="store_true", help="估算分层重长（允许重叠）的控件数；需要 Node")
    ap.add_argument("--edge-aware", action="store_true",
                    help="边缘优先的误差预算（边缘收紧、平坦·缓变放宽）；纯矩形与 --layered 都支持")
    ap.add_argument("--edge-boost", type=float, default=None, help="明显色差处容差收紧倍率（默认 1.8）")
    ap.add_argument("--edge-cap", type=float, default=None, help="精细区域权重上限（默认 2.2）")
    ap.add_argument("--smooth-slack", type=float, default=None, help="色差不大处容差放宽倍率（默认 0.5）")
    ap.add_argument("--edge-ref", type=float, default=None, help="梯度归一化高分位（默认 95）")
    ap.add_argument("--edge-floor", type=float, default=None, help="梯度归一化绝对下限（默认 24）")
    ap.add_argument("--focus", metavar="FILE", help="视觉焦点文件（JSON 或热图 PNG）")
    ap.add_argument("--focus-gain", type=float, default=None, help="焦点重要度抬升量（默认 0.8）")
    ap.add_argument("--edge-split", action="store_true",
                    help="额外报「边缘带 MAE / 其余 MAE」，用来看预算是不是挪对了位置")
    ap.add_argument("--config", help="JSON 配置文件")
    return ap


def main():
    args = build_parser().parse_args()

    cfg = dict(CONFIG)
    if args.config:
        with open(args.config, encoding="utf-8") as f:
            cfg.update(json.load(f))
    if args.input: cfg["INPUT"] = args.input
    if args.size:
        w, h = args.size.lower().split("x")
        cfg["OUT_W"], cfg["OUT_H"] = int(w), int(h)
    if args.std is not None: cfg["STD"] = args.std
    if args.lock_aspect: cfg["LOCK_ASPECT"] = True
    if args.bits is not None: cfg["COLOR_BITS"] = args.bits
    if args.safe_limit is not None: cfg["SAFE_LIMIT"] = args.safe_limit
    if args.geometry_check: cfg["SHOW_GEOMETRY_CHECK"] = True
    if args.preview: cfg["PREVIEW"] = True
    if args.edge_aware: cfg["EDGE_AWARE"] = True
    if args.edge_boost is not None: cfg["EDGE_BOOST"] = args.edge_boost
    if args.edge_cap is not None: cfg["EDGE_CAP"] = args.edge_cap
    if args.smooth_slack is not None: cfg["SMOOTH_SLACK"] = args.smooth_slack
    if args.edge_ref is not None: cfg["EDGE_REF"] = args.edge_ref
    if args.edge_floor is not None: cfg["EDGE_FLOOR"] = args.edge_floor
    if args.focus: cfg["FOCUS"] = args.focus
    if args.focus_gain is not None: cfg["FOCUS_GAIN"] = args.focus_gain
    if args.edge_split: cfg["EDGE_SPLIT"] = True

    edge_aware = bool(cfg.get("EDGE_AWARE", False))
    if edge_aware or cfg.get("FOCUS"):
        print("视觉预算：边缘 %s（boost %.2f / slack %.2f）　焦点 %s（gain %.2f）"
              % ("开" if edge_aware else "关", cfg["EDGE_BOOST"], cfg["SMOOTH_SLACK"],
                 cfg.get("FOCUS") or "无", cfg["FOCUS_GAIN"]))
        print()

    if not os.path.exists(cfg["INPUT"]):
        print("找不到输入图片：%s" % cfg["INPUT"], file=sys.stderr)
        return 1

    if args.scan_size:
        size_list = [(int(s), int(s)) for s in args.scan_size.split(",")]
    else:
        size_list = [(cfg["OUT_W"], cfg["OUT_H"])]

    if args.scan_std:
        std_list = [float(s) if "." in s else int(s) for s in args.scan_std.split(",")]
    else:
        std_list = [cfg["STD"]]

    for st in std_list:
        if st < STD_MIN or st > STD_MAX:
            print("错误：STD 必须在 %s ~ %s 之间（收到 %s）" % (STD_MIN, STD_MAX, st),
                  file=sys.stderr)
            return 1

    print("=" * 108)
    print("控件数与 MAE 估算（复用 compress.py 的算法，结果为精确值）")
    print("=" * 108)
    print("  输入图片 : %s" % cfg["INPUT"])
    print("  锁定比例 : %s" % cfg["LOCK_ASPECT"])
    print("  颜色位数 : %d" % cfg["COLOR_BITS"])
    print("  安全上限 : %d 控件（实测 50,000 正常、61,440 崩溃）" % cfg["SAFE_LIMIT"])
    print("  建立耗时按 %.3f ms/控件 估算（实测）" % cfg["MS_PER_CONTROL"])
    print()
    print(HEADER)
    print("-" * 108)

    for (w, h) in size_list:
        arr_full = load_and_prepare(cfg["INPUT"], w, h, cfg["LOCK_ASPECT"])
        q = quantize(arr_full, cfg["COLOR_BITS"])
        base = (edge_importance(q, cfg["EDGE_BOOST"], cfg["SMOOTH_SLACK"],
                                cfg["EDGE_REF"], cfg["EDGE_FLOOR"], cap=cfg.get("EDGE_CAP", 2.2))
                if edge_aware else None)
        if cfg.get("FOCUS"):
            F = load_focus(cfg["FOCUS"], w, h)
            if base is None:
                base = np.ones((h, w), dtype=np.float64)
            base = np.clip(base + float(cfg["FOCUS_GAIN"]) * F, EDGE_I_MIN,
                           min(EDGE_I_MAX, float(cfg.get("EDGE_CAP", 2.2))))
        imp = base
        weights = imp if (imp is not None and not bool(np.all(imp == 1.0))) else None
        for std in std_list:
            t0 = time.time()
            blocks = (pack_layered(q, std, weights)[0] if args.layered
                      else pack_rects(q, std, importance=weights))
            n = len(blocks)
            avg = (w * h) / max(1, n)
            mae, maxerr = compute_mae(arr_full, blocks, w, h)
            line = fmt_row(w, h, std, n, mae, maxerr, avg,
                           cfg["SAFE_LIMIT"], cfg["MS_PER_CONTROL"])

            extra = ""
            if cfg["SHOW_GEOMETRY_CHECK"] and not args.layered:
                # 分层数据允许重叠，所以只对不重叠的数据做"铺满 + 不重叠"检查
                holes, overlap, oob = validate_blocks(blocks, w, h)
                order_bad = check_scan_order(blocks, w)
                extra = "  几何 %s 扫描 %s" % (
                    "✓" if (holes == 0 and overlap == 0 and oob == 0) else
                    "✗ 空%d/重%d/越%d" % (holes, overlap, oob),
                    "✓" if order_bad == 0 else "✗ %d处" % order_bad)

            if args.layered:
                extra += "  p64=%.1f万字符" % (n * 11 / 10000)
            else:
                extra += "  b64=%.1f万字符" % (codec_sizes(blocks)["b64_chars"] / 10000)
            if cfg.get("EDGE_SPLIT") and imp is not None:
                me, ms = mae_split(arr_full, blocks, w, h, imp > 1.2)
                extra += "  高权重MAE=%.2f 其余=%.2f" % (me, ms)

            print(line + extra + "   (%.1fs)" % (time.time() - t0))

            if cfg["PREVIEW"]:
                rec = reconstruct(blocks, w, h)
                pv = "%s_%dx%d_std%s.png" % (cfg["PREVIEW_PATH"], w, h, std)
                Image.fromarray(rec.astype(np.uint8)).save(pv)
                print("      预览图 → %s" % pv)
        print()

    print("说明：")
    print("  · 块数 = 需要的控件数；建立耗时 ≈ 块数 × %.3f ms（实测值）" % cfg["MS_PER_CONTROL"])
    print("  · MAE = 每像素每通道的平均绝对色差（0~255）：")
    print("      0     = 无损（STD=0，只合并同色相邻像素）")
    print("      ≤1.5  = 一般人看不出      ≤3.0 = 轻微")
    print("      ≥3.5  = 明显块状          更大 = 严重失真")
    print("  · 块数据体积：b64 = 7 字符/块，hex = 10 字符/块，p64 = 11 字符/块")
    print("  · 若块数超标：提高 STD，或降低分辨率（降分辨率同时减少块数、观感更干净）")
    print("  · 本估算与 compress.py 的输出严格一致，可以直接据此定参数再跑 compress.py")
    return 0


if __name__ == "__main__":
    sys.exit(main())
