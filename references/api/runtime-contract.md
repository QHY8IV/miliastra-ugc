# 运行时契约（官方文档之外的第二来源，带证据分级）

> **来源**：第三方逆向工程仓库 `1475505/miliastra-beyond-simulator` 的
> `client/lua-runtime/docs/observed-contract.md`（master 分支），
> 内容为「官方 API 文档表面 + 三轮 `probes/engine-fidelity` 日志」的结论。
> 该仓库自己声明：**不把模拟器回归当成真机通过**。
>
> 本文**优先级说明**：与 `client-ui-api.md`（官方文档逐字抄录）冲突时，以本文件为准；
> 本文件也未覆盖的，以编辑器内实测为准。每条后面的括号是该仓库给出的证据来源。
>
> **本文的事实是技能自带离线模拟器的建模依据之一**（`references/formats/lua-sim.md` §5 逐条列出对应关系；`scripts/lib/sim/selftest-contract.mjs` 里每条真机 / 文档事实各有一条用例，用例名标出处）。
> 真机结果与本文 / 模拟器不一致时：改本文、改模拟器的用例与模型、改 `lua-sim.md` §5，再跑 `node scripts/check-lua-sim.mjs`。

---

## 1. 生命周期与调度（本条含真机标记）

- 顺序：`OnInit` → `OnEnable` → `OnStart`；**`EnableUpdate` 之前不会有 `OnUpdate`**；
  退出为 `OnDisable` → `OnDestroy`。（2026-08-29 真机）
- `SetActive(false)` **立刻**触发 `OnDisable`；`SetActive(true)` 再触发 `OnEnable`，
  **不重跑 `OnStart`**。（同上）
- `OnUpdate` 只收到一个 `dt`。
- ▸官方示例 **`OnStart` 时画布尺寸可能还没就绪**：`game.GetUICanvasSize()` 会返回非正数或 `nan`/`inf`。
  官方做法是 `OnStart` 里只 `script:EnableUpdate(true)`，真正的初始化放 `OnUpdate` 逐帧重试，
  并设 60 帧重试预算；初始化成功后立刻 `EnableUpdate(false)`。
  （来源：`references/live/mh47p30a87qo_official-sample-main.lua`）

> **写代码的直接后果**：定义了 `OnUpdate` 却从不调用 `script:EnableUpdate(true)`，
> 那个函数是**死代码**——不报错、不执行、日志里什么都没有。
>
> 反过来，**在 `OnStart` 里默认"画布已就绪"同样是错的**——官方示例专门为这件事写了重试循环。

## 2. 控件实例化与激活

- `InstantiateClientUIControl` 的生命周期限制官方文档未记载。探针结果：
  在 `OnInit` / `OnDestroy` 中调用返回 nil；在 `OnStart` 中返回控件。
- 实例的 `active` / `visible` **继承模板定义**，运行时不再强制打开。
- **官方加工稿称 `active` 「默认为 false」，但真机未改过的客户端模板实例为 `true`**；
  明确设为 false 的模板实例为 `false`。编辑器 Authoring 新建节点默认 true。

## 3. 控件标识字段（★ 2026-09-27 真机钉死，本条已改判）

- **正确字段是小写 `id`。大写 `Id` 读为 `nil`。**
  2026-09-27 23:33 真机回传（探针 v2 / v3 两轮一致，容器 `script.object` 直读）：

  | 字段 | 真机值 |
  |---|---|
  | `.id` | `1` `<number>` |
  | `.prefabIndex` | `1073741874` `<number>` |
  | `.name` | `容器节点` `<string>` |
  | `.visible` | `true` `<boolean>` |
  | **`.Id`** | **`nil` `<nil>`** |

- 其余标识字段不变：`prefabIndex`；`Script` 侧为 `scriptMappingId`；
  网格视窗为 `itemPrefabIndex`；模板引用为 `referencedPrefabIndex`。
- **本条旧版曾断言「以 `Id` 为准，小写 `id` 是旧接口」——已被真机推翻。**
  被推翻的根因：那条来自 `miliastra-beyond-simulator` 的**模拟器**观测，
  该仓库自己也声明「不把模拟器回归当成真机通过」。**模拟器与真机在此字段上不一致。**
- 兜底顺序：先 `id`，取不到再试 `Id`。

## 3b. `script.object` 就是挂载点本身（真机）

脚本挂在容器节点上时，`script.object` **直接就是那个容器控件**，不需要 `FindClientUIRoot`：

```
[探针] script.object = ClientUIContainerControl:1  (type=ClientUIContainerControl)
```

