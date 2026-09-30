# 客户端 Lua UI 脚本 · 实战手册

> 这是「客户端 Lua UI 脚本」这一个域的完整打法。
> 平台总入口见 `SKILL.md`；语料查找方法见 `references/index.md`。
> API 逐字速查见 `api/client-ui-api.md`，实测契约见 `api/runtime-contract.md`，静默失效成因见 `api/pitfalls.md`。
>
> **⚠️ 动手前先看 `references/live/mh47p30a87qo_official-sample-main.lua`。**
> 那是官方教程「3.21 客户端脚本——制作点击收集玩法」的完整工程实现，**正文 225 行（含空行）、逐字未改、可直接抄**（文件头另有 15 行来源说明）。
> 本手册下面好几条范式（控件树嵌套、初始化重试、点击判定控件选型）都以它为准，不是推测。

## 一条硬范式：控件树要"会一起动的东西放进同一个容器"

官方实现（`references/live/…official-sample-main.lua` 头部注释，逐字）：

```
脚本所属对象          [容器节点]        ← script.object
├─ 背景                [图片控件]
├─ 圆圈容器            [容器控件]        ← 移动的是这一层
│  ├─ 圆圈点击区域    [光标检测区域]     ← 收点击的是这一层
│  └─ 圆圈图片        [图片控件]        ← 只负责显示
└─ 分数文本            [文本控件]
```

> **注：方括号里的类型标签是官方示例注释的口语化写法，不是编辑器菜单里的正式名。**
> 官方控制类型清单（`references/corpus/Miliastra-knowledge/client/mhbgxf0nynww_客户端控件和客户端脚本.md`，逐条列了
> 每种客户端控件及其查询接口）用的是 **容器节点**（`ContainerControl`）/ **图片**（`ImageControl`）/
> **文本框**（`TextBoxControl`）；而示例注释写的是 容器控件 / 图片控件 / 文本控件。只有「光标检测区域」两边一致。
>
> **哪个是菜单里的实际标签 = 未确认。** 但这不影响能否取到控件：`GetChild` 匹配的是控件的**名字**
> （编辑器里你给它起的名），不是类型标签。菜单里能选到哪个就先选哪个，**把名字起对才是关键**。

**为什么必须这样**：要让"看得见的图形"和"点得到的判定区"**一起动**，就把两者放进同一个容器，然后只对容器调 `SetAnchoredPosition(x, y)`。分别移动两个控件迟早会错位——而错位的表现是"看着点到了却没反应"，极难排查。

**两条随之而来的选型结论**：

1. **点击判定用【光标检测区域】（`ClientUICursorEventAreaControl`），不要用【预设按钮】。** 官方原话：*"'圆圈点击区域'必须是'光标检测区域'，不是预设按钮。"* 预设按钮带自己的按下态/音效表现，做游戏内判定区是错配。
2. **显示层不要挂事件。** 官方原话：*"图片控件不需要单独处理点击事件。"* 事件只挂在判定区上。

## 写一个脚本：六步

1. **定控件树**：先列出需要的控件类型与名称，名称要和画布上**逐字一致**（含大小写）。命名统一风格，别一个名词化一个动词化。**必须一起动的控件，先想清楚它们的共同父容器是谁**（见上一节）。
2. **定数据流**：谁是权威源？客户端只有**读**自定义变量的接口，没有写接口——需要权威分数的玩法必须让服务端持有，客户端发增量、服务端回发权威值。
3. **定生命周期落点**：控件引用解析放 `OnStart`（`OnInit` 时控件树可能未就绪）；**但画布尺寸在 `OnStart` 时可能还没就绪**——凡是依赖 `game.GetUICanvasSize()` 的初始化，都要走下面的"逐帧重试"范式，别在 `OnStart` 里直接开工。
4. **按对照表落地**：每个名字回 `api/client-ui-api.md` 核一遍；每条与文档冲突处回 `api/runtime-contract.md`。
5. **兜底与日志**：不确定的调用包 `pcall`，失败打日志不中断；用 `print` / `printerr`，**不要用 `io`**。控件引用判空，别让 nil 在几十行之后才炸。
6. **过检查脚本**，再**离线跑一遍**（`node scripts/sim-lua.mjs smoke 脚本.lua --gil 关卡.gil`，见下文「检查脚本」）；写出「已验证 / 未验证」的明确状态与不确定清单。离线通过只能写成「离线模拟通过」，不是「已验证」。

