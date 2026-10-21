# -*- coding: utf-8 -*-
"""小图对拍：Python 覆盖率模型 vs preview.mjs（shapes-core 的真实实现）。"""
import os
import subprocess
import sys
import tempfile

import numpy as np
from PIL import Image

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import compress  # noqa: E402
import covmodel as CM  # noqa: E402

W = H = 64
rects = [(0, 0, W, H, (0x30 << 16) | (0x30 << 8) | 0x30)]


def q(cx, cy, hw, hh, deg, aq, r, g, b):
    return (2, int(round(cx * 4)), int(round(cy * 4)), int(round(hw * 4)), int(round(hh * 4)),
            int(round(deg * 2)) % 360, aq, r, g, b)


shapes = [
    q(20, 20, 10, 3, 30, 32, 220, 40, 40),
    q(40, 25, 12, 4, 45, 32, 40, 200, 60),
    q(30, 45, 9, 2.5, 62, 32, 60, 60, 220),
    q(48, 48, 8, 5, 15, 32, 240, 220, 30),
    q(15, 45, 6, 6, 75, 16, 255, 255, 255),
]

compress.write_lua(os.path.join(tempfile.gettempdir(), 'snap_mt.lua'), rects, W, H, 1.0, 8, 'p64', 0.0,
                   layered=True, shapes=shapes)
subprocess.run(['node', os.path.join(HERE, 'preview.mjs'),
                os.path.join(tempfile.gettempdir(), 'snap_mt.lua'), os.path.join(tempfile.gettempdir(), 'snap_mt.png'), '--scale', '1'], check=True)
ref = np.asarray(Image.open(os.path.join(tempfile.gettempdir(), 'snap_mt.png')).convert('RGB'), np.float64)

mine = CM.to_u8(CM.render(W, H, rects, shapes))
d = np.abs(ref.reshape(-1, 3) - mine.astype(np.float64))
print('像素数', d.size, '最大差', d.max(), '差异像素', int((d > 0).any(1).sum()), '平均差 %.4f' % d.mean())
if d.max() > 0:
    for i in np.nonzero((d > 0).any(1))[0][:10]:
        print('  idx %d ref=%s mine=%s' % (i, ref.reshape(-1, 3)[i].astype(int), mine[i].astype(int)))
