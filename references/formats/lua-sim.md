# 离线 Lua 模拟器（`scripts/sim-lua.mjs`）

> 没有真机的时候，先把客户端 Lua 脚本**离线整局跑一遍**：一个 Lua 5.3 解释器 + 一套「我对客户端 API 的建模」（控件树、布局、`script` / `game` / `Enum` / `Color`、补间、生命周期、光标 / 按键 / 信号事件、虚拟时钟）。
> 零依赖、不联网、不改你的文件。规则入口见 `AGENTS.md`，Lua 写法见 `references/lua-ui-playbook.md`。

## 0. 一分钟版

```sh
node scripts/sim-lua.mjs smoke 脚本.lua --gil 关卡.gil      # 最常用：lint + 整局运行 + 自动点击 + 诊断报告
node scripts/sim-lua.mjs smoke --gil 关卡.gil                # 不给 .lua：用存档里嵌着的脚本（验证的正是将要导入的东西）
node scripts/sim-lua.mjs smoke 脚本.lua --tree '容器节点:container(分数:text,按钮:button)'   # 没有存档：手写控件树
node scripts/sim-lua.mjs lint  脚本.lua                      # 只做静态：语法 / 作用域 / 标准库 / 数字类型陷阱（LS）+ 客户端用法（LX）
node scripts/sim-lua.mjs test  脚本.lua --gil 关卡.gil --scenario 场景.mjs    # 跑你写的场景测试（断言游戏规则）
node scripts/sim-lua.mjs tree  关卡.gil --dsl                # 看存档里的控件树（含布局），输出可直接给 --tree 用
node scripts/sim-lua.mjs eval  'print(7 // 2, 7 / 2)'        # 在 Lua 5.3 语义下验证一小段代码
node scripts/check-lua-sim.mjs                               # 模拟器自检（离线，全绿才可信）
```

| | |
|---|---|
| **它抓得到** | 语法错误（真机加载期就失败）、拼错的变量 / 被裁剪的库 / 5.1 的写法（`unpack`、`math.pow`）、`local function OnStart`（宿主看不见）、`OnUpdate` 没 `EnableUpdate(true)`（死代码）、控件名对不上（`GetChild` 返回 nil，后面 `attempt to index a nil value (upvalue 'label')`）、字段写错（`cannot set … no such field`）、`fontSize` 赋小数、补间没 `Play` / 字段名写错 / 序列没播、`showCursor` / `raycastTarget` 没开导致点击收不到、监听移不掉 / 重复注册、`s:AddInt(1):SendSignal()` 链式、整数浮点混用（`"HP:" .. 100 / 2` 得到 `HP:50.0`、`string.format("%d", x / 2)`）、死循环、未捕获错误的行号与调用栈、整局逻辑（倒计时 / 计分 / 重开 / 边界时刻） |
| **它抓不到** | 渲染与排版（文字溢出、字体、图片、层级遮挡的真实观感）、手感、真实帧率与 `dt` 的单位、多点触控 / 拖拽手势、手柄导航的真实焦点、网格视窗的回收复用、声音、服务端节点图（信号只记录发出了什么，不模拟服务端回发）、引擎在文档与真机都没写的地方到底怎么做（见 §5，带【模型】/【未确认】标签的行） |
| **它不是什么** | **不是引擎，不是真机证据。** 通过 = 「脚本在这个模型里是这样」。模型只在官方 3.21 示例脚本上校准过（§6），其余行为有的来自真机回传（契约文档里带日期的那些），有的来自官方文档，有的是按常理的猜测——**每条诊断都带证据标签**（§3），引用时保留标签。 |

**交付时怎么说**（`AGENTS.md` 规则一、三）：写成「离线模拟：…（通过 / 发现 …）」，**不要**套用【文档】/【官方示例】/【实测】去证明引擎行为；并照旧写「未在真机验证」、给出该看的日志行。

## 1. 命令

### `smoke`：冒烟（最常用）