`ClientUIContainerControl` 继承 `ClientUIBaseControl`，所以 `GetChild` / `FindChild` / `GetChildren`
可以直接从 `script.object` 往下走。
**写 UI 脚本的正确入口是 `script.object`，不是 `FindClientUIRoot`**——后者只找 UI 根控件，
在同一容器上实测 `FindClientUIRoot(容器名)` 与 `FindClientUIRoot(索引)` **都返回 nil**。（2026-09-27 真机）

## 3c. 属性 vs 方法（真机）

控件标识**没有 getter 方法**，只有属性：

```
[探针2] root:GetName() !! 报错：attempt to call a nil value (method 'GetName')
[探针2] root:GetId()   !! 报错：attempt to call a nil value (method 'GetId')
```

不要写 `:GetName()` / `:GetId()`，用 `.name` / `.id`。

## 3d. 控件树与方法表（真机 v4，2026-09-27 23:53）

容器里加好控件之后的真实形状：

```
[探针4] root:GetChildren() 返回类型 = table
[探针4] #kids（数组部分）      = 2
[探针4] ---- 子节点 #1  key = 1
[探针4]      typeof = ClientUIPresetButtonControl
[探针4]      name   = AddButton   id = 2   prefabIndex = 1073741876
[探针4] ---- 子节点 #2  key = 2
[探针4]      typeof = ClientUITextBoxControl
[探针4]      name   = ScoreText   id = 3   prefabIndex = 1073741875
```

**`GetChildren()` 返回数组式表**（key 为 `1..n`），`#` 正常可用。
所以 v3 那次 `# = 0` 是**容器真的空**，不是"数法不对"——`#` 数不了 map 的担心已被证伪。

**按名字取子控件：扁平名即可**，不必拼路径：

```
[探针4] FindChild("AddButton") → ClientUIPresetButtonControl:2
[探针4] GetChild("AddButton")  → ClientUIPresetButtonControl:2
```

**控件对象不是 table**——`pairs(控件)` 直接报错：

```
[探针4] pairs(root) 失败：ahdkjahskjdhlaks:103: bad argument #1 to 'for iterator'
        (table expected, got ClientUIContainerControl)
```

配合 §9 的 `getmetatable = nil`，**方法表在 Lua 侧完全不可枚举**。
唯一可行的办法是**逐个测存在性**——`pcall` 只包【读取】，不包调用：

```lua
local ok, v = pcall(function() return obj[k] end)   -- 读，不是调
if not ok then return "!! 读取出错" end
if v == nil then return "nil ← 不存在" end
return typeof(v)
```

真机结果：官方 `ClientUIBaseControl` 全量 **36 个方法 + 预设按钮 4 个，全部 `= function`**；
`game` 的 23 个函数、`script` 的 7 个方法同样全部存在。

**结论：API 名只能查文档，但可以用"存在性探测"在真机上 100% 验证，不必猜。**

## 4. 控件字段的两种失败模式

- 控件 userdata **按类型封死**：当前类型没有的字段，**读为 nil**，
  **写报 `cannot set <field>, no such field`**。
- 所以字段名写错有两种表现：写 → 明确报错；读 → 静默 nil。
  排查时不要把"静默"当成"没生效"。
- Lua 表面只开放官方文档列出的字段/方法。文档未写的（`script.tickEnabled`、
  `EnumItem.__kind`、`enableFill`、按钮四态等）读为 nil、写报错。

## 5. `game` 必须点号调用（真机回传）

2026-09-25 日记脚本真机回传：`game:GetClientUIRoots()` 报
`bad argument count ... (0 expected, got 1)`。同一脚本的 `game:GetUICanvasSize()`
也应改点号。

> 官方文档另有一句"以下函数均使用点号调用"，可作旁证。
> 注意：仓库自述"参数个数统一核对"是**模拟器防错策略**，只有 `GetClientUIRoots`
> 的零参约束标注为真机确认；其余函数冒号调用在真机上具体报什么，尚未逐条确认，
> 但**语义上都是错的**（会多传一个 `game`）。

## 6. 字号必须是整数（真机日志）

- 真机报错：`bad argument #2 to 'fontSize' (integer expected, got number)`，
  调用链算出 `38 * .62 = 23.56`。（2026-09-27 用户提供日志，原件待补）
- 官方文档把文本框与文本视窗的 `fontSize` / `minimumFontSize` 声明为 `integer`，与此一致。
- **写代码时**：`fontSize` 赋值前用 `math.floor`，不要传小数。
- 该修复只覆盖"直接赋值"，**不外推**到 Tween 内部插值、其它控件字段或字号上下限。

