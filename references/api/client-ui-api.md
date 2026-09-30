# 客户端 Lua UI API 速查

> 来源①：官方条目 `客户端控件API文档`（id `mhtakr07vej4`），镜像抓取时间 **2026-09-25T17:54:09.605Z**。
> 来源②：官方教程 3.21 辅助课件的完整实现 —— `references/live/mh47p30a87qo_official-sample-main.lua`。
> 本文是**写代码时的逐字对照表**；症状与成因见 `pitfalls.md`；出处小节号写在标题里。
> 名字一律逐字抄，不要改写大小写。
>
> **两条来源冲突时以官方教程示例为准**（它是可运行的工程产物，条目文档只是文字描述）。
> 本文中标注「▸示例」的行，出处是来源②。

---

## 0. 运行环境（§3）

**Lua 5.3**。以下不可用：

- `io.*`（全部）
- `coroutine.*`（全部）
- `string.dump`
- 除 `os.time`、`os.date`、`os.clock`、`os.difftime` 之外的 `os.*`
- 除 `debug.traceback` 之外的 `debug.*`

额外补充：`math.isnan(n)`、`math.isinf(n)`。

## 1. 生命周期（§1）

宿主**按固定名称**查找并调用，只有这七个：

| 函数 | 参数 | 时机 |
|---|---|---|
| `OnInit()` | 无 | 初始化 |
| `OnStart()` | 无 | 启动 |
| `OnEnable()` | 无 | 启用 |
| `OnDisable()` | 无 | 停用 |
| `OnUpdate(dt)` | `dt: number` | 逐帧，**不受**关卡时停影响 |
| `OnLevelUpdate(dt)` | `dt: number` | 逐帧，**受**关卡时停影响 |
| `OnDestroy()` | 无 | 销毁 |

## 2. 全局（§3、§5）

| 名称 | 说明 |
|---|---|
| `script` | 当前脚本实例（`Script`） |
| `Enum` | 枚举表 |
| `typeof(value)` | 返回运行时类型名称 |
| `print(...)` | 普通日志 |
| `printerr(...)` | 错误级日志，不抛错 |
| `debug.traceback([message[, level]])` | 只返回文本，需自己 print |
| `game.PrintClientUITree()` | 把控件树写进日志 |

## 3. Color（§4）

```lua
Color(r, g, b, a?)              -- 0–255；a 省略或 nil 即 255
Color.FromRGB(r, g, b)
Color.FromRGBA(r, g, b, a?)
Color.ToRGBA(colorValue)        -- 返回 r, g, b, a
```

## 4. Script（§5）— 冒号调用

**字段**（只读除 `enabled`）：`alive`、`scriptMappingId`、`object`、`path`、`enabled`(读写)

| 方法 | 说明 |
|---|---|
| `script:GetParam(paramName)` | 按变量名读脚本内参数 |
| `script:Invoke(funcName, ...)` | 调用本脚本内的全局函数 |
| `script:EnableUpdate(enabled)` | 开关自己的逐帧更新 |
| `script:RegisterServerSignalHandler(signalName, callback)` | 回调 `fun(signalName, signalParams: any[])` |
| `script:UnregisterServerSignalHandler(signalName)` | |
| `script:RegisterCustomVariableChangedHandler(entityType, customVariableName, callback)` | 回调只给 `entityType` 与变量名 |
| `script:UnregisterCustomVariableChangedHandler(entityType, customVariableName)` | |

## 5. game（§6）— **点号调用**

### UI 与层级
```lua
game.InstantiateClientUIControl(controlPrefabIndex, parent)  -- → ClientUIBaseControl
game.DestroyClientUIControl(control)
game.GetClientUIControl(controlId)
game.FindClientUIRoot(nodeName)        -- 找 UI 根控件
game.GetClientUIRoots()                -- → ClientUIBaseControl[]
game.GetUICanvasSize()                 -- → x, y
game.GetCursorUIPos()                  -- → x, y
```

### 输入与聚焦
```lua
game.GetDevice()                       -- → Enum.Device
game.SetControllerFocus(control)
game.GetControllerFocus()
game.GetControllerLeftStickAxis()      -- → horizontal, vertical
game.GetControllerRightStickAxis()     -- → horizontal, vertical
```

### 补间 / 信号 / 变量
```lua
game.Tween(object, tweenDataTable, duration)   -- → Tween（创建后要 Play）
game.TweenSequence()                           -- → TweenSequence
game.ServerSignal(signalName)                  -- → ServerSignal
game.GetGlobalCustomVariableValue(entityType, customVariableName)
```