### 骨架（生命周期部分照官方范式写）

**官方范式**：`OnStart` 只开逐帧；真正的初始化放 `OnUpdate` 里重试，直到画布就绪或耗尽预算。

```lua
local this = script.object               -- 就是挂载的容器本身

local Game = {
    started = false,                     -- 初始化是否已完成
    startAttempts = 0,
    startRetryBudget = 60,               -- 画布未就绪时最多重试多少帧
    canvasWidth = 0, canvasHeight = 0,
}

-- 控件引用在文件顶部解析；nil 是正常的（画布可能还没起来）
local scoreText = this:GetChild("分数文本")

local function isReady(ctrl) return ctrl ~= nil and ctrl.alive end

local function printFault(msg)           -- 带调用栈的出错日志
    printerr(table.concat({
        "GAME FAULT BEGIN", "message=" .. msg,
        "traceback=" .. debug.traceback("", 2), "GAME FAULT END",
    }, "\n"))
end

-- 返回 true=初始化完成 / false=不可恢复的失败 / nil=稍后重试
local function startGame()
    if Game.started then return true end
    if not isReady(scoreText) then
        printFault("找不到预设界面控件，请检查控件名称和层级")
        return false
    end
    local w, h = game.GetUICanvasSize()
    if type(w) ~= "number" or type(h) ~= "number"
        or math.isnan(w) or math.isinf(w) or math.isnan(h) or math.isinf(h)
        or w <= 0 or h <= 0 then
        return nil                        -- 画布还没就绪 → 下一帧再来
    end
    Game.canvasWidth, Game.canvasHeight = w, h
    this.showCursor = true                -- 不打开，光标事件一律收不到
    scoreText.text = "分数：0"
    Game.started = true
    return true
end

function OnStart()
    math.randomseed(os.time())
    script:EnableUpdate(true)             -- 不调，下面的 OnUpdate 是死代码
end

function OnUpdate(_dt)                    -- 只收一个参数
    if Game.started then return end
    Game.startAttempts = Game.startAttempts + 1
    local r = startGame()
    if r == true then
        script:EnableUpdate(false)        -- 初始化完就关掉，别白烧帧
    elseif r == false or Game.startAttempts >= Game.startRetryBudget then
        if r == nil then printFault("画布未就绪") end
        script:EnableUpdate(false)
    end
end
```

> **点击回调只收一个参数**：官方签名是 `local function onCircleClick(_data)`。`_data` 是 `CursorEventData`（只读 `dragging` / `touchId`，方法 `GetUIPos()` / `GetPressUIPos()` / `GetUIPosDelta()`）。
>
> **防重复点击的官方手法**：进回调先 `area.raycastTarget = false`，处理完再 `= true`。
>
> ```lua
> local function onCircleClick(_data)
>     if not Game.running then return end
>     circleArea.raycastTarget = false       -- 同一次点击只处理一次
>     Game.score = Game.score + 1
>     updateScore()
>     circleArea.raycastTarget = true
> end
> ```
>
> 服务端信号：`local s = game.ServerSignal("ScoreAdd"); s:AddInt(1); s:SendSignal()` —— `game` **点号**调用，`SendSignal()` 不调就不发。

> 缩放弹出动画：`game.Tween(ctrl, { localScaleX = 1.2, localScaleY = 1.2 }, 0.15):SetEase(Enum.EaseType.OutBack):Play()`
> 注意三点：`game` **点号**、控件**没有 `scale` 字段**、**不 `Play()` 就不动**。

## 审一段脚本：四步

