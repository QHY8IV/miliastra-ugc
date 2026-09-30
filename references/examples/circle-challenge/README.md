# 示例：圆圈挑战（30 秒点圆圈）

一个完整的客户端 Lua 小游戏，同时是「怎么离线试跑、怎么给脚本写场景测试」的范例。**未在真机验证**（见下文「证据」）。

| 文件 | 内容 |
|---|---|
| `main.lua` | 游戏脚本（客户端 Lua，不需要服务端节点图） |
| `tree.txt` | 控件树描述（由 `node scripts/sim-lua.mjs tree <官方 3.21 存档> --dsl` 生成）。名字、层级、类型必须逐字对上 |
| `scenario.mjs` | 整局场景测试：75 项断言（初始化、计分、金圈、位置不出界不压 HUD、弹一下、倒计时、结算防连点、最高分、边界时刻、销毁清理、三种出错降级） |

## 玩法

进关卡后中间有一个圆圈，点它开始。30 秒内尽量多点：每点中一个 +1 分，圆圈随即跳到新位置并且越点越小（最小 56）；每第 5 个是**金圈**，值 3 分；最后 5 秒背景泛红；时间到显示得分与本次运行内的最高分，点中间的圆圈再来一局。

## 控件树（名字必须逐字一致）

```
容器节点  ← 脚本所属（script.object）
├─ 背景            [图片]
├─ 分数文本        [文本]       ← 当 HUD 用：得分 / 剩余时间 / 提示语（脚本会把它加宽、放大字号）
└─ 圆圈容器        [容器]
   ├─ 圆圈图片        [图片]
   └─ 圆圈点击区域    [光标检测区域]   ← 只有它接收点击
```

这棵树就是官方教程 3.21 的教学存档里的那棵（`references/samples/mh47p30a87qo_客户端脚本.gil`），所以用它当底座最省事。

## 离线试跑

```sh
node scripts/sim-lua.mjs smoke references/examples/circle-challenge/main.lua \
     --tree-file references/examples/circle-challenge/tree.txt --seconds 40      # 冒烟：lint + 整局 + 自动点击
node scripts/sim-lua.mjs test references/examples/circle-challenge/main.lua \
     --tree-file references/examples/circle-challenge/tree.txt \
     --scenario references/examples/circle-challenge/scenario.mjs                 # 75 项场景断言
```

两条都应当零 error。`node scripts/check-lua-sim.mjs` 的自检里也会跑这份场景——它一旦与模拟器脱节就会报。

## 做成可导入的 `.gil`

需要官方 3.21 教学存档当底座（不随技能分发，先 `node scripts/fetch-official-samples.mjs` 抓取）：

```sh
node scripts/gi.mjs lua put references/samples/mh47p30a87qo_客户端脚本.gil \
     --file references/examples/circle-challenge/main.lua --name 收集圆圈 -o 圆圈挑战.tmp.gil      # 只替换脚本源码一个字段
node scripts/gi.mjs patch 圆圈挑战.tmp.gil --path level_name --json level-name.json -o 圆圈挑战.gil   # 改关卡名（可选）
node scripts/gi.mjs verify 圆圈挑战.gil --lua                                                        # 存档检查 + 脚本检查
node scripts/sim-lua.mjs smoke --gil 圆圈挑战.gil                                                    # 离线跑存档里嵌着的脚本
```

`level-name.json` 是一个只含一行 JSON 字符串（带引号）的文件：`"圆圈挑战"`。不改关卡名就跳过 `patch` 那一步（把第一步的 `-o` 直接写成 `圆圈挑战.gil`）。

这样得到的文件与原 3.21 存档**只差两处**：关卡名与脚本源码（可用 `node scripts/gi.mjs diff` 核对）。脚本在存档里仍叫「收集圆圈」，已绑在容器节点上，不用在编辑器里再绑。

## 导入与试玩（必须由你在真机做）

先走 `references/formats/README.md` §6：**备份存档、在测试关卡里试**。然后：派蒙菜单 → 我的奇遇 → 右下角「导入存档」→ 选 `圆圈挑战.gil` → 用编辑器打开 → 试玩 → 点中间的圆圈。

日志里按这个顺序看（脚本自己打的行都带 `[圆圈挑战]` 前缀；`GAME FAULT` 块是另起的多行）：

| 日志 | 含义 |
|---|---|
| `OnStart circle-challenge/v1/…` | 版本戳对上了，跑的才是这一版 |
| `showCursor 设置前=…` / `设置后=…` | 设置后不是 `true`：回编辑器手动打开容器节点的 `showCursor` |
| `就绪 …（画布 W x H）` | 初始化成功，可以点了。**W、H 显示成 `1920.0` 还是 `1920`** 是个小数据点：它说明引擎的 `GetUICanvasSize` 返回浮点还是整数（模拟器按浮点建模） |
| `第 N 局开始` / `第 N 局结束 得分=… 最高=…` | 玩法在走 |
| `GAME FAULT BEGIN CIRCLE_CHALLENGE … END` | 出错了，`message=` 那一行是原因 |

## 证据：哪些验证了、哪些没有

- **离线**：`lint` 零发现；冒烟 40 秒（80 次点击全部送达）零 error；75 项场景断言通过；与官方示例共用的写法（生命周期、`GetChild` 取法、`showCursor`、光标检测区域、`raycastTarget` 防重复、`isReady`、`printFault`）来自官方 3.21 示例。
- **脚本里标了「未在真机验证」的地方**（也是第一次试玩最想看的）：
  ① 计时用 `os.time()`（整秒），不用 `OnUpdate` 的 `dt`——文档没写 `dt` 的单位；
  ② 圆圈缩小 / 换色 / 背景泛红 / 点中「弹一下」（`TweenSequence` + `OutBack`）是在官方示例已用的 API 上组合出来的，补间视觉与运行时写颜色没有真机数据；
  ③ 加宽分数文本、放大字号（`fontSize` 必须是整数）、让圆圈避开它——读不到文本矩形时退回「不进画布顶部 110 像素」；文本能不能排下、字号合不合适要看真机。
- 教学存档里分数文本只有 218×68（约 10 个汉字宽）——这是从存档布局槽读出来的（【逆向推断】，见 `references/formats/lua-and-ui.md`），脚本因此才要加宽它。

试玩结果（成功 / 哪一行日志不对 / 手感）请按 `references/formats/lua-sim.md` §7 回填，并记进 `references/formats/verification-ledger.md`。
