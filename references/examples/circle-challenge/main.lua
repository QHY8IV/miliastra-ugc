-- ============================================================================
-- 圆圈挑战 · 30 秒点圆圈小游戏（客户端 Lua，不需要服务端节点图）
-- ============================================================================
-- 玩法
--   进关卡后中间有一个圆圈，点它开始。30 秒内尽量多点：
--     · 每点中一个 +1 分，圆圈随即跳到新位置，并且越点越小（最小 56）；
--     · 每第 5 个圆圈是「金圈」，值 3 分；
--     · 最后 5 秒背景泛红；
--     · 时间到显示得分与本次运行内的最高分，点中间的圆圈再来一局。
--
-- 控件树（与官方教程 3.21 的教学存档一致；名字、层级、类型必须逐字对上）：
--   脚本所属对象（容器节点）
--   ├─ 背景             [图片控件]
--   ├─ 圆圈容器         [容器控件]
--   │  ├─ 圆圈点击区域  [光标检测区域]   ← 只有它接收点击
--   │  └─ 圆圈图片      [图片控件]       ← 只负责显示
--   └─ 分数文本         [文本控件]       ← 当作 HUD：得分 / 剩余时间 / 提示语
--
-- ── 依据 ──
--   【官方示例】references/live/mh47p30a87qo_official-sample-main.lua
--       生命周期（OnStart 只开逐帧、OnUpdate 里重试初始化）、控件树与 GetChild 取法、
--       showCursor、光标检测区域接点击、raycastTarget 防重复点击、isReady、printFault。
--   【文档】references/api/client-ui-api.md
--       game.Tween / TweenSequence / SetEase / Play、Color、imageColor、os.time、
--       SetSizeDelta / SetAnchoredPosition / SetAsLastSibling、控件字段 localScaleX/Y。
--   【教学存档里读到的事实】分数文本是中心锚点、位置 (0, +350)、尺寸只有 218×68（约 10 个汉字宽）。
--       所以本脚本在初始化时把它加宽、放大字号（fontSize 必须是整数，真机日志踩过），
--       并用 GetAnchoredPosition / GetSizeDelta 读出它的矩形，让圆圈避开它。
--   【本脚本新增，未在真机验证】
--       ① 计时用 os.time()（整秒），不用 OnUpdate 的 dt——文档没写 dt 的单位；
--       ② 圆圈缩小 / 换色 / 背景泛红 / 弹一下，都是在官方示例已用的 API 上组合出来的；
--       ③ 加宽分数文本、放大字号、圆圈避开文本：读不到文本矩形时退回「不进画布顶部 HUD_BAND 那一条」。
--
-- ── 第一次试玩看日志的顺序 ──
--   [圆圈挑战] OnStart circle-challenge/v1/…     → 版本戳对上了才算跑的是这一版
--   [圆圈挑战] showCursor 设置前=… 设置后=…       → 设置后不是 true，回编辑器手动开容器节点的 showCursor
--   [圆圈挑战] 就绪（画布 W x H）                 → 初始化成功，可以点了
--   [圆圈挑战] 第 N 局开始 / 第 N 局结束 得分=…    → 玩法在走
--   GAME FAULT BEGIN CIRCLE_CHALLENGE … END       → 出错了，message= 那一行是原因
-- ============================================================================

local STAMP = "circle-challenge/v1/2026-09-30"

-- ───────────── 玩法参数（想调手感改这里）─────────────
local ROUND_SECONDS = 30            -- 一局多少秒（按整秒计时，实际在 29~30 秒之间）
local SIZE_START = 128              -- 开局圆圈直径（官方示例用 112）
local SIZE_STEP = 4                 -- 每得 1 分，圆圈缩小多少
local SIZE_MIN = 56                 -- 圆圈最小直径
local BONUS_EVERY = 5               -- 每第几个圆圈是金圈
local BONUS_POINTS = 3              -- 金圈值几分
local WARN_SECONDS = 5              -- 最后几秒背景泛红
local RESTART_LOCK = 2              -- 结算后多少秒内的点击不算「再来一局」，免得连点直接跳过结算
local HUD_WIDTH = 720               -- 分数文本加宽到多少（原来只有 218，装不下提示语）
local HUD_HEIGHT = 84               -- 分数文本高度（原来 68）
local HUD_FONT_SIZE = 32            -- 分数文本字号，必须是整数（真机：传小数会报错）
local HUD_MARGIN = 16               -- 圆圈与分数文本之间至少留多少像素
local HUD_BAND = 110                -- 读不到分数文本矩形时的兜底：圆圈不进入画布顶部这一条
local POP_SCALE = 1.2               -- 点中后「弹一下」的放大倍数
local POP_TIME = 0.08               -- 弹一下的单程时长（秒）

