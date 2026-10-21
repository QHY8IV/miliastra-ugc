-- ============================================================================
--  render.lua —— 千星奇域客户端渲染器：把 compress.py 切出的块画成一张图
--               （分帧建立 / 大块优先 / 控件复用）
-- ============================================================================
--
--  【怎么用】
--    1) 跑 compress.py 得到 output.lua
--    2) 打开本文件，找到 ▼▼▼ 数据区 ▼▼▼，把那一整段替换成 output.lua 的内容
--    3) 按 README / AGENTS.md 的步骤把本文件挂成关卡的 external_lua_file
--
--  【数据区字段】（compress.py 生成）
--    IMG.N / IMG.W / IMG.H   边长 / 逻辑宽 / 逻辑高
--    IMG.STD                 使用的容差
--    IMG.ENC                 "p64"（默认）、"b64" 或 "hex"
--    IMG.LAYERED             true = 分层数据（允许重叠，数据顺序即绘制顺序）
--    IMG.NBLK                块数（= 需要的控件数）
--    IMG.MAE                 平均色差（仅供参考）
--    IMG.DATA                编码后的块数据
--      hex：10 个 hex 字符 = w,h,r,g,b（各 1 字节）
--      b64： 7 个字符 = [3 字节 w,h,r → 4 字符][2 字节 g,b → 3 字符]
--      p64：11 个字符，坐标显式给出（x,y,w,h,RGB 都在串里）
--    ★ hex / b64 不存坐标：块按"行主序扫描顺序"排列，本文件重放同一套游标即可还原
--
--  【性能实测】
--    新建控件 ≈ 0.223 ms/个；改属性 ≈ 0.004～0.012 ms/次
--    50,000 个控件正常；61,440 个会让引擎销毁脚本（表现是卡死）
--
--  【建立方式：隐藏分组建立 → 建完分帧显示】（本文件默认做法，RENDER.GROUP_HIDE）
--     块挂在【隐藏的全屏透明分组】下建立，再每帧显示一组。依据【第三方实测：
--     wwh177/miliastra-image-algorithm，未在本技能真机复验】：
--       · 稳态每帧开销 = 可见控件数 × 15~18 µs（5,000 → 12 fps；20,000 → 3 fps）；
--         父级隐藏时 ≈ 1.7 µs/个，约 1/9。实测 20,000 个控件：301 ms/帧 → 35 ms/帧。
--         **建立期间**（本文件按 FRAME_BUDGET 摊帧）这个差别就是"能不能玩"。
--       · 一次性让全部控件变可见，引擎要在一帧内重建整批 → 卡顿，所以"变可见"也分帧。
--       · 建立耗时 ≈ 0.27·N + 3.75e-6·N² ms（N = 块数）；单次回调约 20 s 后会被引擎
--         截断——不报错、只是数据没建完（画面缺一块），所以必须分帧。
--       · 隐藏 / 显示必须用冒号调用：c:SetVisible(false) ✓ ／ c.visible = false ✗（静默失败）
--    分组建立失败、或"在隐藏的父级下建不出子控件"时（用一个一次性探针发现），
--    自动回退为「直接挂在宿主控件下、全程可见」：画面正常，只是慢。
-- ============================================================================


-- ============================================================================
-- ▼▼▼ 数据区：把 compress.py 的输出整段替换到这里 ▼▼▼
-- ============================================================================
local IMG = {}
IMG.N = 4
IMG.W = 4
IMG.H = 4
IMG.STD = 3
IMG.ENC = "hex"
IMG.NBLK = 0
IMG.MAE = 0
IMG.DATA = ""
-- ============================================================================
-- ▲▲▲ 数据区结束 ▲▲▲
-- ============================================================================


