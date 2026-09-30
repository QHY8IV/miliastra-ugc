#!/usr/bin/env node
/**
 * check-lua-ui.mjs — 千星奇域「客户端 Lua UI 脚本」静态检查
 *
 * 零依赖，Node >= 22。不需要 Lua 解释器、不联网、不改动被检查文件。
 *
 *   node scripts/check-lua-ui.mjs <你的脚本.lua>
 *   node scripts/check-lua-ui.mjs --selftest      # 自检：内置样例，验证检查器本身是否正常
 *   node scripts/check-lua-ui.mjs --help
 *
 * 退出码：0 = 无 error；1 = 有 error；2 = 用法错误 / 自检失败
 *
 * 依据：官方条目「客户端控件API文档」(id mhtakr07vej4)，镜像抓取时间 2026-09-25T17:54:09.605Z。
 * 规则说明见 ../references/api/pitfalls.md。
 */

import { readFileSync } from 'node:fs';
import { isMain } from './lib/ismain.mjs';

// ─────────────────────────── 数据表（逐字来自 API 文档） ───────────────────────────

const LIFECYCLE = ['OnInit', 'OnStart', 'OnEnable', 'OnDisable', 'OnUpdate', 'OnLevelUpdate', 'OnDestroy'];
/** 这些回调只接受列出的参数个数 */
const LIFECYCLE_ARITY = { OnInit: 0, OnStart: 0, OnEnable: 0, OnDisable: 0, OnUpdate: 1, OnLevelUpdate: 1, OnDestroy: 0 };

const TWEENABLE = new Set([
  // ClientUIBaseControl
  'anchoredPositionX', 'anchoredPositionY', 'sizeDeltaX', 'sizeDeltaY',
  'anchorMinX', 'anchorMinY', 'anchorMaxX', 'anchorMaxY', 'pivotX', 'pivotY',
  'localScaleX', 'localScaleY', 'localScaleZ',
  'localRotationX', 'localRotationY', 'localRotationZ',
  // 图片
  'imageColor', 'softEdgeWidthX', 'softEdgeWidthY', 'horizontalSoftRange', 'verticalSoftRange', 'fillAmount',
  // 文本框 / 文本视窗
  'fontSize', 'fontColor', 'bgColor', 'outlineColor', 'minimumFontSize',
  // 网格视窗
  'scrollProgress',
]);

const READONLY_FIELDS = new Set([
  'alive', 'id', 'prefabIndex', 'active', 'activeInHierarchy', 'visible',
  'imageSource', 'imageId', 'itemCount', 'scrollDirection',
  'layoutConstraint', 'layoutConstraintFixedCount', 'referencedPrefabIndex',
]);

