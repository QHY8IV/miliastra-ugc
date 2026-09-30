/**
 * selftest-contract.mjs —— 「世界契约」自检：references/api/runtime-contract.md 与官方文档里每条可验证的事实，
 * 在模拟世界里的体现。用例名后面的括号是出处；【真机】= 契约里带日期的真机回传，【文档】= 官方原文，【模型】= 文档没写的建模。
 *
 * 锁住的是「模拟器按这些事实工作」。如果真机与这里不同，先改这里、改 lua-sim.md 的保真度表，再谈别的。
 */

import { Sim } from './world.mjs';
import { LuaSyntaxError } from '../lua/value.mjs';

const TREE = '容器节点:container@stretch(标题:text@0,300,400x80,图:image@200x200,按钮:button@200x80,区:area@100x100,子容器:container@300x300(孙:image@50x50))';

/** 起一个 Sim：装载脚本并 start（默认画布立即就绪） */
function boot(src, opts = {}) {
  const sim = new Sim({ tree: TREE, ...opts });
  sim.load(src);
  sim.start();
  return sim;
}
const logs = (src, opts) => boot(src, opts).logLines();
const codes = (sim) => sim.diags.map((d) => d.code);
const has = (sim, code) => sim.diags.some((d) => d.code === code);

export function registerContract({ suite, test, eq, ok }) {
  // ───────────────────────── 标识与类型 ─────────────────────────
  suite('世界契约 · 标识与类型', () => {
    test('typeof(nil) 是字符串 "nil"；控件的 typeof 是类型名（契约 §9、§3d 真机）', () => {
      eq(logs('print(typeof(nil), type(nil), typeof(1), typeof({}), typeof(script.object), typeof(script), typeof(Enum.EaseType.Linear), typeof(typeof(nil)))'),
        ['nil\tnil\tnumber\ttable\tClientUIContainerControl\tScript\tEnumItem\tstring']);
    });
    test('小写 id / prefabIndex / name 是属性；大写 Id 读为 nil；tostring(控件) = 类型名:id（契约 §3、§3b 真机）', () => {
      const L = logs('local o = script.object print(o.id, math.type(o.id), o.Id, math.type(o.prefabIndex), o.name, tostring(o))');
      eq(L[0].split('\t').slice(0, 3), ['1', 'integer', 'nil']);
      ok(L[0].endsWith('\t容器节点\tClientUIContainerControl:1'), L[0]);
      eq(L[0].split('\t')[3], 'integer');
    });
    test('控件 id 按先序递增：根 1，子控件 2、3…（契约 §3d 探针里根=1，子=2、3）', () => {
      const sim = boot('print("ok")');
      eq(sim.all().map((c) => c.id), [1, 2, 3, 4, 5, 6, 7]);
    });
    test('没有 getter 方法：GetName() / GetId() 报 attempt to call a nil value (method …)（契约 §3c 真机）', () => {
      eq(logs('print(pcall(function() return script.object:GetName() end)) print(pcall(function() return script.object:GetId() end))'),
        ["false\tmain:1: attempt to call a nil value (method 'GetName')", "false\tmain:1: attempt to call a nil value (method 'GetId')"]);
    });
    test('script：path 保留目录、alive / enabled、没有的字段读 nil 写报错（契约 §8、§4 真机）', () => {
      eq(logs('print(script.path, script.alive, script.enabled, script.tickEnabled, math.type(script.scriptMappingId)) print(pcall(function() script.tickEnabled = 1 end)) print(pcall(function() script.alive = false end))'),
        ['default_import_file/levelScript\ttrue\ttrue\tnil\tinteger', 'false\tmain:1: cannot set tickEnabled, no such field', 'false\tmain:1: cannot set alive, no such field']);
    });
    test('script.object 就是挂载点本身（契约 §3b 真机）', () => {
      const sim = boot('obj = script.object print(obj == script.object)');
      eq(sim.logLines(), ['true']);
    });
    test('getmetatable 对控件 / script / game / 字符串一律是 nil（契约 §7、§9 真机）', () => {
      eq(logs('print(getmetatable(script), getmetatable(game), getmetatable(script.object), getmetatable("x"), getmetatable(Enum.EaseType.Linear))'), ['nil\tnil\tnil\tnil\tnil']);
    });
    test('pairs(控件) 报错，措辞与真机日志一致（契约 §3d 真机）', () => {
      eq(logs('print(pcall(function() for k, v in pairs(script.object) do end end))'),
        ["false\tmain:1: bad argument #1 to 'for iterator' (table expected, got ClientUIContainerControl)"]);
    });
    test('GetChildren() 返回数组式表，# 可用（契约 §3d 真机）', () => {
      eq(logs('local kids = script.object:GetChildren() print(type(kids), #kids, kids[1].name, kids[#kids].name)'), ['table\t5\t标题\t子容器']);
    });
  });

  // ───────────────────────── 字段：按类型封死 ─────────────────────────
  suite('世界契约 · 字段', () => {
    test('读不存在的字段是静默 nil，并给「你是不是想写」（契约 §4 真机）', () => {
      const sim = boot('local t = script.object:GetChild("标题") print(t.Text, t.scale, t.fontsize)');
      eq(sim.logLines(), ['nil\tnil\tnil']);
      const msgs = sim.diags.filter((d) => d.code === 'SIM010').map((d) => d.msg).join('\n');
      ok(msgs.includes('text') && msgs.includes('fontSize'), msgs);
    });
    test('写不存在的字段 / 只读字段报 cannot set <字段>, no such field（契约 §4 真机；只读的措辞是模型）', () => {
      eq(logs('local t = script.object:GetChild("标题") print(pcall(function() t.foo = 1 end)) print(pcall(function() t.active = true end)) print(pcall(function() t.id = 5 end)) print(pcall(function() script.object.text = "x" end))'),
        ['false\tmain:1: cannot set foo, no such field', 'false\tmain:1: cannot set active, no such field', 'false\tmain:1: cannot set id, no such field', 'false\tmain:1: cannot set text, no such field']);
    });
    test('fontSize 必须是整数：传 23.56 报 integer expected, got number（契约 §6 真机）', () => {
      eq(logs('local t = script.object:GetChild("标题") print(pcall(function() t.fontSize = 38 * 0.62 end)) t.fontSize = 24.0 print(t.fontSize, math.type(t.fontSize)) t.fontSize = math.floor(38 * 0.62) print(t.fontSize)'),
        ["false\tmain:1: bad argument #2 to 'fontSize' (integer expected, got number)", '24\tinteger', '23']);
    });
    test('数字字段：非数字报错；NaN / inf 给警告（文档 §3 建议用 math.isnan 校验）', () => {
      const sim = boot('local i = script.object:GetChild("图") print(pcall(function() i.sizeDeltaX = "a" end)) i.sizeDeltaX = 0/0');
      eq(sim.logLines(), ["false\tmain:1: bad argument #2 to 'sizeDeltaX' (number expected, got string)"]);
      ok(has(sim, 'SIM040'));
    });
    test('布尔 / 枚举 / 颜色字段的类型校验（模型：按字段声明类型严格处理）', () => {
      eq(logs('local i = script.object:GetChild("图") local a = script.object:GetChild("区")\n'
        + 'print(pcall(function() a.raycastTarget = 1 end))\n'
        + 'print(pcall(function() i.imageType = "Stretch" end))\n'
        + 'print(pcall(function() i.imageType = Enum.EaseType.Linear end))\n'
        + 'print(pcall(function() i.imageColor = 5.5 end))\n'
        + 'i.imageType = Enum.ImageType.Stretch i.imageColor = Color(255, 0, 0) print(i.imageType.Name, math.type(i.imageColor))'),
      ["false\tmain:2: bad argument #2 to 'raycastTarget' (boolean expected, got number)",
        "false\tmain:3: bad argument #2 to 'imageType' (Enum.ImageType expected, got string)",
        "false\tmain:4: bad argument #2 to 'imageType' (Enum.ImageType expected, got EnumItem)",
        "false\tmain:5: bad argument #2 to 'imageColor' (Color expected, got number)",
        'Stretch\tinteger']);
    });
    test('text 赋数字：模拟器转成字符串并警告（真机是否自动转换文档没写）【未确认】', () => {
      const sim = boot('local t = script.object:GetChild("标题") t.text = 5 print(t.text, type(t.text))');
      eq(sim.logLines(), ['5\tstring']);
      ok(has(sim, 'SIM041'));
    });
    test('name 可改（GetChild 按新名字找）；parent 可改（重新挂靠）', () => {
      eq(logs('local o = script.object local i = o:GetChild("图") i.name = "新名字" print(o:GetChild("图"), o:GetChild("新名字") == i) i.parent = o:GetChild("子容器") print(#o:GetChild("子容器"):GetChildren(), i.parent.name)'),
        ['nil\ttrue', '2\t子容器']);
    });
    test('布局字段读出来是浮点，写进去的整数变成浮点', () => {
      eq(logs('local t = script.object:GetChild("标题") t.anchoredPositionX = 5 print(t.anchoredPositionX, math.type(t.anchoredPositionX), t.sizeDeltaX, t.localScaleX)'), ['5.0\tfloat\t400.0\t1.0']);
    });
    test('只读字段：imageSource / imageId 由 SetImage 更新', () => {
      eq(logs('local i = script.object:GetChild("图") i:SetImage(Enum.ImageSource.StaticReference, 107016) print(i.imageSource.Name, i.imageId, math.type(i.imageId))'), ['StaticReference\t107016\tinteger']);
    });
    test('实例化出来的图片写 imageType 报 no such field（契约 §8 真机）', () => {
      const tpl = new Map([[777, { name: '模板图', type: 'image', prefabIndex: 777 }]]);
      const sim = new Sim({ tree: TREE, templates: tpl });
      sim.load('function OnStart() local c = game.InstantiateClientUIControl(777, script.object) print(c.name, c.prefabIndex, pcall(function() c.imageType = Enum.ImageType.Stretch end)) end');
      sim.start();
      eq(sim.logLines(), ['模板图\t777\tfalse\tmain:1: cannot set imageType, no such field']);
    });
  });

  // ───────────────────────── 控件方法 ─────────────────────────
  suite('世界契约 · 控件方法', () => {
    test('Get* 返回多个值，不是表；接成一个变量只拿第一个（文档 §13、官方示例）', () => {
      eq(logs('local t = script.object:GetChild("标题") local w = t:GetSizeDelta() local x, y = t:GetAnchoredPosition() print(w, x, y, math.type(w)) print(select("#", t:GetLocalScale()))'), ['400.0\t0.0\t300.0\tfloat', '3']);
    });
    test('SetSizeDelta / SetAnchoredPosition / SetPivot / SetAnchorMin / SetAnchorMax / SetLocalRotation 往返', () => {
      eq(logs('local t = script.object:GetChild("图") t:SetSizeDelta(10, 20) t:SetAnchoredPosition(1, 2) t:SetPivot(0, 1) t:SetAnchorMin(0.1, 0.2) t:SetAnchorMax(0.3, 0.4) t:SetLocalScale(2, 3, 4) t:SetLocalRotation(5, 6, 7)\n'
        + 'print(t:GetSizeDelta()) print(t:GetAnchoredPosition()) print(t:GetPivot()) print(t:GetAnchorMin()) print(t:GetAnchorMax()) print(t:GetLocalScale()) print(t:GetLocalRotation())'),
      ['10.0\t20.0', '1.0\t2.0', '0.0\t1.0', '0.1\t0.2', '0.3\t0.4', '2.0\t3.0\t4.0', '5.0\t6.0\t7.0']);
    });
    test('SetLocalScale 只传两个参数：按常理接受，给提示（文档签名是 x,y,z）【未确认】', () => {
      const sim = boot('local t = script.object:GetChild("图") t:SetLocalScale(2, 3) print(t:GetLocalScale())');
      eq(sim.logLines(), ['2.0\t3.0\t1.0']);
      ok(has(sim, 'SIM082'));
    });
    test('同级顺序：索引越大越靠上；SetAsFirstSibling / SetAsLastSibling 返回 boolean；越界 SetSiblingIndex 返回 false（文档 §12）', () => {
      eq(logs('local o = script.object local i = o:GetChild("图") print(i:GetSiblingIndex(), i:SetAsFirstSibling(), i:GetSiblingIndex(), i:SetAsLastSibling(), i:GetSiblingIndex(), i:SetSiblingIndex(99), i:SetSiblingIndex(1), i:GetSiblingIndex()) print(o:GetSiblingIndex(), o:SetAsFirstSibling())'),
        ['1\ttrue\t0\ttrue\t4\tfalse\ttrue\t1', '0\tfalse']);
    });
    test('GetChild 只看直接子控件；FindChild 用 A/B 路径（文档 §13；路径写法未真机验证）', () => {
      const sim = boot('local o = script.object print(o:GetChild("孙"), o:GetChild("子容器"):GetChild("孙").name, o:FindChild("子容器/孙").name, o:FindChild("孙"), o:GetChild("标题") == o:FindChild("标题"))');
      eq(sim.logLines(), ['nil\t孙\t孙\tnil\ttrue']);
      ok(has(sim, 'SIM070') && has(sim, 'SIM080'));
    });
    test('SetActive：activeInHierarchy 计入父级；SetVisible 只改可见性（文档 §13）', () => {
      eq(logs('local o = script.object local p = o:GetChild("子容器") local g = p:GetChild("孙") p:SetActive(false) print(p.active, g.active, g.activeInHierarchy) p:SetActive(true) g:SetVisible(false) print(g.visible, g.active, g.activeInHierarchy)'),
        ['false\ttrue\tfalse', 'false\ttrue\ttrue']);
    });
    test('方法挂错类型：图片没有 AddCursorEventListener，调用报 nil（契约 §8 真机：光标监听只在按钮 / 光标检测区域上）', () => {
      eq(logs('local i = script.object:GetChild("图") print(pcall(function() i:AddCursorEventListener(Enum.CursorEventType.CursorClick, function() end) end))'),
        ["false\tmain:1: attempt to call a nil value (method 'AddCursorEventListener')"]);
    });
    test('点号 / 冒号用反：ctrl.SetActive(false) 报 bad argument #1（模型措辞）', () => {
      eq(logs('local o = script.object print(pcall(function() o.SetActive(false) end))'),
        ["false\tmain:1: bad argument #1 to 'SetActive' (ClientUIContainerControl expected, got boolean)"]);
    });
    test('参数类型：布尔 / 数字 / 枚举 / 缺参（模型措辞）', () => {
      eq(logs('local o = script.object local i = o:GetChild("图")\n'
        + 'print(pcall(function() o:SetActive("yes") end))\n'
        + 'print(pcall(function() i:SetAnchoredPosition(1) end))\n'
        + 'print(pcall(function() i:SetImage(1, 2) end))\n'
        + 'print(pcall(function() o:GetChild(5) end))'),
      ["false\tmain:2: bad argument #1 to 'SetActive' (boolean expected, got string)",
        "false\tmain:3: bad argument #2 to 'SetAnchoredPosition' (number expected, got no value)",
        "false\tmain:4: bad argument #1 to 'SetImage' (Enum.ImageSource expected, got number)",
        "false\tmain:5: bad argument #1 to 'GetChild' (string expected, got number)"]);
    });
    test('DestroyClientUIControl：alive 变 false、从父级摘掉；再调用方法给警告（模型）', () => {
      const sim = boot('local o = script.object local i = o:GetChild("图") game.DestroyClientUIControl(i) print(i.alive, o:GetChild("图"), #o:GetChildren()) i:SetActive(true)');
      eq(sim.logLines(), ['false\tnil\t4']);
      ok(has(sim, 'SIM071'));
    });
    test('GetScripts / GetScriptByPath：挂在 script.object 上的脚本（文档 §13）', () => {
      eq(logs('local o = script.object print(#o:GetScripts(), o:GetScripts()[1] == script, o:GetScriptByPath(script.path) == script, o:GetScriptByPath("nope"), o:GetChild("图"):GetScripts()[1])'),
        ['1\ttrue\ttrue\tnil\tnil']);
    });
  });

  // ───────────────────────── game ─────────────────────────
  suite('世界契约 · game', () => {
    test('game 必须点号调用：冒号报 bad argument count（契约 §5 真机）', () => {
      const L = logs('print(pcall(function() return game:GetClientUIRoots() end)) print(#game.GetClientUIRoots())');
      ok(L[0].startsWith("false\tmain:1: bad argument count to 'GetClientUIRoots' (0 expected, got 1)"), L[0]);
      ok(L[0].includes('点号'), L[0]);
      eq(L[1], '1');
    });
    test('FindClientUIRoot 对容器名返回 nil（契约 B1 真机）', () => {
      const sim = boot('print(game.FindClientUIRoot("容器节点"))');
      eq(sim.logLines(), ['nil']);
      ok(has(sim, 'SIM083'));
    });
    test('GetUICanvasSize：画布未就绪的头几帧是 (0, 0)，就绪后是浮点（官方示例）', () => {
      const sim = new Sim({ tree: TREE, canvasReadyAfterFrames: 2 });
      sim.load('function OnUpdate(dt) local w, h = game.GetUICanvasSize() print(w, h) end function OnStart() script:EnableUpdate(true) end');
      sim.start();
      sim.advance(0.5, 0.1);
      eq(sim.logLines().slice(0, 4), ['0.0\t0.0', '1920.0\t1080.0', '1920.0\t1080.0', '1920.0\t1080.0']);
    });
    test('其它 game 函数：设备 / 语言 / 关卡模式 / 时停 / 音效 / 文本', () => {
      eq(logs('print(game.GetDevice().Name, game.GetLanguageType().Name, game.GetStageMode().Name, game.IsTestPlay(), game.IsLevelTimePaused()) game.PauseLevelTime(true) print(game.IsLevelTimePaused()) local a = game.PlayAudio2D(10) print(math.type(a), game.IsAudioAlive(a)) game.StopAudio(a) print(game.IsAudioAlive(a), game.GetText("hello"))'),
        ['KeyboardAndMouse\tLanguageChs\tBeyond\ttrue\tfalse', 'true', 'integer\ttrue', 'false\thello']);
    });
    test('PrintClientUITree 把控件树写进日志', () => {
      const sim = boot('game.PrintClientUITree()');
      eq(sim.treePrinted, 1);
      ok(sim.logLines()[0].includes('容器节点') && sim.logLines()[0].includes('  标题'), sim.logLines()[0]);
    });
    test('没有的 game 函数读 nil、调用报 nil；多传参数报 bad argument count（契约 §5）', () => {
      const L = logs('print(game.Nope) print(pcall(function() game.Nope() end)) print(pcall(function() game.Tween(script.object, {}, 1, 2) end))');
      eq(L[0], 'nil');
      eq(L[1], "false\tmain:1: attempt to call a nil value (field 'Nope')");
      ok(L[2].startsWith("false\tmain:1: bad argument count to 'Tween' (3 expected, got 4)"), L[2]);
    });
    test('InstantiateClientUIControl：OnInit / OnDestroy 里返回 nil，OnStart 里返回控件（契约 §2 真机）', () => {
      const tpl = new Map([[777, { name: '实例', type: 'text', prefabIndex: 777 }]]);
      const sim = new Sim({ tree: TREE, templates: tpl });
      sim.load('function OnInit() print("init", game.InstantiateClientUIControl(777, script.object)) end function OnStart() local c = game.InstantiateClientUIControl(777, script.object) print("start", c.name, c.id > 7, c.active) end function OnDestroy() print("destroy", game.InstantiateClientUIControl(777, script.object)) end');
      sim.start();
      sim.destroy();
      eq(sim.logLines(), ['init\tnil', 'start\t实例\ttrue\ttrue', 'destroy\tnil']);
    });
    test('GetClientUIControl 按运行时 id 取控件', () => {
      eq(logs('local i = script.object:GetChild("图") print(game.GetClientUIControl(i.id) == i, game.GetClientUIControl(9999))'), ['true\tnil']);
    });
    test('全局自定义变量：读取 + 变化回调只给实体类型与变量名（文档 E4）', () => {
      const sim = boot('local E = Enum.CustomVariableEntityType function OnStart() script:RegisterCustomVariableChangedHandler(E.Level, "分数", function(et, name) print(et.Name, name, game.GetGlobalCustomVariableValue(et, name)) end) end');
      sim.setCustomVariable('Level', '分数', 5);
      sim.setCustomVariable('PlayerSelf', '分数', 9);
      eq(sim.logLines(), ['Level\t分数\t5']);
    });
  });

  // ───────────────────────── script 与生命周期 ─────────────────────────
  suite('世界契约 · 生命周期', () => {
    test('顺序 OnInit → OnEnable → OnStart；退出 OnDisable → OnDestroy（契约 §1 真机）', () => {
      const sim = boot('function OnInit() print("init") end function OnEnable() print("enable") end function OnStart() print("start") end function OnDisable() print("disable") end function OnDestroy() print("destroy") end');
      sim.destroy();
      eq(sim.logLines(), ['init', 'enable', 'start', 'disable', 'destroy']);
    });
    test('SetActive(false) 立刻触发 OnDisable；SetActive(true) 触发 OnEnable，不重跑 OnStart（契约 §1 真机）', () => {
      eq(logs('function OnEnable() print("enable") end function OnStart() print("start") end function OnDisable() print("disable") end function OnInit() end\nlocal o = script.object\nfunction Later() print("a") o:SetActive(false) print("b") o:SetActive(true) print("c") end'),
        ['enable', 'start']);
      const sim = boot('function OnEnable() print("enable") end function OnStart() print("start") end function OnDisable() print("disable") end function Later() print("a") script.object:SetActive(false) print("b") script.object:SetActive(true) print("c") end');
      sim.callLua('Later', sim.G.get('Later'));
      eq(sim.logLines(), ['enable', 'start', 'a', 'disable', 'b', 'enable', 'c']);
    });
    test('EnableUpdate 之前不会有 OnUpdate（契约 §1、§9 真机）；EnableUpdate(true) 没有返回值', () => {
      const sim = boot('function OnUpdate(dt) end');
      sim.advance(1);
      eq(sim.stats.updates, 0);
      const sim2 = boot('function OnStart() print(select("#", script:EnableUpdate(true))) end function OnUpdate(dt) end');
      sim2.advance(1);
      eq(sim2.stats.updates, 60);
      eq(sim2.logLines(), ['0']);
    });
    test('OnUpdate 只收到一个 dt，且是浮点（文档 §1）', () => {
      const sim = boot('function OnStart() script:EnableUpdate(true) end function OnUpdate(dt, extra) print(math.type(dt), extra) end');
      sim.frame(0.25);
      eq(sim.logLines(), ['float\tnil']);
    });
    test('控件不激活时没有 OnUpdate；重新激活后恢复（文档 B2）', () => {
      const sim = boot('function OnStart() script:EnableUpdate(true) end function OnUpdate(dt) n = (n or 0) + 1 end');
      sim.advance(0.5, 0.1);
      sim.root.setActive(false);
      sim.advance(0.5, 0.1);
      sim.root.setActive(true);
      sim.advance(0.5, 0.1);
      eq(sim.G.get('n'), 10n);
    });
    test('PauseLevelTime 只挡 OnLevelUpdate，不挡 OnUpdate（契约 §8 真机）', () => {
      const sim = boot('function OnStart() script:EnableUpdate(true) end function OnUpdate(dt) u = (u or 0) + 1 end function OnLevelUpdate(dt) l = (l or 0) + 1 end');
      sim.advance(0.3, 0.1);
      sim.levelPaused = true;                      // 等价于脚本里调用 game.PauseLevelTime(true)
      sim.advance(0.3, 0.1);
      eq([sim.G.get('u'), sim.G.get('l')], [6n, 3n]);
    });
    test('script:GetParam 按变量名读脚本变量，保型（契约 §8 真机）；Invoke 调用脚本里的全局函数', () => {
      const sim = boot('limit = 10 ratio = 1.5 title = "t" flag = true function hello(a, b) print("hello", a, b) end local function hidden() end\nprint(math.type(script:GetParam("limit")), math.type(script:GetParam("ratio")), script:GetParam("title"), script:GetParam("flag"), script:GetParam("none"))\nscript:Invoke("hello", 1, "x") script:Invoke("hidden")');
      eq(sim.logLines(), ['integer\tfloat\tt\ttrue\tnil', 'hello\t1\tx']);
      ok(has(sim, 'SIM090'), 'local 函数宿主看不到，Invoke 它要给警告');
    });
    test('服务端信号：回调收到 (信号名, 数组)，下标从 1；类型保持（文档 E1、契约 §8）', () => {
      const sim = boot('function OnStart() script:RegisterServerSignalHandler("s", function(name, p) print(name, #p, p[0], math.type(p[1]), p[2], math.type(p[3])) end) end');
      sim.signal('s', 1, 'a', sim.float(2));
      sim.signal('other', 1);
      eq(sim.logLines(), ['s\t3\tnil\tinteger\ta\tfloat']);
    });
    test('script.enabled = false 会触发 OnDisable；改回 true 触发 OnEnable', () => {
      const sim = boot('function OnEnable() print("enable") end function OnDisable() print("disable") end function Later() script.enabled = false script.enabled = true end');
      sim.callLua('Later', sim.G.get('Later'));
      eq(sim.logLines(), ['enable', 'disable', 'enable']);
    });
    test('未捕获的 Lua 错误只记日志：该回调的后半段不执行，之后的回调照常运行（契约 §10 / 文档 F2）', () => {
      const sim = boot('function OnStart() script:EnableUpdate(true) print("before") local x = nil x.y = 1 print("after") end function OnUpdate(dt) ticks = (ticks or 0) + 1 end');
      sim.advance(0.3, 0.1);
      eq(sim.logLines().filter((l) => !l.includes('Lua 运行时错误')), ['before']);
      eq(sim.errors.length, 1);
      ok(sim.errors[0].message.includes("attempt to index a nil value (local 'x')"), sim.errors[0].message);
      eq(sim.G.get('ticks'), 3n);
    });
    test('同一个运行时错误只记一条并累加次数', () => {
      const sim = boot('function OnStart() script:EnableUpdate(true) end function OnUpdate(dt) local x = nil return x.y end');
      sim.advance(0.5, 0.1);
      eq(sim.errors.length, 1);
      eq(sim.errors[0].count, 5);
    });
    test('死循环被步数预算拦下，记为 timeout；pcall 拦不住；之后的帧照常运行', () => {
      const sim = new Sim({ tree: TREE, stepLimit: 20000 });
      sim.load('function OnStart() script:EnableUpdate(true) end function OnUpdate(dt) n = (n or 0) + 1 if n == 2 then print(pcall(function() while true do end end)) end end');
      sim.start();
      sim.advance(0.4, 0.1);
      ok(sim.errors.some((e) => e.timeout), '应记录 timeout');
      eq(sim.G.get('n'), 4n);
      eq(sim.logLines().filter((l) => l === 'false'), []);
    });
    test('递归过深：记为 stack overflow 错误', () => {
      const sim = boot('local function f() return 1 + f() end function OnStart() f() end');
      ok(sim.errors[0]?.message.includes('stack overflow'), sim.errors[0]?.message);
    });
    test('加载：语法错误抛 LuaSyntaxError；load 只能调一次；先 load 再 start', () => {
      const sim = new Sim({ tree: TREE });
      let threw = false;
      try { sim.load('local x <const> = 1'); } catch (e) { threw = e instanceof LuaSyntaxError; }
      ok(threw, '语法错误应抛 LuaSyntaxError');
      const s2 = new Sim({ tree: TREE });
      s2.load('x = 1');
      let again = false;
      try { s2.load('y = 2'); } catch { again = true; }
      ok(again);
      let early = false;
      try { new Sim({ tree: TREE }).start(); } catch { early = true; }
      ok(early);
    });
  });

  // ───────────────────────── 事件 ─────────────────────────
  suite('世界契约 · 光标与按键事件', () => {
    const CLICK = 'local a = script.object:GetChild("区") a:AddCursorEventListener(Enum.CursorEventType.CursorClick, function(d) print("click", d.dragging, math.type(d.touchId)) end)';
    test('容器 showCursor 默认 false，光标事件一律收不到；打开后才送达（文档 C1、契约 C1 真机）', () => {
      const sim = boot(CLICK);
      const r1 = sim.click('区');
      ok(!r1.delivered && r1.reasons.some((x) => x.includes('showCursor')), JSON.stringify(r1));
      eq(sim.logLines(), []);
      sim.root.values.set('showCursor', true);
      ok(sim.click('区').delivered);
      eq(sim.logLines(), ['click\tfalse\tinteger']);
    });
    test('送不到的原因：raycastTarget=false / 不可见 / 不激活 / 类型不对（文档 C2、B2；可见性是模型）', () => {
      const sim = boot(`${CLICK} script.object.showCursor = true`);
      const a = sim.ctrl('区');
      a.values.set('raycastTarget', false);
      ok(sim.click('区').reasons.some((x) => x.includes('raycastTarget')));
      a.values.set('raycastTarget', true);
      a.visible = false;
      ok(sim.click('区').reasons.some((x) => x.includes('不可见')));
      a.visible = true;
      a.active = false;
      ok(sim.click('区').reasons.some((x) => x.includes('不在激活')));
      a.active = true;
      ok(sim.click('图').reasons.some((x) => x.includes('不是预设按钮')));
      ok(sim.click('区').delivered);
    });
    test('点击按顺序发 CursorDown、CursorUp、CursorClick；回调收到 CursorEventData（文档 §17–§19）', () => {
      const sim = boot('script.object.showCursor = true local b = script.object:GetChild("按钮") for _, n in ipairs({"CursorDown", "CursorUp", "CursorClick"}) do b:AddCursorEventListener(Enum.CursorEventType[n], function(d) local x, y = d:GetUIPos() print(n, math.type(x), x, y, d.dragging) end) end');
      sim.click('按钮');
      const L = sim.logLines();
      eq(L.map((l) => l.split('\t')[0]), ['CursorDown', 'CursorUp', 'CursorClick']);
      eq(L[0].split('\t').slice(1), ['float', '960.0', '540.0', 'false']);
    });
    test('SimulateCursorClick() 从 Lua 里触发（文档 §17）', () => {
      const sim = boot(`${CLICK} script.object.showCursor = true script.object:GetChild("区"):SimulateCursorClick()`);
      eq(sim.logLines(), ['click\tfalse\tinteger']);
    });
    test('Remove*Listener 必须传注册时的同一个引用；匿名函数移不掉并给警告（文档 C3）', () => {
      const sim = boot('script.object.showCursor = true local a = script.object:GetChild("区") local function f() n = (n or 0) + 1 end a:AddCursorEventListener(Enum.CursorEventType.CursorClick, f) a:AddCursorEventListener(Enum.CursorEventType.CursorClick, function() m = (m or 0) + 1 end) a:RemoveCursorEventListener(Enum.CursorEventType.CursorClick, f) a:RemoveCursorEventListener(Enum.CursorEventType.CursorClick, function() end)');
      sim.click('区');
      eq([sim.G.get('n'), sim.G.get('m')], [undefined, 1n]);
      ok(has(sim, 'SIM032'));
    });
    test('重复注册同一个监听给警告（重复注册的语义文档没写，契约 §10）', () => {
      const sim = boot('local a = script.object:GetChild("区") local function f() end a:AddCursorEventListener(Enum.CursorEventType.CursorClick, f) a:AddCursorEventListener(Enum.CursorEventType.CursorClick, f)');
      ok(has(sim, 'SIM030'));
    });
    test('RemoveCursorEventListeners / RemoveAllCursorEventListeners 清理', () => {
      const sim = boot('script.object.showCursor = true local a = script.object:GetChild("区") a:AddCursorEventListener(Enum.CursorEventType.CursorClick, function() n = 1 end) a:RemoveCursorEventListeners(Enum.CursorEventType.CursorClick)');
      sim.click('区');
      eq(sim.G.get('n'), undefined);
      eq(sim.click('区').reasons.some((x) => x.includes('没有注册')), true);
    });
    // 渲染顺序：同级里后出现的（索引大的）在上。「图」排在「标题」后面，所以「图」先收到按键（文档只说「按渲染顺序传递」，具体先后是模型）
    test('按键事件：回调返回 true 中断后续派发（文档 §13、契约 §8 真机）', () => {
      const sim = boot('local K = Enum.KeyEventType.KeyboardJumpKeyDown script.object:GetChild("图"):AddKeyEventListener(K, function() print("top") return true end) script.object:GetChild("标题"):AddKeyEventListener(K, function() print("below") end)');
      eq(sim.pressKey('KeyboardJumpKeyDown'), { handled: true, by: '图' });
      eq(sim.logLines(), ['top']);
    });
    test('按键事件：回调没返回 true 时继续派发给下面的控件', () => {
      const sim = boot('local K = Enum.KeyEventType.KeyboardJumpKeyDown script.object:GetChild("图"):AddKeyEventListener(K, function() print("top") end) script.object:GetChild("标题"):AddKeyEventListener(K, function() print("below") end)');
      eq(sim.pressKey('KeyboardJumpKeyDown'), { handled: false });
      eq(sim.logLines(), ['top', 'below']);
    });
    test('手柄导航事件与配置（文档 §13）', () => {
      const sim = boot('local b = script.object:GetChild("按钮") b:AddNavigationEventListener(Enum.ControllerNavigationEventType.Confirm, function() print("confirm") end) b:SetControllerNavigation(Enum.ControllerNavigationDir.Up, Enum.ControllerNavigationMode.Specified, script.object:GetChild("图")) local m, t = b:GetControllerNavigation(Enum.ControllerNavigationDir.Up) print(m.Name, t.name) print(b:GetControllerNavigation(Enum.ControllerNavigationDir.Down).Name)');
      sim.navigate('按钮', 'Confirm');
      eq(sim.logLines(), ['Specified\t图', 'None', 'confirm']);
    });
    test('按坐标点击：渲染顺序靠上的、命中矩形的、能接光标的控件', () => {
      const sim = boot('script.object.showCursor = true for _, n in ipairs({"按钮", "区"}) do script.object:GetChild(n):AddCursorEventListener(Enum.CursorEventType.CursorClick, function() print(n) end) end');
      sim.ctrl('按钮').layout.size = [300, 300];
      sim.ctrl('区').layout.size = [100, 100];
      sim.clickAt(960, 540);                       // 两者重叠：「区」在同级里更靠后 → 在上面
      sim.clickAt(960 + 120, 540);                 // 只在按钮里
      sim.clickAt(10, 10);                         // 谁都不在
      eq(sim.logLines(), ['区', '按钮']);
    });
  });

  // ───────────────────────── 补间 ─────────────────────────
  suite('世界契约 · 补间', () => {
    const mid = (src, t, field = 'localScaleX', name = '图') => { const sim = boot(src); sim.advance(t, 0.01); return sim.ctrl(name).read(field); };
    test('默认绝对目标值；线性；到点精确落在目标（文档 §7、契约 §8 真机）', () => {
      const v = mid('game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1):Play()', 0.5);
      ok(Math.abs(v - 2) < 1e-9, `中点 ${v}`);
      eq(mid('game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1):Play()', 1.2), 3);
    });
    test('SetRelative(true)：目标值按增量解释（文档 D5）', () => {
      eq(mid('game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1):SetRelative(true):Play()', 1.2), 4);
    });
    test('补间字段写错 → 静默无效，并给出正确的字段名（文档 D3）', () => {
      const sim = boot('game.Tween(script.object:GetChild("图"), {scale = 3, localScaleY = 2}, 1):Play()');
      sim.advance(1.2, 0.1);
      eq([sim.ctrl('图').read('localScaleX'), sim.ctrl('图').read('localScaleY')], [1, 2]);
      const d = sim.diags.find((x) => x.code === 'SIM020');
      ok(d && d.msg.includes('localScaleX') && d.msg.includes('静默'), d?.msg);
    });
    test('只创建不 Play：什么都不发生，收尾时给警告（文档 D2）', () => {
      const sim = boot('game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1)');
      sim.advance(2);
      eq(sim.ctrl('图').read('localScaleX'), 1);
      sim.finish();
      ok(has(sim, 'SIM021'));
    });
    test('放进序列的补间不会自己播，序列不 Play 就一个都不动（文档 D6）', () => {
      const sim = boot('local s = game.TweenSequence() s:Append(game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1))');
      sim.advance(2);
      eq(sim.ctrl('图').read('localScaleX'), 1);
      sim.finish();
      ok(has(sim, 'SIM022'));
    });
    test('「点一下弹一下」的序列写法：去程 + 回程，最终回到 1.0（文档 D6）', () => {
      const src = 'local i = script.object:GetChild("图") local out = game.Tween(i, {localScaleX = 1.2, localScaleY = 1.2}, 0.08) local back = game.Tween(i, {localScaleX = 1.0, localScaleY = 1.0}, 0.08) local seq = game.TweenSequence() seq:Append(out) seq:Append(back) seq:Play()';
      const sim = boot(src);
      sim.advance(0.08, 0.01);
      ok(Math.abs(sim.ctrl('图').read('localScaleX') - 1.2) < 1e-6, `去程末尾 ${sim.ctrl('图').read('localScaleX')}`);
      sim.advance(0.2, 0.01);
      eq(sim.ctrl('图').read('localScaleX'), 1);
    });
    test('只写去程的反例：第二次点击起点等于终点，什么也看不到（文档 D6）', () => {
      const sim = boot('function Pop() game.Tween(script.object:GetChild("图"), {localScaleX = 1.08}, 0.08):Play() end');
      sim.callLua('Pop', sim.G.get('Pop'));
      sim.advance(0.2, 0.01);
      const after1 = sim.ctrl('图').read('localScaleX');
      sim.callLua('Pop', sim.G.get('Pop'));
      sim.advance(0.04, 0.01);
      eq(sim.ctrl('图').read('localScaleX'), after1);
    });
    test('Kill(true) 切到结束状态并触发完成回调；Kill(false) 停在当前状态、不触发（文档 §7）', () => {
      const a = boot('tw = game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1):SetOnComplete(function() print("done") end):Play()');
      a.advance(0.5, 0.1);
      a.callLua('k', a.G.get('tw').index('Kill', a.interp), [a.G.get('tw'), true]);
      eq([a.ctrl('图').read('localScaleX'), a.logLines()], [3, ['done']]);
      const b = boot('tw = game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1):SetOnComplete(function() print("done") end):Play()');
      b.advance(0.5, 0.1);
      const mid = b.ctrl('图').read('localScaleX');
      b.callLua('k', b.G.get('tw').index('Kill', b.interp), [b.G.get('tw'), false]);
      b.advance(1, 0.1);
      eq([b.ctrl('图').read('localScaleX'), b.logLines()], [mid, []]);
    });
    test('SetLoops(n)：每圈一次步骤回调，全部走完一次完成回调；负数 = 无限循环永不完成（文档 §7）', () => {
      const sim = boot('game.Tween(script.object:GetChild("图"), {localScaleX = 2}, 0.1):SetLoops(3):SetOnStepComplete(function() steps = (steps or 0) + 1 end):SetOnComplete(function() done = (done or 0) + 1 end):Play() game.Tween(script.object:GetChild("标题"), {localScaleX = 2}, 0.1):SetLoops(-1):SetOnComplete(function() inf_done = true end):Play()');
      sim.advance(1, 0.01);
      eq([sim.G.get('steps'), sim.G.get('done'), sim.G.get('inf_done')], [3n, 1n, undefined]);
    });
    test('返回值：Play / SetEase / SetOnComplete 返回自身可链式；Pause / Kill 没有返回值；序列 Append 返回序列（文档 §7、§8）', () => {
      eq(logs('local t = game.Tween(script.object:GetChild("图"), {localScaleX = 2}, 1) print(t:SetEase(Enum.EaseType.Linear) == t, t:Play() == t, select("#", t:Pause()), select("#", t:Kill(false))) local s = game.TweenSequence() print(s:Append(game.Tween(script.object:GetChild("图"), {localScaleX = 2}, 1)) == s, select("#", s:Kill(false)))'),
        ['true\ttrue\t0\t0', 'true\t0']);
    });
    test('SetEase 要 EaseType 枚举值；easeOutBack 这类前端写法不存在（文档 D4）', () => {
      eq(logs('local t = game.Tween(script.object:GetChild("图"), {localScaleX = 2}, 1) print(pcall(function() t:SetEase(Enum.EaseType.easeOutBack) end)) print(pcall(function() t:SetEase("OutBack") end))'),
        ["false\tmain:1: bad argument #1 to 'SetEase' (EaseType expected, got nil)", "false\tmain:1: bad argument #1 to 'SetEase' (EaseType expected, got string)"]);
    });
    test('OutBack 会过冲（中间超过终点）；Linear 不会', () => {
      const peak = (ease) => { const sim = boot(`game.Tween(script.object:GetChild("图"), {localScaleX = 2}, 1):SetEase(Enum.EaseType.${ease}):Play()`); let m = 0; for (let i = 0; i < 100; i++) { sim.frame(0.01); m = Math.max(m, sim.ctrl('图').read('localScaleX')); } return m; };
      ok(peak('OutBack') > 2.05, `OutBack 峰值 ${peak('OutBack')}`);
      ok(peak('Linear') <= 2 + 1e-9);
    });
    test('颜色按通道插值；fontSize 插值后仍是整数（文档 §15 / §14）', () => {
      const sim = boot('game.Tween(script.object:GetChild("图"), {imageColor = Color(0, 0, 0, 0)}, 1):Play() game.Tween(script.object:GetChild("标题"), {fontSize = 40}, 1):Play()');
      sim.advance(0.5, 0.1);
      eq(sim.ctrl('图').values.get('imageColor') >> 24n, 128n);
      sim.advance(1, 0.1);
      eq([sim.ctrl('标题').read('fontSize'), typeof sim.ctrl('标题').values.get('fontSize')], [40, 'bigint']);
    });
    test('补间已放进序列又单独 Play 给警告（文档：Tween 自己不 Play，序列才 Play）', () => {
      const sim = boot('local t = game.Tween(script.object:GetChild("图"), {localScaleX = 2}, 1) local s = game.TweenSequence() s:Append(t) t:Play()');
      ok(has(sim, 'SIM023'));
    });
    test('Pause / Resume / Restart / Complete', () => {
      const sim = boot('tw = game.Tween(script.object:GetChild("图"), {localScaleX = 3}, 1):Play()');
      const tw = sim.G.get('tw');
      const call = (m, ...a) => sim.interp.callFromHost(tw.index(m, sim.interp), [tw, ...a]);
      sim.advance(0.5, 0.1);
      call('Pause');
      const held = sim.ctrl('图').read('localScaleX');
      sim.advance(0.5, 0.1);
      eq(sim.ctrl('图').read('localScaleX'), held);
      call('Resume');
      sim.advance(0.2, 0.1);
      ok(sim.ctrl('图').read('localScaleX') > held);
      call('Restart');
      eq(sim.ctrl('图').read('localScaleX'), 1);
      call('Complete');
      eq(sim.ctrl('图').read('localScaleX'), 3);
    });
    test('序列的 Join / Insert / AppendInterval / AppendCallback 时间线', () => {
      const sim = boot('local i = script.object:GetChild("图") local t = script.object:GetChild("标题") local s = game.TweenSequence() s:Append(game.Tween(i, {localScaleX = 2}, 0.2)) s:Join(game.Tween(t, {localScaleX = 3}, 0.4)) s:AppendInterval(0.1) s:AppendCallback(function() print("cb") end) s:Append(game.Tween(i, {localScaleX = 5}, 0.1)) s:SetOnComplete(function() print("seq done") end) s:Play()');
      sim.advance(0.4, 0.01);
      eq([sim.ctrl('图').read('localScaleX'), sim.ctrl('标题').read('localScaleX'), sim.logLines()], [2, 3, []]);
      sim.advance(0.11, 0.01);
      eq(sim.logLines(), ['cb']);
      sim.advance(0.2, 0.01);
      eq([sim.ctrl('图').read('localScaleX'), sim.logLines()], [5, ['cb', 'seq done']]);
    });
  });

  // ───────────────────────── 服务端信号 ─────────────────────────
  suite('世界契约 · ServerSignal', () => {
    test('Add* / SendSignal 没有返回值：s:AddInt(1):SendSignal() 这种链式写法会报错（文档 §9 返回值「—」）', () => {
      eq(logs('local s = game.ServerSignal("x") print(pcall(function() s:AddInt(1):SendSignal() end))'), ["false\tmain:1: attempt to index a nil value"]);
    });
    test('SendSignal 才发出去；参数按类型记录（文档 E2、E3）', () => {
      const sim = boot('local s = game.ServerSignal("得分") s:AddInt(3) s:AddFloat(1) s:AddString("名") s:AddBool(true) s:AddVector3({x = 1, y = 2, z = 3}) s:AddIntList({1, 2}) s:AddParam(Enum.ParamType.Int, 9) local never = game.ServerSignal("never") never:AddInt(1) s:SendSignal()');
      eq(sim.sentSignals.length, 1);
      eq(sim.sentSignals[0].name, '得分');
      eq(sim.sentSignals[0].params.map((p) => [p.type, p.value]), [['Int', 3], ['Float', 1], ['String', '名'], ['Bool', true], ['Vector3', { x: 1, y: 2, z: 3 }], ['IntList', [1, 2]], ['Int', 9]]);
    });
    test('参数类型校验：AddInt 收不下小数，AddString 收不下数字（模型；措辞沿用 fontSize 的真机写法）', () => {
      eq(logs('local s = game.ServerSignal("x") print(pcall(function() s:AddInt(1.5) end)) print(pcall(function() s:AddString(5) end)) print(pcall(function() s:AddVector3({x = 1}) end))'),
        ["false\tmain:1: bad argument #1 to 'AddInt' (integer expected, got number)", "false\tmain:1: bad argument #1 to 'AddString' (string expected, got number)", "false\tmain:1: bad argument #1 to 'AddVector3' (Vector3 需要数字字段 y)"]);
    });
  });

  // ───────────────────────── Enum / Color ─────────────────────────
  suite('世界契约 · Enum 与 Color', () => {
    test('Enum.EaseType 用 pairs 枚举恰好 31 项，成员是 EnumItem 不是字符串（契约 §9 真机）', () => {
      eq(logs('local n = 0 local allItems = true for k, v in pairs(Enum.EaseType) do n = n + 1 if typeof(v) ~= "EnumItem" then allItems = false end end print(n, allItems)'), ['31\ttrue']);
    });
    test('EnumItem 字段是大写 Name / FullName / EnumType（文档 §10）；小写 name 读为 nil；同一个值是同一个对象', () => {
      eq(logs('local e = Enum.EaseType.OutBack print(e.Name, e.EnumType, e.name, e == Enum.EaseType.OutBack, e == Enum.EaseType.InBack, pcall(function() e.Name = "x" end))'),
        ['OutBack\tEaseType\tnil\ttrue\tfalse\tfalse\tmain:1: cannot set Name, no such field']);
    });
    test('Enum 里没有的值读 nil', () => {
      eq(logs('print(Enum.EaseType.easeOutBack, Enum.Nope)'), ['nil\tnil']);
    });
    test('Color：打包整数；a 省略 / nil = 255；FromRGB / FromRGBA / ToRGBA（文档 §4、契约 §8）', () => {
      eq(logs('local c = Color(10, 20, 30) print(math.type(c), Color.ToRGBA(c)) print(Color.ToRGBA(Color(1, 2, 3, nil))) print(Color.ToRGBA(Color.FromRGB(4, 5, 6))) print(Color.ToRGBA(Color.FromRGBA(7, 8, 9, 10)))'),
        ['integer\t10\t20\t30\t255', '1\t2\t3\t255', '4\t5\t6\t255', '7\t8\t9\t10']);
    });
    test('Color 分量越界给警告；非数字报错', () => {
      const sim = boot('print(pcall(function() return Color("a", 1, 1) end)) local c = Color(300, 0, 0)');
      eq(sim.logLines(), ["false\tmain:1: bad argument #1 to 'Color' (number expected, got string)"]);
      ok(has(sim, 'SIM042'));
    });
  });

  // ───────────────────────── 运行环境（被裁剪的标准库） ─────────────────────────
  suite('世界契约 · 运行环境', () => {
    test('被裁掉的库是 nil；debug 只剩 traceback；os 只剩 4 个；require 可用（文档 §3、契约 §7 / §9）', () => {
      eq(logs('print(io, coroutine, package, load, loadfile, dofile, collectgarbage, string.dump, string.pack, string.unpack, os.execute, debug.getinfo, unpack)\nprint(type(require), type(debug.traceback), type(os.time), type(os.date), type(os.clock), type(os.difftime), type(math.isnan), type(math.isinf), type(utf8))'),
        ['nil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil\tnil', 'function\tfunction\tfunction\tfunction\tfunction\tfunction\tfunction\tfunction\ttable']);
    });
    test('print 是普通日志、printerr 是错误级日志且不抛错；debug.traceback 只返回文本不写日志（文档 §3、F2）', () => {
      const sim = boot('print("a") printerr("b") local s = debug.traceback("tb") print(type(s))');
      eq(sim.logs.map((l) => [l.lvl, l.text]), [['log', 'a'], ['error', 'b'], ['log', 'string']]);
      eq(sim.faults().length, 1);
    });
    test('require：有返回值、有缓存（模块体只跑一次）、独立环境、不跑 OnInit / OnStart（契约 §7 真机）', () => {
      const sim = new Sim({ tree: TREE, modules: { util: 'runs = (runs or 0) + 1 leaked = 1 function OnStart() print("模块的 OnStart 不该被调用") end return { v = 42 }' } });
      sim.load('local a = require("util") local b = require("util") print(a == b, a.v, leaked, runs)');
      sim.start();
      eq(sim.logLines(), ['true\t42\tnil\tnil']);
      ok(has(sim, 'SIM050'));
    });
    test('require 找不到模块时报错并点名', () => {
      const sim = boot('print(pcall(function() require("nope") end))');
      ok(sim.logLines()[0].includes("module 'nope' not found"), sim.logLines()[0]);
    });
    test('pairs 的哈希部分顺序可以被打乱（暴露依赖遍历顺序的脚本）', () => {
      const src = 'local t = {} t.a = 1 t.b = 2 t.c = 3 local ks = {} for k in pairs(t) do ks[#ks + 1] = k end print(table.concat(ks))';
      eq(logs(src), ['abc']);
      eq(logs(src, { pairsOrder: 'reverse' }), ['cba']);
    });
    test('os.time 用虚拟时钟；os.clock 是虚拟秒数', () => {
      const sim = new Sim({ tree: TREE, t0: 1000.7 });
      sim.load('function OnStart() script:EnableUpdate(true) end function OnUpdate(dt) print(os.time(), os.clock()) end');
      sim.start();
      sim.frame(0.5);
      sim.frame(0.5);
      eq(sim.logLines(), ['1001\t0.5', '1001\t1.0']);
    });
  });

  // ───────────────────────── 布局 ─────────────────────────
  suite('世界契约 · 布局矩形', () => {
    test('根容器铺满画布；中心锚点 + 位置 = 与父级中心的相对偏移（文档 §13）', () => {
      const sim = boot('print("x")');
      eq(sim.root.worldRect(), { x: 0, y: 0, w: 1920, h: 1080 });
      const r = sim.ctrl('标题').worldRect();
      eq([r.x + r.w / 2, r.y + r.h / 2, r.w, r.h], [960, 840, 400, 80]);
    });
    test('拉伸锚点 + 负的 sizeDelta = 四周内缩', () => {
      const sim = boot('local i = script.object:GetChild("图") i:SetAnchorMin(0, 0) i:SetAnchorMax(1, 1) i:SetSizeDelta(-100, -100)');
      eq(sim.ctrl('图').worldRect(), { x: 50, y: 50, w: 1820, h: 980 });
    });
    test('缩放和轴心影响矩形', () => {
      const sim = boot('local i = script.object:GetChild("图") i:SetLocalScale(2, 2, 1) i:SetPivot(0, 0)');
      const r = sim.ctrl('图').worldRect();
      eq([r.w, r.h], [400, 400]);
      eq([r.x, r.y], [960, 540]);
    });
  });
}