## 7. 运行时裁剪（比官方文档列的更多）

| 可用 | 不可用 |
|---|---|
| `require`（已映射脚本路径；独立环境；有返回值；有缓存；**不跑 OnInit/OnStart**） | `load` `loadfile` `dofile` `collectgarbage` `package` `coroutine` `io` |
| 字符串方法语法保留（但全局 `getmetatable` 对字符串隐藏） | `string.dump` `string.pack` `string.unpack` |
| `math` 保留 `modf` `ult`，额外提供 `isnan` `isinf` | 文档异常行提到的 `math.isnaf` 语义无处记载，**按反编造政策不提供**（读为 nil） |

- 普通 Lua 表的 `typeof` 返回 `table`。
- Fengari 的整数仍是 32 位，这是**模拟器底层限制，不能当作客户端整数结论**。

## 8. 其它确证行为

- `GetParam`：string / integer / float / boolean **保型**。
- Tween **默认绝对**；`Linear` 为时间线性。
- `PauseLevelTime` **只挡 `OnLevelUpdate`**。
- 按键监听回调返回 `true` 会**中断后续**派发。
- `SimulateCursorClick` 发送的是 `Click`，**坐标不必落在控件中心**。
- `FindChild` 支持 `A/B` 路径；`GetChild` **只有一层**。
- `Color` 在运行时是**打包整数**。
- **光标监听只挂在「预设按钮」和「光标检测区域」上**。
- 层级：显式层级数值大的在上；编辑器同级列表**先出现的在上**；
  Lua sibling **大索引置顶**，`First` 置底、`Last` 置顶。
- `script.path` **保留目录**（真机回传返回 `default_import_file/levelScript`，
  不是短名 `levelScript`）。
- `ClientUIImageControl.imageType`：**只有部分图片支持设置**。已观察到对刚
  实例化出的图片赋值报 `cannot set imageType, no such field`。不要全局依赖它。

## 9. 已结案（2026-09-27 真机，探针 v1–v3）

- **`Enum.EaseType` 全量 = 31 项，与 `client-ui-api.md` §11 清单逐项一致，无额外成员。**
  真机 `pairs(Enum.EaseType)` 枚举出 31 项（`OutQuart` `InOutBounce` `InElastic` `InBack` `OutExpo`
  `OutSine` `InQuint` `OutBounce` `InOutSine` `InOutQuint` `InCirc` `Linear` `InOutElastic`
  `InOutQuart` `OutCubic` `InSine` `InOutBack` `InCubic` `OutElastic` `OutBack` `OutQuint`
  `InOutCirc` `OutCirc` `InBounce` `InOutExpo` `InOutCubic` `InQuart` `OutQuad` `InExpo`
  `InOutQuad` `InQuad`）。成员是 `EnumItem`，不是字符串。
- **`OnUpdate` 默认不调度** —— 已从「未写默认值」升级为真机确证：
  不调 `EnableUpdate` 时整局 **0 帧**；调 `script:EnableUpdate(true)` 后 **3080 帧**。
  `EnableUpdate(true)` 返回 `nil`，调用本身不报错。
- **`typeof(nil)` 与 `type(nil)` 都返回字符串 `"nil"`**，不是 Lua 的 nil。
  这是引擎约定，**不是探针 bug**——判 nil 用 `== nil`，别用 `typeof`。
- **`debug` 库只剩 `traceback`**，`debug.getinfo` 不可用（想要行号时会踩）。
- **`getmetatable` 对控件 / `script` / `game` 一律返回 `nil`**，方法表**无法枚举**。
  → **API 名字只能回文档查，不要再花一轮探针试图列出方法。**

## 10. 尚未确认（写代码时留余地）

- `OnClick` 这类"脚本级点击回调"在运行时契约里**不存在**；`self` 自动注入也查不到出处。
  **改用显式 `AddCursorEventListener`**，不要依赖它。
- `signalParams` 的元素个数、类型与顺序，取决于服务端「信号管理器」里的定义；
  只能确定**索引从 1 开始**、回调签名为 `fun(signalName, signalParams)`。
- 「服务端节点图发信号 → 客户端脚本收到」这条链路没有端到端验证。
- 各接口参数个数在**真机**上是否被逐条校验，未确认。
- `FindChild` 的 `"A/B"` 路径写法**未被真机验证**（探针跑时容器是空的，没有子控件可查）。
- ▸官方示例用了 `background.imageColor = Color(255, 255, 255)` 与 `Enum.ImageType.Stretch`，
  但**未在真机复现过**；静态图片资源 id（示例里是 `107016` / `100002`）是否对所有关卡可用也未知。

