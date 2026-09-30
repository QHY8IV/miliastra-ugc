-- ============================================================================
-- 官方参考实现：圆圈点击小游戏（main.lua）
-- ----------------------------------------------------------------------------
-- 出处：米哈游官方教程「3.21 客户端脚本——制作点击收集玩法」辅助课件
--       条目 id  mh47p30a87qo
--       工程文件  客户端脚本.gil
--       https://act-webstatic.mihoyo.com/ugc-tutorial/course/cn/zh-cn/mh47p30a87qo/6b8bbfd8-1948-41e4-a772-8812dbb3eed6.gil
-- 提取方式：node scripts/gi.mjs lua get 客户端脚本.gil（按 protobuf 结构取出脚本源码，含全部空行；.gil 不是压缩包，源码是明文）。
-- 提取时间：2026-09-30（重新提取；此前的副本丢了 33 个空行，代码无差别，但行号对不上官方脚本）
-- 版权：归米哈游（miHoYo / HoYoverse）所有，此处仅作个人学习与创作辅助。
--
-- 本文件为**逐字提取**（含空行与注释），未改动任何内容；仅把换行统一成了 LF（官方是 CRLF）。
-- 它是本技能包中唯一一份「官方亲自写的、可直接抄的」客户端 Lua 完整实现。
-- ============================================================================

-- 圆圈点击小游戏（带中文说明版）
--
-- 使用前请在编辑器中预先创建以下控件层级；名称、层级和控件类型需保持一致：
-- 脚本所属对象
-- ├─ 背景                 [图片控件]
-- ├─ 圆圈容器             [容器控件]
-- │  ├─ 圆圈点击区域     [光标检测区域]
-- │  └─ 圆圈图片         [图片控件]
-- └─ 分数文本             [文本控件]
--
-- “圆圈点击区域”必须是“光标检测区域”，不是预设按钮。
-- 它负责接收点击；“圆圈图片”仅负责显示圆圈。脚本会通过 GetChild
-- 复用上述预先放置的控件，不会动态创建任何界面控件。

--获取当前脚本绑定的对象，后续通过 this 操作当前 UI 或者脚本节点。
local this = script.object

--定义游戏状态表，用来保存分数、是否运行、是否一开始，以及画布尺寸等运行数据
local Game = {
    score = 0, -- 当前已点击的次数。
    scoreTarget = 10, -- 达到该次数后向服务端发送成功信号。
    running = false, -- 是否处于可点击的游戏进行状态。
    started = false, -- 初始化是否已完成，防止重复初始化。
    startAttempts = 0, -- 当前已经尝试初始化的次数。
    startRetryBudget = 60, -- 画布未就绪时，最多允许重试的次数。
    canvasWidth = 0, -- 游戏界面画布宽度。
    canvasHeight = 0, -- 游戏界面画布高度。
}

--定义圆圈的尺寸常量，并根据直径计算半径，便于统一管理碰撞范围或显示大小
local CIRCLE_SIZE = 112
local CIRCLE_RADIUS = CIRCLE_SIZE / 2

-- 静态资源的图片编号：一个用于背景，一个用于可点击的圆圈。
local BACKGROUND_IMAGE_ID = 107016
local CIRCLE_IMAGE_ID = 100002

--获取界面中的子节点引用，方便后续控制背景、圆圈区域、圆圈图片和文本分数
local background = this:GetChild("背景")
local circleRoot = this:GetChild("圆圈容器")
local circleArea = circleRoot:GetChild("圆圈点击区域")
local circleImage = circleRoot:GetChild("圆圈图片")
local scoreText = this:GetChild("分数文本")

--显示鼠标光标，通常用于需要鼠标点击交互的 UI 场景
this.showCursor = true

-- 判断控件是否存在且仍处于有效状态。
local function isReady(control)
    return control ~= nil and control.alive
end

-- 统一输出包含调用栈的错误信息，便于定位界面配置或运行时问题。
local function printFault(message)
    printerr(table.concat({
        "GAME FAULT BEGIN CIRCLE_CLICK",
        "message=" .. message,
        "traceback=" .. debug.traceback("", 2),
        "GAME FAULT END CIRCLE_CLICK",
    }, "\n"))
end

--函数作用：根据画布大小和圆圈尺寸，随机生成一个位置并将圆圈移动到该位置。
local function spawnCircle()
    -- 获取圆圈容器实际尺寸，确保随机坐标不会让圆圈超出画布边界。
    local circleWidth, circleHeight = circleRoot:GetSizeDelta()
    local maxX = math.max(Game.canvasWidth * 0.5 - circleWidth * 0.5, 0)
    local maxY = math.max(Game.canvasHeight * 0.5 - circleHeight * 0.5, 0)

    -- 在横向和纵向可用范围内分别生成随机坐标。
    local x = (math.random() * 2 - 1) * maxX
    local y = (math.random() * 2 - 1) * maxY

    -- 将容器移动至新坐标，图片和点击区域会随容器一起移动。
    circleRoot:SetAnchoredPosition(x, y)
    return true
end

-- 将当前分数同步到分数文本控件。
local function updateScore()
    scoreText.text = "分数：" .. tostring(Game.score)
end