1. **静态**：`lint`（LS 规则，§3）+ `check-lua-ui.mjs` 的 LX 规则。有语法错误就只报 LS001，不运行。
2. **装载**：`load` → `OnInit` → `OnEnable` → `OnStart`。前 3 帧画布「未就绪」（`game.GetUICanvasSize()` 返回 `0, 0`）——官方示例专门为此写了重试，`OnStart` 里默认「画布已就绪」的脚本会在这里露馅（`--canvas-ready-frames N` 改帧数）。
3. **逐帧推进**虚拟时间（`--seconds 10 --dt 0.0333`）；每 0.5 秒自动点一下「注册了 `CursorClick` 监听」的控件（轮流；`--clicks off|N` 控制）。`--toggle` 会在中途把所属控件 `SetActive(false)` 再 `true`（暴露 `OnEnable` 里重复注册监听的脚本）。
4. **收尾**：`OnDisable` → `OnDestroy`；检查补间没 `Play`、`OnUpdate` 是死代码、监听泄漏。
5. **报告**：未捕获的 Lua 错误（同一条只列一次，带次数、行号、调用栈）、运行时诊断（带证据标签）、日志摘要（`--echo-logs` 看全部）、`--verbose` 多看源码行与结束时的控件树、`--json` 给程序读。退出码 `0` 无 error / `1` 有 error / `2` 用法错误。

关卡来源：`--gil 关卡.gil [--script 名字] [--owner 控件名]`（导入控件树 + 布局）、`--tree 'DSL'`、`--tree-file 文件`。其它选项：`--module 名字=文件.lua`（给 `require` 用，可重复）、`--seed N`、`--canvas 1920x1080`、`--pairs-order reverse`（打乱 `pairs` 的哈希部分顺序，暴露依赖遍历顺序的脚本）、`--tz 分钟`（`os.date` 的时区，默认 UTC）、`--step-limit N`。

### `test`：场景测试

smoke 只能发现「哪里出错」，**游戏规则**（得分、倒计时、重开、边界时刻）要自己写断言。场景文件是一个 ES 模块，默认导出 `async function (t)`：

```js
export default async function (t) {
  t.section('开局');
  const sim = t.fresh();                                   // 装载 + start + 空转 12 帧（过掉画布未就绪）
  sim.click('圆圈点击区域');                               // 点控件（按规则判定能不能送达）
  t.eq(sim.ctrl('分数文本').read('text'), '得分：0｜剩余：30 秒', '开局 HUD');
  sim.advance(31);                                         // 推进虚拟时间（秒）
  t.ok(/时间到/.test(sim.ctrl('分数文本').read('text')), '到点结算');
  t.noProblems(sim, '整局');                               // 没有 Lua 错误、没有错误级日志
}
```

**完整范例**：`references/examples/circle-challenge/`（脚本 + 控件树 + 75 项断言的场景；自检里会跑它，它一旦与模拟器脱节就会报）。

`t`：`section` `ok` `eq` `fresh(额外选项?, 空转帧数=12)` `newSim(额外选项?)`（要自己控制 `load` / `start` 时机、或在装载前改动世界时用）`noProblems(sim, 标签)`，以及 `Sim` `source` `chunk` `float`。

`Sim` 速查（`scripts/lib/sim/world.mjs` 文件头有完整说明）：