-- ============================================================================
-- RENDER 区（可调参数）
-- ============================================================================
local RENDER = {
    TEMPLATE = 0,                                   -- 0 = 自动探测
    TEMPLATE_PRIORITY = { 1073741931, 1073758498, 1073741926 },
    TEMPLATE_SCAN = { 1073741800, 1073742100 },
    UNIT = "AUTO",          -- 每个源像素占多少画布单位；"AUTO" = 按画布自适应
    MAX_RATIO = 0.98,       -- 图最多占画布的比例
    MARGIN = 1,             -- 每块向外扩（防拼缝）
    RECT_IMG = 100001,      -- 引擎内置纯色图
    SHOW_CURSOR = true,
    LOCK_CHARACTER = true,
    BIG_FIRST = true,       -- 先建大块：轮廓先出来、细节随后补齐（实测 STD=3 时前 9% 的块盖住一半画面）
    FRAME_BUDGET = 0.012,   -- 每帧最多花多少秒建控件；0 = 在 OnStart 里一次建完（期间画面卡住）
    BUILD_MODE = "manual",  -- "manual" = 完全按 FRAME_BUDGET 决定
                            -- "auto"   = 按预估耗时自动选：≤ SINGLE_SAFE_MS 一次建完，否则分帧
    SINGLE_SAFE_MS = 10000, -- 【本技能建议】一次建完最多用多少毫秒（看门狗 22 s 的 ~45%，留余量）
    WATCHDOG_MS = 22000,    -- 【第三方实测】单次回调约 22 s 被引擎静默截断（早期文档写 20 s）
    MS_PER_CONTROL = 0.223, -- 【实测·真机】新建一个控件约 0.223 ms（本技能台账）
    QUAD_MS = 3.75e-6,      -- 【第三方实测】建控件耗时二次项：T ≈ a·N + b·N²
    FRAME_MS = 16,          -- auto 分帧：每帧**总**开销目标（毫秒），建控件预算 = 它减去隐藏层渲染
    HIDDEN_US = 1.7,        -- 【第三方实测】父级隐藏时每控件每帧约 1.7 µs
    BUDGET_MAX_S = 0.040,   -- auto 分帧：每帧建控件的耗时上限（再高会明显掉帧）
    PRESET_TEMPLATE = false,-- true = 模板在编辑器里已经设好（锚点/轴心居中、图片 100001、拉伸 Stretch），
                            --        新建控件时就不再逐个写这 5 项（每控件少 5 次引擎调用，真机收益未测）
    GROUP_HIDE = true,      -- true = 块挂在隐藏的全屏透明分组下建立，建完分帧显示（稳态帧开销约 1/9）
                            --        false = 老做法：直接挂在宿主控件下、全程可见（对比用）
    GROUPS = 16,            -- 分成几组：建完每帧显示一组（把"变可见"的成本摊到 K 帧）
}


-- ============================================================================
-- 实现（通常不用改）
-- ============================================================================
local function log(...) print("[render] " .. table.concat({ ... }, " ")) end
local function err(...) printerr("[render] " .. table.concat({ ... }, " ")) end
local function I(v) return math.floor(tonumber(v) or 0) end

-- ---------------------------------------------------------------------------
-- 建立计划：N 个控件要多久、该不该分帧
--   T ≈ a·N + b·N²    （a = 本技能真机实测 0.223 ms/个；b = 第三方实测）
--   判据用**预估耗时**而不是块数：二次项意味着 4 万块不是 2 万块的两倍，而是 2.5 倍。
--   单次回调超过看门狗会被静默截断（不报错、画面缺块），所以分成"安全 / 不建议 / 禁止"三档。
-- ---------------------------------------------------------------------------
local function estimateBuildMs(n)
    return n * RENDER.MS_PER_CONTROL + RENDER.QUAD_MS * n * n
end

local function decideMode(n)
    local est = estimateBuildMs(n)
    local single = (RENDER.FRAME_BUDGET <= 0)
    if RENDER.BUILD_MODE == "auto" then
        single = (est <= RENDER.SINGLE_SAFE_MS)
        log(string.format("建立计划：%d 块 → 预估 %.1f s（%.1f s 线性 + %.1f s 二次项）→ %s",
            I(n), est / 1000,
            n * RENDER.MS_PER_CONTROL / 1000,
            RENDER.QUAD_MS * n * n / 1000,
            single and "一次建完" or "分帧（隐藏建立）"))
    end
    if single then
        if est > RENDER.WATCHDOG_MS then
            err(string.format("⚠️ 单次回调预估 %.1f s > 看门狗 %.0f s：一定会被静默截断（画面缺块）。"
                .. "把 BUILD_MODE 设为 \"auto\"，或让 FRAME_BUDGET > 0",
                est / 1000, RENDER.WATCHDOG_MS / 1000))
        elseif est > RENDER.SINGLE_SAFE_MS then
            err(string.format("⚠️ 单次回调预估 %.1f s > 建议上限 %.0f s：进关卡会定格这么久。"
                .. "不想定格就让 FRAME_BUDGET > 0（总时长会更长）",
                est / 1000, RENDER.SINGLE_SAFE_MS / 1000))
        end
    end
    return single, est
