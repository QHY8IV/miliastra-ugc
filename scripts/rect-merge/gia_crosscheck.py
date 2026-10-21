"""用第三方独立实现（1475505/Miliastra-toolbox-primitive-shape 的 MIT 读取器 gia_lua.py）解析 to-gia.mjs 的输出，
逐条核对：控件数、图片 ID、位置、尺寸、轴心、锚点、颜色，以及绘制顺序（读取器按「前景在前」的子控件列表倒序给出，
即先画的在前，应与块数据的顺序一致）。

用法：python gia_crosscheck.py <输出.gia> <期望.json> <gia_lua.py 所在目录>
期望.json：{"unit":2,"margin":0.5,"W":..,"H":..,"blocks":[[x,y,w,h,col],...]}（由 check.mjs 生成）
"""
import json
import sys


def main():
    gia_path, expect_path, reader_dir = sys.argv[1:4]
    sys.path.insert(0, reader_dir)
    import gia_lua  # noqa: E402  第三方 MIT 读取器，只依赖 math / struct
    exp = json.load(open(expect_path, encoding="utf-8"))
    res = gia_lua.parse_material_gia(open(gia_path, "rb").read())
    recs = res["records"]
    unit, margin, W, H = exp["unit"], exp["margin"], exp["W"], exp["H"]
    bad = []
    if len(recs) != len(exp["blocks"]):
        bad.append("控件数 %d ≠ %d" % (len(recs), len(exp["blocks"])))
    for k, (rec, blk) in enumerate(zip(recs, exp["blocks"])):
        x, y, w, h, col = blk
        want = [100001, (x + w / 2 - W / 2) * unit, (H / 2 - (y + h / 2)) * unit, w * unit + 2 * margin, h * unit + 2 * margin,
                0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 1.0, 1.0, 0.0, (col >> 16) & 255, (col >> 8) & 255, col & 255, 255]
        got = rec[:18]
        for i, (a, b) in enumerate(zip(got, want)):
            if (abs(a - b) > 1e-3) if isinstance(b, float) else (a != b):
                bad.append("第 %d 块 字段 %d：%r ≠ %r" % (k, i, a, b))
                break
        if len(bad) > 5:
            break
    print(json.dumps({"records": len(recs), "missing_refs": len(res["missing_refs"]), "ignored_mask": res["ignored_mask"],
                      "bad": bad}, ensure_ascii=False))


if __name__ == "__main__":
    main()
