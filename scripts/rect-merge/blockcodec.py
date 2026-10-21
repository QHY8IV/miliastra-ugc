#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
================================================================================
 blockcodec.py —— 图元数据串的编解码（compress.py / estimate.py 共用）
================================================================================

 本文件是独立实现。它遵循的数据布局是"本工具链 ↔ render.lua / to-gil.mjs"
 之间约定的接口事实，代码本身自写。


【矩形块串】

  块坐标 x / y 不进数据串。块在串里按"行主序扫描顺序"排列，读的一侧重放同一套
  游标推进就能把 x / y 还原出来，于是每块只剩 5 个字节 w, h, r, g, b：

    hex   5 字节 → 10 个十六进制字符
    b64   3 字节 (w,h,r) → 4 字符；2 字节 (g,b) → 3 字符；合计 7 字符

  b64 拆成 24 位 + 16 位两组，而不是把 5 字节并成一个 40 位整数。原因很实际：
  Lua 侧的中间值只要超过 32 位就会回绕（实测 807136431*64+24 在 32 位实现下算出
  117124056，而正确答案是 51656731608）。分组之后每一步中间值都小于 2^24，
  任何整数宽度都安全。

  p64   11 个字符/块，字符 = chr(48 + 6 位值)，落在 '0'..'o' 连续区间：

          2 字符  2x+w        块中心的横坐标 ×2
          2 字符  2y+h        块中心的纵坐标 ×2
          3 字符  w*512+h     w、h ≤ 511
          4 字符  RGB

        位置是显式给出的，读的一侧不必推演扫描、不必先存数组再重排；块在 Python
        侧就已按面积从大到小排好，Lua 端读一块建一个控件。
        字符区间里含 ']' 与反斜杠，所以写进 Lua 时用长字符串（见 lua_long_string）。


【形状串】

  shapes.mjs 学出来的椭圆 / 旋转矩形 / 三角形 / 圆环 / 软边矩形，每项定长若干字符：

    v1  14 字符：cxq cyq hwq hhq kt(2)            颜色(4)      ← 历史格式，不再生成
    v2  15 字符：cxq cyq hwq hhq kt(2) aq(1)      颜色(4)
    v3  19 字符：cxq cyq hwq hhq kt(2) aq(1) fxq(2) fyq(2) 颜色(4)

  坐标分量都放大 4 倍（0.25 源像素为单位），kt = (kind - 1) * 512 + thq 把类型与
  角度塞进 12 位，thq 以 0.5° 计，aq = 不透明度 × 32（1～32），
  fxq / fyq = 羽化宽度 × 2（0.5 源像素为单位，0 表示该方向不渐隐）。

