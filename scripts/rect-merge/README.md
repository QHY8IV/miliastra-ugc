# scripts/rect-merge —— 最大对齐矩形合并：图片 → 纯色矩形 → Lua 绘制

作业说明见 [`references/rect-merge-playbook.md`](../../references/rect-merge-playbook.md)。本文件只记来源、许可与文件清单。

## 来源与许可

- 原作：《最大对齐矩形合并压缩 V1.0》，福州大学千星奇域游戏创作社群 吴玮航，2026-10-05。
  本机原件：`（作者本机路径，未随技能分发）`（未改动）。
  **原作没有附许可证**，所以它本身没有、也不会随本技能公开。
- 2026-10-15 起本目录是原作的加速版。**2026-10-17 把整条压缩管线换成独立实现**：
  `compress.py` / `blockcodec.py` / `estimate.py` / `render.lua` 的代码为自写，
  只保留"两端约定的接口事实"这一类内容 ——
  x、y 不进数据串（读的一侧重放行主序扫描游标还原）、p64 的 11 字符/块与字符基数 48、
  三种编码的位宽拆分、`IMG.*` 字段名与含义、命令行参数名、`RENDER.*` 配置键。
  这些是 render.lua / to-gil.mjs 与 Python 端之间的约定，不是可替换的实现细节。
- 原作的 `pack_modes.py`、`assemble_modes.py`、`render_modes.lua` 是**逐字节副本**，
  已移出技能：`（作者本机路径，未随技能分发）`，
  只在本机可用。多档比较改用下面的替代做法（见 README 末尾）。
