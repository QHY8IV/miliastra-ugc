# 静默失效成因清单（客户端 Lua UI）

> 依据：`客户端控件API文档`（条目 id `mhtakr07vej4`，镜像抓取时间 2026-09-25T17:54:09.605Z）。
> 每条右侧括号内是原文出处的小节号，便于回查。

千星奇域客户端脚本最坑的地方不是报错，而是**不报错也不生效**。宿主按名字查回调、按名字查控件、按字段名插值——名字对不上就静默跳过。下面按"症状 → 成因 → 改法"排列。

---

## A. 回调根本不执行

### A1 `OnUpdate` 多写了一个参数
```lua
function OnUpdate(dt, elapsed) end   -- 错：只看第一个
function OnUpdate(dt) end            -- 对
```
宿主按固定名称查找并调用，`OnUpdate` 只声明 `dt: number` 一个参数。（§1）

### A2 自己造生命周期名
`OnClick`、`Register`、`Start`、`Update`、`Awake` **都不是**宿主回调。宿主只查这七个名字：
`OnInit` / `OnStart` / `OnEnable` / `OnDisable` / `OnUpdate` / `OnLevelUpdate` / `OnDestroy`。（§1）

用错的效果是函数被定义但永不调用——脚本"没反应"。逻辑入口要么挂在宿主回调里，要么自己显式调用（`script:Invoke("函数名", ...)`，§5）。

### A3 该逐帧的没逐帧
`OnUpdate` 不受关卡时停影响；`OnLevelUpdate` 受时停影响。要"游戏暂停时界面也停"，必须用 `OnLevelUpdate`。（§1）

`script:EnableUpdate(false)` 会关掉自己的逐帧更新——调过之后忘了重开，表现就是"跑一会儿就不动了"。（§2、§5）

---

## B. 控件拿不到

### B0 容器里根本没加控件
`GetChildren()` 返回 **0 项**时，后面所有 `GetChild` / `FindChild` 必然都是 nil——**不是查找写错，是里面真的空的**。

**挂脚本 ≠ 有控件。** 客户端控件只能在容器的
**画布设置 → 前往编辑 → 添加控件**里加；脚本挂在容器节点上不会自动产生子控件。
（出处：`客户端控件容器` 条目 `mhlz2lrly3dq`；`客户端控件和客户端脚本` `mhbgxf0nynww` 原文
"客户端控件只有在_客户端控件容器_的画布设置，或_客户端控件模板_中才能添加"）

判据：`#root:GetChildren() == 0` → 先回编辑器加控件，**别再改代码**。
（2026-09-27 真机：容器已挂载并运行脚本，`GetChildren()` 与 `pairs` 枚举同为 0 项。）

> **后续对照（同一容器，同日 23:53）**：在「画布设置 → 前往编辑」里加了两个控件之后，
> 同一份探针实测 `GetChildren()` 返回 **2 项**、`#` = 2，`FindChild("AddButton")` 直接拿到控件。
> **空 → 有** 的对照坐实了 B0 的判据：拿不到子控件时先看计数，别先怀疑查找写法。

顺带：控件树看不清时直接 `game.PrintClientUITree()`，比猜名字快。

### B1 用错查找入口
- `game.FindClientUIRoot(nodeName)` 找的是**UI 根控件**，不是任意子控件；**对客户端控件容器实测返回 nil**。（§6、真机）
- 子控件要用 `控件:GetChild(name)` 或 `控件:FindChild(path)`。（§13）
- **脚本挂在容器上时，入口就是 `script.object`**，不用再找。（真机，见 `runtime-contract.md` §3b）
- 控件标识是**属性**不是方法：`.name` / `.id`，没有 `:GetName()` / `:GetId()`。（真机，§3c）

### B2 父级没激活
`active=false` 时控件不可见**且挂载脚本逻辑停止运行**。父级不激活，子控件全部不工作。
`activeInHierarchy` 才是计入全部父级后的实际状态——排查时看这个，别看 `active`。（§13）

### B3 把只读字段当 setter 用
```lua
ctrl.active  = true    -- 错：active 只读
ctrl.visible = false   -- 错：visible 只读
ctrl:SetActive(true)   -- 对（同时影响脚本是否运行）
ctrl:SetVisible(false) -- 对（只影响可见性，不停脚本）
```
`alive`、`id`、`prefabIndex`、`active`、`activeInHierarchy`、`visible` 都是**只读**；`name`、`parent` 及各类坐标/缩放/锚点字段是读写。（§13）

### B4 脚本已销毁还在用
控件上取到的脚本实例可能因销毁而不再存活，**使用前检查 `script.alive`**。（§5、§13）