| 类别 | 成员 |
|---|---|
| 构造选项 | `tree`（DSL 或 spec）`templates` `canvas` `canvasReadyAfterFrames` `t0`（`os.time` 起点，可带小数）`dt` `seed` `modules` `pairsOrder` `stepLimit` `texts` `language` `stageMode` `testPlay` `device` `onLog` |
| 生命周期与时间 | `load(源码)` `start()` `frame(dt)` `advance(秒, dt)` `destroy()` `finish()`；`sim.t`（虚拟时钟，秒；直接 `sim.t += 31` 可以模拟「帧还没来得及处理」） |
| 找控件 | `ctrl(名字或路径)` `find` `all()` `snapshot()`；控件上 `read(字段)`（整数→Number、字符串解码、枚举→值名）`worldRect()`（画布坐标矩形）`values` `layout` `children` |
| 事件 | `click(控件, {x,y})` → `{delivered, reasons}`　`clickAt(x, y)`　`cursorEvent(控件, 'CursorDrag', {…})`　`pressKey('KeyboardJumpKeyDown')`　`navigate(控件, 'Confirm')`　`signal(名, …参数)`　`setCustomVariable(实体类型, 名, 值)`　`float(5)`（强制 Lua 浮点） |
| 观察 | `logs` `logLines()` `faults()`　`errors`（未捕获的 Lua 错误）　`diags`（软诊断）　`problems()`　`sentSignals`　`activeTweens`　`tweens`　`stats.updates`　`treePrinted` |

### `tree`：看存档里的控件树

`node scripts/sim-lua.mjs tree 关卡.gil` 列出脚本所属控件的子树（名字 / 类型 / 尺寸 / 位置）；`--dsl` 只输出一行树描述。**布局是逆向推断**（§4）。

### `eval`：验证一小段 Lua 的语义

```sh
node scripts/sim-lua.mjs eval 'print(7 // 2, 7 / 2, 2^2, "hp:" .. 100 / 2)'     # 3  3.5  4.0  hp:50.0
```

不确定 Lua 5.3 在整数 / 浮点 / 取整 / 格式化上怎么表现时，跑一下比猜快。

## 2. 控件树怎么来

| 来源 | 写法 | 说明 |
|---|---|---|
| 存档 | `--gil 关卡.gil` | 树、类型、层级来自存档（【官方示例】，`ui.mjs` 头部）；布局来自 `layoutOfNode`（【逆向推断】）；类型认不出的控件按基类处理（只有基础字段），导入时会提示 |
| 手写 | `--tree '名字:类型@布局(子,子)'` | 类型别名 `container` `image` `text` `textwindow` `button` `area` `grid` `keyhint` `anim` `fullscreen` `reference`，或官方类型名 `ClientUI…Control`；布局 `x,y,宽x高` / `宽x高` / `stretch`（锚点拉满）；默认中心锚点、轴心 0.5 |
| 对象 | 构造 `Sim({ tree: {name, type, layout, children} })` | 场景脚本里直接传 |

```
容器节点:container@stretch(背景:image@0,0,1600x900,分数文本:text@0,350,218x68,圆圈容器:container@150x150(圆圈图片:image@80x80,圆圈点击区域:area@150x50))
```

要点：
- **`prefabIndex` = 存档里的控件 GUID**（【逆向推断】：真机探针里控件的 `prefabIndex` 与存档 GUID 同一数量级，契约 §3d）。`game.InstantiateClientUIControl(prefabIndex, parent)` 会按它在存档里找同 GUID 的控件当模板克隆（`templates` 选项可自己提供）。
- **初始兄弟顺序按存档里的 `children` 顺序**。编辑器列表顺序与 Lua 兄弟索引（大 = 在上，`SetAsFirstSibling` = 置底）是正序还是反序对应，**未确认**（契约 §8 只写了两种规则各自成立）。依赖初始层级的脚本要像官方示例那样自己 `SetAsFirstSibling` / `SetAsLastSibling`。
- 没给控件树时，脚本里所有 `GetChild` 都会取不到；smoke 会给 SIM063 并列出脚本引用了哪些控件路径。

## 3. 怎么读报告：规则与诊断码

每条诊断带**证据标签**：`真机` / `文档` / `官方示例` = 有出处；`模型` / `未确认` = 模拟器对引擎的猜测。**只有前者能当作平台事实引用。**

### 静态 · LS（`lib/lua/lint.mjs`，基于语法树）

