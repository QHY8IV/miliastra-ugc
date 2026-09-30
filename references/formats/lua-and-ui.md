# Lua 脚本与界面控件（在 .gil 里）

客户端 Lua 脚本怎么写，见 `references/lua-ui-playbook.md` 与 `references/api/*`。
本篇讲的是**它们在存档里是什么样**，以及怎么用这一层把"名字逐字匹配"这个头号翻车点变成可机械核对的事。

## 1. 脚本资产

【官方示例】样本 `客户端脚本.gil`（3.21 教程，编辑器 7.1.0）：

```
client_scripts.scripts[0] = { guid: 0x40000002, name: "收集圆圈", file_name: "main.lua", source: "<Lua 源码明文>" }
```

- Lua 源码是**明文**（UTF-8），官方这份带 `\r\n` 换行。
- 脚本要**绑定在一个控件上**才会运行（编辑器里：控件 → 添加脚本）。Lua 里 `script.object` 就是这个控件。
- 存档里脚本被两处引用：**分类页签**（`category_kind 69`，`asset_kind 7900`）与**控件的绑定槽**。

```sh
node scripts/gi.mjs lua ls x.gil                       # 列出
node scripts/gi.mjs lua get x.gil --name 收集圆圈 -o main.lua
node scripts/gi.mjs lua put x.gil --file main.lua --name 收集圆圈 -o x.new.gil    # 替换已有脚本源码
```

替换只改 `source` 一个字段；把取出的源码原样放回，文件与原文件**字节相同**【官方示例】。
`--new` 新增脚本【逆向推断】（同时登记分类页签），且**绑定仍需在编辑器里手动做**。

## 2. 控件树

【官方示例】还原出的树与 3.21 教程要求的层级逐项一致：

```
容器节点  [容器控件]  ← 绑定脚本「收集圆圈」
├─ 背景        [图片控件]
├─ 分数文本    [文本控件]
└─ 圆圈容器    [容器控件]
   ├─ 圆圈图片        [图片控件]
   └─ 圆圈点击区域    [光标检测区域]
```

```sh
node scripts/gi.mjs ui x.gil          # 默认只列自定义控件树；--all 列全部（含内置布局）
```

### 存档里怎么描述一个控件

每个控件是一个 `UiNode`：`guid`、`parent`、`children`（兄弟顺序）、若干数据槽 `slots`。
数据槽用 `(slot_id, slot_type)` 标识，组合决定它存什么。名字槽是 `(2,15)`。

### 控件类型怎么识别

类型没有直接的"type"字段，靠**节点带了哪些类型专属槽**判断（`scripts/lib/ui.mjs` 的 `WIDGETS` 表）：

| 类型 | 需要的槽 | 证据 |
|---|---|---|
| 图片控件 | `63:83` `73:96` `74:97` | 官方示例 |
| 文本控件 | `63:83` `64:84` | 官方示例 |
| 光标检测区域 | `63:83` `65:85` | 官方示例 |
| 容器控件 | `63:83` `68:91` | 官方示例 |
| 文本框 / 进度条 / 计时器 / 自定义按钮 / 弹窗 / 图片 / 素材组（老式界面控件） | `9:25` / `10:26` / `11:27` / `7:22` / `8:24` / `21:38` / `38:56` | **逆向推断**（由控件名与槽位一致出现推得，仅作提示，输出里带「(推测)」） |

认不出的显示为「客户端控件(类型未识别)」。**新的控件类型（预设按钮、按键提示、文本视窗、网格视窗、模板引用等）样本里没有，识别不了**——遇到时用 `gi.mjs dump --path` 看它的槽签名，再补进 `WIDGETS`。

### 脚本绑定

脚本绑定在槽 `(63,83)` 的内层：`503.74.502.1.1 = 脚本 GUID`（未知字段路径，`ui.mjs` 的 `uget` 取）。
`gi.mjs ui` 会在被绑定的控件后面标出 `← 绑定脚本 0x…`。

### 布局槽 `(1,12)`（【逆向推断】，离线模拟器用）