1. **过检查脚本**拿到机械发现（错误/警告/提示，带行号）；再 `node scripts/sim-lua.mjs smoke` 离线整局跑一遍，拿到**运行时**才暴露的问题（取不到的控件名、补间没 Play、点击收不到、整数浮点混用、未捕获错误的行号与调用栈）。
2. **看静默类**：字段**读**错只是 nil——查名字有没有拼错、层级有没有写错、控件是不是子控件。
   **手头有关卡存档（`.gil`）时别靠眼睛核对**：`node scripts/gi.mjs lua check <存档.gil> --file 脚本.lua`（见下文「拿存档核对控件名」）。
3. **看架构类**：权威源是否唯一（本地 `score` 与服务端回发直接互相覆盖是经典 bug）；监听是否成对注册/移除；不确定调用是否兜了 `pcall`；
   **控件树结构是否合理**——该一起动的控件有没有共同父容器、点击判定是不是用了光标检测区域。
4. **交结论**：逐条「错在哪 + 怎么改」，按严重程度排序；修正稿给出；**已跑过什么、没跑过什么写清楚**。

## 排错：按症状走阶梯

用户说"点了没反应 / 脚本没跑 / 动画不动"，**按出现概率**依次查，不要一上来重写。
**手头没有真机时，先把脚本喂给离线模拟器复现**：`node scripts/sim-lua.mjs smoke 脚本.lua --gil 关卡.gil`。下表的 ①②（`showCursor` / `raycastTarget` / 类型选错）、③（控件取不到）、④（画布未就绪）、⑥（父级不激活）、⑦（回调不执行、`EnableUpdate`）、⑧（补间）、⑨（信号没发）它都能复现并给出原因——`SIM031`「点击没有送达：…」、`SIM070`「`GetChild("…")` → nil，已有：…」、`SIM060`「`OnUpdate` 是死代码」、`SIM020` / `SIM021` / `SIM022`（补间）。复现不出来才说明问题在真机与模型的差异处，这时再看 `formats/lua-sim.md` §5 的保真度表。

按出现概率排的阶梯：

| 顺位 | 症状 | 先查 |
|---|---|---|
| 1 | 点击完全不响应 | ① 容器节点的 **`showCursor`**——**真机实测新建容器默认就是 `false`**，必须先打开（`CursorEvent` 系列方法的前提），官方教程第 4 步也是这么写的；② 判定控件的 `raycastTarget` 是否为 true；③ **判定区是不是盖在图片下面 / 尺寸没覆盖到图形**——"看着点到了却没反应"多半是这个 |
| 2 | 判定区收不到点击（但别的都好） | **控件类型选错了**：点击判定要用【光标检测区域】，**不是预设按钮**；显示用的图片控件**不要**挂事件 |
| 3 | 控件取不到 | **有存档先跑 `gi.mjs lua check`，它会指到行和层**；否则核对：控件名/层级是否与画布逐字一致；是不是子控件而用了 `FindClientUIRoot`（那只找 UI 根）；**嵌套容器的子控件要先拿到父容器再 `GetChild`**：`circleRoot:GetChild("圆圈点击区域")`，不能从 `script.object` 一步到位 |
| 4 | 初始化没生效 / 坐标全 0 | `game.GetUICanvasSize()` 在 `OnStart` 时**可能还没就绪**。改用 `OnStart` 只开 `EnableUpdate(true)`、`OnUpdate` 里重试的官方范式（见上文骨架） |
| 5 | 脚本整个没跑 | ① 是否**真的点过试玩**（编辑器里那个画面是预览，不是运行态）；② 脚本是否在编辑器里**建立了映射**（不建映射不上传、不运行）；③ **界面控件组是否被「界面布局」引用**——未激活的控件组运行时根本不存在，里面的控件和脚本一律不生效。落盘位置与版本核对见下节 |
| 6 | 控件在但逻辑不跑 | 父级 `active` 是否为 false（会**同时**隐藏控件并停掉挂载脚本） |
| 7 | 某个回调不执行 | 名字是否在那七个生命周期之内；`OnUpdate` 是否忘了 `EnableUpdate(true)` |
| 8 | 动画不动 | 是否 `Play()`；补间字段名是否合法（**没有 `scale`**） |
| 9 | 服务端联不上 | 信号是否 `SendSignal()`；参数个数/顺序是否与服务端约定一致；参数下标是否误用 `[0]` |
| 10 | 动画播完卡住 | `Tween:Kill(complete)` 的语义；重复点击是否叠加了未结束的补间 |