| 码 | 级别 | 含义 |
|---|---|---|
| LS001 | error | 语法错误（真机加载期就会失败，整个脚本一个回调都不会执行）；含 5.4 的 `<const>`（5.3 里是语法错误）、`goto` 跳进局部变量作用域、重复标签 |
| LS002 | error | 读了没声明的全局（拼写错 / `local` 声明在使用之后 / 被裁剪的库 / 5.1 的 `unpack` `loadstring` `setfenv`） |
| LS003 | warning | 只写不读的全局（典型的拼写错误形态） |
| LS004 | warning | 生命周期函数被声明成 `local`（宿主按名字找全局函数，看不见） |
| LS005 | warning | 疑似生命周期名拼错 / 照搬别的引擎（`onStart` `Start` `Update` `OnClick`…） |
| LS006 | info | 局部变量从未被读取 |
| LS007 | error | 标准库里没有这个成员（`math.pow` `table.getn` `os.execute` `debug.getinfo`…，附正确写法） |
| LS008 | warning | 定义了 `OnUpdate` / `OnLevelUpdate` 却没有 `script:EnableUpdate(true)`（死代码；契约 §1 真机确证） |
| LS011 | warning | `typeof(x) == nil` 永远为假（`typeof(nil)` 是字符串 `"nil"`；契约 §9 真机确证） |
| LS018 | info | 浮点结果拼进文本（`/` `^` 在 5.3 里总得浮点，`"HP:" .. 100/2` → `HP:50.0`） |
| LS019 | warning | `fontSize` 赋了可能带小数的值（真机报 `integer expected, got number`；契约 §6） |
| LS022 | info | 大写 `Id` / `GetName()` / `GetId()`（控件标识是小写 `id` / `name` 属性，契约 §3） |

客户端 API 用法的正则规则（LX001–LX013）仍由 `scripts/check-lua-ui.mjs` 负责，`lint` / `smoke` 会一并跑。

### 运行时 · SIM

| 码 | 级别 | 含义 | 证据 |
|---|---|---|---|
| SIM010 | info | 读了控件 / `script` / `game` 上不存在的字段 → nil（附「你是不是想写 X」） | 真机 |
| SIM020 | warn | 补间字段名写错 → 真机**静默无效**（该键被忽略，附正确字段名） | 文档 D3 |
| SIM021 | warn | 补间创建了却从未 `Play()` | 文档 D2 |
| SIM022 | warn | 补间放进了序列但序列从未 `Play()` / 创建了序列从未播 | 文档 D6 |
| SIM023 | warn | 补间已放进序列又单独 `Play()` | 文档 |
| SIM024 | warn | 对已播完 / 已销毁的补间再 `Play()`（真机可能已自动销毁） | 未确认 |
| SIM025 / SIM026 | warn | 同一补间放进两个序列 / 补间时长非正 | 文档 / 未确认 |
| SIM030 | warn | 重复注册同一个监听 / 处理函数（替换还是叠加文档没写） | 模型 / 未确认（契约 §10） |
| SIM031 | info | 点击没有送达，附原因（`showCursor` / `raycastTarget` / 不激活 / 类型不对…） | 文档、真机 |
| SIM032 | warn | `Remove*Listener` 没找到要移除的回调（必须传注册时的同一个引用，匿名函数移不掉） | 文档 C3 |
| SIM040 | warn | 写入 NaN / inf（文档建议用 `math.isnan` / `math.isinf` 校验外部数值） | 文档 §3 |
| SIM041 / SIM042 | warn | `text` 赋了数字 / `Color` 分量越界 | 未确认 |
| SIM050 | info | `require` 的模块环境细节文档没写 | 未确认 |
| SIM060 | warn | 定义了 `OnUpdate` 却从未 `EnableUpdate(true)`（死代码） | 真机 §1 |
| SIM061 / SIM062 | info | `OnDestroy` 后仍有控件带监听 / 整个运行没有任何 `CursorClick` 监听 | 官方示例 / 模型 |
| SIM063 / SIM064 | warn / info | 没给控件树但脚本引用了控件 / 关卡导入提示（未识别类型等） | — |
| SIM070 | info | `GetChild` / `FindChild` 没找到 → nil（列出已有的子控件） | 文档 |
| SIM071 | warn | 对已销毁的控件操作 | 模型 |
| SIM080–SIM084 | info | `FindChild` 的 `A/B` 路径未验证 / `RefreshItems` 的 index 起点 / `SetLocalScale` 只传两个参数 / `FindClientUIRoot` 返回 nil / `GetText` 无本地化表 | 未确认 / 真机 / 模型 |
| SIM090 | warn | `script:Invoke("x")` 的函数不存在（`local` 函数宿主看不到） | 文档 |
| SIM092 | warn | 实例化的模板找不到 | 模型 |
| SIM099 | error | 文档里有的 API 模拟器没实现（这次调用被当成空操作）——自检保证正常不会出现 | 模型 |