-- 静态资源的图片编号：与官方示例相同（一个背景，一个圆圈）。
local BACKGROUND_IMAGE_ID = 107016
local CIRCLE_IMAGE_ID = 100002

-- ───────────── 基础工具 ─────────────

local function log(...)
    print("[圆圈挑战]", ...)
end

-- 官方 isReady：控件存在且仍然存活。
local function isReady(control)
    return control ~= nil and control.alive
end

-- 官方 printFault：带调用栈的错误输出，便于定位界面配置或运行时问题。
local function printFault(message)
    printerr(table.concat({
        "GAME FAULT BEGIN CIRCLE_CHALLENGE",
        "message=" .. message,
        "traceback=" .. debug.traceback("", 2),
        "GAME FAULT END CIRCLE_CHALLENGE",
    }, "\n"))
end

-- 把可能失败的调用包起来：失败只打日志，不打断游戏。只取第一个返回值。
local function safe(what, fn, ...)
    local ok, r = pcall(fn, ...)
    if not ok then
        log("调用失败 " .. what .. " -> " .. tostring(r))
        return nil
    end
    return r
end

local function usableNumber(v)
    if type(v) ~= "number" then return false end
    if math.isnan(v) or math.isinf(v) then return false end
    return true
end

-- ───────────── 运行状态 ─────────────

local Game = {
    state = "boot",            -- boot（初始化中）→ menu（等第一次点击）→ playing → over（结算）→ 点圆圈回 playing
    started = false,           -- 控件初始化是否已完成
    startAttempts = 0,         -- 已尝试初始化多少帧
    startRetryBudget = 60,     -- 画布未就绪时最多重试多少帧（官方取 60）
    canvasWidth = 0,
    canvasHeight = 0,
    round = 0,                 -- 第几局
    score = 0,
    hits = 0,                  -- 本局已点中几个
    best = 0,                  -- 本次运行内的最高分
    bonus = false,             -- 当前圆圈是不是金圈
    endAt = 0,                 -- 本局结束的 os.time() 时刻
    lockUntil = 0,             -- 结算画面里，这个时刻之前点击无效
    lastText = nil,            -- HUD 上一次写进去的文字，没变就不重写
    warn = false,              -- 背景当前是不是泛红
    hudRect = nil,             -- 分数文本占的矩形 {x0,x1,y0,y1}（相对容器中心，已含边距）；读不到就是 nil
}

-- ───────────── 控件引用 ─────────────

-- script.object 就是脚本挂载的容器本身（官方示例与真机都如此），不用 FindClientUIRoot。
local this = script.object

local background = nil
local circleRoot = nil
local circleArea = nil
local circleImage = nil
local scoreText = nil
local popSeq = nil

-- 官方示例：光标事件要先打开容器的 showCursor（真机新建容器默认是 false）。
this.showCursor = true

-- 取子控件：父控件是 nil 或名字对不上时打日志，而不是直接报错中断。
local function childOf(parent, name)
    if parent == nil then
        log("取「" .. name .. "」失败：它的父控件是 nil")
        return nil
    end
    local ok, c = pcall(function() return parent:GetChild(name) end)
    if not ok then
        log("GetChild(\"" .. name .. "\") 报错 -> " .. tostring(c))
        return nil
    end
    if c == nil then
        log("GetChild(\"" .. name .. "\") 返回 nil —— 名字或层级对不上")
    end
    return c
end

local function resolveRefs()
    if not isReady(this) then
        printFault("script.object 无效 —— 脚本没有挂在客户端控件容器上")
        return false
    end
    background = childOf(this, "背景")
    circleRoot = childOf(this, "圆圈容器")
    -- 嵌套容器里的子控件必须先拿到父容器再取，不能从 this 一步到位。
    circleArea = childOf(circleRoot, "圆圈点击区域")
    circleImage = childOf(circleRoot, "圆圈图片")
    scoreText = childOf(this, "分数文本")

    local okAll = isReady(background) and isReady(circleRoot)
        and isReady(circleArea) and isReady(circleImage) and isReady(scoreText)
    if not okAll then
        -- 取不到时把真实控件树打进日志：正确名字就在里面。
        safe("PrintClientUITree", function() return game.PrintClientUITree() end)
    end
    return okAll
end

-- ───────────── 画面 ─────────────