end

-- p64 每个字符都加了 48（见 blockcodec.py 的 P64_BASE），所以整组字符还原成数值时
-- 要一次性减掉"基数 × 各位权之和"。下面三个常数就是从 BASE 算出来的，别写死成魔法数。
local P64_BASE = 48
local P64_AXIS_BIAS = P64_BASE * (64 + 1)                                   -- 3120
local P64_WH_BIAS = P64_BASE * (64 * 64 + 64 + 1)                           -- 199728
local P64_RGB_BIAS = P64_BASE * (64 * 64 * 64 + 64 * 64 + 64 + 1)           -- 12782640

local host, template = nil, 0
local canvasW, canvasH = 0, 0
local pool = {}         -- 已建好、当前闲置的控件（下次建立时优先复用）

-- 分组：建立期间挂着块控件的全屏透明控件，默认处于隐藏态（见文件头【建立方式】）
local groups = {}       -- 分组控件（创建顺序 = 兄弟顺序 = 显示顺序 = 绘制层次）
local perGroup = 0      -- 每组放多少块
local revealIdx = 0     -- > 0 = 正在分帧显示，值 = 下一个要显示的分组下标；0 = 不在显示阶段
local groupApiOk = nil  -- SetVisible / SetActive 的冒号调用是否成功（nil = 还没试过）
local groupProbe = nil  -- 能否在【隐藏的父级】下新建控件（nil = 还没试过；false = 走回退路径）

-- ---------------------------------------------------------------------------
-- 字符 → 数值查表
-- ---------------------------------------------------------------------------
local HEXV = {}
for i = 0, 9 do HEXV[48 + i] = i end
for i = 0, 5 do
    HEXV[65 + i] = 10 + i
    HEXV[97 + i] = 10 + i
end

local B64V = {}
do
    local CH = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/"
    for i = 1, #CH do B64V[string.byte(CH, i)] = i - 1 end
end

-- ---------------------------------------------------------------------------
-- 扫描游标：hex / b64 的数据里不带坐标，靠重放"行主序扫描"把 x、y 还原出来。
-- occ[c] 记第 c 列已经被占到第几行；游标从左往右走，走不过去就换下一行从头来。
-- ---------------------------------------------------------------------------
local function newScan(N)
    return { occ = {}, ci = 0, cj = 0, N = N }
end

local function scanNext(S)
    while true do
        while S.ci < S.N do
            local o = S.occ[S.ci]
            if o and o >= S.cj then S.ci = S.ci + 1 else break end
        end
        if S.ci < S.N then return S.ci, S.cj end
        S.cj = S.cj + 1
        S.ci = 0
    end
end

local function scanPlace(S, x, y, w, h)
    local last = y + h - 1
    for xx = x, x + w - 1 do
        local o = S.occ[xx]
        if not o or o < last then S.occ[xx] = last end
    end
    S.ci = x + w
end

-- ---------------------------------------------------------------------------
-- 解码器工厂：返回 function(i) -> x, y, w, h, r, g, b（nil = 数据到头）
-- ---------------------------------------------------------------------------
local function makeHexDecoder(data, N)
    local S = newScan(N)
    return function(i)
        local o = (i - 1) * 10
        local a1, a2, a3, a4, a5, a6, a7, a8, a9, a10 = string.byte(data, o + 1, o + 10)
        if not a10 then return nil end
        local w = HEXV[a1] * 16 + HEXV[a2]
        local h = HEXV[a3] * 16 + HEXV[a4]
        local r = HEXV[a5] * 16 + HEXV[a6]
        local g = HEXV[a7] * 16 + HEXV[a8]
        local b = HEXV[a9] * 16 + HEXV[a10]
        local x, y = scanNext(S)
        scanPlace(S, x, y, w, h)
        return x, y, w, h, r, g, b
    end
end