控件树整体看不清时：`game.PrintClientUITree()` 把当前控件树按父子层级写进日志。（§3）

---

## C. 交互不响应

### C1 忘了开常驻光标
`CursorEvent` 相关方法**都需先把容器的 `showCursor` 设为真**才可正常使用。（§24）
这是最典型的"代码没错但不响应"。

> **2026-09-27 真机：容器 `showCursor` 实测默认就是 `false`。**
> ```
> [探针4] showCursor = false <boolean>
> ```
> 也就是说**新建的容器默认收不到光标事件**，第一版"点了没反应"十有八九是它。
> 先在编辑器里打开这个字段，再怀疑代码。脚本里写 `root.showCursor = true` 可以试，
> 但**回读确认为 true 之前不要假设它生效了**。

### C2 忘了开射线检测
预设按钮、光标检测区域、网格视窗都有 `raycastTarget` 字段，为 `false` 时光标射线打不到它。（§17、§18、§20）

### C3 监听注册了但拿不到引用去移除
`RemoveKeyEventListener(eventType, callback)` / `RemoveCursorEventListener(eventType, callback)` 要求**回调必须是注册时的同一个引用**。写成匿名函数就再也移除不掉，只能 `RemoveAllXxxEventListeners()` 全清。（§13、§17）

### C4 事件被上层吃掉
同一个容器里，如果交互按键事件已被某个 Lua 回调响应并标记为已处理，容器内其他按键不会响应本次事件。（§13）

---

## D. 动画不动

### D1 用冒号调 `game` 的函数
```lua
game:Tween(obj, {...}, 0.2)   -- 错
game.Tween(obj, {...}, 0.2)   -- 对
```
`game` 是全局表，**文中函数一律点号调用**；而 `Tween`/`TweenSequence`/`ServerSignal` 返回的**对象方法一律冒号调用**（`tween:Play()`）。（§6、§7）

### D2 忘了 `Play()`
`game.Tween(...)` 只是**创建**，不会自己播。要 `game.Tween(...):Play()`（或先接 `SetEase` 再 `Play`）。（§7）

### D3 补间的字段名不存在
插值是按 `tweenDataTable` 的键去写对象字段。写错键名 → 静默无效。
- `scale` **不存在**。缩放字段是 `localScaleX` / `localScaleY` / `localScaleZ`。（§13）
- 文本框可补间：`fontSize`、`fontColor`、`bgColor`、`outlineColor`、`minimumFontSize`。（§15）
- 基类可补间：`anchoredPositionX/Y`、`sizeDeltaX/Y`、`anchorMinX/Y`、`anchorMaxX/Y`、`pivotX/Y`、`localScaleX/Y/Z`、`localRotationX/Y/Z`。（§13）

### D4 缓动枚举名照搬前端习惯
枚举值是 **PascalCase**：`Enum.EaseType.OutBack`。
`easeOutBack` / `EaseOutBack` / `back.out` 都不存在。（§11）

### D5 相对值与绝对值搞混
`Tween:SetRelative(true)` 时，目标值被解释为**相对当前值的增量**；默认 `false` 是绝对目标值。做"点一下弹一下"用相对值更稳。（§7）

### D6 "点一下弹一下"只写了去程 —— 只有第一次点得动
```lua
-- 错：只补间到 1.08。补间结束控件就停在 1.08。
--     下一次点击时起点 == 终点（都是 1.08），看不见任何变化——而且不报错。
local tw = game.Tween(ctrl, { localScaleX = 1.08, localScaleY = 1.08 }, 0.08)
tw:Play()
```

改法：用 `TweenSequence` 把回程接上（文档 §6 的官方玩法；Tween 自己不 Play，序列才 Play）：

```lua
local out  = game.Tween(ctrl, { localScaleX = 1.08, localScaleY = 1.08 }, 0.08)
local back = game.Tween(ctrl, { localScaleX = 1.0,  localScaleY = 1.0  }, 0.08)
local seq  = game.TweenSequence()
seq:Append(out)
seq:Append(back)
seq:Play()          -- 序列不 Play，里面的补间一个都不会动
```

**为什么会踩**：重复点击的常规写法是 `Kill(false)` 掉上一条再建一条。上一条若已停在终点，新建的那条就是"终点 → 终点"，**静默无事发生**——现象是"第一次点有动画，之后就没有了"。（§6、§7）

---

## E. 和服务端联不上

### E1 信号参数下标从 0 数
`script:RegisterServerSignalHandler(signalName, callback)` 的回调签名是
`fun(signalName: string, signalParams: any[])`——`signalParams` 是 **Lua 数组**，下标从 **1** 开始。（§5）

