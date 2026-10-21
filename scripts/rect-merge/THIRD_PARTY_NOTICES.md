# 第三方声明（rect-merge）

## gia-skeleton.json

`gia-skeleton.json` 派生自 GitHub 项目
[1475505/Miliastra-toolbox-primitive-shape](https://github.com/1475505/Miliastra-toolbox-primitive-shape)
（commit `0526509e73d36b359d3c9bee1104718e4a600ed0`）的 `gia/image_template.gia`：去掉子节点与引用后的根资产，加上第一个图片控件作原型。
该项目以 MIT 许可证发布，许可证全文如下（按许可证要求随副本保留）：

```
MIT License

Copyright (c) 2026 LiuL

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## 原作《最大对齐矩形合并压缩 V1.0》

作者：福州大学千星奇域游戏创作社群 吴玮航（2026-10-05）。**原作没有附许可证**，本目录里没有它的代码：
`compress.py` / `blockcodec.py` / `estimate.py` / `render.lua` 在 2026-10-17 按「两端约定的接口事实」独立重写
（数据串的布局、p64 的位宽、`IMG.*` / `RENDER.*` 字段名、命令行参数名），并用输出逐字节对拍验证等价，见 README.md。
原作 README 里的实测数字在 playbook 中标注为【第三方】，只引用事实与数字，不搬原文。