## 4. 布局是怎么来的（逆向推断）

新式客户端控件在 `.gil` 里带一个 `(1,12)` 槽，里面有一条「默认」布局和三条带状态号的变体。`ui.mjs` 的 `layoutOfNode` 取**没有状态号**的那一条，其 `502` 组里：

`501{1,2,3}` = localScale　`502` = anchorMin　`503` = anchorMax　`504` = anchoredPosition　`505` = sizeDelta　`506` = pivot　（省略的分量 = 0）

依据：官方 3.21 存档里根容器 `anchorMax=(1,1)`（全屏拉伸）、背景 `sizeDelta=1600×900`、分数文本 `218×68 @ (0, 350)`；普查 48 个样本的 419 个新式控件，字段形状全部一致。**没有官方文档逐字段说明这些编号**，所以只用于模拟，不当作事实；三个「状态变体」对应什么（横竖屏？设备？）未知，没有读。换算成画布矩形用的是 Unity RectTransform 的标准公式（【模型】），画布默认 1920×1080（【未确认】）。

## 5. 保真度表：每条行为的依据

**Lua 语言层**（官方文档 §3：运行时是 **Lua 5.3**）

| 行为 | 模拟器怎么做 | 说明 |
|---|---|---|
| 整数 / 浮点两个子类型 | 整数 = BigInt（64 位回绕），浮点 = number；`4/2` → `2.0`，`7//2` → `3`，`2^2` → `4.0`，字符串参与算术按 5.3 转换 | 语言规范。**客户端 API 返回值是整数还是浮点**是另一回事，见下 |
| 字符串是字节串 | `#"圆"` = 3；`string.sub` 按字节；`upper` / `lower` 只动 ASCII | 语言规范 |
| 浮点显示 | `tostring` = `%.14g` 且整数值补 `.0`；`string.format` 的 `%f %e %g` 对**精确平局取偶**（`%.1f` 的 0.25 → `0.2`，`%.0f` 的 2.5 → `2`，JS 的 `toFixed` 会给 `0.3` / `3`） | C 语言规范；`cfloat.mjs` |
| 表 | 数组部分 + 哈希部分；浮点整数值键归一化；带洞表的 `#` 是一个合法边界 | 带洞表的 `#` 真机可能取到另一个合法边界 |
| 元表 | 全部运算类元方法、`__index` `__newindex` `__call` `__eq` `__lt` `__le` `__concat` `__len` `__tostring` `__pairs` `__metatable`；`getmetatable` 对字符串 / 宿主对象返回 nil | 契约 §7、§9 真机 |
| `goto` / 标签 | 有，含加载期检查（重复 / 找不到 / 跳进局部作用域） | 5.3 |
| 语法 | 严格 5.3：`<const>` / `<close>` 是语法错误 | 5.3 |
| 报错文案 | `块名:行号:` 前缀；`(local 'x')` `(global 'x')` `(field 'x')` `(method 'x')` `(upvalue 'x')`；原生函数被原生函数直接调用时没有前缀；`assert` 的字符串消息带前缀 | 5.3 |
| 标准库可见集合 | 有：基础函数、`string` `table` `math`（含 `isnan` `isinf`）、`os.time/date/clock/difftime`、`debug.traceback`、`require`、`utf8`；没有：`io` `coroutine` `package` `load*` `dofile` `collectgarbage` `string.dump/pack/unpack`、其它 `os.*` / `debug.*`、全局 `unpack`、`math.pow` 等 5.1 遗留 | 官方文档 §3、契约 §7 真机。`utf8`：文档和契约都没说裁掉，按 5.3 保留——**未确认** |
| `table.sort` | 照 `ltablib.c` 移植：相等元素的相对顺序与 5.3 一致；比较函数自相矛盾会报 `invalid order function for sorting` | 5.3 |
| 模式匹配 | 照 `lstrlib.c` 移植（`%b` `%f` 捕获 位置捕获 反向引用） | 5.3 |
| `pairs` 顺序 | 数组部分按下标，哈希部分按插入序 | **真机是哈希序**；依赖遍历顺序的脚本用 `--pairs-order reverse` 试 |
| 随机数 | 可设种子的生成器 | **序列与真机不同**，断言必须对任意种子成立 |
| 时间 | 虚拟时钟：`os.time()` = `t0` + 已推进秒数取整；`os.clock()` = 已推进秒数；`os.date` 默认 UTC | 真机是真实时间 / 本地时区 |
| 递归深度 / 死循环 | 递归受 JS 栈限制（约 500~900 层）→ `stack overflow` 错误；单次回调超过 5000 万步 → 中止（pcall 拦不住） | 真机允许更深的递归；真机遇到死循环是卡死 |
| `string.format` 的 `%a`、协程 | 不支持 | 罕见 / 被裁剪 |