- `gia-skeleton.json` 派生自 [1475505/Miliastra-toolbox-primitive-shape](https://github.com/1475505/Miliastra-toolbox-primitive-shape)@0526509e73 的 `gia/image_template.gia`，MIT License，Copyright (c) 2026 LiuL。

## 换实现怎么验的（2026-10-17）

| 对象 | 办法 | 结果 |
|---|---|---|
| `blockcodec.py` | `diff_blockcodec.py`：新旧两份逐函数对拍（块编码 / p64 往返 / 形状串 v2·v3 / 长字符串 / 拒错 / 常量） | 全部一致 |
| `compress.py` | `diff_compress.py`：同一输入同一参数，新旧产出的 `.lua` **逐字节**比对（15 组：三种编码、STD=0 无损、量化、锁比例、非正方形、纯色大图切 255/511、layered、超范围报错） | 15/15 一致 |
| `estimate.py` | `diff_estimate.py`：10 组参数的**数值表**逐行比对（去掉耗时列） | 10/10 一致 |
| `render.lua` | `check_render_arith.py`：解码与几何换算的语句级算术核对（数字与运算符多重集）；`sim-lua.mjs lint` 三种编码 | 算术一致；lint 0 问题 |
| 整条链路 | `node scripts/rect-merge/check.mjs --selftest` | 全部通过 |

对拍脚本与黄金样本留在 `（作者本机路径，未随技能分发）`，基线快照 `（作者本机路径，未随技能分发）`。

> **`render.lua` 的运行时等价还没验过。** 离线模拟器给不了引擎内置图片控件的模板
> （`InstantiateClientUIControl` 按存档 GUID 找模板，实测关卡 `.gil` 里的控件 GUID 不在
> `TEMPLATE_SCAN` 区间内），所以建立路径在模拟器里跑不到底。已做的是 lint + 解码算术核对；
> 真正的运行时验证要靠真机导入。

## 文件清单

| 文件 | 说明 |
|---|---|
| `compress.py` | 图片 → 块数据 `.lua`。切矩形：积分图 O(1) 求矩形的均值/标准差，铺满式划分；块宽高受编码上限约束（b64/hex ≤ 255，p64 ≤ 511）。默认 `p64`。`--edge-aware` 走"边缘优先预算"：逐像素重要度 `I`（亮度梯度归一化）把判据换成加权标准差 `ΣI²(c−μ)²/n ≤ STD`，边缘收紧、平坦放宽；**三条路径（纯矩形 / 分层 / 形状）用同一条加权判据**，`I≡1` 时逐字节退化为老路径。`--focus FILE` 把 AI / 人工标出的视觉焦点（JSON 的 boxes / points / heatmap，或直接一张热图 PNG）叠加到同一张重要度图上：`I_eff = clip(I_edge + gain·F)` |
| `blockcodec.py` | 编解码与自检：hex / b64 / p64 三种块串、形状串 v2·v3、扫描顺序推演、Lua 长字符串 |
| `estimate.py` | 只算控件数与 MAE，不写文件（与 compress.py 同一套切块函数，结果是精确值）。`--edge-aware` / `--focus` 与 compress.py 同义；`--edge-split` 分别报高权重区 / 其余区域的 MAE |
| `plan.mjs` | 容量与建立路线决策：给定块数，算 `.gil` 预建能不能放下（20 MiB）、运行时建的预估耗时（`0.223·N + 3.75e-6·N²` ms）、是否撞 22 s 看门狗、分帧要几帧。`--selftest` 19 项 |
| `render.lua` | 千星奇域渲染器：p64 流式建立（不查表、不做扫描推演、不建中间数组）；大块优先；`FRAME_BUDGET` 分帧；**隐藏分组建立、建完每帧显示一组**（`GROUP_HIDE` / `GROUPS`，依据第三方实测：可见 15~18 µs/控件/帧，隐藏约 1.7 µs）；重建复用控件；建完关闭 `OnUpdate`；可选 `PRESET_TEMPLATE` |
| `layered.mjs` | 分层重长：允许控件重叠，同 MAE 下少用控件（插画 4%～20%，像素画无损 36%～42%）。`compress.py --layered` / `estimate.py --layered` 调用。`--weights` 给出逐像素重要度时，底层铺满与逐层生长都改用加权标准差（`σw` 只统计**露出来**的像素） |
| `shapes.mjs` `shapes-core.mjs` `shapes-refine.mjs` `shapes-tiles.mjs` `shapes-worker.mjs` `preview.mjs` `make-calibration.mjs` | 在分层矩形上加旋转矩形 / 椭圆（可选三角形 / 圆环 / 半透明 / 软边羽化渐变；软边走 SHPV = 3、19 字符）。按覆盖率混合模型做率失真替换 + 精修（颜色、几何、矩形边、修剪），多线程搜索；同 MAE 少约 40% 控件；只支持脚本版 `.gil`。`preview.mjs` 出带形状的预期效果 PNG（纯 Node）。`shapes-core.mjs` 是覆盖率光栅化与搜索，`shapes-refine.mjs` 是像素堆栈与精修（修剪 / 矩形边 / 几何 / 颜色，主线程与工作线程共用），`shapes-tiles.mjs` 是分块并行精修（`--no-parallel-refine` 关闭）；1000 px 的构建从 117 分钟降到约 12 分钟，见 playbook §2.19 |
| `shapes-gpu.mjs` `gpu_search_server.py` `gpu_search_kernels.py` | **GPU 形状搜索（`compress.py --gpu`，实验性）**：把 `searchSeed` 的「打分 + 爬山」搬到 GPU（Triton 内核；`shapes.mjs` 起 Python 子进程，经 stdin / stdout 二进制帧通信，`shapes-gpu.mjs` 是 Node 端客户端，负责状态增量同步与批量搜索）。1000 px 完整构建 706 s → 448 s，形状搜索 414 s → 约 56 s，画质持平；起不来自动退回 CPU 线程池。依赖 PyTorch（CUDA）+ Triton（Windows：`pip install triton-windows`），第一次要编译内核（约 1 分钟）。`check.mjs --selftest --gpu` 带 GPU 自检。详见 playbook §2.19 |
| `spot-fit.mjs` | 「**先铺光斑**」：先用不透明椭圆（kind 1）铺一层低频大色斑打底，再由色块层补残差。光栅化复用 `shapes-core` 的 `coverageInto`（每个半径真跑一次、之后按整数偏移平移复用）。同 MAE 下省控件依图而定：平滑插画 15.8%～29.2%，细节多的插画 5.1%～5.7%。2026-10-20 提速（评估封顶 + 惰性候选表 + 抽样精搜）：1000 px 从 34 分钟到约 1.2 分钟，光斑层 MAE 持平（`--eval-cap` / `--exhaustive` / `--no-lazy` / `--refresh` / `--fine-topk`，见 playbook §2.19） |
| `snap.py` `covmodel.py` `snap-modelcheck.py` | **斜边补条**：在已有的 `.lua` 上，沿「两侧平坦、有明确色差」的斜边补细长旋转矩形（9～13 px 长、1～4 px 深），把矩形拼出来的台阶换成一条直边。是否落地**只看实测 L1**（`covmodel.py` 的覆盖率模型与 `shapes-core` 逐像素对得上，`snap-modelcheck.py` 是这条对拍的回归测试）。三种模式：`trim`（单侧修剪，只求更好）/ `ridge`（骑线上拉直细线）/ `pair`（两侧成对铺成直边，会牺牲 L1）。详见 playbook §2.11 |
| `to-gia.mjs` `gia_crosscheck.py` `blocks.mjs` | 块数据 → 图片素材组 `.gia`。骨架取自 1475505/Miliastra-toolbox-primitive-shape（MIT）；交叉核对脚本调用该项目的 MIT 读取器；`blocks.mjs` 是共用的数据解码 |
| `to-gil.mjs` `verify-gil.mjs` | 块数据编进关卡 `.gil`。默认：新式客户端图片预建、位置尺寸写进存档、颜色由开局 Lua 填；`--static`：老式布局图片，颜色也写进存档、无脚本，一个布局最多 1 万个控件（真机校验）；`--default-layout-only` 每控件省约 40%，大图推荐脚本版加这个（真机 3.1 万块通过）。`verify-gil.mjs` 逐像素核对 |
| `coverage-ref.mjs` | 形状覆盖率的**冻结参考实现**（优化前的原算法），只给 `check.mjs --selftest` 对拍当前的 `coverageInto` 用，不要在流水线里 import |
| `check.mjs` | 离线检查（技能自带 Lua 5.3 解释器 + 引擎替身，逐像素核对），替代原作依赖 fengari 固定路径的 `verify_toolkit.py` / `selftest.py` |

原作的 `README.md`、`AGENT_GUIDE.md` 没有搬进来，关键内容已整理进作业说明并标注【第三方】。

## 快速用法

```bash
python scripts/rect-merge/estimate.py --input 图.png --size 300x300 --scan-std 0,1,2,3,4,6,8
python scripts/rect-merge/compress.py --input 图.png --output out.lua --std 3 --size 300x300
node scripts/rect-merge/check.mjs render scripts/rect-merge/render.lua out.lua
node scripts/rect-merge/check.mjs --selftest
node scripts/rect-merge/plan.mjs --selftest
node scripts/rect-merge/plan.mjs --blocks 40000                               # 该走 .gil 还是运行时、要不要分帧
python scripts/rect-merge/compress.py --input 图.png --output edge.lua --std 3 --size 300x300 --edge-aware   # 边缘优先预算（锯齿优先）
python scripts/rect-merge/compress.py --input 图.png --output focus.lua --std 3 --size 300x300 --focus 焦点.json   # 视觉焦点优先（主体 / 脸 / 文字）
python scripts/rect-merge/compress.py --input 图.png --output rot.lua --std 3 --size 300x300 --shapes --shape-prefer-rotation 8   # 旋转图形优先（斜边台阶；--preset best 已默认 =8）
python scripts/rect-merge/compress.py --input 图.png --output out.lua --std 3 --size 300x300 --layered   # 分层重长
python scripts/rect-merge/compress.py --input 图.png --output out.lua --std 3.6 --size 500x500 --preset best   # ★推荐（36 号关卡真机通过）：先铺 150 个光斑 + 椭圆 / 旋转矩形 / 三角形 / 圆环 + 半透明，强度 0.6（500×500 约 18 分钟，约 4 万控件；控件数由 --std 与 --shape-strength 调，要 ≤ 4.0 万）
python scripts/rect-merge/compress.py --input 图.png --output out1000.lua --std 8.4 --size 1000x1000 --preset best --shape-strength 0.6 --shape-passes 4   # ★现在的推荐（加 --gpu 可把构建从约 12 分钟缩到约 7.5 分钟，见 playbook §2.19）：画布 1000 + 用满预算 + 多搜一遍（74 号真机通过，39,380 控件；约 20 分钟；强度 0.9 / 3 遍 = 63 号，28k 控件、约 12 分钟；换图要把强度标定到 ≤ 4.08 万控件；.gil 用 to-gil.mjs --unit 1，verify-gil.mjs 同样传 --unit 1）
python scripts/rect-merge/compress.py --input 图.png --output out800.lua --std 6.72 --size 800x800 --preset best --shape-strength 0.9   # 画布密度 800（64 号真机通过；提速前约 60 分钟，提速后没单独计时；--unit 1.25；见 playbook §2.18）
python scripts/rect-merge/compress.py --input 图.png --output out.lua --std 6 --size 360x203 --spotted      # 只先铺光斑（默认 150 个，隐含 --shapes）
node scripts/rect-merge/spot-fit.mjs --selftest        # 光斑光栅化等价性自检
python scripts/rect-merge/snap-modelcheck.py           # 补条的覆盖率模型与 preview.mjs 逐像素对拍（要求最大差 0）
python scripts/rect-merge/snap.py 基底.lua 输出.lua --img 图.png --render 当前渲染.png --mode trim --max-strips 1200   # 斜边补条（只落在实测变好的位置）
```

依赖：Python 3 + Pillow + numpy（压缩端）；Node ≥ 22（检查端，零第三方依赖）。**可选**：`--gpu` 需要 PyTorch（CUDA 版）+ Triton（Windows：`pip install triton-windows`，Linux：`pip install triton`），没有就自动用 CPU。

## 多档比较（原来的 `pack_modes.py` 那条路已移出）

要在关卡里按 P 键切档对比的那个做法依赖原作的三个副本，已随原件移出技能。替代做法：

```bash
# 离线选档：一次扫多档 STD 或分辨率，直接看数值表
python scripts/rect-merge/estimate.py --input 图.png --scan-size 200,300,400 --scan-std 1,3,6
# 要进关卡看：每档各跑一次 compress.py，比较时把 render.lua 的数据区整段换掉
python scripts/rect-merge/compress.py --input 图.png --output a.lua --std 1 --size 300x300
python scripts/rect-merge/compress.py --input 图.png --output b.lua --std 6 --size 300x300
```

失去的是"进关卡后不用重导就能切档"；离线选参数、以及真机上逐份导入对比都还在。