### E2 发信号漏了 `SendSignal()`
```lua
local s = game.ServerSignal("ScoreChanged")
s:AddFloat(score)
s:SendSignal()          -- 不调这句，信号不出去
```
参数按服务器约定**依次**添加，顺序必须与服务端节点图的接收顺序一致。（§9）

### E3 类型方法用错
`AddInt` / `AddFloat` / `AddString` / `AddBool` / `AddVector3` / `AddGuid` / `AddEntity` / `AddPrefabId` / `AddConfigId`，每种都有对应 `...List` 版本，另有通用的 `AddParam(paramType, paramValue)`。（§9）

### E4 自定义变量监听拿不到值
`script:RegisterCustomVariableChangedHandler(entityType, customVariableName, callback)` 的回调**只给实体类型和变量名**，当前值要自己再读：
```lua
local v = game.GetGlobalCustomVariableValue(Enum.CustomVariableEntityType.Level, "分数")
```
`entityType` 取 `Enum.CustomVariableEntityType` 的 `Level` / `PlayerSelf` / `AvatarSelf`。（§5、§6）

---

## F. 环境层

### F1 用了被裁掉的标准库
运行时是 **Lua 5.3**，下列不可用：
- `io.*` 全部
- `coroutine.*` 全部
- `string.dump`
- 除 `os.time` / `os.date` / `os.clock` / `os.difftime` 外的 `os.*`
- 除 `debug.traceback` 外的 `debug.*`

补充了两个方法：`math.isnan(n)`、`math.isinf(n)`。（§3）

掉这些都**不报错也不生效**，只是函数是 nil。

### F2 用 `print` 当成断言
`print(...)` 写普通日志；`printerr(...)` 写错误级别日志，**不抛错、不阻断运行**。所以"日志里没红字"不等于逻辑正确。（§3）

`debug.traceback()` 只**返回**文本，不会自动写日志——要自己 `print(debug.traceback())`。（§3）

---

## G. 多平台适配

- `game.GetDevice()` 返回 `Enum.Device`：`KeyboardAndMouse` / `Mobile` / `Controller` / `MobileController`。（§6、§11）
- 手柄聚焦：`game.SetControllerFocus(ctrl)` / `game.GetControllerFocus()`；控件侧 `canControllerFocus` 要可聚焦。（§6、§13）
- 手柄导航事件与配置：`AddNavigationEventListener` / `SetControllerNavigation(navigationDir, navigationMode, navigationTarget)`，方向取 `Enum.ControllerNavigationDir`（Up/Down/Left/Right），模式取 `Enum.ControllerNavigationMode`（`None` / `NearestControl` / `Specified`）。（§13、§11）
- 文本视窗的 `interactable` 与 `showScrollBar` **同时为 false 时手柄无法滚动**。（§16）
- 网格视窗复用列表生成的列表项**不保证同级排序结果稳定**——不要依赖顺序做逻辑。（§13、§20）

---

## H. 模拟器的边界（可选自测面，不是判据）

> **技能自带的离线模拟器**（`scripts/sim-lua.mjs`，零依赖）能把上面 A–G 里的大部分静默失效离线复现并报出原因——回调不执行（`SIM060` / `LS004` / `LS005` / `LS008`）、控件拿不到（`SIM070`）、点击收不到（`SIM031`）、动画不动（`SIM020` / `SIM021` / `SIM022`）、信号不发、读错字段（`SIM010`）等。它同样**不是判据**：是 Lua 解释器加对引擎的建模，只对照过官方 3.21 示例；每条诊断带证据标签。用法、诊断码、保真度表见 `references/formats/lua-sim.md`。

下面是另一个**第三方**外置沙箱的边界。

`miliastra-beyond-simulator`（npm `dsh-plugin-beyond-simulator`，仓库 `1475505/miliastra-beyond-simulator`）可以用来自测，但**它的通过不等于真机通过**，以下边界摘自其 README：

1. 它是 **2D** 沙箱，面向 2D + Lua 驱动的玩法。
2. 服务端模拟**只覆盖变量与信号**，不含完整官方服务端节点图，也不是真实网络联机。
3. 图片预览以基础图元为主，只代理图片 ID `100001–100006`，其他素材显示缺失。
4. GIA 导入导出只支持**已验证的内容子集**，部分控件属性与脚本挂载关系无法完整交换。
5. 安装包**不包含官方知识库**，需要另行准备 Lua 参考资料。
6. 其 README 里的 `dsh plugin --profile web add dsh-plugin-miliastra-toolbox` 命令**在 npm 上取不到该包**，需改用 GitHub 源安装。

**用法**：拿它验证生命周期是否被调到、控件是否取到、Tween 是否播放、信号参数顺序是否正确。这些结构性错误它抓得到；渲染细节、真机手感、服务端节点图行为它抓不到。