-- 背景泛红开关（最后几秒）。只在状态变化时才写。
local function setWarn(on)
    if Game.warn == on then return end
    Game.warn = on
    if isReady(background) then
        if on then
            background.imageColor = Color(255, 150, 150)
        else
            background.imageColor = Color(255, 255, 255)
        end
    end
end

-- HUD 文字随状态变化；文字没变就不重写控件。
local function renderHud(force)
    if not isReady(scoreText) then return end
    local text
    if Game.state == "playing" then
        local remain = math.max(0, math.floor(Game.endAt - os.time()))
        text = "得分：" .. Game.score .. "｜剩余：" .. remain .. " 秒"
        setWarn(remain <= WARN_SECONDS)
    elseif Game.state == "over" then
        text = "时间到！得分 " .. Game.score .. "｜最高 " .. Game.best .. "｜点圆圈再来一局"
    else
        text = "点圆圈开始（" .. ROUND_SECONDS .. " 秒挑战）"
    end
    if force or text ~= Game.lastText then
        scoreText.text = text
        Game.lastText = text
    end
end

-- 容器、点击区、图片三者同尺寸——判定区必须盖住看得见的圆。
local function applySize(size)
    circleRoot:SetSizeDelta(size, size)
    circleArea:SetSizeDelta(size, size)
    circleImage:SetSizeDelta(size, size)
end

local function applyColor(bonus)
    if bonus then
        circleImage.imageColor = Color(255, 213, 74)    -- 金圈（官方示例用的就是这个金色）
    else
        circleImage.imageColor = Color(80, 190, 255)
    end
end

-- 读分数文本占的矩形（GetAnchoredPosition / GetSizeDelta 都返回两个值，不是 table）。
-- 假设它是中心锚点（教学存档里就是）；读不到可用数字就返回 nil，由调用方退回顶部条兜底。
local function readHudRect()
    local ok, ax, ay, sw, sh = pcall(function()
        local px, py = scoreText:GetAnchoredPosition()
        local w, h = scoreText:GetSizeDelta()
        return px, py, w, h
    end)
    if not ok or not usableNumber(ax) or not usableNumber(ay)
        or not usableNumber(sw) or not usableNumber(sh) or sw <= 0 or sh <= 0 then
        return nil
    end
    return {
        x0 = ax - sw * 0.5 - HUD_MARGIN, x1 = ax + sw * 0.5 + HUD_MARGIN,
        y0 = ay - sh * 0.5 - HUD_MARGIN, y1 = ay + sh * 0.5 + HUD_MARGIN,
    }
end

-- 圆心在 (x, y)、直径 size 的圆是否压到分数文本（没读到文本矩形时，改判是否进了顶部条）。
local function hitsHud(x, y, size)
    local r = Game.hudRect
    local half = size * 0.5
    if r == nil then
        return y + half > Game.canvasHeight * 0.5 - HUD_BAND
    end
    return x + half > r.x0 and x - half < r.x1 and y + half > r.y0 and y - half < r.y1
end

-- 在画布内随机取一个不出界、且不压分数文本的位置（坐标是相对容器中心的偏移，与官方示例一致）。
-- 最多试 30 次；文本只占画布很小一块，实际几乎一次就中。
local function randomSpot(size)
    local halfW = math.max(Game.canvasWidth * 0.5 - size * 0.5, 0)
    local halfH = math.max(Game.canvasHeight * 0.5 - size * 0.5, 0)
    local x, y = 0, 0
    for _ = 1, 30 do
        x = (math.random() * 2 - 1) * halfW
        y = (math.random() * 2 - 1) * halfH
        if not hitsHud(x, y, size) then
            return x, y
        end
    end
    return x, y
end

-- 菜单 / 结算画面：圆圈放正中间，恢复初始大小。
local function showCircleAtCenter()
    applySize(SIZE_START)
    applyColor(false)
    circleRoot:SetAnchoredPosition(0, 0)
end

-- 下一个目标：按当前分数定大小、是不是金圈、去哪儿。
local function nextTarget()
    local size = math.max(SIZE_MIN, SIZE_START - Game.score * SIZE_STEP)
    Game.bonus = (Game.hits % BONUS_EVERY) == (BONUS_EVERY - 1)    -- hits 从 0 数：第 5、10、15… 个
    applySize(size)
    applyColor(Game.bonus)
    local x, y = randomSpot(size)
    circleRoot:SetAnchoredPosition(x, y)
end