### 关卡 / 音效 / 本地化
```lua
game.PauseLevelTime(pause)     -- 仅单人模式；不暂停脚本自身
game.IsLevelTimePaused()
game.PlayAudio2D(audioId)      -- → 音效实例 ID
game.StopAudio(audioInstanceId)
game.IsAudioAlive(audioInstanceId)
game.GetLanguageType()         -- → Enum.LanguageType
game.GetStageMode()            -- → Enum.StageMode
game.IsTestPlay()
game.GetText(textMapId)        -- → 本地化文本
```

## 6. Tween / TweenSequence（§7、§8）— 冒号调用

```lua
local tw = game.Tween(ctrl, { localScaleX = 1.2, localScaleY = 1.2 }, 0.15)
tw:SetEase(Enum.EaseType.OutBack):SetLoops(1):Play()
```

| Tween | TweenSequence |
|---|---|
| `SetEase(easeType)` → 自身 | `Append(tween)` / `AppendInterval(sec)` / `AppendCallback(fn)` |
| `SetRelative(bool)` | `Join(tween)` / `Insert(time, tween)` / `InsertCallback(time, fn)` |
| `Play()` / `Pause()` / `Resume()` / `Restart()` / `Complete()` | 同名 |
| `Kill(complete: boolean)` | 同名 |
| `SetOnComplete(fn)` / `SetOnStepComplete(fn)` | 同名 |
| `SetLoops(times)`（负数=无限） | 同名 |

## 7. ServerSignal（§9）— 冒号调用

```lua
local s = game.ServerSignal("ScoreChanged")
s:AddFloat(score)      -- 参数按服务端约定依次添加
s:SendSignal()         -- 不调就不发
```

`AddParam(paramType, value)`，以及成对的单值 / 列表方法：
`AddInt` / `AddIntList`、`AddFloat` / `AddFloatList`、`AddString` / `AddStringList`、`AddBool` / `AddBoolList`、`AddVector3`（table `{x=,y=,z=}`）/ `AddVector3List`、`AddGuid` / `AddGuidList`、`AddEntity` / `AddEntityList`、`AddPrefabId` / `AddPrefabIdList`、`AddConfigId` / `AddConfigIdList`。

## 8. 控件继承（§12）

全部继承 `ClientUIBaseControl`：

| 类型 | 控件 |
|---|---|
| `ClientUIImageControl` | 图片 |
| `ClientUITextBoxControl` | 文本框 |
| `ClientUITextWindowControl` | 文本视窗 |
| `ClientUIPresetButtonControl` | 预设按钮 |
| `ClientUICursorEventAreaControl` | 光标检测区域 |
| `ClientUIGridScrollerControl` | 网格视窗 |
| `ClientUIKeyHintControl` | 按键提示 |
| `ClientUIAnimationControl` | 界面动效 |
| `ClientUIFullscreenAnimationControl` | 全屏动效 |
| `ClientUIContainerControl` | 容器节点 |
| `ClientUIReferenceControl` | 模板引用控件 |

## 9. ClientUIBaseControl（§13）

**字段**：只读 `alive` `id` `prefabIndex` `active` `activeInHierarchy` `visible`；读写 `name` `parent` `canControllerFocus`，以及可补间字段
`anchoredPositionX/Y`、`sizeDeltaX/Y`、`anchorMinX/Y`、`anchorMaxX/Y`、`pivotX/Y`、`localScaleX/Y/Z`、`localRotationX/Y/Z`。

**层级与可见性**
```lua
GetChildren() / GetChild(name) / FindChild(path)
SetActive(active)        -- 关掉后不可见且挂载脚本停止运行
SetVisible(visible)      -- 只改可见性，不停脚本
GetSiblingIndex() / SetSiblingIndex(index) / SetAsFirstSibling() / SetAsLastSibling()
```

**布局与变换**：`Get/SetAnchoredPosition`、`Get/SetSizeDelta`、`Get/SetAnchorMin`、`Get/SetAnchorMax`、`Get/SetPivot`、`Get/SetLocalScale`、`Get/SetLocalRotation`

> ▸示例 **`Get*` 系列返回多个值，不是 table/vector**。官方示例写的是
> `local circleWidth, circleHeight = circleRoot:GetSizeDelta()`，
> 同理适用于 `GetAnchoredPosition` / `GetPivot` / `GetAnchorMin` / `GetAnchorMax` / `GetLocalScale` / `GetLocalRotation`。
> 接成一个变量（`local v = ctrl:GetSizeDelta()`）只会拿到第一个分量，**不报错**。
>
> ▸示例 变换类方法都是**两/三个标量入参**：`SetAnchoredPosition(x, y)`、`SetSizeDelta(w, h)`、`SetPivot(x, y)`。
> 图片相关另有两个字段是**直接赋值**的：`ctrl.imageType = Enum.ImageType.Stretch`、`ctrl.imageColor = Color(255, 213, 74)`。