**客户端 API 层**

| 行为 | 依据 | 出处 |
|---|---|---|
| 控件按类型封死：读不存在的字段 → nil；写不存在的字段 → `cannot set <字段>, no such field` | 真机 | 契约 §4 |
| 写只读字段（`active` `id` …）→ 同一句报错 | 模型（措辞没有真机出处） | — |
| `id` `prefabIndex` `name` 是属性；大写 `Id` 读为 nil；没有 `GetName()` / `GetId()` | 真机 | 契约 §3、§3c |
| `tostring(控件)` = `类型名:id`；`id` 先序递增（根 = 1） | 真机（形）/ 模型（递增细节） | 契约 §3b、§3d |
| `pairs(控件)` 报 `bad argument #1 to 'for iterator' (table expected, got ClientUIContainerControl)` | 真机 | 契约 §3d |
| `getmetatable(控件 / script / game)` = nil | 真机 | 契约 §9 |
| `fontSize` / `minimumFontSize` 要整数：`bad argument #2 to 'fontSize' (integer expected, got number)` | 真机 | 契约 §6 |
| 布尔 / 数字 / 枚举 / 颜色字段与方法参数的类型校验（措辞仿上一条） | 模型 | — |
| `text` 赋数字：转成字符串并警告 | 未确认 | — |
| `Get*` 布局方法返回多个值（浮点）；`SetLocalScale(x, y)` 只传两个参数时接受 | 官方示例 / 未确认 | 文档 §13 |
| `GetChildren()` 返回数组式表；`GetChild` 只看直接子控件；`FindChild` 支持 `A/B` | 真机（`A/B` 路径没验证） | 契约 §3d、§8、§10 |
| 同级索引越大越靠上；`SetAsFirstSibling` 置底、`SetAsLastSibling` 置顶；返回 boolean | 文档 | §13 / 契约 §8 |
| 从存档导入的初始兄弟顺序 = 存档里 `children` 的顺序 | 未确认 | — |
| 光标监听只在预设按钮 / 光标检测区域上（其它控件没有这个方法） | 真机 | 契约 §8 |
| 光标事件收得到的条件：容器 `showCursor=true`（默认 `false`）、`raycastTarget=true`、控件激活；可见性与 `interactable` 也算 | 文档 + 真机 / 模型 | 文档 C1、C2；契约 C1 |
| 点击按顺序发 `CursorDown` `CursorUp` `CursorClick`；回调收 `CursorEventData`（`dragging` `touchId` `GetUIPos` …，默认坐标 = 控件矩形中心） | 文档 / 模型 | 文档 §17–§19 |
| `Remove*Listener` 必须传同一个引用；重复注册 = 叠加；`SetActive(false)` 再 `true` 后监听依然存活 | 文档 C3 / 未确认 | 契约 §10 |
| 按键事件：回调返回 `true` 中断后续派发；派发顺序 = 渲染靠上的先收 | 文档 + 真机 / 模型 | 文档 §13、契约 §8 |
| 生命周期 `OnInit → OnEnable → OnStart`；`SetActive(false)` 立刻 `OnDisable`；`SetActive(true)` 触发 `OnEnable` 不重跑 `OnStart` | 真机 | 契约 §1 |
| `EnableUpdate` 之前没有 `OnUpdate`；`OnUpdate` 只收一个 `dt`（秒，浮点）；`PauseLevelTime` 只挡 `OnLevelUpdate` | 真机 | 契约 §1、§8、§9 |
| `OnLevelUpdate` 是否也要先 `EnableUpdate`；`dt` 的真实单位 | 未确认 | — |
| 控件不激活 → 挂载脚本不运行 | 文档 | §13 |
| 补间：默认绝对目标值；`Linear` 时间线性；`SetRelative(true)` 为增量；`Kill(true)` 切到终态并触发完成回调、`Kill(false)` 停在当前且不触发 | 文档 + 真机 | §7、契约 §8 |
| 补间字段名写错 → 静默无效；必须 `Play()`；序列才负责播放里面的补间 | 文档 | D2、D3、D6 |
| 补间缓动曲线（Penner 公式）、默认缓动 `Linear`、起点在「轮到它」时才取、循环是重头再来 | 模型 / 未确认 | — |
| `ServerSignal` 的 `Add*` / `SendSignal` 没有返回值；`AddInt(1.5)` 报 `integer expected` | 文档 / 模型 | §9 |
| 信号回调收 `(信号名, 数组)`，下标从 1；`GetParam` 保型；`Invoke` 找不到函数 → 警告不报错 | 文档 + 真机 / 未确认 | E1、契约 §8 |
| `game` 必须点号调用：冒号报 `bad argument count … (N expected, got N+1)` | 真机（形）/ 模型（文案） | 契约 §5 |
| `FindClientUIRoot` 对容器返回 nil；`GetClientUIRoots()` 给出脚本所在的根 | 真机 / 未确认 | 契约 B1 |
| `InstantiateClientUIControl` 在 `OnInit` / `OnDestroy` 里返回 nil，`OnStart` 里返回控件；实例化的图片写 `imageType` 报 `no such field` | 真机 | 契约 §2、§8 |
| `GetUICanvasSize()` 画布未就绪时返回非正数；默认画布 1920×1080 | 官方示例 / 未确认 | 契约 §1 |
| 枚举值是 `EnumItem`，`EaseType` 恰好 31 项；字段是大写 `Name` `FullName` `EnumType`；`FullName` 写法 | 真机 / 文档 / 未确认 | 契约 §9、文档 §10 |
| `Color` 是打包整数；`a` 省略 / nil = 255；通道字节序、越界处理、`ToRGBA` 返回整数 | 真机 + 文档 / 未确认 | 契约 §8、文档 §4 |
| `script.path` = `default_import_file/levelScript`；没有的字段读 nil 写报错 | 真机 | 契约 §8、§4 |
| `require`：可用、独立环境、有缓存、不跑 `OnInit` / `OnStart`；模块里的 `script` 是谁 | 真机 / 未确认 | 契约 §7 |
| `typeof(nil)` 是字符串 `"nil"`；`typeof(控件)` = 类型名 | 真机 | 契约 §9、§3d |
| 布局矩形的换算、画布尺寸；存档布局字段的含义 | 模型 / 逆向推断 | §4 |

