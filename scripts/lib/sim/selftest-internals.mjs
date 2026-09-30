/**
 * selftest-internals.mjs —— 「Lua 内部」「lint」「树与冒烟」「官方示例校准」「存档样本」几组自检
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { cfloatCases } from './selftest-cfloat.mjs';
import { LuaTable, float, fromLua, fmtFloat, str2num, tableToJs, toLua, utf8Decode, utf8Encode } from '../lua/value.mjs';
import { runLua } from '../lua/run.mjs';
import { lintLua } from '../lua/lint.mjs';
import { formatSpec, parseTreeDsl, specFromGil, specToDsl } from './level.mjs';
import { runSmoke, formatReport } from './smoke.mjs';
import { runScenario } from './scenario.mjs';
import { Sim } from './world.mjs';
import { readGi } from '../gifile.mjs';
import { layoutOfNode } from '../ui.mjs';

export function registerInternals({ suite, test, eq, ok, throws, ROOT }) {
  // ───────────────────────── Lua 内部 ─────────────────────────
  suite('Lua 内部 · 值与表', () => {
    test('toLua / fromLua：整数值 → Lua 整数，浮点保持浮点，字符串是字节串，float() 强制浮点', () => {
      eq(toLua(5), 5n);
      eq(toLua(5.5), 5.5);
      eq(toLua(float(5)), 5);
      eq(toLua('圆'), '\xe5\x9c\x86');
      eq(fromLua('\xe5\x9c\x86'), '圆');
      eq(fromLua(7n), 7);
      eq(toLua(undefined), undefined);
      const t = toLua([1, 'a', { k: true }]);
      ok(t instanceof LuaTable && t.length() === 3);
      eq(tableToJs(t), [1, 'a', { k: true }]);
    });
    test('LuaTable：整数值浮点键归一化；置 nil 收缩尾部；紧邻的整数键迁入数组部分；keys 先数组后哈希', () => {
      const t = new LuaTable();
      t.set(2n, 'b');
      t.set('z', 1n);
      eq(t.length(), 0);
      t.set(1n, 'a');
      eq([t.length(), t.arr.length, t.hash.size], [2, 2, 1]);
      t.set(1.0, 'A');
      eq(t.get(1n), 'A');
      t.set(2n, undefined);
      eq(t.length(), 1);
      eq(t.keys().map(String), ['1', 'z']);
      t.set(3n, 'c');
      t.set(2n, 'b');
      eq(t.length(), 3);
      t.set(2n, undefined);
      eq(t.length(), 3);                         // 中间有洞时，末尾非 nil 的边界仍是 3（合法）
      t.set(3n, undefined);
      eq(t.length(), 1);                         // 收缩时连带裁掉尾部的洞
    });
    test('LuaTable.fromArray 裁掉尾部 nil；带洞的构造 # 取数组长度', () => {
      eq(LuaTable.fromArray([1, undefined, 3, undefined]).length(), 3);
      eq(runLua('print(#{1, nil, 3}, #{nil, nil, 3}, #{1, nil})').out, '3\t3\t1');
    });
    test('str2num：十六进制 / 浮点 / 空白 / 溢出退化为浮点', () => {
      eq([str2num('0x10'), str2num(' 12 '), str2num('1e2'), str2num('0x1p4'), str2num('abc'), str2num(''), str2num('9223372036854775808')], [16n, 12n, 100, 16, undefined, undefined, 9223372036854775808]);
      eq(str2num('0xffffffffffffffff'), -1n);
    });
    test('字节串编码：utf8Encode / utf8Decode 往返；坏字节解码成替换字符', () => {
      eq(utf8Decode(utf8Encode('圆圈abc')), '圆圈abc');
      eq(utf8Encode('圆').length, 3);
      eq(utf8Decode('\xff'), '�');
    });
  });

  suite('Lua 内部 · 浮点格式化（C 风格）', () => {
    for (const [name, got, want] of cfloatCases()) test(name, () => eq(got(), want));
    test('tostring 的边界：最小 / 最大 double、-0.0、整数值浮点补 .0', () => {
      eq([fmtFloat(5e-324), fmtFloat(1.7976931348623157e308), fmtFloat(-0), fmtFloat(100), fmtFloat(1e15), fmtFloat(2 ** 53)],
        ['4.9406564584125e-324', '1.7976931348623e+308', '-0.0', '100.0', '1e+15', '9.007199254741e+15']);
    });
  });

  suite('Lua 内部 · 解释器选项', () => {
    test('maxDepth：超过就是 stack overflow 错误（带位置）', () => {
      const r = runLua('local function f(n) return 1 + f(n + 1) end f(1)', { maxDepth: 50 });
      eq(r.error, 'main:1: stack overflow');
    });
    test('pairsOrder 可以是函数：自定义哈希部分的遍历顺序', () => {
      const r = runLua('local t = {} t.a = 1 t.b = 2 t.c = 3 local ks = {} for k in pairs(t) do ks[#ks + 1] = k end print(table.concat(ks))', { pairsOrder: (keys) => [...keys].sort().reverse() });
      eq(r.out, 'cba');
    });
    test('步数预算按「一次宿主回调」重置：callFromHost 每次进来重新计数', () => {
      const r = runLua('function f() local n = 0 for i = 1, 400 do n = n + 1 end return n end', { stepLimit: 2000 });
      eq(r.error, undefined);
      const fn = r.G.get('f');
      for (let i = 0; i < 20; i++) r.interp.callFromHost(fn, []);            // 累计远超 2000，但每次都在预算内
    });
    test('错误值保留类型：error({}) 抛表，error(42) 抛数字', () => {
      const r = runLua('local ok, e = pcall(error, 42) print(ok, e, math.type(e))');
      eq(r.out, 'false\t42\tinteger');
    });
    test('原生函数的参数错误：带位置（被 Lua 调用）/ 不带位置（被 pcall 直接调用）', () => {
      eq(runLua('print(pcall(string.rep)) print(pcall(function() return string.rep() end))').out,
        "false\tbad argument #1 to 'rep' (string expected, got no value)\nfalse\tmain:1: bad argument #1 to 'rep' (string expected, got no value)");
    });
  });

  // ───────────────────────── lint ─────────────────────────
  suite('lint · LS 规则', () => {
    const codesOf = (src) => lintLua(src).findings.map((f) => `${f.code}:${f.sev}`);
    const cases = [
      ['LS001 语法错误', 'local x = ', 'LS001:error'],
      ['LS001 <const> 在 5.3 里是语法错误', 'local x <const> = 1', 'LS001:error'],
      ['LS002 没声明的全局（拼写错）', 'local score = 1\nprint(scroe)', 'LS002:error'],
      ['LS002 用了被裁掉的库', 'io.write("x")', 'LS002:error'],
      ['LS002 5.1 的 unpack', 'print(unpack({1}))', 'LS002:error'],
      ['LS003 只写不读的全局', 'scroe = 1', 'LS003:warning'],
      ['LS004 生命周期函数被声明成 local', 'local function OnStart() end', 'LS004:warning'],
      ['LS005 大小写写错的生命周期名', 'function onStart() end', 'LS005:warning'],
      ['LS005 照搬别的引擎的名字', 'function Update() end', 'LS005:warning'],
      ['LS006 局部变量从未读取', 'local unused = 1', 'LS006:info'],
      ['LS007 标准库里没有 math.pow', 'print(math.pow(2, 3))', 'LS007:error'],
      ['LS007 table.getn / string.gfind / os.execute', 'print(table.getn({}), string.gfind, os.execute)', 'LS007:error'],
      ['LS008 OnUpdate 没有 EnableUpdate(true)', 'function OnUpdate(dt) end', 'LS008:warning'],
      ['LS011 typeof 和 nil 比较', 'local x if typeof(x) == nil then end', 'LS011:warning'],
      ['LS018 浮点结果拼进文本', 'print("hp:" .. 100 / 2)', 'LS018:info'],
      ['LS019 fontSize 赋小数', 'local c c.fontSize = 38 * 0.62', 'LS019:warning'],
      ['LS022 大写 Id / GetName', 'local c print(c.Id, c:GetName())', 'LS022:info'],
    ];
    for (const [name, src, want] of cases) test(name, () => ok(codesOf(src).includes(want), `期望含 ${want}，实际 ${codesOf(src).join(',') || '无'}`));

    const clean = [
      ['后面才定义的全局函数不算没声明', 'function f() return helper() end function helper() return 1 end print(f())'],
      ['有读有写的全局（有意的脚本状态）', 'state = 0 function bump() state = state + 1 end bump()'],
      ['EnableUpdate(true) 在，OnUpdate 就不报 LS008', 'function OnStart() script:EnableUpdate(true) end function OnUpdate(dt) print(dt) end'],
      ['math.floor 包住的 fontSize', 'local size = 3 local c = {} c.fontSize = math.floor(38 * 0.62) c.fontSize = 24 c.fontSize = size'],
      ['整除 / math.floor 的拼接不报 LS018', 'print("n=" .. 10 // 3, "m=" .. math.floor(10 / 3))'],
      ['下划线开头的局部变量不报未使用', 'local _ignored = 1'],
    ];
    for (const [name, src] of clean) test(name, () => eq(lintLua(src).findings.filter((f) => f.sev !== 'info'), [], '不该有 error / warning'));

    test('官方示例脚本：没有 error / warning', () => {
      const src = readFileSync(join(ROOT, 'references', 'live', 'mh47p30a87qo_official-sample-main.lua'), 'utf8');
      eq(lintLua(src).findings.filter((f) => f.sev !== 'info'), []);
    });
  });

  // ───────────────────────── 树描述与冒烟 ─────────────────────────
  suite('树描述 DSL 与冒烟', () => {
    test('DSL 解析：嵌套、布局（位置+尺寸 / 仅尺寸 / stretch）、别名与官方类型名、带空格的名字', () => {
      const s = parseTreeDsl('根 节点:container@stretch(标题:text@0,300,400x80, 图:image@200x200, 容器:ClientUIContainerControl(按钮:button))');
      eq(s.name, '根 节点');
      eq(s.layout, { anchorMin: [0, 0], anchorMax: [1, 1], position: [0, 0], size: [0, 0] });
      eq(s.children.map((c) => [c.name, c.type]), [['标题', 'ClientUITextBoxControl'], ['图', 'ClientUIImageControl'], ['容器', 'ClientUIContainerControl']]);
      eq(s.children[0].layout, { position: [0, 300], size: [400, 80] });
      eq(s.children[1].layout, { size: [200, 200] });
      eq(s.children[2].children[0].type, 'ClientUIPresetButtonControl');
    });
    test('DSL 往返：specToDsl 再 parse 得到同样的树', () => {
      const src = '根:container@stretch(标题:text@0,350,218x68,圆圈容器:container@150x150(图:image@80x80,区:area@150x50))';
      const back = specToDsl(parseTreeDsl(src));
      eq(parseTreeDsl(back), parseTreeDsl(src));
    });
    test('DSL 错误：不认识的类型点名并列出可用的；缺类型；括号不配', () => {
      throws(() => parseTreeDsl('根:widget'), /不认识的控件类型「widget」.*container/);
      throws(() => parseTreeDsl('根'), /后面要写 :类型/);
      throws(() => parseTreeDsl('根:container(子:image'), /应该是 ',' 或 '\)'/);
      throws(() => parseTreeDsl('根:container@abc'), /@ 后面要写布局/);
    });
    test('冒烟：干净脚本无 error；语法错误只报 LS001 不运行；缺树时报 SIM063', () => {
      const good = runSmoke({ source: 'function OnStart() script:EnableUpdate(true) end\nfunction OnUpdate(dt) end\n', tree: '根:container', seconds: 1 });
      ok(good.ok && good.run.updates === 30, JSON.stringify(good.counts));
      const syn = runSmoke({ source: 'local x =', tree: '根:container' });
      ok(!syn.ok && syn.syntaxError && syn.run === null);
      const noTree = runSmoke({ source: 'local a = script.object:GetChild("按钮")\nprint(a)\n', seconds: 1 });
      ok(noTree.static.ls.some((f) => f.code === 'SIM063'));
    });
    test('冒烟：抓到运行时错误 / 补间没 Play / OnUpdate 死代码 / 取不到的控件名，并给出证据标签', () => {
      const src = [
        'local root = script.object',
        'local label = root:GetChild("分数")',
        'function OnStart()',
        '  game.Tween(root, { localScaleX = 2 }, 1)',
        '  label.text = "x"',
        'end',
        'function OnUpdate(dt) end',
      ].join('\n');
      const rep = runSmoke({ source: src, tree: '容器节点:container(分数文本:text)', seconds: 1 });
      ok(!rep.ok);
      ok(rep.run.errors.some((e) => e.message.includes("attempt to index a nil value (upvalue 'label')")), JSON.stringify(rep.run.errors.map((e) => e.message)));
      const codes = rep.run.diags.map((d) => d.code);
      for (const c of ['SIM021', 'SIM060', 'SIM070']) ok(codes.includes(c), `缺诊断 ${c}：${codes}`);
      ok(rep.run.diags.every((d) => d.evidence), '每条诊断都要带证据标签');
      const text = formatReport(rep, { source: src });
      ok(text.includes('证据等级') && text.includes('离线模拟通过 ≠ 真机通过') === false, '有 error 时不说「通过」');
    });
    test('冒烟：中途关掉再打开所属控件（--toggle）会暴露 OnEnable 里重复注册监听', () => {
      const src = 'function OnEnable() script.object:GetChild("区"):AddCursorEventListener(Enum.CursorEventType.CursorClick, function() end) end';
      const rep = runSmoke({ source: src, tree: '根:container(区:area)', seconds: 2, toggle: true });
      ok(rep.run.diags.some((d) => d.code === 'SIM030'), '应报重复注册');
    });
  });

  // ───────────────────────── 官方示例校准 ─────────────────────────
  suite('官方示例校准', () => {
    const src = readFileSync(join(ROOT, 'references', 'live', 'mh47p30a87qo_official-sample-main.lua'), 'utf8');
    // 官方教学存档里的实际布局（逆向推断，见 ui.mjs layoutOfNode）
    const TREE = '容器节点:container@stretch(背景:image@1600x900,分数文本:text@0,350,218x68,圆圈容器:container@150x150(圆圈图片:image@80x80,圆圈点击区域:area@150x50))';
    const ready = (frames) => {
      const sim = new Sim({ tree: TREE, canvasReadyAfterFrames: frames });
      sim.load(src);
      sim.start();
      return sim;
    };
    test('加载时就写 showCursor = true；OnStart 只开逐帧更新（契约 §1、§11）', () => {
      const sim = new Sim({ tree: TREE });
      sim.load(src);
      eq(sim.root.read('showCursor'), true);
      sim.start();
      eq(sim.updateEnabled, true);
    });
    test('画布没就绪的头几帧不注册监听（重试）；就绪后恰好注册一次并关掉逐帧（官方示例、契约 §1）', () => {
      const sim = ready(5);
      sim.advance(0.3, 0.1);
      eq(sim.ctrl('圆圈点击区域').cursorListeners.size, 0);
      sim.advance(0.6, 0.1);
      eq(sim.ctrl('圆圈点击区域').cursorListeners.get('CursorClick').length, 1);
      eq(sim.updateEnabled, false);
    });
    test('画布一直没就绪：60 帧重试预算用完后报「画布未就绪」并关掉逐帧', () => {
      const sim = ready(1e9);
      sim.advance(8, 0.1);
      ok(sim.faults().some((l) => /画布未就绪/.test(l.text)), sim.logLines().join('|'));
      eq(sim.updateEnabled, false);
    });
    test('初始分数文本、点击计分、第 10 次发 success 信号且只发一次；成功后点击区关闭（官方示例）', () => {
      const sim = ready(5);
      sim.advance(1, 0.1);
      eq(sim.ctrl('分数文本').read('text'), '分数：0');
      eq(sim.ctrl('圆圈点击区域').read('raycastTarget'), true);
      for (let i = 0; i < 9; i++) sim.click('圆圈点击区域');
      eq([sim.ctrl('分数文本').read('text'), sim.sentSignals.length], ['分数：9', 0]);
      sim.click('圆圈点击区域');
      eq([sim.ctrl('分数文本').read('text'), sim.sentSignals.map((s) => s.name)], ['分数：10', ['success']]);
      eq(sim.ctrl('圆圈点击区域').read('raycastTarget'), false);
      const r = sim.click('圆圈点击区域');
      ok(!r.delivered && r.reasons.some((x) => x.includes('raycastTarget')));
      eq(sim.ctrl('分数文本').read('text'), '分数：10');
    });
    test('圆圈每次都跳到画布内的新位置', () => {
      const sim = ready(2);
      sim.advance(0.5, 0.1);
      for (let i = 0; i < 9; i++) {
        sim.click('圆圈点击区域');
        const r = sim.ctrl('圆圈容器').worldRect();
        ok(r.x >= -1e-6 && r.y >= -1e-6 && r.x + r.w <= 1920 + 1e-6 && r.y + r.h <= 1080 + 1e-6, `第 ${i + 1} 次落到了画布外 ${JSON.stringify(r)}`);
      }
    });
    test('OnDestroy 移除监听；整个过程没有 Lua 错误、没有 GAME FAULT', () => {
      const sim = ready(3);
      sim.advance(1, 0.1);
      for (let i = 0; i < 10; i++) sim.click('圆圈点击区域');
      sim.destroy();
      sim.finish();
      eq(sim.ctrl('圆圈点击区域').cursorListeners.size, 0);
      eq(sim.errors.length, 0);
      eq(sim.faults().length, 0);
      eq(sim.diags.filter((d) => d.sev !== 'info').map((d) => d.msg), []);
    });
    test('把 showCursor 写入去掉：点击被丢弃（真机默认值 false 的坑）', () => {
      const sim = new Sim({ tree: TREE });
      sim.load(src.replace('this.showCursor = true', '-- （测试：去掉 showCursor 写入）'));
      sim.start();
      sim.advance(0.5, 0.1);
      const r = sim.click('圆圈点击区域');
      ok(!r.delivered && r.reasons.some((x) => x.includes('showCursor')));
    });
  });

  // ───────────────────────── 圆圈挑战示例 ─────────────────────────
  suite('圆圈挑战示例', () => {
    const dir = join(ROOT, 'references', 'examples', 'circle-challenge');
    test('整局场景测试：references/examples/circle-challenge/scenario.mjs 全部通过', async () => {
      const source = readFileSync(join(dir, 'main.lua'), 'utf8');
      const tree = readFileSync(join(dir, 'tree.txt'), 'utf8');
      const mod = await import(pathToFileURL(join(dir, 'scenario.mjs')).href);
      const lines = [];
      const { pass, fail } = await runScenario(mod, { source, chunk: 'main', simOptions: { tree }, print: (s) => lines.push(s) });
      eq(fail, 0, lines.filter((l) => l.includes('✗')).join('\n'));
      ok(pass >= 70, `只跑了 ${pass} 项断言`);
    });
    test('示例脚本：lint 没有 error / warning；冒烟无 error', () => {
      const source = readFileSync(join(dir, 'main.lua'), 'utf8');
      eq(lintLua(source).findings.filter((f) => f.sev !== 'info'), []);
      const rep = runSmoke({ source, tree: readFileSync(join(dir, 'tree.txt'), 'utf8'), seconds: 40 });
      eq(rep.counts.error, 0, formatReport(rep, { source }));
    });
    test('示例带的树描述与官方 3.21 教学存档的控件树一致（没有样本时跳过）', () => {
      const sample = join(ROOT, 'references', 'samples', 'mh47p30a87qo_客户端脚本.gil');
      if (!existsSync(sample)) return;
      const fromGil = specToDsl(specFromGil(sample).spec);
      eq(parseTreeDsl(readFileSync(join(dir, 'tree.txt'), 'utf8')), parseTreeDsl(fromGil));
    });
  });

  // ───────────────────────── 存档样本（有才跑） ─────────────────────────
  suite('存档样本', () => {
    const dir = join(ROOT, 'references', 'samples');
    const sample = join(dir, 'mh47p30a87qo_客户端脚本.gil');
    const have = existsSync(sample);
    test('官方 3.21 教学存档：导入控件树、类型、布局（没有样本时跳过）', () => {
      if (!have) return;
      const g = specFromGil(sample);
      eq(g.spec.name, '容器节点');
      eq(g.spec.children.map((c) => `${c.name}:${c.type}`), ['背景:ClientUIImageControl', '分数文本:ClientUITextBoxControl', '圆圈容器:ClientUIContainerControl']);
      eq(g.spec.children[2].children.map((c) => `${c.name}:${c.type}`), ['圆圈图片:ClientUIImageControl', '圆圈点击区域:ClientUICursorEventAreaControl']);
      const near = (a, b) => Math.abs(a - b) < 0.01;
      const bg = g.spec.children[0].layout;
      const hud = g.spec.children[1].layout;
      ok(near(bg.size[0], 1600) && near(bg.size[1], 900), `背景尺寸 ${bg.size}`);
      ok(near(hud.size[0], 218) && near(hud.size[1], 68) && near(hud.position[0], 0) && near(hud.position[1], 350), `分数文本 ${JSON.stringify(hud)}`);
      eq(g.script.name, '收集圆圈');
    });
    test('官方存档里嵌着的脚本在导入的树上冒烟无 error（没有样本时跳过）', () => {
      if (!have) return;
      const g = specFromGil(sample);
      const rep = runSmoke({ source: g.script.source, tree: g.spec, templates: g.templates, seconds: 5 });
      eq(rep.counts.error, 0, formatReport(rep, { source: g.script.source }));
    });
    test('全部官方 .gil 样本：布局解码不崩，且每个带 (1,12) 槽的控件都解出了布局（没有样本时跳过）', () => {
      if (!existsSync(dir)) return;
      let nodes = 0;
      for (const f of readdirSync(dir).filter((x) => x.endsWith('.gil'))) {
        const gil = readGi(join(dir, f)).root;
        for (const n of gil.ui?.nodes || []) {
          const has12 = (n.slots || []).some((s) => !s.name && s.slot_id === 1 && s.slot_type === 12);
          const lay = layoutOfNode(n);
          if (has12) { nodes++; ok(lay && lay.size.length === 2 && lay.scale.length === 3, `${f} 里 0x${n.guid.toString(16)} 没解出布局`); } else ok(lay === null);
        }
      }
      ok(nodes > 0, '没有遇到任何新式客户端控件');
    });
    test('formatSpec / specToDsl 对导入的树可用', () => {
      if (!have) return;
      const g = specFromGil(sample);
      ok(formatSpec(g.spec).includes('分数文本'));
      eq(parseTreeDsl(specToDsl(g.spec)).children.length, 3);
    });
  });
}