local function makeB64Decoder(data, N)
    local S = newScan(N)
    return function(i)
        local base = (i - 1) * 7
        local c1, c2, c3, c4, c5, c6, c7 = string.byte(data, base + 1, base + 7)
        if not c7 then return nil end
        local v1, v2, v3, v4 = B64V[c1], B64V[c2], B64V[c3], B64V[c4]
        local v5, v6, v7 = B64V[c5], B64V[c6], B64V[c7]
        if not (v1 and v2 and v3 and v4 and v5 and v6 and v7) then return nil end
        -- 拆成 24 位 + 16 位两组，而不是把 5 字节并成 40 位整数 ——
        -- Lua 的中间值超过 32 位就会回绕，分组之后每一步都小于 2^24，任何整数宽度都安全。
        local a = ((v1 * 64 + v2) * 64 + v3) * 64 + v4
        local w = math.floor(a / 65536)
        local h = math.floor(a / 256) % 256
        local r = a % 256
        local b2 = (v5 * 64 + v6) * 64 + v7
        local g = math.floor(b2 / 256)
        local b = b2 % 256
        local x, y = scanNext(S)
        scanPlace(S, x, y, w, h)
        return x, y, w, h, r, g, b
    end
end

local function makeDecoder(enc, data, N)
    if enc == "b64" then return makeB64Decoder(data, N) end
    return makeHexDecoder(data, N)      -- 默认按 hex
end

-- ---------------------------------------------------------------------------
-- 模板探测：找一个能 SetImage 的图片控件当模板
-- ---------------------------------------------------------------------------
local function tryTemplate(id)
    local ok, c = pcall(game.InstantiateClientUIControl, id, host)
    if ok and c ~= nil then
        local isImg = pcall(function()
            c.SetImage(c, Enum.ImageSource.StaticReference, RENDER.RECT_IMG)
        end)
        pcall(game.DestroyClientUIControl, c)
        if isImg then return id end
    end
    return nil
end

local function discoverTemplate()
    if RENDER.TEMPLATE and RENDER.TEMPLATE > 0 then
        local t = tryTemplate(RENDER.TEMPLATE)
        if t then return t end
        err(string.format("指定模板 %d 不可用，改为自动探测", RENDER.TEMPLATE))
    end
    for i = 1, #RENDER.TEMPLATE_PRIORITY do
        local t = tryTemplate(RENDER.TEMPLATE_PRIORITY[i])
        if t then
            log("模板命中优先项 " .. I(t))
            return t
        end
    end
    for id = RENDER.TEMPLATE_SCAN[1], RENDER.TEMPLATE_SCAN[2] do
        local t = tryTemplate(id)
        if t then
            log(string.format("模板自动探测命中 %d", I(t)))
            return t
        end
    end
    return nil
end

-- ---------------------------------------------------------------------------
-- 控件：新建、或从上一轮留着的 spare 里复用
-- ---------------------------------------------------------------------------
local hidden = {}       -- 被隐藏、等待复用的控件

-- ---------------------------------------------------------------------------
-- 分组：建立期间把块挂在隐藏的全屏透明控件下，建完再逐帧显示（见文件头【建立方式】）
--   子控件坐标不受影响：组居中、锚点 (0.5,0.5)、位置 (0,0) → 组中心 = 宿主中心，
--   与"直接平铺挂在宿主下"完全等价；组本身的顺序就是它那批块的绘制层次。
-- ---------------------------------------------------------------------------
local function groupVisible(g, on)
    local ok1 = pcall(function() g:SetVisible(on) end)
    local ok2 = pcall(function() g:SetActive(on) end)
    if groupApiOk == nil and on == false then
        groupApiOk = (ok1 and ok2)
        if not groupApiOk then
            err("⚠️ 分组的 SetVisible / SetActive 冒号调用失败：隐藏建立无效，"
                .. "建立期间与稳态的帧开销会高约 9 倍（画面仍然正确）")
        end
    end
end

local function newGroup()
    local ok, g = pcall(game.InstantiateClientUIControl, template, host)
    if not ok or g == nil then return nil end
    ok = pcall(function()
        g:SetAnchorMin(0.5, 0.5)
        g:SetAnchorMax(0.5, 0.5)
        g:SetPivot(0.5, 0.5)
        g:SetSizeDelta(canvasW, canvasH)
        g:SetAnchoredPosition(0, 0)
        g.SetImage(g, Enum.ImageSource.StaticReference, RENDER.RECT_IMG)
        g.imageType = Enum.ImageType.Stretch
        g.imageColor = Color.FromRGBA(0, 0, 0, 0)       -- 全透明，只当容器
    end)
    if not ok then pcall(game.DestroyClientUIControl, g); return nil end
    groupVisible(g, false)
    return g