const ENUMS = {
  EaseType: ['Linear', 'InSine', 'OutSine', 'InOutSine', 'InQuad', 'OutQuad', 'InOutQuad', 'InCubic', 'OutCubic', 'InOutCubic', 'InQuart', 'OutQuart', 'InOutQuart', 'InQuint', 'OutQuint', 'InOutQuint', 'InExpo', 'OutExpo', 'InOutExpo', 'InCirc', 'OutCirc', 'InOutCirc', 'InBack', 'OutBack', 'InOutBack', 'InElastic', 'OutElastic', 'InOutElastic', 'InBounce', 'OutBounce', 'InOutBounce'],
  CustomVariableEntityType: ['Level', 'PlayerSelf', 'AvatarSelf'],
  Device: ['KeyboardAndMouse', 'Mobile', 'Controller', 'MobileController'],
  StageMode: ['Beyond', 'Classic'],
  LanguageType: ['LanguageNone', 'LanguageEng', 'LanguageChs', 'LanguageCht', 'LanguageFra', 'LanguageDeu', 'LanguageSpa', 'LanguagePor', 'LanguageRus', 'LanguageJpn', 'LanguageKor', 'LanguageTha', 'LanguageVie', 'LanguageInd', 'LanguageTur', 'LanguageIta'],
  ParamType: ['Entity', 'EntityList', 'Int', 'IntList', 'Bool', 'BoolList', 'Float', 'FloatList', 'String', 'StringList', 'Vector3', 'Vector3List', 'Guid', 'GuidList', 'ConfigId', 'PrefabId', 'ConfigIdList', 'PrefabIdList'],
  CursorEventType: ['CursorDown', 'CursorUp', 'CursorEnter', 'CursorExit', 'CursorDrag', 'CursorBeginDrag', 'CursorEndDrag', 'CursorClick'],
  ScrollDirection: ['Horizontal', 'Vertical'],
  ScrollLayoutConstraint: ['AutoWrap', 'Fixed'],
  ScrollAlignType: ['Bottom', 'Center', 'Top'],
  ControllerNavigationDir: ['Up', 'Down', 'Left', 'Right'],
  ControllerNavigationEventType: ['Confirm', 'Cancel', 'Focus', 'LostFocus', 'RightStickUp', 'RightStickDown', 'RightStickRight', 'RightStickLeft', 'LeftStickUp', 'LeftStickDown', 'LeftStickRight', 'LeftStickLeft'],
  ControllerNavigationMode: ['None', 'NearestControl', 'Specified'],
  TextHorizontalAlignment: ['Left', 'Middle', 'Right'],
  TextVerticalAlignment: ['Top', 'Middle', 'Bottom'],
  ImageType: ['Basic', 'Stretch'],
  ImageSource: ['StaticReference', 'Item', 'Equipment', 'Skill', 'UnitStatus', 'Faction', 'Currency', 'Prefab'],
  ImageFillType: ['Unused', 'Horizontal', 'Vertical', 'Radial90', 'Radial180', 'Radial360'],
  ImageFillHorizontalType: ['Left', 'Right'],
  ImageFillVerticalType: ['Bottom', 'Top'],
  ImageFillRadial90Type: ['BottomLeft', 'TopLeft', 'TopRight', 'BottomRight'],
  ImageFillRadialType: ['Bottom', 'Left', 'Top', 'Right'],
  ImageMaskSoftEdgeMode: ['Percentage', 'Pixel'],
  UIAnimationLayer: ['AboveAllControls', 'BelowAllControls'],
};

const KEYBOARD_KEYS = /^(CraftspersonKey([1-9]|[1-3][0-9]|4[0-3])|MoveForwardKey|MoveBackwardKey|MoveLeftKey|MoveRightKey|SwitchToWalkOrRunKey|SprintKey|JumpKey|DropKey|OpenShortcutWheelKey|InteractKey|NormalAttackKey|CharacterSkill[1-4]Key|None)$/;
const CONTROLLER_KEYS = /^(CraftspersonKey([1-9]|1[0-4])|SprintKey|JumpKey|InteractKey|NormalAttackKey|CharacterSkill[1-4]Key|MenuConfirmKey|MenuBackKey|None)$/;
const KEY_EVENT_TYPES = /^(Keyboard|Controller)((CraftspersonKey([1-9]|[1-3][0-9]|4[0-3]))|MoveForwardKey|MoveBackwardKey|MoveLeftKey|MoveRightKey|SwitchToWalkOrRunKey|SprintKey|JumpKey|DropKey|OpenShortcutWheelKey|InteractKey|NormalAttackKey|CharacterSkill[1-4]Key|MenuConfirmKey|MenuBackKey)(Down|Up)$/;

const CURSOR_API = /\b(AddCursorEventListener|SimulateCursorClick|GetPressUIPos|GetUIPosDelta)\b/;
const REMOVE_REF_API = /\b(RemoveKeyEventListener|RemoveCursorEventListener|RemoveNavigationEventListener)\s*\([^)]*function\s*\(/g;

// ─────────────────────────── 工具 ───────────────────────────

function lineOf(text, index) {
  let n = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

function lineText(lines, n) {
  return (lines[n - 1] ?? '').trim().slice(0, 120);
}

/** 找到与 openIndex 处 `(` 配对的 `)`，跳过字符串与注释（够用的近似实现） */
function matchParen(text, openIndex) {
  let depth = 0, i = openIndex, inStr = null;
  for (; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === inStr) inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      if (nl === -1) return -1;
      i = nl; continue;
    }
    if (c === '(') depth++;
    else if (c === ')') { depth--; if (depth === 0) return i; }
  }
  return -1;
}

/**
 * 把字符串与注释置空（原字符换成空格，换行保留），只留下真正会被执行的代码。
 * 目的：`print("io.write")`、`-- debug.log(x)` 这类出现在字符串/注释里的文本
 * 不该被当成调用（否则误报，检查器会被使用者学会忽略）。
 * 长度与换行位置完全不变，因此行号仍然准确。
 */
