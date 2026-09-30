-- ============================================================================
-- 千星奇域 · 客户端 Lua UI 探针：钉死两处「官方文档 vs 实测契约」的矛盾
--
-- 用法（两遍，约 3 分钟）：
--   1) 把本文件整段内容粘进一个**新建的客户端脚本**（千星沙箱 → 客户端脚本资源管理器）
--   2) 只改下面 CONFIG.controlName 成你画布上**真实存在**的控件名
--   3) 把脚本挂到一个已存在的控件上（建议挂在客户端控件容器的节点上）
--   4) 试玩，打开日志面板，只看 [探针] 开头的行，跑 5 秒后停止
--   5) 第一遍保持 CONFIG.enableUpdate = false；第二遍改成 true 再跑一次
--
-- 判读规则（照这个读，不要脑补）：
--   ● 两遍都看到 "[探针] OnInit / OnStart 进入" → 脚本确实加载并执行了，下面的结论才有效
--   ● 第一遍【看不到】"★ OnUpdate 被调用"，第二遍【看到】了
--         → 结论：OnUpdate 默认不调度，必须先 script:EnableUpdate(true)
--   ● 第一遍就【看到】"★ OnUpdate 被调用"
--         → 结论：OnUpdate 默认就调度，EnableUpdate 只用于开关
--   ● "读 Id" 与 "读 id" 哪一行打出数字，哪一行就是正确的字段名
--         两行都是 nil → 改用 "读 roots[1].Id / .id" 那两行的结果
--
-- ============================ 结案（2026-09-27 真机）============================
-- 本探针已于 2026-09-27 23:30–23:39 在真机跑完 v1/v2/v3 三轮，矛盾全部结清：
--
--   OnUpdate 默认调度       → 【默认不调度】。不调 EnableUpdate 整局 0 帧；
--                             调 script:EnableUpdate(true) 后 3080 帧。EnableUpdate 返回 nil。
--   控件运行时 ID 字段       → 【小写 id】。`.id = 1 <number>`，`.Id = nil <nil>`。
--                             （模拟器契约曾断言大写 Id，已被真机推翻。）
--   Enum.EaseType           → 【31 项，与文档全量清单逐项一致，无额外成员】；成员是 EnumItem。
--   Enum.EaseType.easeOutBack → 【不存在】，值为 nil。
--   typeof(nil) / type(nil)  → 都返回字符串 "nil"，不是 Lua nil。判空用 `== nil`。
--   控件标识取值              → 是【属性】不是方法：`:GetName()` / `:GetId()` 报 nil value。
--   找容器的入口              → 【script.object 就是挂载的容器本身】，
--                             `FindClientUIRoot(容器名)` 与 `FindClientUIRoot(索引)` 都返回 nil。
--   getmetatable(root/script/game) → 一律 nil，方法表无法枚举 → API 名只能查文档。
--   容器子控件                → 【0 项】。挂脚本不等于有控件；控件要在
--                             容器的「画布设置 → 前往编辑 → 添加控件」里加。
--
-- 结论已回写 references/api/runtime-contract.md §3/§3b/§3c/§9/§10。
-- 本文件保留为可复跑的证据来源；下次再跑请以 runtime-contract.md 的结案版为准。
-- ===============================================================================
--
-- 本探针不写文件、不改画布、不联网。日志用 print，不用 io（io 在客户端不存在）。
-- ============================================================================

local CONFIG = {
    controlName = "ScoreText",   -- ← 改成你画布上真实存在的控件名
    enableUpdate = false,        -- ← 第一遍 false，第二遍改 true
    childPath = "Panel/ScoreText", -- ← 若你知道一个子控件路径，填这里可顺带验证 FindChild 的 "A/B" 写法
}

local ticks = 0
local childPathTried = false

local function say(msg)
    print("[探针] " .. msg)
end

local function probe(what, fn)
    local ok, r = pcall(fn)
    if ok then
        say(what .. " → " .. tostring(r) .. "   (type=" .. tostring(typeof(r)) .. ")")
    else
        say(what .. " → 报错：" .. tostring(r))
    end
    return ok, r
end

function OnInit()
    say("OnInit 进入")
    say("typeof(script) = " .. tostring(typeof(script)))
    say("script.path = " .. tostring(script.path))
    say("script.object = " .. tostring(script.object) .. "  (type=" .. tostring(typeof(script.object)) .. ")")
end

function OnStart()
    say("OnStart 进入（此时控件树应已就绪）")

    if CONFIG.enableUpdate then
        probe("script:EnableUpdate(true)", function() return script:EnableUpdate(true) end)
    else
        say("本遍【没有】调用 EnableUpdate —— 用于验证 OnUpdate 的默认调度行为")
    end

    -- ① 控件运行时 ID 字段名：Id 还是 id
    local c = nil
    local ok, r = pcall(function() return game.FindClientUIRoot(CONFIG.controlName) end)
    if ok then c = r end
    if c == nil then
        say("FindClientUIRoot(\"" .. CONFIG.controlName .. "\") 返回 nil —— 控件名或层级不对，请改成真实控件名")
        local roots = nil
        local ok2, r2 = pcall(function() return game.GetClientUIRoots() end)
        if ok2 then roots = r2 end
        if type(roots) == "table" and roots[1] ~= nil then
            c = roots[1]
            say("改用 GetClientUIRoots()[1] 作为探测对象")
        end
    end

    if c ~= nil then
        say("目标控件已取得")
        probe("读 c.Id",          function() return c.Id end)
        probe("读 c.id",          function() return c.id end)
        probe("读 c.prefabIndex", function() return c.prefabIndex end)
        probe("读 c.name",        function() return c.name end)
        probe("写 c.Id = 1",      function() c.Id = 1 end)   -- 预期报 cannot set ... no such field
        probe("SetSiblingIndex 返回", function() return c:SetSiblingIndex(0) end)

        -- ② FindChild 的 "A/B" 路径写法
        probe("FindChild(\"" .. CONFIG.childPath .. "\")",
            function() return c:FindChild(CONFIG.childPath) end)
        probe("GetChild(整串路径)",
            function() return c:GetChild(CONFIG.childPath) end)
    end

    -- ③ 枚举表是否与文档一致（顺手抽验两个）
    probe("Enum.EaseType.OutBack",  function() return tostring(Enum.EaseType.OutBack) end)
    probe("Enum.EaseType.OutQuad",  function() return tostring(Enum.EaseType.OutQuad) end)
    probe("Enum.EaseType.easeOutBack（预期 nil）",
        function() return tostring(Enum.EaseType.easeOutBack) end)
end

function OnUpdate(dt)
    ticks = ticks + 1
    if ticks == 1 then
        say("★ OnUpdate 被调用（第 1 帧，dt=" .. tostring(dt) .. "）")
    elseif ticks % 60 == 0 then
        say("OnUpdate 已跑 " .. ticks .. " 帧")
    end
end

function OnDisable()
    say("OnDisable 进入；OnUpdate 累计帧数 = " .. tostring(ticks))
end

function OnDestroy()
    say("OnDestroy 进入；OnUpdate 累计帧数 = " .. tostring(ticks))
    if ticks == 0 then
        say("结论：OnUpdate 在未调用 EnableUpdate 时【从未】被调用 → 默认不调度")
    else
        say("结论：OnUpdate 被调用了 " .. ticks .. " 帧")
    end
end