看不清控件树时直接 `game.PrintClientUITree()`。

## 探针怎么落盘、怎么确认跑的是哪一版

**真机 Lua 的落盘位置**（2026-09-27 实测，全盘扫描确认）：

```
…\AppData\LocalLow\miHoYo\原神\BeyondLocal\<uid>\Beyond_Local_Save_Level\<关卡ID>\external_lua_file\<脚本名>.lua
```

- 同一台机上可能有**多个** `external_lua_file` 目录（国服 `原神` 与国际服 `Genshin Impact` 各一份），**只有非空的那个是活的**。本机活的是 `…\原神\…\Beyond_Local_Save_Level\1073741826\…`，而同级的 `1073741825` 是**空壳**——**别按编号猜**，先扫：

  ```powershell
  Get-ChildItem -Path "C:\" -Recurse -Directory -Filter "external_lua_file" -ErrorAction SilentlyContinue -Force
  ```

  然后挑**里面有文件**的那个。
- 改完**不用手动上传**，但**必须重新试玩**才会加载。

**确认"跑的是磁盘上这一版"——靠内容戳，不要靠行号：**

- `debug.getinfo` **不可用**（§0 只留 `debug.traceback`），想要行号时会直接踩空。
- 实测还出现过 **日志行号与磁盘行号差 5 行**的不明偏移（内容一致，已排除"空行剥离"假说）。原因未定，**结论是别依赖行号**。
- 正确做法：脚本里放 `local STAMP = "v4-A/7f3c9d21"`，`OnStart` 头部打印。**日志里见到这串，才算版本对**。

**探针提问的正确姿势——问"有没有"，别问"能不能调"：**

```lua
-- 好：pcall 只包【读取】，nil 与"调用失败"不会混为一谈
local function exists(obj, k)
    local ok, v = pcall(function() return obj[k] end)
    if not ok then return "!! 读取出错" end
    if v == nil then return "nil   ← 不存在" end
    return typeof(v)
end

-- 差：pcall 包【调用】——返回 nil 时分不清"不存在"还是"调用失败"
local ok, r = pcall(function() return obj:SomeMethod() end)
```

同理，**`#t` 只数数组部分**：`GetChildren()` 若返回按名字索引的表，`#` 恒为 0。数个数一律用 `pairs`，两个都打出来对照。

## 官方文档与实测冲突的地方（必须知道）

这些是官方文档**写错或没写**的。逐条按右列写：