================================================================================
"""

B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
B64_VALUE = {ch: i for i, ch in enumerate(B64_ALPHABET)}

HEX_CHARS_PER_BLOCK = 10
B64_CHARS_PER_BLOCK = 7
TABLE_CHARS_PER_BLOCK = 36      # 旧的 Lua 表写法 {x=..,y=..,w=..,h=..,c=..} 的经验值

P64_BASE = 48
P64_BLOCK_CHARS = 11
P64_STRIDE = P64_BLOCK_CHARS    # 旧名，保留以免外部脚本失效
P64_MAX_SIDE = 511

# 每个字符都加了 P64_BASE，所以整组字符还原成数值时要一次性减掉"基数 × 各位权之和"。
# 这三个常数在 render.lua 里是写死的（3120 / 199728 / 12782640），这里用公式算出来，
# 让两边的关系一眼可查。
P64_AXIS_BIAS = P64_BASE * (64 + 1)
P64_WH_BIAS = P64_BASE * (64 * 64 + 64 + 1)
P64_RGB_BIAS = P64_BASE * (64 ** 3 + 64 * 64 + 64 + 1)

SHAPE_CHARS_BY_VERSION = {1: 14, 2: 15, 3: 19}
SHAPE_CHARS_V2 = SHAPE_CHARS_BY_VERSION[2]
SHAPE_CHARS_V3 = SHAPE_CHARS_BY_VERSION[3]
SHP_STRIDE = SHAPE_CHARS_V2          # 旧名
SHP_STRIDE_V3 = SHAPE_CHARS_V3       # 旧名
SHP_STRIDE_BY_VER = SHAPE_CHARS_BY_VERSION

SHAPE_KINDS = (1, 2, 3, 4, 5)        # 椭圆 / 旋转矩形 / 三角形 / 圆环 / 软边矩形
SOFT_EDGE_KIND = 5                   # 只有它需要 fxq / fyq，必须走 v3


# ==============================================================================
# 扫描顺序推演
# ==============================================================================
class ScanReplay:
    """重放"行主序扫描"的游标，把块的 x / y 还原出来。

    occ[c] 记第 c 列已经被占到的最大行号。游标从左往右走，走不过去（该列已被
    当前行或更下面占住）就跳过，走到列尾就换下一行、从头再来。

    数据串里不存 x / y，靠的就是读的一侧能以同样的顺序重放这套游标。
    """

    __slots__ = ("cols", "occ", "ci", "cj")

    def __init__(self, cols):
        self.cols = cols
        self.occ = [-1] * cols
        self.ci = 0
        self.cj = 0

    def take(self, w, h):
        """占下 w×h（左上角放在游标处），返回它的 (x, y)。"""
        cols, occ = self.cols, self.occ
        ci, cj = self.ci, self.cj
        while True:
            while ci < cols and occ[ci] >= cj:
                ci += 1
            if ci < cols:
                break
            cj += 1
            ci = 0
        bottom = cj + h - 1
        stop = ci + w
        if stop > cols:
            stop = cols
        for xx in range(ci, stop):
            if occ[xx] < bottom:
                occ[xx] = bottom
        self.ci, self.cj = ci + w, cj
        return ci, cj


def replay_positions(blocks, cols):
    """按扫描顺序推演每块的 (x, y)，返回长度与 blocks 相同的列表。"""
    scan = ScanReplay(cols)
    return [scan.take(w, h) for (_x, _y, w, h, _c) in blocks]


def check_scan_order(blocks, cols):
    """推演出来的坐标与存储坐标不一致的块数。渲染端靠推演取坐标，这里必须是 0。"""
    bad = 0
    for (x, y, w, h, _c), (dx, dy) in zip(blocks, replay_positions(blocks, cols)):
        if dx != x or dy != y:
            bad += 1
    return bad


# ==============================================================================
# hex / b64
# ==============================================================================
def _chars_of(value, count):
    """把 value 编成 count 个 base64 字符（高位在前）。"""
    return "".join(B64_ALPHABET[(value >> (6 * k)) & 63] for k in range(count - 1, -1, -1))


def pack_hex(blocks):
    """每块 10 个十六进制字符 = w, h, r, g, b。"""
    raw = bytearray()
    for (_x, _y, w, h, col) in blocks:
        raw += bytes((w & 255, h & 255, (col >> 16) & 255, (col >> 8) & 255, col & 255))
    return raw.hex()


def pack_b64(blocks):
    """每块 7 个字符：4 字符给 (w,h,r)，3 字符给 (g,b)。"""
    out = []
    for (_x, _y, w, h, col) in blocks:
        out.append(_chars_of((w << 16) | (h << 8) | ((col >> 16) & 255), 4))
        out.append(_chars_of((((col >> 8) & 255) << 8) | (col & 255), 3))
    return "".join(out)


def pack(blocks, enc="b64"):
    """enc = "p64" | "b64" | "hex"。"""
    if enc == "p64":
        return pack_p64(blocks)
    if enc == "b64":
        return pack_b64(blocks)
    if enc == "hex":
        return pack_hex(blocks)
    raise ValueError("未知编码：%r（可选 p64 / b64 / hex）" % enc)


def sizes(blocks):
    """三种写法的字符数，以及 b64 相对另外两种省多少。"""
    n = max(1, len(blocks))
    hex_chars = n * HEX_CHARS_PER_BLOCK
    b64_chars = n * B64_CHARS_PER_BLOCK
    table_chars = n * TABLE_CHARS_PER_BLOCK
    return {
        "n": len(blocks),
        "hex_chars": hex_chars,
        "b64_chars": b64_chars,
        "table_chars": table_chars,
        "b64_vs_hex": b64_chars / hex_chars,
        "b64_vs_table": b64_chars / table_chars,
    }


def encode_all(blocks):
    """一次给出 hex 与 b64，便于并排比较。"""
    return {"hex": pack_hex(blocks), "b64": pack_b64(blocks)}


# ==============================================================================
# p64
# ==============================================================================
def _p64_chars(value, count):
    return "".join(chr(P64_BASE + ((value >> (6 * k)) & 63)) for k in range(count - 1, -1, -1))


def split_oversize(blocks, max_side=P64_MAX_SIDE):
    """把 w 或 h 超过 max_side 的矩形切成 ≤max_side 的条带（像素完全等价）。

    p64 的块尺寸只有 9 bit（w*512+h），所以单块边长上限 511；目标图 ≥512 px 时
    均色底板、大片纯色块都会越界。切条只增几个控件，绘制结果逐像素不变，
    顺序（分层绘制序）也保持原样。返回 (新块列表, 被拆的块数)。
    """
    out = []
    nsplit = 0
    for b in blocks:
        x, y, w, h, col = b
        if w <= max_side and h <= max_side:
            out.append(b)
            continue
        nsplit += 1
        for yy in range(y, y + h, max_side):
            hh = min(max_side, y + h - yy)
            for xx in range(x, x + w, max_side):
                ww = min(max_side, x + w - xx)
                out.append((xx, yy, ww, hh, col))
    return out, nsplit


def pack_p64(blocks, keep_order=False):
    """输出 p64 串。

    默认按面积从大到小（同面积保持原有先后）；keep_order=True 时原样保持给定顺序
    —— 分层数据的列表顺序就是绘制顺序，先画的在下面，不能被重排。
    """
    if keep_order:
        order = range(len(blocks))
    else:
        order = sorted(range(len(blocks)), key=lambda i: (-(blocks[i][2] * blocks[i][3]), i))
    out = []
    for i in order:
        x, y, w, h, col = blocks[i]
        sx, sy = 2 * x + w, 2 * y + h
        if not (0 < w <= P64_MAX_SIDE and 0 < h <= P64_MAX_SIDE and sx < 4096 and sy < 4096):
            raise ValueError("p64 超出范围：%r（要求 w,h ≤ %d 且 2x+w、2y+h < 4096）"
                             % (blocks[i], P64_MAX_SIDE))
        out.append(_p64_chars(sx, 2) + _p64_chars(sy, 2)
                   + _p64_chars(w * 512 + h, 3) + _p64_chars(col & 0xFFFFFF, 4))
    return "".join(out)


def unpack_p64(data):
    """p64 串 → [(x, y, w, h, col), ...]，顺序即串里的顺序。"""
    out = []
    for start in range(0, len(data), P64_BLOCK_CHARS):
        c = [ord(ch) for ch in data[start:start + P64_BLOCK_CHARS]]
        sx = c[0] * 64 + c[1] - P64_AXIS_BIAS
        sy = c[2] * 64 + c[3] - P64_AXIS_BIAS
        wh = (c[4] * 64 + c[5]) * 64 + c[6] - P64_WH_BIAS
        col = ((c[7] * 64 + c[8]) * 64 + c[9]) * 64 + c[10] - P64_RGB_BIAS
        w, h = wh // 512, wh % 512
        out.append(((sx - w) // 2, (sy - h) // 2, w, h, col))
    return out


# ==============================================================================
# 自检：重建与 MAE
# ==============================================================================
def reconstruct(blocks, W, H):
    """把块列表画回一张 (H, W, 3) 的 int16 图。后画的盖住先画的。"""
    import numpy as np
    canvas = np.zeros((H, W, 3), dtype=np.int16)
    for (x, y, w, h, col) in blocks:
        canvas[y:y + h, x:x + w] = ((col >> 16) & 255, (col >> 8) & 255, col & 255)
    return canvas


def compute_mae(orig, blocks, W, H):
    """与原图相比的平均绝对误差（每像素每通道，0～255）与最大单点误差。"""
    import numpy as np
    diff = np.abs(orig.astype(np.int32) - reconstruct(blocks, W, H).astype(np.int32))
    return float(diff.mean()), int(diff.max())


# ==============================================================================
# 形状串
# ==============================================================================
def _shape_chars(version):
    chars = SHAPE_CHARS_BY_VERSION.get(int(version))
    if chars is None:
        raise ValueError("不认识的形状串版本 SHPV=%r（支持 1 / 2 / 3）" % (version,))
    return chars


def _split_tuple(item, version):
    """把 shapes.mjs 给的元组拆成字段。

    shapes.mjs 是**按形状逐个**决定元组长度的：软边 12 项（多 fxq / fyq），其余 10 项。
    所以同一次输出里两种长度会混在一起 —— 10 项的补 fxq = fyq = 0。
    """
    if len(item) == 12:
        if version < 3:
            raise ValueError("带羽化宽度的 12 项形状必须用 SHPV = 3（当前 SHPV = %d）：%r"
                             % (version, item))
        kind, cxq, cyq, hwq, hhq, thq, aq, fxq, fyq, r, g, b = item
        return kind, cxq, cyq, hwq, hhq, thq, aq, fxq, fyq, r, g, b
    if len(item) == 10:
        kind, cxq, cyq, hwq, hhq, thq, aq, r, g, b = item
        return kind, cxq, cyq, hwq, hhq, thq, aq, 0, 0, r, g, b
    raise ValueError("形状元组应该是 10 项或 12 项，实际 %d 项：%r" % (len(item), item))


def pack_shapes(shapes, version=2):
    """形状列表 → p64 串（顺序即绘制顺序）。

    version 2 写 15 字符/个，version 3 写 19 字符/个（软边要 fxq / fyq）。
    v1 没有不透明度字段，是历史格式，不再生成。
    """
    if version < 2:
        raise ValueError("pack_shapes 只写 v2 / v3（v1 是历史格式、没有不透明度字段，不再生成）")
    chars = _shape_chars(version)
    wide = version >= 3
    out = []
    for item in shapes:
        kind, cxq, cyq, hwq, hhq, thq, aq, fxq, fyq, r, g, b = _split_tuple(item, version)
        if kind not in SHAPE_KINDS:
            raise ValueError("形状类型 kind 只能是 %s，收到 %r" % (list(SHAPE_KINDS), kind))
        if not (0 <= cxq < 4096 and 0 <= cyq < 4096
                and 0 < hwq < 4096 and 0 < hhq < 4096
                and 0 <= thq < 360 and 1 <= aq <= 32):
            raise ValueError("形状数据超出范围：%r" % ((kind, cxq, cyq, hwq, hhq, thq, aq),))
        if kind == SOFT_EDGE_KIND and not wide:
            raise ValueError("软边形状（kind %d）要写 fxq / fyq 两个字段，必须用 SHPV = 3：%r"
                             % (SOFT_EDGE_KIND, (kind, cxq, cyq, hwq, hhq, thq, aq)))
        if wide and not (0 <= fxq <= 255 and 0 <= fyq <= 255):
            raise ValueError("羽化宽度超出范围（fxq / fyq 取 0～255，即 0～127.5 源像素）：%r"
                             % ((fxq, fyq),))
        text = (_p64_chars(cxq, 2) + _p64_chars(cyq, 2)
                + _p64_chars(hwq, 2) + _p64_chars(hhq, 2)
                + _p64_chars((kind - 1) * 512 + thq, 2) + _p64_chars(aq, 1)
                + (_p64_chars(fxq, 2) + _p64_chars(fyq, 2) if wide else "")
                + _p64_chars((r << 16) | (g << 8) | b, 4))
        if len(text) != chars:
            raise AssertionError("内部错误：编出 %d 个字符，SHPV=%d 应该是 %d"
                                 % (len(text), version, chars))
        out.append(text)
    return "".join(out)


def unpack_shapes(data, version=2):
    """形状串 → 与 shapes.mjs 输出同形的元组。

    v1 给 9 项（没有不透明度），v2 给 10 项，v3 给 12 项（多 fxq / fyq）。
    """
    chars = _shape_chars(version)
    out = []
    for start in range(0, len(data), chars):
        c = [ord(ch) - P64_BASE for ch in data[start:start + chars]]
        pair = lambda i: c[i] * 64 + c[i + 1]      # noqa: E731
        kt = pair(8)
        if version >= 3:
            col = ((c[15] * 64 + c[16]) * 64 + c[17]) * 64 + c[18]
            out.append((kt // 512 + 1, pair(0), pair(2), pair(4), pair(6), kt % 512,
                        c[10], pair(11), pair(13),
                        (col >> 16) & 255, (col >> 8) & 255, col & 255))
        elif version >= 2:
            col = ((c[11] * 64 + c[12]) * 64 + c[13]) * 64 + c[14]
            out.append((kt // 512 + 1, pair(0), pair(2), pair(4), pair(6), kt % 512,
                        c[10], (col >> 16) & 255, (col >> 8) & 255, col & 255))
        else:
            col = ((c[10] * 64 + c[11]) * 64 + c[12]) * 64 + c[13]
            out.append((kt // 512 + 1, pair(0), pair(2), pair(4), pair(6), kt % 512,
                        (col >> 16) & 255, (col >> 8) & 255, col & 255))
    return out


# ==============================================================================
# Lua 长字符串
# ==============================================================================
def lua_long_string(data):
    """把 data 包成 Lua 长字符串。

    等号个数取能满足下面条件的最小值：拼起来之后，结束符的**第一次**出现必须正好
    落在 data 之后。

    只判断"结束符不在 data 里出现"是不够的 —— 它还会骑在交界处：data 末位是 ']'
    时，紧跟的 `]]` 会被 Lua 看成提前出现的结束符，内容被截短、后面多出一个孤立的
    ']'（实测 data = "]==]" 就是这样）。p64 的字符落在 '0'..'o'，其中就有 ']' 和
    反斜杠，所以这一层必须做对。
    """
    level = 0
    while True:
        closer = "]" + "=" * level + "]"
        if (data + closer).find(closer) == len(data):
            return "[" + "=" * level + "[" + data + closer
        level += 1