function maskNonCode(src) {
  const out = src.split('');
  const n = src.length;
  const blank = (from, to) => {
    for (let k = from; k < to && k < n; k++) if (out[k] !== '\n') out[k] = ' ';
  };
  let i = 0;
  while (i < n) {
    const c = src[i];
    if (c === '[') {                                   // 长括号字符串 [[ ]] / [=[ ]=]
      const lb = /^\[(=*)\[/.exec(src.slice(i, i + 12));
      if (lb) {
        const closeTok = ']' + lb[1] + ']';
        const end = src.indexOf(closeTok, i + lb[0].length);
        const to = end === -1 ? n : end + closeTok.length;
        blank(i, to); i = to; continue;
      }
    }
    if (c === '-' && src[i + 1] === '-') {             // 注释：长注释或行注释
      const lb = /^--\[(=*)\[/.exec(src.slice(i, i + 14));
      if (lb) {
        const closeTok = ']' + lb[1] + ']';
        const end = src.indexOf(closeTok, i + lb[0].length);
        const to = end === -1 ? n : end + closeTok.length;
        blank(i, to); i = to; continue;
      }
      let nl = src.indexOf('\n', i);
      if (nl === -1) nl = n;
      blank(i, nl); i = nl; continue;
    }
    if (c === '"' || c === "'") {                      // 短字符串
      let j = i + 1;
      while (j < n) {
        if (src[j] === '\\') { j += 2; continue; }
        if (src[j] === c) { j++; break; }
        if (src[j] === '\n') break;
        j++;
      }
      blank(i, j); i = j; continue;
    }
    i++;
  }
  return out.join('');
}

// ─────────────────────────── 检查器 ───────────────────────────

function check(rawText) {
  const findings = [];
  const lines = rawText.split('\n');   // 原文：只用来展示源码行
  const text = maskNonCode(rawText);   // 掩码稿：字符串/注释置空，长度与换行不变
  const add = (severity, rule, line, message, hint) =>
    findings.push({ severity, rule, line, message, hint, source: lineText(lines, line) });

  // LX001 生命周期白名单 / LX002 参数个数
  for (const m of text.matchAll(/\bfunction\s+([A-Za-z_]\w*)\s*\(([^)]*)\)/g)) {
    const name = m[1];
    const params = m[2].trim();
    const line = lineOf(text, m.index);
    if (LIFECYCLE.includes(name)) {
      const want = LIFECYCLE_ARITY[name];
      const got = params === '' ? 0 : params.split(',').length;
      if (got !== want) {
        add('error', 'LX002', line,
          `${name} 声明了 ${got} 个参数，宿主只按固定签名调用（应为 ${want} 个）`,
          want === 1 ? '改成 function ' + name + '(dt)' : `改成 function ${name}()`);
      }
    } else if (/^On[A-Z]/.test(name)) {
      add('warning', 'LX001', line,
        `${name} 不在宿主生命周期白名单内，宿主不会自动调用它`,
        `白名单只有：${LIFECYCLE.join(' / ')}。要手动调用请用 script:Invoke("${name}", ...)`);
    }
  }

  // 赋值语句里也常见 function 写法：OnUpdate = function(dt, e)
  for (const m of text.matchAll(/\b(OnInit|OnStart|OnEnable|OnDisable|OnUpdate|OnLevelUpdate|OnDestroy)\s*=\s*function\s*\(([^)]*)\)/g)) {
    const name = m[1], params = m[2].trim();
    const got = params === '' ? 0 : params.split(',').length;
    if (got !== LIFECYCLE_ARITY[name]) {
      add('error', 'LX002', lineOf(text, m.index),
        `${name} 声明了 ${got} 个参数（应为 ${LIFECYCLE_ARITY[name]} 个）`, '宿主按固定签名调用');
    }
  }

  // LX003 被裁掉的标准库
  // 官方文档列出的：io.* / coroutine.* / string.dump / 部分 os.* / 部分 debug.*
  // 观测契约补充的：load / loadfile / dofile / collectgarbage / package / string.pack / string.unpack
  // 注意：require 是【可用】的（已映射脚本路径），不要误报
  const banned = [
    [/\bio\s*\./g, 'io.* 在运行时不可用（沙箱显式置 nil）'],
    [/\bcoroutine\s*\./g, 'coroutine.* 在运行时不可用'],
    [/\bpackage\s*\./g, '没有标准 package 库'],
    [/\bstring\s*\.\s*dump\b/g, 'string.dump 在运行时不可用'],
    [/\bstring\s*\.\s*(?:pack|unpack)\b/g, 'string.pack / string.unpack 按客户端裁剪'],
    [/\bos\s*\.\s*(?!time\b|date\b|clock\b|difftime\b)([A-Za-z_]\w*)/g, 'os.* 仅保留 time / date / clock / difftime'],
    [/\bdebug\s*\.\s*(?!traceback\b)([A-Za-z_]\w*)/g, 'debug.* 仅保留 debug.traceback'],
    [/\b(load|loadfile|dofile|loadstring|collectgarbage)\s*\(/g, '按客户端裁剪，这些全局函数不可用'],
  ];
  for (const [re, why] of banned) {
    for (const m of text.matchAll(re)) {
      add('error', 'LX003', lineOf(text, m.index), `使用了不可用的标准库：${m[0].trim()}`, why);
    }
  }

  // LX004 game 必须点号调用
  for (const m of text.matchAll(/\bgame\s*:\s*([A-Za-z_]\w*)/g)) {
    add('error', 'LX004', lineOf(text, m.index),
      `game:${m[1]}(...) 用了冒号调用`, `game 是全局表，必须写成 game.${m[1]}(...)`);
  }

  // LX005 枚举值白名单
  for (const m of text.matchAll(/\bEnum\s*\.\s*([A-Za-z_]\w*)\s*\.\s*([A-Za-z_]\w*)/g)) {
    const type = m[1], value = m[2], line = lineOf(text, m.index);
    if (type === 'KeyboardKeyCode') {
      if (!KEYBOARD_KEYS.test(value)) add('error', 'LX005', line, `Enum.KeyboardKeyCode.${value} 不存在`, '见 client-ui-api.md §11 按键枚举');
      continue;
    }
    if (type === 'ControllerKeyCode') {
      if (!CONTROLLER_KEYS.test(value)) add('error', 'LX005', line, `Enum.ControllerKeyCode.${value} 不存在`, '见 client-ui-api.md §11 按键枚举');
      continue;
    }
    if (type === 'KeyEventType') {
      if (!KEY_EVENT_TYPES.test(value)) add('error', 'LX005', line, `Enum.KeyEventType.${value} 不存在`, '格式为 Keyboard/Controller + 键名 + Down/Up');
      continue;
    }
    const allowed = ENUMS[type];
    if (!allowed) { add('warning', 'LX005', line, `Enum.${type} 不是已知枚举类型`, '可能拼错了枚举类型名'); continue; }
    if (!allowed.includes(value)) {
      add('error', 'LX005', line, `Enum.${type}.${value} 不存在`,
        type === 'EaseType' ? `枚举值为 PascalCase，最接近的是 Enum.EaseType.OutBack 这类写法；可用值：${allowed.slice(0, 6).join(',')} …` : `可用值：${allowed.join(', ')}`);
    }
  }

  // LX008 只读字段赋值
  for (const m of text.matchAll(/\.\s*([A-Za-z_]\w*)\s*=(?!=)/g)) {
    const field = m[1];
    if (!READONLY_FIELDS.has(field)) continue;
    const before = text.slice(0, m.index).replace(/\s+$/, '').slice(-1);
    if (before === '{' || before === ',') continue; // 表构造器内的键，跳过
    const fix = field === 'active' ? 'ctrl:SetActive(true)' : field === 'visible' ? 'ctrl:SetVisible(true)' : null;
    add('error', 'LX008', lineOf(text, m.index),
      `${field} 是只读字段，直接赋值无效`,
      fix ? `改用 ${fix}` : '只读字段请用对应的 Set 方法；图片用 SetImage，网格用 RefreshItems');
  }

  // LX007 Tween 字段名 + LX006 是否 Play
  for (const m of text.matchAll(/\bgame\s*\.\s*Tween\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close === -1) continue;
    const args = text.slice(open + 1, close);
    const braceStart = args.indexOf('{');
    if (braceStart !== -1) {
      let depth = 0, j = braceStart, braceEnd = -1;
      for (; j < args.length; j++) {
        if (args[j] === '{') depth++;
        else if (args[j] === '}') { depth--; if (depth === 0) { braceEnd = j; break; } }
      }
      if (braceEnd !== -1) {
        const tableText = args.slice(braceStart, braceEnd + 1);
        const offset = open + 1 + braceStart;
        for (const k of tableText.matchAll(/([A-Za-z_]\w*)\s*=(?!=)/g)) {
          const key = k[1];
          if (TWEENABLE.has(key)) continue;
          add('error', 'LX007', lineOf(text, offset + k.index),
            `Tween 目标字段 "${key}" 不是可补间字段`,
            key === 'scale' ? '没有 scale 字段；缩放请用 localScaleX / localScaleY / localScaleZ' : '字段名必须以 API 为准，写错会静默无效');
        }
      }
    }
    // 判断有没有 Play：链式调用里找 Play、赋值后另调，或结果外传（静态跟不到）
    const chain = /^\s*((?::\s*\w+\s*\([^)]*\)\s*)+)/.exec(text.slice(close + 1, close + 300));
    const chainedPlay = chain !== null && /:\s*Play\s*\(/.test(chain[1]);
    const stmtStart = Math.max(text.lastIndexOf('\n', m.index) + 1, text.lastIndexOf(';', m.index) + 1);
    const prefix = text.slice(stmtStart, m.index);
    const assignMatch = /^\s*(?:local\s+)?([A-Za-z_]\w*)\s*=\s*$/.exec(prefix);
    const assigned = assignMatch ? assignMatch[1] : null;
    const playedElsewhere = assigned !== null && new RegExp(`\\b${assigned}\\s*:\\s*Play\\s*\\(`).test(text);
    // 结果被 TweenSequence 消费：文档 §6 的用法就是 seq:Append(tween) + seq:Play()，
    // Tween 自己不 Play。找到接收它的那个序列变量，序列 Play 了就算通过；
    // 序列没 Play 则仍要报，但把提示指向序列而不是这条 Tween。
    if (assigned !== null && !chainedPlay && !playedElsewhere) {
      const cm = new RegExp(`\\b([A-Za-z_]\\w*)\\s*:\\s*(?:Append|Join|Insert)\\s*\\([^)]*\\b${assigned}\\b`).exec(text);
      if (cm) {
        const seqVar = cm[1];
        if (new RegExp(`\\b${seqVar}\\s*:\\s*Play\\s*\\(`).test(text)) continue;
        add('warning', 'LX006', lineOf(text, m.index),
          `game.Tween(...) 交给了 TweenSequence(${seqVar})，但没看到 ${seqVar}:Play()`,
          `序列不 Play，里面的补间一个都不会动：${seqVar}:Play()`);
        continue;
      }
    }
    // 结果被 return 出去、或作为别的调用实参传走 → 静态跟不到，只提示不报警
    const escaped = assigned === null && !chainedPlay && (/return\s*$/.test(prefix) || /[,(]\s*$/.test(prefix));
    if (!chainedPlay && !playedElsewhere) {
      if (escaped) {
        add('info', 'LX006', lineOf(text, m.index),
          'game.Tween(...) 的结果被外传（return 或作为实参），静态无法确认是否 Play()',
          '确认外传后在某处调了 :Play()；若确实有，此行可忽略');
      } else {
        add('warning', 'LX006', lineOf(text, m.index),
          'game.Tween(...) 只是创建补间，没有看到 Play()',
          '补上 :Play()，例如 game.Tween(ctrl, {fillAmount=1}, 0.3):Play()');
      }
    }
  }

  // LX009 发信号必须 SendSignal
  if (/\bgame\s*\.\s*ServerSignal\s*\(/.test(text) && !/:\s*SendSignal\s*\(/.test(text)) {
    const idx = text.search(/\bgame\s*\.\s*ServerSignal\s*\(/);
    add('error', 'LX009', lineOf(text, idx),
      '构造了服务器信号但没有调用 SendSignal()', '参数按服务端约定依次 Add 之后，必须 s:SendSignal()');
  }

  // LX010 信号参数下标从 1 开始
  for (const m of text.matchAll(/\b(?:signalParams|params|args)\s*\[\s*0\s*\]/g)) {
    add('warning', 'LX010', lineOf(text, m.index),
      `${m[1] ?? 'params'}[0] 取了第 0 个元素，Lua 数组下标从 1 开始`,
      '信号回调形如 fun(signalName, signalParams)，第一个参数是 signalParams[1]');
  }

  // LX011 CursorEvent 需要 showCursor
  if (CURSOR_API.test(text) && !/showCursor\s*=\s*true/.test(text)) {
    const idx = text.search(CURSOR_API);
    add('warning', 'LX011', lineOf(text, idx),
      '用了光标事件相关 API，但没看到把容器的 showCursor 设为 true',
      'CursorEvent 相关方法都需容器 showCursor = true 才可正常使用');
  }

  // LX012 移除监听必须用同一个回调引用
  for (const m of text.matchAll(REMOVE_REF_API)) {
    add('warning', 'LX012', lineOf(text, m.index),
      'Remove*EventListener 传了内联函数，无法与注册时的引用匹配',
      '把回调存进变量/表，注册与移除用同一个引用；否则只能 RemoveAll*EventListeners()');
  }

  // LX013 debug.traceback 不会自动写日志
  //
  // 判定改成「结果是否落在 print/printerr 的实参范围内」。
  // 旧写法是往回看 40 字符里有没有 'print('，只认直连；而官方示例
  // （references/live/mh47p30a87qo_official-sample-main.lua）是把 traceback
  // 拼进 table、经 table.concat 后交给 printerr —— 旧写法会对官方代码误报。
  const logSpans = [];
  for (const m of text.matchAll(/\b(print|printerr)\s*\(/g)) {
    const open = m.index + m[0].length - 1;
    const close = matchParen(text, open);
    if (close !== -1) logSpans.push([open, close]);
  }
  for (const m of text.matchAll(/debug\s*\.\s*traceback\s*\(/g)) {
    if (logSpans.some(([a, b]) => m.index > a && m.index < b)) continue;
    add('info', 'LX013', lineOf(text, m.index),
      'debug.traceback() 只返回文本，不会写入日志',
      '要看见它请写成 print(debug.traceback())，或拼进 table.concat 再交给 printerr');
  }

  return findings;
}

// ─────────────────────────── 输出 ───────────────────────────

const SEV_ORDER = { error: 0, warning: 1, info: 2 };
const SEV_LABEL = { error: '错误', warning: '警告', info: '提示' };
const SEV_MARK = { error: '✗', warning: '!', info: '·' };

function report(file, findings) {
  const sorted = [...findings].sort((a, b) => a.line - b.line || SEV_ORDER[a.severity] - SEV_ORDER[b.severity]);
  const counts = { error: 0, warning: 0, info: 0 };
  for (const f of findings) counts[f.severity]++;

  console.log(`\n检查：${file}`);
  console.log('─'.repeat(64));
  if (sorted.length === 0) {
    console.log('未发现问题。');
    console.log('注意：静态检查通过 ≠ 真机通过。仍需在编辑器中确认控件树、交互与显示结果。');
    return counts;
  }
  for (const f of sorted) {
    console.log(`\n${SEV_MARK[f.severity]} [${SEV_LABEL[f.severity]} ${f.rule}] 第 ${f.line} 行`);
    console.log(`  ${f.message}`);
    if (f.hint) console.log(`  → ${f.hint}`);
    if (f.source) console.log(`  源码：${f.source}`);
  }
  console.log('\n' + '─'.repeat(64));
  console.log(`合计：${counts.error} 错误 / ${counts.warning} 警告 / ${counts.info} 提示`);
  if (counts.error === 0) console.log('无 error。静态检查通过 ≠ 真机通过，仍需在编辑器里验证。');
  return counts;
}

// ─────────────────────────── 自检 ───────────────────────────

const SELFTEST_CASES = [
  {
    name: 'OnUpdate 多参数 → LX002',
    code: 'function OnUpdate(dt, elapsed)\nend\n',
    expect: ['LX002'],
  },
  {
    name: 'game 冒号调用 → LX004',
    code: 'local t = game:Tween(ctrl, { fillAmount = 1 }, 0.2)\nt:Play()\n',
    expect: ['LX004'],
  },
  {
    name: '错误缩放字段 scale → LX007',
    code: 'game.Tween(ctrl, { scale = 1.2 }, 0.2):Play()\n',
    expect: ['LX007'],
  },
  {
    name: '错误缓动值 easeOutBack → LX005',
    code: 'tw:SetEase(Enum.EaseType.easeOutBack)\n',
    expect: ['LX005'],
  },
  {
    name: 'io.* → LX003',
    code: 'function OnInit()\n  io.write("x")\nend\n',
    expect: ['LX003'],
  },
  {
    name: '只读字段赋值 → LX008',
    code: 'ctrl.active = true\n',
    expect: ['LX008'],
  },
  {
    name: '表构造器里的键不算只读赋值',
    code: 'local opts = { visible = true, active = false }\n',
    expect: [],
  },
  {
    name: '信号没 SendSignal → LX009',
    code: 'local s = game.ServerSignal("Hit")\ns:AddFloat(1)\n',
    expect: ['LX009'],
  },
  {
    name: 'params[0] → LX010',
    code: 'script:RegisterServerSignalHandler("Hit", function(name, params)\n  print(params[0])\nend)\n',
    expect: ['LX010'],
    warn: ['LX010'],
  },
  {
    name: 'Tween 未 Play → LX006',
    code: 'game.Tween(ctrl, { fillAmount = 1 }, 0.2)\n',
    expect: ['LX006'],
    warn: ['LX006'],
  },
  {
    name: 'Tween 赋值后另行 Play 不报警',
    code: 'local tw = game.Tween(ctrl, { fillAmount = 1 }, 0.2)\ntw:Play()\n',
    expect: [],
  },
  {
    name: '合规脚本应当干净',
    code: [
      'local score = 0',
      'function OnInit()',
      '  local root = game.FindClientUIRoot("Panel")',
      '  local btn = root:GetChild("AddButton")',
      '  root.showCursor = true',
      '  btn:AddCursorEventListener(Enum.CursorEventType.CursorClick, function(data)',
      '    score = score + 1',
      '    local s = game.ServerSignal("ScoreChanged")',
      '    s:AddFloat(score)',
      '    s:SendSignal()',
      '  end)',
      'end',
      'function OnUpdate(dt)',
      '  local tw = game.Tween(game.FindClientUIRoot("ScoreText"), { localScaleX = 1.2 }, 0.15)',
      '  tw:SetEase(Enum.EaseType.OutBack)',
      '  tw:Play()',
      'end',
      '',
    ].join('\n'),
    expect: [],
  },
  {
    name: 'Tween 结果外传（return / 实参）→ 只提示，不误报',
    code: 'local function mk()\n  return game.Tween(ctrl, { fillAmount = 1 }, 0.2)\nend\n',
    expect: ['LX006'],
    info: ['LX006'],
  },
  {
    // 回归用例：TweenSequence 是文档 §6 的官方玩法——Tween 本身不 Play，
    // 交给序列去 Append，序列才 Play。旧逻辑只认 `<var>:Play()`，会对它误报。
    name: 'Tween 交给 TweenSequence 并由序列 Play → 不误报',
    code: 'local out = game.Tween(ctrl, { localScaleX = 1.2 }, 0.1)\n'
        + 'local back = game.Tween(ctrl, { localScaleX = 1.0 }, 0.1)\n'
        + 'local seq = game.TweenSequence()\n'
        + 'seq:Append(out)\n'
        + 'seq:Append(back)\n'
        + 'seq:Play()\n',
    expect: [],
  },
  {
    name: 'Tween 交给了 TweenSequence 但序列没 Play → LX006',
    code: 'local out = game.Tween(ctrl, { localScaleX = 1.2 }, 0.1)\n'
        + 'local seq = game.TweenSequence()\n'
        + 'seq:Append(out)\n',
    expect: ['LX006'],
    warn: ['LX006'],
  },
  {
    name: 'Remove*EventListener 传内联函数 → LX012',
    code: 'btn:RemoveCursorEventListener(Enum.CursorEventType.CursorClick, function(d) end)\n',
    expect: ['LX012'],
    warn: ['LX012'],
  },
  {
    name: '字符串 / 注释 / 长字符串里的 io. debug. 不误报',
    code: 'print("io.write")\n-- debug.log("x")\nlocal s = [[\nio.open()\n]]\n',
    expect: [],
  },
  {
    // 回归用例：官方参考实现把 traceback 拼进 table、经 table.concat 交给 printerr。
    // 旧版 LX013 往回看 40 字符找 'print('，会对这段官方代码误报。
    name: 'debug.traceback 经 table.concat 进 printerr → 不误报（官方示例写法）',
    code: 'local function fault(msg)\n  printerr(table.concat({ "FAULT", "message=" .. msg, "traceback=" .. debug.traceback("", 2), "END" }, "\\n"))\nend\n',
    expect: [],
  },
  {
    name: 'debug.traceback 结果没人接收 → LX013',
    code: 'local tb = debug.traceback("", 2)\nlocal unused = 1\n',
    expect: ['LX013'],
    info: ['LX013'],
  },
];

/** 期望的严重度：默认 error；用 warn / info 字段声明例外 */
function expectSeverity(c, rule) {
  if ((c.warn || []).includes(rule)) return 'warning';
  if ((c.info || []).includes(rule)) return 'info';
  return 'error';
}

function selftest() {
  let failed = 0;
  console.log('check-lua-ui 自检');
  console.log('─'.repeat(64));
  for (const c of SELFTEST_CASES) {
    const found = check(c.code);
    const got = [...new Set(found.map((f) => f.rule))].sort();
    const want = [...new Set(c.expect)].sort();
    const ok = JSON.stringify(got) === JSON.stringify(want)
      && want.every((r) => found.some((f) => f.rule === r && f.severity === expectSeverity(c, r)));
    if (!ok) failed++;
    const wantStr = want.map((r) => `${r}:${expectSeverity(c, r)}`).join(',');
    console.log(`${ok ? '✓' : '✗'} ${c.name}  期望[${wantStr || '无'}]  实得[${got.join(',') || '无'}]`);
  }
  console.log('─'.repeat(64));
  console.log(failed === 0 ? `全部 ${SELFTEST_CASES.length} 项通过。` : `${failed} 项失败。`);
  return failed;
}

// ─────────────────────────── 入口 ───────────────────────────

async function readStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks.map((c) => (typeof c === 'string' ? Buffer.from(c) : c))).toString('utf8');
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(`用法：
    node scripts/check-lua-ui.mjs <脚本.lua>    检查一个文件
    node scripts/check-lua-ui.mjs -             从标准输入读脚本再检查（不落盘）
    node scripts/check-lua-ui.mjs --selftest    自检（验证检查器本身）
    node scripts/check-lua-ui.mjs --help

  为什么要支持标准输入：本技能规则二要求「没明确要求不要往工作区写文件」，
  规则三又要求「交稿前跑检查」。没有 stdin 入口时这两条会打架——查一份草稿
  必须先落一个临时文件。用 - 就能在不落盘的前提下过检查。

  检查项：生命周期名与参数个数、被裁掉的标准库、game 点号/冒号、
  枚举值白名单、Tween 可补间字段、只读字段赋值、SendSignal、
  信号参数下标、showCursor、事件监听引用、traceback 输出。

  退出码：0 无 error；1 有 error；2 用法错误或自检失败。`);
    process.exit(argv.length === 0 ? 2 : 0);
  }

  if (argv.includes('--selftest')) {
    process.exit(selftest() === 0 ? 0 : 2);
  }

  const file = argv.find((a) => !a.startsWith('-'));
  const useStdin = argv.includes('-') || (file === undefined && !process.stdin.isTTY);

  if (file === undefined && !useStdin) {
    console.error('错误：没有给出要检查的文件。用 --help 看用法。');
    process.exit(2);
  }

  let text, label;
  if (useStdin) {
    label = '(标准输入)';
    text = await readStdin();
    if (text.trim() === '') {
      console.error('错误：标准输入是空的。用 --help 看用法。');
      process.exit(2);
    }
  } else {
    label = file;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      console.error(`错误：读不到文件 ${file}\n  ${err.message}`);
      process.exit(2);
    }
  }

  // 去掉 UTF-8 BOM，归一换行
  text = text.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');

  const counts = report(label, check(text));
  process.exit(counts.error > 0 ? 1 : 0);
}

// 被 sim-lua.mjs 等脚本 import 时只提供 check()，不跑命令行
export { check };
if (isMain(import.meta.url)) await main();