-- 点中后弹一下。必须「放大再回来」：只写去程的话补间停在终点，第二次点击起点等于终点，
-- 就再也看不到动静（pitfalls.md §D6）。整个动画放 pcall/safe 里，坏了也不影响玩法。
local function playPop()
    if not isReady(circleRoot) then return end
    if popSeq ~= nil then
        safe("Kill", function() popSeq:Kill(false) end)
        popSeq = nil
        -- 上一段被打断时可能停在半路，先归位
        safe("归位", function()
            circleRoot.localScaleX = 1.0
            circleRoot.localScaleY = 1.0
        end)
    end
    local out = game.Tween(circleRoot, { localScaleX = POP_SCALE, localScaleY = POP_SCALE }, POP_TIME)
    local back = game.Tween(circleRoot, { localScaleX = 1.0, localScaleY = 1.0 }, POP_TIME)
    if out == nil or back == nil then return end
    local seq = game.TweenSequence()
    if seq == nil then return end
    popSeq = seq
    safe("SetEase", function() out:SetEase(Enum.EaseType.OutBack) end)
    safe("Append 去", function() seq:Append(out) end)
    safe("Append 回", function() seq:Append(back) end)
    safe("Play", function() seq:Play() end)         -- 序列不 Play，里面的补间一个都不会动
end

-- ───────────── 一局的开始与结束 ─────────────

local function startRound()
    Game.round = Game.round + 1
    Game.score = 0
    Game.hits = 0
    Game.endAt = os.time() + ROUND_SECONDS
    Game.state = "playing"
    nextTarget()
    renderHud(true)
    log("第 " .. Game.round .. " 局开始（" .. ROUND_SECONDS .. " 秒）")
end

local function finishRound()
    Game.state = "over"
    Game.lockUntil = os.time() + RESTART_LOCK
    if Game.score > Game.best then
        Game.best = Game.score
    end
    setWarn(false)
    showCircleAtCenter()
    renderHud(true)
    log("第 " .. Game.round .. " 局结束 得分=" .. Game.score .. " 最高=" .. Game.best)
end

-- ───────────── 点击 ─────────────

-- 回调是具名函数而不是匿名函数：注册与移除要用同一个引用。
-- 签名照官方示例，只收一个参数（CursorEventData）。
local function onCircleClick(_data)
    if not Game.started then return end

    -- 菜单 / 结算画面：点圆圈开新局。结算后的头几秒不响应，免得连点直接跳过结算画面。
    if Game.state ~= "playing" then
        if Game.state == "over" and os.time() < Game.lockUntil then return end
        circleArea.raycastTarget = false
        startRound()
        circleArea.raycastTarget = true
        return
    end

    -- 时间已到、这一帧的 OnUpdate 还没来得及收尾：按超时处理，这次点击不算分。
    if os.time() >= Game.endAt then
        finishRound()
        return
    end

    -- 官方防重复手法：处理期间先关射线检测，收尾再打开。
    circleArea.raycastTarget = false
    if Game.bonus then
        Game.score = Game.score + BONUS_POINTS
    else
        Game.score = Game.score + 1
    end
    Game.hits = Game.hits + 1
    nextTarget()
    safe("playPop", playPop)      -- 先换位置再弹：弹的是新出现的那个圆
    renderHud()
    circleArea.raycastTarget = true
end

-- ───────────── 初始化 ─────────────