## 6. 校准与自检：靠什么相信它

- **校准点**：官方教程 3.21 的脚本（`references/live/mh47p30a87qo_official-sample-main.lua`）在模拟世界里的行为（监听只注册一次、第 10 击发 `success` 且只发一次、成功后点击区关闭、画布未就绪时重试、重试预算用完报错、`showCursor` 被去掉时点击被丢弃）——**这是模拟器唯一对照过的引擎行为样本**。
- **自检** `node scripts/check-lua-sim.mjs`（离线，约 7 秒）：Lua 语义用例表（135 条，含 16 个程序级用例，期望值由 JS 独立算出或是公认结果）、浮点格式化、值与表、lint 规则正反例、树描述、冒烟、API 表（与 `client-api.json` 一致；文档里每个字段 / 方法 / 函数模拟器都有实现，反向也没有凭空多出来的；与 `check-lua-ui.mjs` 的枚举 / 补间 / 只读三张表交叉核对）、世界契约（每条真机 / 文档事实一条用例，用例名后标出处）、官方示例校准、圆圈挑战示例、（有样本时）官方 `.gil` 的导入与布局解码。
- **API 表不手抄**：`references/formats/data/client-api.json` 由 `node scripts/build-client-api.mjs` 从官方「客户端控件API文档」（条目 `mhtakr07vej4`）的表格机械解析生成；镜像在时 `--check` 校验没有过期。手抄过一次就抄错了：漏了 `RemoveCursorEventListeners` / `SimulateCursorClick`、把 `EnumItem.Name` 写成小写。