**脚本访问**：`GetScriptByPath(scriptPath)`、`GetScript(scriptMappingId)`、`GetScripts()`（用前查 `script.alive`）

**按键事件**：`AddKeyEventListener(eventType, callback)`（回调返回 `boolean`）、`RemoveKeyEventListener(eventType, callback)`、`RemoveKeyEventListeners(eventType)`、`RemoveAllKeyEventListeners()`

**手柄导航**：`AddNavigationEventListener` / `RemoveNavigationEventListener` / `RemoveNavigationEventListeners` / `RemoveAllNavigationEventListeners`、`SetControllerNavigation(dir, mode, target)` / `GetControllerNavigation(dir)`

## 10. 各控件专有字段（§14–§25）

> ▸示例 **做游戏内点击判定，用【光标检测区域】而不是【预设按钮】。**
> 官方原话：*"'圆圈点击区域'必须是'光标检测区域'，不是预设按钮。"*
> 预设按钮自带按下态与音效表现，是给真正的按钮 UI 用的；游戏内的可点击物体（圆点、道具图标、格子）应当用光标检测区域。
> 显示用的【图片控件】**不要**挂点击事件——判定与显示分层，两者放进同一个容器一起移动。

> ▸示例 **容器节点的 `showCursor` 不打开，光标事件一律收不到。**
> 官方示例在脚本里显式写 `this.showCursor = true`（`this` 即 `script.object`）。真机实测新建容器默认是 `false`。

| 控件 | 专有字段 | 专有方法 |
|---|---|---|
| 图片 | `imageSource`(只读) `imageId`(只读) `imageColor` `imageType` `enableMask` `enableSoftEdge` `softEdgeMode` `softEdgeWidthX/Y` `horizontalSoftRange` `verticalSoftRange` `reverseMaskArea` `fillType` `fillHorizontalType` `fillVerticalType` `fillRadial90Type` `fillRadialType` `fillAmount` | `SetImage(src,id)` `SetSoftEdgeWidth(wx,wy)` `SetFillUnused()` `SetFillHorizontal(t,amount)` `SetFillVertical(t,amount)` `SetFillRadial90(t,amount)` `SetFillRadial180(t,amount)` `SetFillRadial360(t,amount)` |
| 文本框 | `text` `fontSize` `fontColor` `bgColor` `enableOutline` `outlineColor` `horizontalAlignment` `verticalAlignment` `adaptiveFontSize` `minimumFontSize` | — |
| 文本视窗 | 同上 + `interactable` `showScrollBar` | — |
| 预设按钮 | `interactable` `clickAudioId` `raycastTarget` | `AddCursorEventListener(eventType, callback)` / `Remove…` / `RemoveAll…`、`SimulateCursorClick()` |
| 光标检测区域 | `raycastTarget` | 同预设按钮 |
| 网格视窗 | `itemCount`(只读) `itemPrefabIndex` `raycastTarget` `showScrollBar` `interactable` `scrollDirection`(只读) `layoutConstraint`(只读) `layoutConstraintFixedCount`(只读) `scrollProgress` | `RefreshItems(itemCount, fn(control, index))` `GetItemIndex(control)` `GetItemSize()` `GetItemSpacing()` `GetPadding()` `ScrollToItemAt(index, align)` `GetContentLength()` |
| 按键提示 | `keyboardKeyCode` `controllerKeyCode` | — |
| 界面动效 | `animationId` `playSoundEffect` `layer` | `PlayAnimation()` `StopAnimation()` |
| 全屏动效 | `animationId` `playSoundEffect` | — |
| 容器节点 | `isolateNavigation` `disableKeyEventPassthrough` `disableCursorEventPassthrough` **`showCursor`** | — |
| 模板引用 | `referencedPrefabIndex`(只读) | — |

`CursorEventData`：只读 `dragging` `touchId`；方法 `GetUIPos()`、`GetPressUIPos()`、`GetUIPosDelta()`。

## 11. 枚举（§11、§26）

写错任何一个值名都会静默失效。以下为全量清单。