新式客户端控件带一个 `(1,12)` 槽，内层 `503.13.12` 下是 4 条布局：一条没有状态号的「默认」+ 三条带状态号（`501` 变体，含义未知，未读）。默认那条的 `502` 组：

| 字段 | 含义 | 省略时 |
|---|---|---|
| `501{1,2,3}` | localScale | 必有（1,1,1） |
| `502` | anchorMin（`{501=x, 502=y}`） | (0,0) |
| `503` | anchorMax | (0,0) |
| `504` | anchoredPosition | (0,0) |
| `505` | sizeDelta | (0,0) |
| `506` | pivot | (0,0)（样本里全都写了，多为 0.5,0.5） |

数值是 f32（`_u` 里 `{w:'i32', hex:'0x0000803f'}`，小端）。依据：官方 3.21 存档里根容器 `anchorMax=(1,1)`（全屏拉伸）、背景 `sizeDelta=1600×900`、分数文本 `218×68 @ (0, 350)`；48 个样本的 419 个新式控件字段形状全部一致。**没有官方文档逐字段说明这些编号**——只用于离线模拟与 `gi.mjs`/`sim-lua.mjs tree` 的显示，不当作事实。`ui.mjs` 的 `layoutOfNode` 读它，`buildUiTree` 的节点上有 `layout` 字段；老式内置控件（`(1,11)` 槽）没有布局，返回 null。用法见 `lua-sim.md` §4。

## 3. `lua check`：Lua 里的控件名 vs 存档里的控件树

```sh
node scripts/gi.mjs lua check x.gil [--name 脚本名]                    # 核对存档里嵌的那一份
node scripts/gi.mjs lua check x.gil --name 脚本名 --file main.lua       # 核对磁盘上的脚本（日常迭代的 external_lua_file\*.lua）
```

**日常迭代不需要把脚本写进 `.gil`**：本机改 `external_lua_file\*.lua` 重新试玩即可（`lua-ui-playbook.md`「探针怎么落盘」）。
`.gil` 在这里主要有两个用处：① 用它的控件树做**只读核对**（导出一份存档就行，不会被改）；② 产出**可分发的关卡存档**（`lua put`）。

找到绑定该脚本的控件作为起点，把 Lua 里的引用逐层比对控件树：

```
✗ 第 41 行：「圆圈容器」下没有名为「圆圈点击区」的子控件（已有：圆圈图片、圆圈点击区域）
```

**识别范围**（静态、保守——宁漏勿误）：

| 识别 | 例 |
|---|---|
| `script.object` 的别名 | `local this = script.object` |
| 链式与逐步获取 | `this:GetChild("甲"):GetChild("乙")`；`local a = this:GetChild("甲")` 之后的 `a:GetChild("乙")` |
| 路径式查找 | `a:FindChild("乙/丙")` |
| 忽略 | 注释里的、字符串里的 |

**不识别**：名字是变量/拼接出来的、经函数返回值传递的、存进表里再取的引用。这些不在核对范围，也不会报错。
它**不核对控件类型**（Lua 把图片当按钮用这类错误）——类型需要你对照 `gi.mjs ui` 的输出自己看。

同名兄弟控件：`GetChild(名)` 只取第一个，`lua check` 会给出 warn。

## 4. 完整例子（教程 3.21 的存档）

```sh
node scripts/gi.mjs lua check references/samples/<3.21 存档>          # ✓ 官方脚本的 5 处引用都在控件树里
node scripts/gi.mjs lua get   … -o main.lua                         # 取出，改分数目标
node scripts/check-lua-ui.mjs main.lua                              # Lua 侧规则
node scripts/gi.mjs lua put   … --file main.lua -o x.new.gil        # 写回
node scripts/gi.mjs verify x.new.gil --lua                          # 存档检查 + 顺带对脚本跑 check-lua-ui
node scripts/sim-lua.mjs smoke --gil x.new.gil                      # 离线整局跑存档里嵌着的脚本（控件树与布局来自这份存档）
```