以下五条是 2026-09-29 做「官方控件树」改写时暴露出来的，**都写进不确定清单，代码里按保守写法处理**：

- **同级顺序是否影响【光标】事件，未确认。** 文档只对**按键**事件写了
  「客户端按键事件按照控件的渲染顺序传递，层级和排序靠前的控件响应优先级更高」
  （`mhbgxf0nynww_客户端控件和客户端脚本.md` §4）。光标事件是否同理没有出处。
  官方示例的做法是把显示图 `SetAsLastSibling()`、判定区留在前面。
  → 保守写法：**两个方向都钉死**（判定区 `SetAsFirstSibling()`、显示图 `SetAsLastSibling()`），不赌哪种读法。
- **文本框会不会挡住光标射线，未确认。** `raycastTarget` 只登记在预设按钮 / 光标检测区域 /
  网格视窗上，`ClientUITextBoxControl` 与 `ClientUIBaseControl` **都没有这个字段**。
  文档里唯一的穿透开关是容器节点的 `disableCursorEventPassthrough`。
  → 所以「分数文本不参与射线检测」这句**没有出处，不要写进代码注释当事实**。
- **重复注册的语义未确认**：同一控件两次 `AddCursorEventListener`、同一信号两次
  `RegisterServerSignalHandler`，是替换还是叠加，文档未写。结果是"点一次加两分"还是"后者覆盖前者"都说不准。
  → 保守写法：注册路径保证**只走一次**（初始化返回 `false` 时直接关掉逐帧，不重试）。
- **禁用再启用后的监听存活情况未确认**：容器 `SetActive(false)` 再 `SetActive(true)`，
  光标监听是否被销毁、需不需要重新注册、能否重新注册，都没验。
  → 本技能包的脚本只在初始化时注册一次（与官方示例一致），**不要靠 `OnEnable` 补注册**，除非先验过。
- **原始字段写入是否立即生效未确认**：`this.showCursor = true` / `area.raycastTarget = true`
  文档都标为读写，但**写成功 ≠ 运行时认账**。
  → 保守写法：写完**回读**并打进日志（`showCursor` 尤其要，真机默认就是 `false`）。

## 11. 官方教程示例带来的确认（2026-09-27）

> **来源**：官方教程「3.21 客户端脚本——制作点击收集玩法」（条目 id `mh47p30a87qo`）正文
> 及其辅助课件 `.gil` 中提取的完整实现。
> 本地副本：`references/live/mh47p30a87qo_official-sample-main.lua`、`references/live/mh47p30a87qo_*.md`。
>
> **证据等级**：官方**教程**正文与官方**工程示例**。既不是第三方逆向，也不是我们的探针——
> 但它描述的是官方自己怎么用，**不等同于真机回传**。标为 ▸官方示例。

- ▸官方示例 **`showCursor` 必须显式打开**。教程第 4 步原话：
  *"为了让光标检测区域正常接收光标事件，还需要开启容器节点的 showCursor"*，代码 `this.showCursor = true`。
  → 与本文件此前的真机实测（默认 `false`）**互证**，本条可以从"实测孤证"升级为**确定结论**。
- ▸官方示例 **光标事件回调只收一个参数**：`local function onCircleClick(_data)`，
  `_data` 是 `CursorEventData`（只读 `dragging` / `touchId`；方法 `GetUIPos()` / `GetPressUIPos()` / `GetUIPosDelta()`）。
- ▸官方示例 **点击判定用【光标检测区域】，不是预设按钮**：
  *"'圆圈点击区域'必须是'光标检测区域'，不是预设按钮。"* 显示用的图片控件不挂事件。
- ▸官方示例 **`Get*` 系列返回多个值**：`local circleWidth, circleHeight = circleRoot:GetSizeDelta()`。
- ▸官方示例 **防重复点击用 `raycastTarget` 开关**：进回调 `= false`，处理完 `= true`。
- ▸官方示例 **`Control.alive` 可读**：`local function isReady(c) return c ~= nil and c.alive end`。
- ▸官方示例 **`debug.traceback` 的可用写法**：`debug.traceback("", 2)`，拼进 table 后交给 `printerr`。
- ▸官方示例 **控件树必须嵌套**：判定区与显示图形放进同一个【容器控件】，
  移动容器 = 两者同步移动（教程原话："让圆圈图片和点击判定区域同步移动"）。