end

-- 按块数定"几组 / 每组多少块"。分组数或组容量变了就整组重建 ——
-- 控件一旦挂在某个组下就搬不动，旧控件留着只会把层次次序弄错。
local function prepareGroups(nblk)
    if not RENDER.GROUP_HIDE then
        if #groups > 0 then
            for i = 1, #groups do pcall(game.DestroyClientUIControl, groups[i]) end
            groups, pool, hidden = {}, {}, {}
        end
        perGroup = 0
        revealIdx = 0
        return
    end

    local K = I(RENDER.GROUPS)
    if K < 1 then K = 1 end
    if nblk > 0 and K > nblk then K = nblk end
    if nblk <= 0 then K = 1 end
    local wantPerGroup = math.max(1, math.ceil(math.max(1, nblk) / K))

    if #groups > 0 and (#groups ~= K or perGroup ~= wantPerGroup) then
        log(string.format("分组容量变化（%d 组 × %d 块 → %d 组 × %d 块），整组重建",
            #groups, perGroup, K, wantPerGroup))
        for i = 1, #groups do pcall(game.DestroyClientUIControl, groups[i]) end
        groups, pool, hidden = {}, {}, {}
    end
    perGroup = wantPerGroup
    while #groups < K do
        local g = newGroup()
        if not g then break end
        groups[#groups + 1] = g
    end
    for i = 1, #groups do groupVisible(groups[i], false) end   -- 每次建立都从隐藏态开始

    -- 探针：确认"在隐藏的父级下新建控件"这条路走得通。只做一次（1 次实例化 = 0.223 ms）。
    -- 走不通就整组退掉、回退成老做法 —— 否则块会全部建立失败（日志里"失败 N"），画面是空的。
    if groupProbe == nil and #groups > 0 then
        local ok, probe = pcall(game.InstantiateClientUIControl, template, groups[1])
        groupProbe = (ok and probe ~= nil)
        if probe ~= nil then pcall(game.DestroyClientUIControl, probe) end
        if not groupProbe then
            err("⚠️ 在隐藏的分组下新建控件失败：回退为直接挂在宿主控件下、全程可见"
                .. "（画面正常，但建立期间与稳态的帧开销高约 9 倍）")
        end
    end
    if groupProbe == false then
        for i = 1, #groups do pcall(game.DestroyClientUIControl, groups[i]) end
        groups, pool, hidden = {}, {}, {}
        perGroup = 0
        revealIdx = 0
        return
    end
    revealIdx = 0
end

-- 第 k 块挂到哪个分组下（k = 建立序号，从 1 开始）
local function parentForIndex(k)
    if #groups == 0 then return host end
    local gi = math.floor((k - 1) / perGroup) + 1
    if gi > #groups then gi = #groups end
    if gi < 1 then gi = 1 end
    return groups[gi] or host
end

-- 每帧显示一组：一帧内让全部控件变可见会被引擎当成"重建整批渲染"→ 卡顿
local function revealStep()
    local g = groups[revealIdx]
    revealIdx = revealIdx + 1
    if g then groupVisible(g, true) end
    if revealIdx > #groups then
        revealIdx = 0
        log(string.format("  显示完成：%d 组已可见", #groups))
        pcall(function() script:EnableUpdate(false) end)
    end
end

local function setupNewControl(c)
    c:SetAnchorMin(0.5, 0.5)
    c:SetAnchorMax(0.5, 0.5)
    c:SetPivot(0.5, 0.5)
    c.SetImage(c, Enum.ImageSource.StaticReference, RENDER.RECT_IMG)
    c.imageType = Enum.ImageType.Stretch
end

local function acquireControl(reuse, k)
    local c = reuse
    if c == nil then
        -- 新建的块挂进分组（k = 建立序号）；复用的块本来就在它该在的组下，不动父级
        c = game.InstantiateClientUIControl(template, parentForIndex(k))
        if c == nil then return nil end
        if not RENDER.PRESET_TEMPLATE then setupNewControl(c) end
    elseif hidden[c] then
        -- 复用：锚点 / 图片 / 拉伸方式建的时候已经设过，这里只改尺寸、颜色、位置
        -- （实测改属性约 0.012 ms，新建约 0.223 ms）
        hidden[c] = nil
        pcall(function() c:SetActive(true) end)
    end
    return c
end

-- ---------------------------------------------------------------------------
-- 建立任务
--   p64：读一块、建一个控件。块在 Python 侧已按面积从大到小排好，位置是显式的，
--        没有查表、没有扫描推演、没有中间数组。
--   hex / b64：先把全部块解码成数组（纯 Lua 运算，很快），再决定建立顺序。
--        两种编码的块互不重叠，所以建立顺序不影响最终画面；BIG_FIRST 只是让轮廓先出来。
--   FRAME_BUDGET > 0 时把建立摊到每一帧，游戏不会卡住好几秒。
-- ---------------------------------------------------------------------------
local job = nil
local spare = {}        -- 上一轮建立留下、可以复用的控件

local function finishJob()
    -- 上一轮用剩的控件收起来，下次复用
    for k = job.made + 1, #spare do
        local c = spare[k]
        if not hidden[c] then
            hidden[c] = true
            pcall(function() c:SetActive(false) end)
        end
        pool[#pool + 1] = c
    end
    spare = {}
    local dt = os.clock() - job.t0
    local single = job.single
    log(string.format("渲染完成：%d 个控件（新建 %d，复用 %d，失败 %d），耗时 %.2f s%s",
        I(job.made), I(job.created), I(job.reused), I(job.failed), dt,
        single and "（一次建完）" or string.format("（分 %d 帧）", I(job.frames))))
    log(string.format("  预估 %.1f s ／ 实际 %.1f s（%s）",
        (job.est or 0) / 1000, dt,
        single and "一次建完" or "分帧，含逐帧开销所以更慢"))
    log(string.format("  %dx%d 像素  编码=%s  块数=%d  压缩率=%.2fx  MAE=%.2f",
        job.N, job.N, tostring(IMG.ENC), I(job.made),
        (job.N * job.N) / math.max(1, job.made), IMG.MAE or 0))
    log(string.format("  UNIT=%.3f  显示边长 %.0f 单位（画布 %dx%d）",
        job.unit, job.side, I(canvasW), I(canvasH)))
    if #groups > 0 then
        log(string.format("  分组：%d 个 × 约 %d 块，建立期间隐藏（稳态帧开销约为全程可见的 1/9）",
            #groups, perGroup))
    elseif RENDER.GROUP_HIDE and groupProbe ~= false then
        err("⚠️ 分组创建失败：回退为直接挂在宿主控件下、全程可见"
            .. "（画面正常，但建立期间与稳态的帧开销高约 9 倍）")
    end
    job = nil

    -- 建完之后再让画面出现：分帧显示（一帧全变可见 = 一帧重建整批渲染）
    if #groups > 0 then
        revealIdx = 1
        if not single then
            log(string.format("  开始显示：每帧显示 1 组，共 %d 帧", #groups))
            return                                      -- 保持 EnableUpdate(true)
        end
        while revealIdx > 0 do revealStep() end          -- 一次建完模式：显示也一次到位
    end
    pcall(function() script:EnableUpdate(false) end)     -- 建完就不用每帧回调了
end

local function pumpP64(budget)
    local J = job
    local data, byte = J.data, string.byte
    local k, n = J.k, J.n
    local unit, hk = J.unit, J.unit * 0.5
    local half, m2 = J.side * 0.5, J.mg * 2
    local made, created, reused, failed = J.made, J.created, J.reused, J.failed
    local preset = RENDER.PRESET_TEMPLATE
    local o = (k - 1) * 11
    local t0 = os.clock()

    while k <= n do
        local c1, c2, c3, c4, c5, c6, c7, c8, c9, c10, c11 = byte(data, o + 1, o + 11)
        if not c11 then
            n = k - 1
            break
        end
        local c = spare[made + 1]
        if c then
            reused = reused + 1
            if hidden[c] then
                hidden[c] = nil
                pcall(c.SetActive, c, true)
            end
        else
            c = game.InstantiateClientUIControl(template, parentForIndex(made + 1))
            if c ~= nil then
                created = created + 1
                if not preset then setupNewControl(c) end
            end
        end
        if c ~= nil then
            local wh = (c5 * 64 + c6) * 64 + c7 - P64_WH_BIAS
            local v = ((c8 * 64 + c9) * 64 + c10) * 64 + c11 - P64_RGB_BIAS
            c:SetSizeDelta((wh // 512) * unit + m2, (wh % 512) * unit + m2)
            c.imageColor = Color.FromRGBA(v // 65536, v // 256 % 256, v % 256, 255)
            c:SetAnchoredPosition((c1 * 64 + c2 - P64_AXIS_BIAS) * hk - half,
                                  half - (c3 * 64 + c4 - P64_AXIS_BIAS) * hk)
            made = made + 1
            pool[made] = c
        else
            failed = failed + 1
        end
        k = k + 1
        o = o + 11
        -- 每 32 个看一次表；os.clock 的开销相对于建控件可以忽略
        if budget > 0 and k % 32 == 0 and os.clock() - t0 >= budget then break end
    end

    J.k, J.n, J.made, J.created, J.reused, J.failed = k, n, made, created, reused, failed
    J.frames = J.frames + 1
    if k > n then finishJob() end
end

local function pumpBlocks(budget)
    local J = job
    local t0 = os.clock()
    local k = J.k
    local n = #J.order
    local unit, half, mg = J.unit, J.side * 0.5, J.mg
    local X, Y, Wd, Hd, R, G, B = J.X, J.Y, J.Wd, J.Hd, J.R, J.G, J.B

    while k <= n do
        local i = J.order[k]
        local w, h = Wd[i], Hd[i]
        local c = acquireControl(spare[J.made + 1], J.made + 1)
        if c then
            c:SetSizeDelta(w * unit + mg * 2, h * unit + mg * 2)
            c.imageColor = Color.FromRGBA(R[i], G[i], B[i], 255)
            c:SetAnchoredPosition(-half + (X[i] + w * 0.5) * unit,
                                  half - (Y[i] + h * 0.5) * unit)
            J.made = J.made + 1
            pool[J.made] = c
            if spare[J.made] then J.reused = J.reused + 1 else J.created = J.created + 1 end
        else
            J.failed = J.failed + 1
        end
        k = k + 1
        if budget > 0 and k % 32 == 0 and os.clock() - t0 >= budget then break end
    end

    J.k = k
    J.frames = J.frames + 1
    if k > n then finishJob() end
end

-- 按面积从大到小排序（桶排序，O(块数)）：图像先出轮廓，再补细节
local function orderByAreaDesc(Wd, Hd, n)
    local buckets, areas = {}, {}
    for i = 1, n do
        local a = Wd[i] * Hd[i]
        local list = buckets[a]
        if not list then
            list = {}
            buckets[a] = list
            areas[#areas + 1] = a
        end
        list[#list + 1] = i
    end
    table.sort(areas, function(p, q) return p > q end)
    local order = {}
    for _, a in ipairs(areas) do
        local list = buckets[a]
        for k = 1, #list do order[#order + 1] = list[k] end
    end
    return order
end

local function startPumping(pump)
    if job.single then
        pump(0)                                         -- 一次建完：期间画面定格，耗时 = 预估
    else
        pcall(function() script:EnableUpdate(true) end)
    end
end

-- auto 模式的分帧预算：每帧**总**开销目标 FRAME_MS，减去"已建好的控件在隐藏父级下"的渲染成本。
-- 建得越多、隐藏层本身越贵，所以预算要随之收缩 —— 这比固定 40 ms 稳：
-- 固定预算在大 N 时每帧实际是 40 ms + N×1.7 µs（4 万块时已经 108 ms）。
local function frameBudget()
    if job == nil or job.single then return 0 end
    if RENDER.BUILD_MODE == "manual" then return RENDER.FRAME_BUDGET end
    local hidden = (job.made or 0) * RENDER.HIDDEN_US / 1000000
    local b = RENDER.FRAME_MS / 1000 - hidden
    if b > RENDER.BUDGET_MAX_S then b = RENDER.BUDGET_MAX_S end
    if b < 0.003 then b = 0.003 end
    return b
end

local function build()
    if not IMG.DATA or IMG.DATA == "" then
        err("数据区为空：请把 compress.py 的输出粘贴进来")
        return
    end

    local N = IMG.N or IMG.W
    local limit = math.min(canvasW, canvasH) * RENDER.MAX_RATIO
    local unit = RENDER.UNIT
    if type(unit) == "string" then
        unit = limit / N
    else
        local need = N * unit
        if need > limit then
            log(string.format("UNIT %.3f 超出画布，自动改为 %.3f", unit, limit / N))
            unit = limit / N
        end
    end

    local t0 = os.clock()
    local common = { N = N, unit = unit, side = N * unit, mg = RENDER.MARGIN,
                     made = 0, created = 0, reused = 0, failed = 0, frames = 0, t0 = t0 }

    -- 分组要在"取复用控件"之前定好：分组容量变了会连控件一起销毁，复用池必须清空
    local function takeSpare()
        for i = 1, #pool do spare[#spare + 1] = pool[i] end
        pool = {}
    end

    if IMG.ENC == "p64" then
        local n = IMG.NBLK or 0
        local single, est = decideMode(n)
        prepareGroups(n)
        takeSpare()
        job = { p64 = true, data = IMG.DATA, k = 1, n = n, single = single, est = est }
        for key, value in pairs(common) do job[key] = value end
        startPumping(pumpP64)
        return
    end

    local dec = makeDecoder(IMG.ENC or "hex", IMG.DATA, N)
    local X, Y, Wd, Hd, R, G, B = {}, {}, {}, {}, {}, {}, {}
    local n = 0
    for i = 1, (IMG.NBLK or 0) do
        local x, y, w, h, r, g, b = dec(i)
        if not x then break end
        n = n + 1
        X[n], Y[n], Wd[n], Hd[n], R[n], G[n], B[n] = x, y, w, h, r, g, b
    end

    local order
    if RENDER.BIG_FIRST then
        order = orderByAreaDesc(Wd, Hd, n)
    else
        order = {}
        for i = 1, n do order[i] = i end
    end
    log(string.format("解码 %d 块用时 %.3f s", I(n), os.clock() - t0))

    local single, est = decideMode(n)
    prepareGroups(n)
    takeSpare()
    job = { order = order, k = 1, X = X, Y = Y, Wd = Wd, Hd = Hd, R = R, G = G, B = B,
            single = single, est = est }
    for key, value in pairs(common) do job[key] = value end
    startPumping(pumpBlocks)
end

-- ---------------------------------------------------------------------------
-- 入口
-- ---------------------------------------------------------------------------
function OnStart()
    log("===== 最大对齐矩形合并压缩 · 渲染器 =====")

    host = script.object
    pcall(function()
        local p = host and host.parent
        if p and p.alive then host = p end
    end)
    canvasW, canvasH = game.GetUICanvasSize()
    canvasW, canvasH = I(canvasW), I(canvasH)
    log(string.format("画布 %dx%d  宿主=%s", canvasW, canvasH, tostring(host)))

    if not IMG.DATA or IMG.DATA == "" then
        err("数据区为空：请把 compress.py 的输出粘贴到本文件的『数据区』")
        return
    end

    template = discoverTemplate()
    if not template then
        err("找不到可用的图片控件模板。请按 README『模板准备』章节创建客户端控件模板。")
        return
    end
    log("使用模板 = " .. I(template))
    log(string.format("数据：%dx%d  %d 块  STD=%s  ENC=%s  MAE=%.2f",
        IMG.W or IMG.N, IMG.H or IMG.N, IMG.NBLK or 0, tostring(IMG.STD),
        tostring(IMG.ENC), IMG.MAE or 0))

    if (IMG.NBLK or 0) > 55000 then
        err(string.format("⚠️ 块数 %d 可能超过引擎上限（实测 50,000 正常、61,440 崩溃）", IMG.NBLK))
    end

    build()

    local t = script.object
    if RENDER.SHOW_CURSOR then pcall(function() t.showCursor = true end) end
    if RENDER.LOCK_CHARACTER then
        pcall(function() t.disableKeyEventPassthrough = true end)
    end

    log("===== 就绪 =====")
end

function OnUpdate(dt)
    if job then
        local b = frameBudget()
        if job.p64 then pumpP64(b) else pumpBlocks(b) end
    elseif revealIdx > 0 then
        revealStep()                                    -- 建完了：每帧放出一组
    end
end

function OnDestroy()
    log("[render] OnDestroy")
    if host then
        -- 控件按类型封死了字段：不存在的方法读出来是 nil，调下去会抛错。
        -- 这里先确认它确实是个函数再调，免得靠 pcall 兜住一个本来就不存在的接口。
        if type(host.RemoveAllKeyEventListeners) == "function" then
            pcall(function() host:RemoveAllKeyEventListeners() end)
        end
        if type(host.RemoveAllCursorEventListeners) == "function" then
            pcall(function() host:RemoveAllCursorEventListeners() end)
        end
    end
end