| 事项 | 官方文档 | 实测 / 官方教程 | 怎么写 |
|---|---|---|---|
| 控件运行时 ID 字段 | `id` | **`id`（小写）——2026-09-27 真机已钉死**。曾一度按模拟器改判为 `Id`，**已被真机推翻** | **直接用 `id`**；`Id` 读为 nil。证据见 `api/runtime-contract.md` §3 |
| UI 脚本取容器的入口 | 未写 | **`script.object` 就是挂载的容器本身**；`FindClientUIRoot` 只找 UI 根控件，对容器返回 nil | 用 `script.object`，别绕 `FindClientUIRoot`（§3b） |
| **`showCursor` 该不该开** | 只登记为「容器节点专有字段」，**没写默认值和后果** | 默认 **`false`**；**官方教程 3.21 明确要求 `this.showCursor = true`**，否则光标检测区域收不到事件 | **新建容器一律显式打开**。这条已从「实测孤证」升级为「文档+实测互证」 |
| **点击判定用什么控件** | 未做选型说明 | **官方教程：用【光标检测区域】，"不是预设按钮"**；显示用的图片控件**不要**挂事件 | 判定用 `ClientUICursorEventAreaControl`；预设按钮留给真正的按钮 UI |
| **控件树该不该嵌套** | 未写 | **官方教程：把"要一起动的图片与判定区"放进同一个容器，移动容器** | 见本文开头「一条硬范式」 |
| **`GetUICanvasSize()` 的时机** | 未写时序 | **官方示例：`OnStart` 时可能未就绪**，官方给了逐帧重试范式（60 帧预算） | 依赖画布尺寸的初始化走 `OnStart`+`OnUpdate` 重试 |
| **光标事件回调签名** | 只写 `AddCursorEventListener(eventType, callback)` | **官方示例：回调只收一个参数**，即 `CursorEventData` | `local function cb(data)`，不要写两个参数 |
| `OnUpdate` 默认调度 | 未写默认值 | **`EnableUpdate` 之前不调度**（含真机标记） | 需要逐帧必须先 `script:EnableUpdate(true)` |
| 生命周期顺序 | 只列函数名 | `OnInit`→`OnEnable`→`OnStart`；`SetActive(false)` 立刻 `OnDisable`，`SetActive(true)` 不重跑 `OnStart` | 引用解析放 `OnStart`；**初始化干活放 `OnUpdate` 重试** |
| `Get*` 系列返回值形态 | 只列方法名 | **多个返回值，不是 table**：官方示例 `local w, h = circleRoot:GetSizeDelta()` | `local w, h = ctrl:GetSizeDelta()`，别当成一个对象接 |
| `fontSize` / `minimumFontSize` | 声明为 `integer` | 传小数真机报 `integer expected, got number` | 赋值前 `math.floor(...)` |
| 被裁剪的标准库 | `io` / `coroutine` / `string.dump` / 部分 `os` / 部分 `debug` | **另加** `load` `loadfile` `dofile` `collectgarbage` `package` `string.pack` `string.unpack`；而 **`require` 是可用的**（已映射脚本路径） | 见 `api/pitfalls.md` §F |
| 字段写错 vs 读错 | 未写 | **写**报 `cannot set <field>, no such field`；**读**为 nil | 排查时区分两种失败模式 |
| `FindChild` 路径 | 未写分隔符 | 支持 `"A/B"`；**`GetChild` 只有一层** | 多层用 `FindChild` |

**冲突时以实测为准**（官方教程正文的权重等同官方文档），并把新发现记回 `api/runtime-contract.md` 的「尚未确认」一节。

## 不要做的事

| 做法 | 为什么不行 |
|---|---|
| 凭印象写 API 名 / 枚举值 / 字段名 | 静默失效，排查代价远高于查一次表 |
| 用 `io.write` 打日志 | 客户端 `io` 不存在，直接报错刷屏 |
| 给 `OnUpdate` 写第二个参数 | 只传一个 `dt` |
| 直接给 `active` / `visible` 赋值 | 只读字段，要用 `SetActive` / `SetVisible` |
| `game:Tween(...)` 用冒号 | `game` 是全局表，点号调用（真机对 `GetClientUIRoots` 已确认报参数个数错） |
| `Enum.EaseType.easeOutBack` | 枚举值是 PascalCase：`OutBack` |
| `Tween(ctrl, { scale = 1.2 }, ...)` | 没有 `scale` 字段；用 `localScaleX/Y/Z` |
| 忘了 `Play()` / 忘了 `SendSignal()` | 一个不动，一个不发 |
| `params[0]` 取信号参数 | Lua 数组从 1 开始 |
| 用 `Remove*EventListener` 传内联函数 | 引用对不上，移除无效；要么存变量，要么 `RemoveAll*` |
| 本地分数与服务端回发互相覆盖 | 先定唯一权威源 |
| **用【预设按钮】当游戏内点击判定区** | 官方选型是【光标检测区域】；预设按钮自带按下态/音效表现，是真正的按钮 UI 用的 |
| **给显示用图片控件挂点击事件** | 官方原话"图片控件不需要单独处理点击事件"；判定与显示要分层 |
| **把"图形"和"判定区"当两个控件分别移动** | 迟早错位；放进同一个容器，只移动容器 |
| **在 `OnStart` 里直接读画布尺寸干活** | 尺寸可能未就绪；用官方逐帧重试范式 |
| **点一次却加了两次分** | 回调里先 `raycastTarget = false`、处理完再 `= true`（官方手法） |
| **"点一下弹一下"只写去程** | 补间停在终点后，第二次点击起点 == 终点，**静默无事发生**。用 `TweenSequence` 接上回程，见 `pitfalls.md` §D6 |
| 把离线模拟 / 模拟器跑通说成真机通过 | 自带离线模拟器是「Lua 解释器 + 对引擎的建模」，只对照过官方 3.21 示例；第三方外置沙箱是 2D、服务端只模拟变量+信号、图片只代理 100001–100006、GIA 只覆盖子集。两者都抓不到渲染 / 排版 / 手感 |
| 为一个审查请求建整个工程 | 超出作用域，污染工作区 |