-- 玩家点击圆圈点击区域时执行的处理函数。
local function onCircleClick(_data)
    -- 游戏未运行时不响应点击，避免成功或销毁后继续加分。
    if not Game.running then
        return
    end

    -- 处理点击期间暂时关闭射线检测，避免同一次点击被重复处理。
    circleArea.raycastTarget = false
    Game.score = Game.score + 1
    updateScore()

    -- 达到目标分数时结束游戏，并通知服务端本局成功。
    if Game.score >= Game.scoreTarget then
        Game.running = false
        game.ServerSignal("success"):SendSignal()
        return
    end

    -- 未达目标时，将圆圈移动到新的随机位置后重新允许点击。
    spawnCircle()
    circleArea.raycastTarget = true
end

-- 完成游戏初始化；返回 true 表示成功，false 表示不可恢复的失败，nil 表示稍后重试。
local function startGame()
    -- 已成功初始化过时直接返回，避免重复注册事件。
    if Game.started then
        return true
    end

    -- 检查所有预设控件是否存在且有效。
    if not isReady(background) or not isReady(circleRoot)
        or not isReady(circleArea) or not isReady(circleImage)
        or not isReady(scoreText) then
        printFault("找不到预设界面控件，请检查控件名称和层级")
        return false
    end

    -- 读取画布尺寸；尺寸尚不可用时返回 nil，交由 OnUpdate 在下一帧重试。
    local width, height = game.GetUICanvasSize()
    if type(width) ~= "number" or type(height) ~= "number"
        or math.isnan(width) or math.isnan(height)
        or math.isinf(width) or math.isinf(height)
        or width <= 0 or height <= 0 then
        return nil
    end

    -- 保存有效画布尺寸，供随机位置计算使用。
    Game.canvasWidth = width
    Game.canvasHeight = height

    -- 调整显示层级：背景最底层，圆圈与分数位于其上方。
    background:SetAsFirstSibling()
    circleRoot:SetAsLastSibling()
    scoreText:SetAsLastSibling()

    -- 配置并显示背景图片。
    background:SetImage(Enum.ImageSource.StaticReference, BACKGROUND_IMAGE_ID)
    background.imageType = Enum.ImageType.Stretch
    background.imageColor = Color(255, 255, 255)
    background:SetActive(true)
    background:SetVisible(true)

    -- 配置圆圈容器的状态、中心锚点和尺寸。
    circleRoot:SetActive(true)
    circleRoot:SetVisible(true)
    circleRoot:SetPivot(0.5, 0.5)
    circleRoot:SetSizeDelta(CIRCLE_SIZE, CIRCLE_SIZE)

    -- 配置接收点击的光标检测区域；初始化期间先禁止点击。
    circleArea:SetActive(true)
    circleArea:SetVisible(true)
    circleArea:SetPivot(0.5, 0.5)
    circleArea:SetAnchoredPosition(0, 0)
    circleArea:SetSizeDelta(CIRCLE_SIZE, CIRCLE_SIZE)
    circleArea.raycastTarget = false

    -- 配置圆圈图片的资源、拉伸方式、颜色、位置与尺寸。
    circleImage:SetImage(Enum.ImageSource.StaticReference, CIRCLE_IMAGE_ID)
    circleImage.imageType = Enum.ImageType.Stretch
    circleImage.imageColor = Color(255, 213, 74)
    circleImage:SetActive(true)
    circleImage:SetVisible(true)
    circleImage:SetPivot(0.5, 0.5)
    circleImage:SetAnchoredPosition(0, 0)
    circleImage:SetSizeDelta(CIRCLE_SIZE, CIRCLE_SIZE)
    circleImage:SetAsLastSibling()

    -- 显示初始分数。
    scoreText:SetActive(true)
    scoreText:SetVisible(true)
    scoreText.text = "分数：0"

    -- 监听点击事件，并标记游戏已经开始运行。
    circleArea:AddCursorEventListener(Enum.CursorEventType.CursorClick, onCircleClick)
    Game.running = true
    Game.started = true

    -- 生成第一枚圆圈；成功后开放其点击区域。
    if spawnCircle() then
        circleArea.raycastTarget = true
        print("CIRCLE CLICK RUNNING")
        return true
    end

    return false
end

-- 脚本启用时初始化随机种子，并打开逐帧更新以等待画布准备完成。
function OnStart()
    math.randomseed(os.time())
    script:EnableUpdate(true)
end

-- 每帧尝试初始化一次；初始化成功、失败或超过重试次数后关闭更新。
function OnUpdate(_dt)
    if Game.started then
        return
    end

    Game.startAttempts = Game.startAttempts + 1
    local result = startGame()
    if result == true then
        script:EnableUpdate(false)
    elseif result == false or Game.startAttempts >= Game.startRetryBudget then
        if result == nil then
            printFault("画布未就绪")
        end
        script:EnableUpdate(false)
    end
end

-- 脚本销毁时关闭游戏与点击区域，并移除监听，避免残留事件回调。
function OnDestroy()
    Game.running = false
    if isReady(circleArea) then
        circleArea.raycastTarget = false
        circleArea:RemoveCursorEventListener(Enum.CursorEventType.CursorClick, onCircleClick)
    end
    script:EnableUpdate(false)
end