-- 返回 true = 初始化完成 / false = 不可恢复的失败 / nil = 稍后重试。
local function startGame()
    if Game.started then return true end

    if not resolveRefs() then
        printFault("找不到预设界面控件，请检查控件名称与层级（上面的日志与控件树就是实际值）")
        return false
    end

    -- 读画布尺寸；尺寸尚不可用时返回 nil，交给 OnUpdate 下一帧重试（官方范式）。
    local width, height = game.GetUICanvasSize()
    if not usableNumber(width) or not usableNumber(height) or width <= 0 or height <= 0 then
        return nil
    end
    Game.canvasWidth = width
    Game.canvasHeight = height

    -- 写 showCursor 后回读：写成功不等于运行时认账，真机默认是 false。
    local after = nil
    safe("读 showCursor", function() after = this.showCursor end)
    log("showCursor 设置前=" .. tostring(after) .. "（脚本加载时已写 true）")
    if after ~= true then
        safe("再写 showCursor", function() this.showCursor = true end)
        safe("回读 showCursor", function() after = this.showCursor end)
        log("showCursor 设置后=" .. tostring(after))
        if after ~= true then
            printFault("showCursor 改不动，请回编辑器：选中容器节点 → 打开【显示光标 / showCursor】")
        end
    end

    -- 显示层级：背景最底，分数文本次之，圆圈在最上面——这样即便圆圈盖住了分数文本也一定点得到。
    background:SetAsFirstSibling()
    scoreText:SetAsLastSibling()
    circleRoot:SetAsLastSibling()

    -- 背景（图片编号与官方示例相同）。
    background:SetImage(Enum.ImageSource.StaticReference, BACKGROUND_IMAGE_ID)
    background.imageType = Enum.ImageType.Stretch
    background.imageColor = Color(255, 255, 255)
    background:SetActive(true)
    background:SetVisible(true)

    -- 圆圈容器：中心锚点。
    circleRoot:SetActive(true)
    circleRoot:SetVisible(true)
    circleRoot:SetPivot(0.5, 0.5)

    -- 点击判定区：初始化期间先禁止点击。
    circleArea:SetActive(true)
    circleArea:SetVisible(true)
    circleArea:SetPivot(0.5, 0.5)
    circleArea:SetAnchoredPosition(0, 0)
    circleArea.raycastTarget = false

    -- 圆圈图片：只负责显示，不挂事件。
    circleImage:SetImage(Enum.ImageSource.StaticReference, CIRCLE_IMAGE_ID)
    circleImage.imageType = Enum.ImageType.Stretch
    circleImage:SetActive(true)
    circleImage:SetVisible(true)
    circleImage:SetPivot(0.5, 0.5)
    circleImage:SetAnchoredPosition(0, 0)
    circleImage:SetAsLastSibling()

    scoreText:SetActive(true)
    scoreText:SetVisible(true)
    -- 教学存档里分数文本只有 218×68，装不下「时间到！得分…点圆圈再来一局」。加宽、放大字号；
    -- 中心锚点，所以左右对称地长出去。都走 safe：这些是锦上添花，失败了不影响玩法。
    safe("加宽分数文本", function() scoreText:SetSizeDelta(HUD_WIDTH, HUD_HEIGHT) end)
    safe("放大字号", function() scoreText.fontSize = HUD_FONT_SIZE end)
    Game.hudRect = readHudRect()
    if Game.hudRect == nil then
        log("读不到分数文本的位置与尺寸，圆圈改为避开画布顶部 " .. HUD_BAND .. " 像素")
    end

    -- 只注册一次监听（与官方示例一致）。
    circleArea:AddCursorEventListener(Enum.CursorEventType.CursorClick, onCircleClick)

    Game.started = true
    Game.state = "menu"
    showCircleAtCenter()
    renderHud(true)
    circleArea.raycastTarget = true
    log("就绪 " .. STAMP .. "（画布 " .. tostring(width) .. " x " .. tostring(height) .. "）")
    return true
end

-- ───────────── 生命周期（宿主按固定名字调用）─────────────

function OnStart()
    log("OnStart " .. STAMP)
    math.randomseed(os.time())
    -- 不调这句，下面的 OnUpdate 是死代码。整局都要用它推进倒计时，所以初始化成功后也不关。
    script:EnableUpdate(true)
end

function OnUpdate(_dt)
    if not Game.started then
        Game.startAttempts = Game.startAttempts + 1
        local result = startGame()
        if result == false or (result == nil and Game.startAttempts >= Game.startRetryBudget) then
            if result == nil then
                printFault("画布尺寸 " .. Game.startAttempts .. " 帧都没就绪，请检查界面布局是否引用了这个控件组、容器节点是否激活")
            end
            script:EnableUpdate(false)
        end
        return
    end

    -- 游戏进行中：整秒倒计时，到点收尾；否则只在 HUD 文字变化时才刷新。
    if Game.state == "playing" then
        if os.time() >= Game.endAt then
            finishRound()
        else
            renderHud()
        end
    end
end

function OnDisable()
    log("OnDisable｜共 " .. Game.round .. " 局｜最高 " .. Game.best)
end

-- 脚本销毁时移除监听、关掉点击区，避免残留回调。
function OnDestroy()
    Game.state = "boot"
    if popSeq ~= nil then
        safe("Kill", function() popSeq:Kill(false) end)
        popSeq = nil
    end
    if isReady(circleArea) then
        circleArea.raycastTarget = false
        circleArea:RemoveCursorEventListener(Enum.CursorEventType.CursorClick, onCircleClick)
    end
    script:EnableUpdate(false)
    log("OnDestroy｜共 " .. Game.round .. " 局｜最高 " .. Game.best)
end