## 7. 真机结果回填：模拟器与真机不一致时怎么办

1. 先复现成最小的场景 / 冒烟用例，确认不是脚本问题。
2. **改模型**（`scripts/lib/sim/` 下的 `world.mjs` `control.mjs` `hosts.mjs` `tween.mjs`），让它与真机一致；在 `scripts/lib/sim/selftest-contract.mjs` 里加 / 改对应用例，**用例名标出处**（真机日期）。
3. 改本文 §5 的对应行：依据写成「真机 + 日期」；如果是 API 事实，同步写进 `references/api/runtime-contract.md`。
4. `node scripts/check-lua-sim.mjs` 全绿；把这次真机结果记进 `references/formats/verification-ledger.md`。

**第一次真机试玩是最值钱的数据点**：圆圈挑战示例（`references/examples/circle-challenge/`）里凡是标了「未在真机验证」的地方，试玩结果请按上面的流程回填。

## 8. 文件索引

| 文件 | 内容 |
|---|---|
| `scripts/sim-lua.mjs` | 命令行（lint / smoke / run / test / tree / eval） |
| `scripts/check-lua-sim.mjs` | 模拟器自检 |
| `scripts/build-client-api.mjs` | 官方 API 文档 → `data/client-api.json`（`--check` 校验过期） |
| `scripts/lib/lua/` | Lua 5.3 解释器：`lexer` `parser` `resolve`（作用域）`interp` `stdlib` `lib-string`（含模式匹配与 `string.format`）`cfloat`（C 风格浮点格式化）`value` `lint` `run` `cases`（语义用例表） |
| `scripts/lib/sim/` | 千星奇域世界：`world`（`Sim`）`control`（控件）`hosts`（script / game / ServerSignal / Color）`tween` `easing` `enums` `color` `level`（树描述与 `.gil` 导入）`smoke` `scenario`（场景测试台）`client-api`（读 JSON）、`selftest-*`（自检用例） |
| `references/formats/data/client-api.json` | 官方 API 文档的结构化解析（18 个类型、100 个字段、119 个方法、26 个 game 函数、27 组枚举） |
| `references/examples/circle-challenge/` | 完整示例：`main.lua`（游戏）`tree.txt`（控件树）`scenario.mjs`（整局场景测试） |