## 拿存档核对控件名（可选，有关卡 `.gil` 时最省事）

"控件名/层级与画布逐字一致"是头号静默失效点。关卡存档里就有整棵控件树，工具可以直接对：

```sh
node scripts/gi.mjs ui 关卡.gil                                   # 控件树：名字、类型、父子、哪个控件绑了脚本
node scripts/gi.mjs lua check 关卡.gil --file main.lua            # 核对磁盘上的脚本（日常迭代改的 external_lua_file\*.lua）
node scripts/gi.mjs lua check 关卡.gil                            # 核对存档里嵌的那一份
```

- 起点是**绑定该脚本的控件**（`script.object`）；`GetChild/FindChild` 链逐层比对，对不上会给出「第几行、哪个控件下没有这个名字、已有哪些」。
- **只识别静态引用**：`local a = this:GetChild("甲")`、链式、`a:GetChild("乙")`、`FindChild("甲/乙")`；名字是变量拼出来的不在范围内。
- **不核对控件类型**（把图片当按钮用这类错要对着 `gi.mjs ui` 的类型标注自己看）。
- 关卡存档怎么来：编辑器 **我的奇遇 → 导出存档**。这份存档只用来**读**，不会被改。
- 想把脚本写进存档（分发关卡用）：`gi.mjs lua put`——**日常迭代不需要**，迭代直接改磁盘上的 `external_lua_file`。细节与边界见 `references/formats/lua-and-ui.md`，规则见 `AGENTS.md` 规则四。

## 检查脚本

```sh
node scripts/check-lua-ui.mjs --selftest      # 先确认检查器本身正常（应 19/19 全过）
node scripts/check-lua-ui.mjs 你的脚本.lua     # 检查一个文件
node scripts/check-lua-ui.mjs -               # 从标准输入读脚本再检查（不落盘）
node scripts/check-lua-ui.mjs references/live/mh47p30a87qo_official-sample-main.lua   # 官方实现，应当零发现
```

**草稿不要为了过检查而落盘**——「不要做的事」里就有一条是往工作区乱写文件。管道进去即可：

```sh
cat draft.lua | node scripts/check-lua-ui.mjs -
```

覆盖：生命周期名与参数个数、被裁掉的标准库、`game` 点号/冒号、枚举值白名单、Tween 可补间字段、只读字段赋值、`SendSignal`、信号参数下标、`showCursor`、事件监听引用、`traceback` 输出。

**TweenSequence 已覆盖**：`seq:Append(tween)` + `seq:Play()` 是文档 §6 的官方玩法（Tween 自己不 Play），检查器认这个形态，不会误报 LX006；序列没 `Play()` 时仍会报，并把提示指向序列。

它会把字符串与注释置空后再扫，所以 `print("io.write")` 这类**不会误报**。
「Tween 结果被外传（`return` 或作为实参）」只给**提示**不给警告——静态跟不进闭包，不硬判。

