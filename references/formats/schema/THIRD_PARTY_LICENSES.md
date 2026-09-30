# 第三方来源与许可证

`references/formats/` 下的 schema（`*.proto`）与数据表（`data/*.json`）有一部分**改编自社区的 MIT 许可项目**。
MIT 许可要求在副本或重要部分中保留版权与许可声明——本文件就是这份声明。

改编内容一律先用 50 个官方教程示例存档（`references/samples/`，由 `scripts/fetch-official-samples.mjs` 抓取）
逐项核对才采用；核对不通过或没有样本可核对的，标为【第三方】或【未确认】，不升格。

## 1. Wu-Yijun/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack

- 仓库：https://github.com/Wu-Yijun/Genshin-Impact-Miliastra-Wonderland-Code-Node-Editor-Pack
- 固定的 commit：`a6365abba2`（2026-01-07）
- 改编内容：
  - `schema/gia.proto` ← 该仓库 `utils/protobuf/gia.proto`（`@version: 2.0.9b`）。改动见该文件头部的「改动清单」。
  - `data/nodes.json` / `data/enums.json` / `data/types.json` ← 该仓库 `utils/node_data/data.json`
    （`Version 2.1.0`，`GameVersion 6.2.0`，作者标注 Aluria）。只抽取节点名、ID、引脚，做过压缩，并与官方样本交叉核对。
- 其节点 ID 是作者用「导入游戏再导出」的碰撞法实测得到的（见其 `docs/utils/原神导入 GIA 文件的规则说明.md`）。

```
Copyright 2025-2026 Wu-Yijun

Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated documentation files (the “Software”), to deal in the Software without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED “AS IS”, WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
```

## 2. script-1024/genshin-miliastra-file-format

- 仓库：https://github.com/script-1024/genshin-miliastra-file-format
- 固定的 commit：`48ffc9c79c`（2025-12-12）
- 参考内容（文字描述与命名，用于对照与出处标注；未整段复制其文档）：
  - 文件容器布局（`docs/zh/概述.md`）、`.gil` 顶层字段名（`docs/zh/内容负载/GIL.md`）、
    `.gia` 顶层结构（`docs/zh/内容负载/GIA.md`）；
  - `schema/gil.proto` 中界面控件（`UiNode` 等）的字段命名参考其 `proto/types/ui_control_group.proto`。

```
MIT License

Copyright (c) 2025 script-1024

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

## 3. 关于这些第三方项目本身

它们是粉丝自制的非官方项目，与米哈游 / HoYoverse 无关。本技能不依赖它们的代码运行，
只把它们的逆向成果当作待核对的线索使用。原始副本存放在 `references/community/`（不属于技能分发内容，
可用 `scripts/fetch-community-refs.mjs` 重新抓取，manifest 里记录了 commit 与 sha256）。