- **EaseType**：`Linear` `InSine` `OutSine` `InOutSine` `InQuad` `OutQuad` `InOutQuad` `InCubic` `OutCubic` `InOutCubic` `InQuart` `OutQuart` `InOutQuart` `InQuint` `OutQuint` `InOutQuint` `InExpo` `OutExpo` `InOutExpo` `InCirc` `OutCirc` `InOutCirc` `InBack` `OutBack` `InOutBack` `InElastic` `OutElastic` `InOutElastic` `InBounce` `OutBounce` `InOutBounce`
- **CustomVariableEntityType**：`Level` `PlayerSelf` `AvatarSelf`
- **Device**：`KeyboardAndMouse` `Mobile` `Controller` `MobileController`
- **StageMode**：`Beyond` `Classic`
- **LanguageType**：`LanguageNone` `LanguageEng` `LanguageChs` `LanguageCht` `LanguageFra` `LanguageDeu` `LanguageSpa` `LanguagePor` `LanguageRus` `LanguageJpn` `LanguageKor` `LanguageTha` `LanguageVie` `LanguageInd` `LanguageTur` `LanguageIta`
- **ParamType**：`Entity` `EntityList` `Int` `IntList` `Bool` `BoolList` `Float` `FloatList` `String` `StringList` `Vector3` `Vector3List` `Guid` `GuidList` `ConfigId` `PrefabId` `ConfigIdList` `PrefabIdList`
- **CursorEventType**：`CursorDown` `CursorUp` `CursorEnter` `CursorExit` `CursorDrag` `CursorBeginDrag` `CursorEndDrag` `CursorClick`
- **ScrollDirection**：`Horizontal` `Vertical`
- **ScrollLayoutConstraint**：`AutoWrap` `Fixed`
- **ScrollAlignType**：`Bottom` `Center` `Top`
- **ControllerNavigationDir**：`Up` `Down` `Left` `Right`
- **ControllerNavigationEventType**：`Confirm` `Cancel` `Focus` `LostFocus` `RightStickUp` `RightStickDown` `RightStickRight` `RightStickLeft` `LeftStickUp` `LeftStickDown` `LeftStickRight` `LeftStickLeft`
- **ControllerNavigationMode**：`None` `NearestControl` `Specified`
- **TextHorizontalAlignment**：`Left` `Middle` `Right`
- **TextVerticalAlignment**：`Top` `Middle` `Bottom`
- **ImageType**：`Basic` `Stretch`
- **ImageSource**：`StaticReference` `Item` `Equipment` `Skill` `UnitStatus` `Faction` `Currency` `Prefab`
- **ImageFillType**：`Unused` `Horizontal` `Vertical` `Radial90` `Radial180` `Radial360`
- **ImageFillHorizontalType**：`Left` `Right`
- **ImageFillVerticalType**：`Bottom` `Top`
- **ImageFillRadial90Type**：`BottomLeft` `TopLeft` `TopRight` `BottomRight`
- **ImageFillRadialType**：`Bottom` `Left` `Top` `Right`
- **ImageMaskSoftEdgeMode**：`Percentage` `Pixel`
- **UIAnimationLayer**：`AboveAllControls` `BelowAllControls`

### 按键枚举（§26）

- **KeyboardKeyCode**：`CraftspersonKey1`–`CraftspersonKey43`，加玩法键 `MoveForwardKey` `MoveBackwardKey` `MoveLeftKey` `MoveRightKey` `SwitchToWalkOrRunKey` `SprintKey` `JumpKey` `DropKey` `OpenShortcutWheelKey` `InteractKey` `NormalAttackKey` `CharacterSkill1Key`–`CharacterSkill4Key`，以及 `None`。
  奇匠按键默认物理键：1–10 → `1`…`9`,`0`；11–22 → `U` `Z` `Y` `G` `H` `I` `O` `P` `J` `K` `L` `V`；23–28 → `F5`–`F10`；29–35 → `` ` `` `-` `=` `[` `,` `.` `/`；36–39 → `↑` `↓` `←` `→`；40–43 → `右Ctrl` `右Shift` `Backspace` `CapsLock`。
- **ControllerKeyCode**：`CraftspersonKey1`–`CraftspersonKey14`（→ `十字键左` `十字键下` `LT` `LB+Y` `LB+X` `LB+A` `LB+十字键上` `LB+十字键右` `LB+十字键左` `LB+十字键下` `LB+RB` `LB+LT` `LB+RT` `LB+LS(按下)`），加 `SprintKey` `JumpKey` `InteractKey` `NormalAttackKey` `CharacterSkill1Key`–`CharacterSkill4Key`、`MenuConfirmKey` `MenuBackKey`、`None`。
- **KeyEventType**：`Keyboard…` / `Controller…` 前缀 + 上述键名 + `Down` / `Up` 后缀（如 `KeyboardCraftspersonKey1Down`、`ControllerJumpKeyUp`）。

---

## 12. 返回值与坑点提示（原文自带）

- `SetSiblingIndex` / `SetAsFirstSibling` / `SetAsLastSibling` 返回 `boolean`；同级索引越大越靠后、**显示越靠上**。
- 复用列表生成的列表项**不保证同级排序结果稳定**。
- `GetAnchoredPosition()`：无父层级时以画布**左下**为原点；有父层级时是与父层级中心的相对偏移。
- 父子的位移/缩放/可见性/Alpha/镜像/裁剪由运行时 UI 层级共同决定，用组合布局后要**验证实际显示结果**。
- `CursorEventData:GetUIPos()` 以画布**左下角**为原点，坐标比例与布局坐标一致。
