/**
 * selftest-api.mjs —— 「API 表」自检
 *   1. client-api.json 的关键事实（官方原文的数字，以及真机契约里点名的数字）
 *   2. 覆盖度：文档里的每个字段 / 方法 / 函数，模拟器都有实现；反过来，模拟器里没有凭空多出文档没有的 API
 *   3. 与 scripts/check-lua-ui.mjs 交叉核对：枚举值、可补间字段、只读字段两边必须一致
 *   4. 有镜像时：产物与源文档逐字节一致（build-client-api.mjs --check）
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { API, CONTROL_TYPES, controlSpec } from './client-api.mjs';
import { CONTROL_METHODS, Control, CursorEventData } from './control.mjs';
import { GAME_FUNCTION_NAMES, SCRIPT_METHOD_NAMES, SIGNAL_METHOD_NAMES } from './hosts.mjs';
import { SEQUENCE_METHOD_NAMES, TWEEN_METHOD_NAMES } from './tween.mjs';
import { Sim } from './world.mjs';
import { check as checkLx } from '../../check-lua-ui.mjs';
import { DEFAULT_SOURCE } from '../../build-client-api.mjs';

export function registerApi({ suite, test, eq, ok, ROOT }) {
  suite('API 表 · client-api.json', () => {
    test('枚举：EaseType 31 项（契约 §9 真机逐项核对过）、按键枚举的数量与文档一致', () => {
      eq(API.enums.EaseType.length, 31);
      eq([API.enums.KeyboardKeyCode.length, API.enums.ControllerKeyCode.length, API.enums.KeyEventType.length], [59, 25, 164]);
      eq(Object.keys(API.enums).length, 27);
    });
    test('ClientUIBaseControl 有 36 个方法（契约 §3d 真机：36 个方法全部存在）；Script 有 7 个方法；game 的函数', () => {
      eq(Object.keys(API.types.ClientUIBaseControl.methods).length, 36);
      eq(Object.keys(API.types.Script.methods).length, 7);
      eq(Object.keys(API.game).length, 26);
    });
    test('EnumItem 的字段是大写 Name / FullName / EnumType（官方原文 §10）', () => {
      eq(Object.keys(API.types.EnumItem.fields), ['Name', 'FullName', 'EnumType']);
    });
    test('光标检测区域与预设按钮都有 5 个光标方法，其它控件没有（契约 §8）', () => {
      const want = ['AddCursorEventListener', 'RemoveCursorEventListener', 'RemoveCursorEventListeners', 'RemoveAllCursorEventListeners', 'SimulateCursorClick'];
      for (const t of ['ClientUICursorEventAreaControl', 'ClientUIPresetButtonControl']) eq(Object.keys(API.types[t].methods), want);
      for (const t of CONTROL_TYPES) if (!['ClientUICursorEventAreaControl', 'ClientUIPresetButtonControl'].includes(t)) ok(!controlSpec(t).methods.has('AddCursorEventListener'), `${t} 不该有光标监听`);
    });
    test('类型：fontSize / minimumFontSize 是 integer（契约 §6）；容器有 showCursor；可补间字段带 tween 标记', () => {
      eq([API.types.ClientUITextBoxControl.fields.fontSize.type, API.types.ClientUITextBoxControl.fields.minimumFontSize.type], ['integer', 'integer']);
      ok(API.types.ClientUIContainerControl.fields.showCursor);
      ok(API.types.ClientUIImageControl.fields.fillAmount.tween && API.types.ClientUIImageControl.fields.imageColor.tween);
      ok(!API.types.ClientUITextBoxControl.fields.text.tween);
      ok(API.types.ClientUIBaseControl.fields.anchoredPositionX.tween && API.types.ClientUIBaseControl.fields.localScaleZ.tween);
    });
    test('Color 有构造函数与 FromRGB / FromRGBA / ToRGBA；全局函数含 math.isnan / math.isinf', () => {
      ok(API.color.constructor);
      eq(Object.keys(API.color.functions), ['FromRGB', 'FromRGBA', 'ToRGBA']);
      ok(API.globalFunctions['math.isnan'] && API.globalFunctions['math.isinf'] && API.globalFunctions.typeof && API.globalFunctions.printerr && API.globalFunctions['debug.traceback']);
    });
    test('镜像在时：产物与官方原文的解析结果一致（没有过期）', () => {
      if (!existsSync(DEFAULT_SOURCE)) return;            // 镜像不入库，没有就跳过
      const r = spawnSync(process.execPath, [join(ROOT, 'scripts', 'build-client-api.mjs'), '--check'], { encoding: 'utf8' });
      ok(r.status === 0, `${r.stdout}${r.stderr}`);
    });
  });

  suite('API 表 · 覆盖度', () => {
    test('文档里每个控件方法，模拟器都有实现', () => {
      const missing = [];
      for (const t of ['ClientUIBaseControl', ...CONTROL_TYPES]) for (const m of controlSpec(t).methods.keys()) if (!CONTROL_METHODS[m]) missing.push(`${t}.${m}`);
      eq(missing, []);
    });
    test('反过来：模拟器里的每个控件方法，文档里都有（不凭空造 API）', () => {
      const documented = new Set();
      for (const t of ['ClientUIBaseControl', ...CONTROL_TYPES]) for (const m of controlSpec(t).methods.keys()) documented.add(m);
      eq(Object.keys(CONTROL_METHODS).filter((m) => !documented.has(m)), []);
    });
    test('文档里每个 game 函数 / Script 方法 / Tween 方法 / TweenSequence 方法 / ServerSignal 方法，模拟器都有实现；反向同理', () => {
      const cmp = (docNames, implNames, label) => {
        eq(docNames.filter((x) => !implNames.includes(x)), [], `${label}：文档有、模拟器没有`);
        eq(implNames.filter((x) => !docNames.includes(x)), [], `${label}：模拟器有、文档没有`);
      };
      cmp(Object.keys(API.game), GAME_FUNCTION_NAMES, 'game');
      cmp(Object.keys(API.types.Script.methods), SCRIPT_METHOD_NAMES, 'Script');
      cmp(Object.keys(API.types.Tween.methods), TWEEN_METHOD_NAMES, 'Tween');
      cmp(Object.keys(API.types.TweenSequence.methods), SEQUENCE_METHOD_NAMES, 'TweenSequence');
      cmp(Object.keys(API.types.ServerSignal.methods), SIGNAL_METHOD_NAMES, 'ServerSignal');
    });
    test('CursorEventData：dragging / touchId / 三个坐标方法', () => {
      const sim = new Sim({});
      const d = new CursorEventData(sim, {});
      for (const f of Object.keys(API.types.CursorEventData.fields)) ok(d.index(f, sim.interp) !== undefined, `字段 ${f}`);
      for (const m of Object.keys(API.types.CursorEventData.methods)) ok(typeof d.index(m, sim.interp) === 'function', `方法 ${m}`);
    });
    test('每种控件：每个字段都能读；每个可写字段写合法值不报错、写非法值报错', () => {
      const sim = new Sim({ tree: '根:container(子:image)' });
      const enumItem = (group) => sim.enumItem(group, API.enums[group][0]);
      const validFor = (type) => {
        switch (type) {
          case 'boolean': return true;
          case 'string': return 'x';
          case 'integer': return 3n;
          case 'number': return 1.5;
          case 'ColorValue': return 0xff0000ffn;
          case 'ClientUIBaseControl': return sim.ctrl('子');
          default: return API.enums[type] ? enumItem(type) : undefined;
        }
      };
      const problems = [];
      for (const t of CONTROL_TYPES) {
        const c = new Control(sim, t, `测试${t}`);
        for (const [name, def] of controlSpec(t).fields) {
          let v;
          try { v = c.getField(name); } catch (e) { problems.push(`${t}.${name} 读取抛错：${e.message}`); continue; }
          if (v === undefined && !['parent', 'imageType'].includes(name) && !(name === 'parent')) problems.push(`${t}.${name} 读出来是 nil（没有默认值）`);
          if (def.access !== 'rw') continue;
          const good = validFor(def.type);
          if (good === undefined) { problems.push(`${t}.${name} 没有该类型（${def.type}）的合法样例`); continue; }
          try { c.newindex(name === 'parent' ? 'parent' : name, good, sim.interp); } catch (e) { problems.push(`${t}.${name} 写合法值报错：${e.message}`); continue; }
          let rejected = false;
          try { c.newindex(name, def.type === 'string' ? {} : 'bad', sim.interp); } catch { rejected = true; }
          if (!rejected) problems.push(`${t}.${name} 写非法值居然没报错`);
        }
      }
      eq(problems, []);
    });
    test('Enum 表：每个枚举组、每个值都在；每个值是 EnumItem', () => {
      const sim = new Sim({});
      for (const [g, names] of Object.entries(API.enums)) {
        const t = sim.enums.table.get(g);
        ok(t, `缺枚举组 ${g}`);
        eq(t.keys().length, names.length, `${g} 的成员数`);
        for (const n of names) ok(sim.enumItem(g, n)?.typeName === 'EnumItem', `${g}.${n}`);
      }
    });
  });

  suite('API 表 · 与 check-lua-ui 交叉核对', () => {
    const tmpCheck = (lines) => checkLx(lines.join('\n'));
    const tweenable = new Set();
    for (const t of ['ClientUIBaseControl', ...CONTROL_TYPES]) for (const [n, d] of controlSpec(t).fields) if (d.tween) tweenable.add(n);

    test('可补间字段：文档里标 Tweenable 的，检查器都认；文档里不可补间的，检查器都报 LX007', () => {
      const good = [...tweenable].map((f) => `game.Tween(x, { ${f} = 1 }, 1):Play()`);
      const bad = ['scale', 'alpha', 'text', 'name', 'position', 'active', 'easeOutBack'].map((f) => `game.Tween(x, { ${f} = 1 }, 1):Play()`);
      eq(tmpCheck(good).filter((f) => f.rule === 'LX007').map((f) => f.message), [], '合法补间字段被检查器误报');
      const flagged = tmpCheck(bad).filter((f) => f.rule === 'LX007');
      eq(flagged.length, bad.length, '非法补间字段没被检查器全部抓到');
    });
    test('枚举值：文档里每个枚举值，检查器都认；编造的值，检查器都报 LX005', () => {
      const good = [];
      for (const [g, names] of Object.entries(API.enums)) for (const n of names) good.push(`local v = Enum.${g}.${n}`);
      eq(tmpCheck(good).filter((f) => f.rule === 'LX005').map((f) => f.message), [], '合法枚举值被检查器误报');
      const bad = ['Enum.EaseType.easeOutBack', 'Enum.EaseType.OutBounce2', 'Enum.ImageType.Fill', 'Enum.KeyboardKeyCode.SpaceKey', 'Enum.KeyEventType.KeyboardJumpKey', 'Enum.CursorEventType.Click'].map((x) => `local v = ${x}`);
      eq(tmpCheck(bad).filter((f) => f.rule === 'LX005').length, bad.length, '编造的枚举值没被检查器全部抓到');
    });
    test('只读字段：文档标只读的控件字段，检查器赋值时报 LX008；可写字段不报', () => {
      const ro = new Set();
      const rw = new Set();
      for (const t of ['ClientUIBaseControl', ...CONTROL_TYPES]) for (const [n, d] of controlSpec(t).fields) (d.access === 'r' ? ro : rw).add(n);
      for (const n of ro) rw.delete(n);
      const flagged = new Set(tmpCheck([...ro].map((f) => `ctrl.${f} = 1`)).filter((f) => f.rule === 'LX008').map((f) => f.source.match(/ctrl\.(\w+)/)[1]));
      eq([...ro].filter((n) => !flagged.has(n)), [], '文档标只读、检查器没报 LX008 的字段');
      eq(tmpCheck([...rw].map((f) => `ctrl.${f} = 1`)).filter((f) => f.rule === 'LX008').map((f) => f.source), [], '可写字段被检查器误报为只读');
    });
  });

  suite('API 表 · 命令行', () => {
    const run = (args, input) => spawnSync(process.execPath, [join(ROOT, 'scripts', 'sim-lua.mjs'), ...args], { encoding: 'utf8', input });
    test('eval：在 Lua 5.3 语义下算一小段；语法错误退出码 1', () => {
      const r = run(['eval', 'print(7 // 2, 7 / 2, 2^2)']);
      eq([r.status, r.stdout.trim()], [0, '3\t3.5\t4.0']);
      eq(run(['eval', 'print(']).status, 1);
    });
    test('lint：标准输入；有 error 退出码 1，干净退出码 0', () => {
      const bad = run(['lint', '-'], 'local x = math.pow(2, 3)\nprint(undefined_name)\n');
      eq(bad.status, 1);
      ok(bad.stdout.includes('LS007') && bad.stdout.includes('LS002'), bad.stdout);
      eq(run(['lint', '-'], 'local a = 1\nprint(a)\n').status, 0);
    });
    test('smoke：--tree 手写树；干净脚本退出码 0；--json 可解析；缺控件树时给 SIM063', () => {
      const dir = mkdtempSync(join(tmpdir(), 'simlua-'));
      try {
        const good = join(dir, 'good.lua');
        writeFileSync(good, 'function OnStart() script:EnableUpdate(true) end\nfunction OnUpdate(dt) n = (n or 0) + 1 end\n');
        const r = run(['smoke', good, '--tree', '根:container', '--seconds', '1', '--json']);
        eq(r.status, 0, r.stdout + r.stderr);
        const rep = JSON.parse(r.stdout);
        ok(rep.ok && rep.run.updates === 30, JSON.stringify(rep.run?.updates));
        const refs = join(dir, 'refs.lua');
        writeFileSync(refs, 'local a = script.object:GetChild("按钮")\nprint(a)\n');
        const r2 = run(['smoke', refs, '--seconds', '1']);
        ok(r2.stdout.includes('SIM063'), r2.stdout);
      } finally { rmSync(dir, { recursive: true, force: true }); }
    });
    test('不认识的命令 / 缺脚本：用法错误退出码 2', () => {
      eq(run(['nope']).status, 2);
      eq(run(['smoke']).status, 2);
    });
  });
}