**静态检查通过 ≠ 真机通过。** 通过后仍要在编辑器里确认控件树、交互与显示结果。

## 离线模拟（技能自带，没有真机也能整局试跑）

正则检查（上面）看不出语法错误，也不会运行脚本。`scripts/sim-lua.mjs` 补这两块：一个 Lua 5.3 解释器 + 对客户端 API 的建模（控件树与布局、补间、生命周期、光标 / 按键 / 信号事件、虚拟时钟）。

```sh
node scripts/sim-lua.mjs smoke 脚本.lua --gil 关卡.gil      # 最常用：lint + 整局运行 + 自动点击 + 诊断报告
node scripts/sim-lua.mjs smoke --gil 关卡.gil                # 用存档里嵌着的脚本（验证的正是将要导入的东西）
node scripts/sim-lua.mjs smoke 脚本.lua --tree '容器节点:container(分数:text,按钮:button)'   # 没有存档：手写控件树
cat draft.lua | node scripts/sim-lua.mjs lint -              # 只做静态（不落盘）：语法 / 作用域 / 标准库 / 数字类型陷阱
node scripts/sim-lua.mjs test 脚本.lua --gil 关卡.gil --scenario 场景.mjs    # 游戏规则的断言（计分 / 倒计时 / 重开 / 边界时刻）
node scripts/sim-lua.mjs eval 'print("hp:" .. 100 / 2)'      # 不确定 Lua 5.3 怎么表现时，跑一下比猜快
```

**它额外抓到的**（`check-lua-ui.mjs` 抓不到的）：语法错误（真机加载期就失败，含 5.4 的 `<const>`）、拼错的变量与被裁剪的库（`LS002`）、`local function OnStart`（宿主看不见，`LS004`）、`math.pow` 这类 5.1 写法（`LS007`）、`typeof(x) == nil` 恒假（`LS011`）、浮点拼进文本（`"HP:" .. 100 / 2` → `HP:50.0`，`LS018`）、`fontSize` 赋小数（`LS019`）；以及**运行时**才暴露的：`GetChild` 返回 nil 之后在哪一行炸、`showCursor` 默认 `false` 导致点击收不到、补间没 `Play` / 字段名写错 / 序列没播、`Remove*Listener` 移不掉匿名函数、`s:AddInt(1):SendSignal()` 链式、`OnUpdate` 没 `EnableUpdate(true)`、死循环、整局逻辑里的边界时刻。

**怎么读报告**：每条运行时诊断带证据标签——`真机` / `文档` / `官方示例` 有出处，可以当平台事实引用；`模型` / `未确认` 是模拟器的猜测，只能当线索。诊断码表与保真度表在 `references/formats/lua-sim.md`。**完整示例**（游戏脚本 + 控件树 + 75 项断言的场景测试）：`references/examples/circle-challenge/`，它同时是「怎么给自己的脚本写场景测试」的范例。

**它不是引擎。** 通过 = 「脚本在这个模型里是这样」；渲染 / 排版 / 手感 / 真实帧率、服务端节点图都不在模型里；模型只对照过官方 3.21 示例脚本。交付时写「离线模拟通过」，不要写「已验证」，并照旧给出真机该看的日志行。真机与模拟器不一致时以真机为准，回填流程见 `lua-sim.md` §7。

## 可选：外置沙箱（第三方）

`miliastra-beyond-simulator`（npm `dsh-plugin-beyond-simulator`）能在游戏外跑客户端 Lua、显示 UI、响应操作，用来抓**结构性错误**：生命周期是否被调到、控件是否取到、Tween 是否播放、信号参数顺序是否正确。

抓不到的：渲染细节、真机手感、服务端节点图行为、真实联机。**它的通过不等于真机通过。**
其 README 里的 `dsh plugin --profile web add dsh-plugin-miliastra-toolbox` 在 npm 上取不到该包，需改用 GitHub 源。
（它需要另行安装；技能自带的离线模拟器零依赖、开箱即用，日常先用后者。）
