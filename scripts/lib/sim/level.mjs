/**
 * level.mjs —— 给离线模拟器准备「关卡里的控件树」
 *
 * 三种来源，产物都是同一种 spec：{ name, type, layout?, prefabIndex?, active?, visible?, values?, children[] }
 *   1. 树描述 DSL（写测试最省事）：
 *        容器节点:container(背景:image,圆圈容器:container(圆圈点击区域:area,圆圈图片:image),分数文本:text@0,350,218x68)
 *      名字:类型[@布局][(子节点,…)]；布局写 x,y,宽x高 或 stretch；类型可以写官方类型名或别名（container/image/text/area/button/…）
 *   2. 从 .gil 导入：控件树（名字 / 类型 / 层级）+ 布局（逆向推断，见 ui.mjs layoutOfNode）
 *   3. 手写 JS 对象
 *
 * 证据：树形与类型识别【官方示例】（ui.mjs 头部）；布局字段含义【逆向推断】；其它控件属性的初始值没有从存档里读
 * （文本初值、图片编号、颜色…都按 control.mjs 的默认值，脚本一般会自己设置）。
 */

import { readGi } from '../gifile.mjs';
import { findScript, listScripts } from '../gil.mjs';
import { buildUiTree } from '../ui.mjs';
import { Control } from './control.mjs';
import { TYPE_ALIASES, resolveTypeName } from './client-api.mjs';

// ─────────────────────────── 树描述 DSL ───────────────────────────

/** 在 s 的位置 at 吃一个布局；返回 { layout, end }。布局本身带逗号（x,y,宽x高），所以不能按逗号截断，而是按固定形状匹配 */
function parseLayoutAt(s, at, fail) {
  const tryRe = (re) => { re.lastIndex = at; return re.exec(s); };
  let m = tryRe(/stretch/y);
  if (m) return { layout: { anchorMin: [0, 0], anchorMax: [1, 1], position: [0, 0], size: [0, 0] }, end: at + m[0].length };
  m = tryRe(/(-?\d+(?:\.\d+)?)\s*,\s*(-?\d+(?:\.\d+)?)\s*,\s*(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/y);
  if (m) return { layout: { position: [Number(m[1]), Number(m[2])], size: [Number(m[3]), Number(m[4])] }, end: at + m[0].length };
  m = tryRe(/(\d+(?:\.\d+)?)\s*[x×*]\s*(\d+(?:\.\d+)?)/y);
  if (m) return { layout: { size: [Number(m[1]), Number(m[2])] }, end: at + m[0].length };
  return fail('@ 后面要写布局：x,y,宽x高（例如 @0,350,218x68）/ 宽x高 / stretch');
}

/** 树描述 → spec。语法见文件头 */
export function parseTreeDsl(text) {
  const s = String(text);
  let i = 0;
  const fail = (msg) => { throw new Error(`树描述第 ${i + 1} 个字符附近：${msg}\n  ${s.slice(Math.max(0, i - 20), i + 20).replace(/\n/g, ' ')}`); };
  const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
  const readUntil = (stops) => {
    let j = i;
    while (j < s.length && !stops.includes(s[j])) j++;
    const out = s.slice(i, j).trim();
    i = j;
    return out;
  };
  function node() {
    ws();
    const name = readUntil(':(),@');
    if (!name) fail('这里应该是一个控件名');
    if (s[i] !== ':') fail(`控件「${name}」后面要写 :类型（例如 ${name}:image）`);
    i++;
    const typeTxt = readUntil('@(),');
    const type = resolveTypeName(typeTxt);
    if (!type) fail(`不认识的控件类型「${typeTxt}」。可用：${Object.keys(TYPE_ALIASES).filter((k) => /^[a-z]+$/.test(k)).join(' / ')}，或官方类型名 ClientUI…Control`);
    let layout;
    if (s[i] === '@') {
      i++;
      const r = parseLayoutAt(s, i, fail);
      layout = r.layout;
      i = r.end;
    }
    const children = [];
    ws();
    if (s[i] === '(') {
      i++;
      for (;;) {
        children.push(node());
        ws();
        if (s[i] === ',') { i++; continue; }
        if (s[i] === ')') { i++; break; }
        fail("这里应该是 ',' 或 ')'");
      }
    }
    return { name, type, layout, children };
  }
  const root = node();
  ws();
  if (i < s.length) fail('后面还有多余的内容');
  return root;
}

/** 接受 DSL 字符串 或 spec 对象，返回 spec（补全类型名） */
export function normalizeSpec(x) {
  if (typeof x === 'string') return parseTreeDsl(x);
  const fix = (n) => {
    const type = resolveTypeName(n.type);
    if (!type) throw new Error(`控件「${n.name}」的类型「${n.type}」不认识`);
    return { ...n, type, children: (n.children ?? []).map(fix) };
  };
  return fix(x);
}

// ─────────────────────────── spec → 控件 ───────────────────────────

let syntheticGuid = 0x40000000;

/** 在 sim 里按 spec 搭出一棵控件树（父节点可空 = 根） */
export function buildControls(sim, spec, parent = null, { dynamic = false } = {}) {
  const values = spec.values ? new Map(Object.entries(spec.values)) : undefined;
  const c = new Control(sim, spec.type, spec.name, {
    layout: spec.layout,
    prefabIndex: spec.prefabIndex ?? ++syntheticGuid,
    active: spec.active,
    visible: spec.visible,
    dynamic,
    values,
  });
  if (parent) parent.addChild(c);
  for (const ch of spec.children ?? []) buildControls(sim, ch, c, { dynamic });
  return c;
}

// ─────────────────────────── .gil 导入 ───────────────────────────

const LABEL_TO_TYPE = {
  图片控件: 'ClientUIImageControl',
  文本控件: 'ClientUITextBoxControl',
  光标检测区域: 'ClientUICursorEventAreaControl',
  容器控件: 'ClientUIContainerControl',
};

/**
 * 从 .gil 取出脚本所属控件的子树。
 * @param {string} path  .gil 路径
 * @param {{script?: string, owner?: string}} opts  script = 脚本名 / 文件名 / GUID；owner = 直接指定所属控件名
 * @returns {{ spec, templates: Map<number, object>, script: {name, fileName, guid, source}|null, notes: string[] }}
 */
export function specFromGil(path, opts = {}) {
  const file = readGi(path);
  if (file.kind !== 'gil') throw new Error(`${path} 不是 .gil（是 ${file.kind}）`);
  const gil = file.root;
  const tree = buildUiTree(gil);
  const notes = [];

  const specs = new Map();
  let collectNotes = true;              // 只为脚本所属子树里的控件提示；存档里其它（内置）控件不相关
  const specOf = (guid) => {
    if (specs.has(guid)) return specs.get(guid);
    const n = tree.nodes.get(guid);
    let type = LABEL_TO_TYPE[n.label];
    if (!type) {
      type = 'ClientUIBaseControl';
      if (collectNotes) notes.push(`控件「${n.name}」（${n.label}）的具体类型没有识别出来，按基类处理（只有基础字段）`);
    }
    const sp = {
      name: n.name,
      type,
      prefabIndex: n.guid,          // 【逆向推断】真机 prefabIndex 与存档里的控件 GUID 同一数量级（契约 §3）
      layout: n.layout ? { anchorMin: n.layout.anchorMin, anchorMax: n.layout.anchorMax, position: n.layout.position, size: n.layout.size, pivot: n.layout.pivot, scale: n.layout.scale } : undefined,
      children: [],
    };
    specs.set(guid, sp);
    sp.children = n.children.filter((g) => tree.nodes.has(g)).map(specOf);
    return sp;
  };

  const scripts = listScripts(gil);
  let script = null;
  if (opts.script != null) script = findScript(gil, opts.script);
  else if (scripts.length === 1) script = scripts[0];
  else if (scripts.length > 1) {
    const bound = scripts.filter((s) => tree.scripts.has(s.guid));
    if (bound.length === 1) script = bound[0];
    else throw new Error(`这个 .gil 里有 ${scripts.length} 个脚本，请用 --script 指定：${scripts.map((s) => `「${s.name}」(${s.file_name})`).join('、')}`);
  }

  let ownerGuid;
  if (opts.owner) {
    const hits = [...tree.nodes.values()].filter((n) => n.name === opts.owner);
    if (hits.length !== 1) throw new Error(`控件名「${opts.owner}」在 .gil 里对应 ${hits.length} 个节点，无法确定所属控件`);
    ownerGuid = hits[0].guid;
  } else if (script && tree.scripts.has(script.guid)) ownerGuid = tree.scripts.get(script.guid);
  else {
    const cands = [...tree.nodes.values()].filter((n) => n.label === '容器控件' && n.children.length);
    throw new Error(`${script ? `脚本「${script.name}」没有绑定到任何控件` : '没有找到脚本'}。请用 --owner 指定脚本所属的控件名。候选：${cands.map((n) => `「${n.name}」`).join('、') || '（没有带子控件的容器）'}`);
  }

  const spec = specOf(ownerGuid);
  collectNotes = false;
  const templates = new Map();
  for (const g of tree.nodes.keys()) templates.set(g, specOf(g));
  return {
    spec,
    templates,
    script: script ? { name: script.name, fileName: script.file_name, guid: script.guid, source: script.source ?? '' } : null,
    notes,
  };
}

const TYPE_TO_ALIAS = {
  ClientUIContainerControl: 'container', ClientUIImageControl: 'image', ClientUITextBoxControl: 'text', ClientUITextWindowControl: 'textwindow',
  ClientUIPresetButtonControl: 'button', ClientUICursorEventAreaControl: 'area', ClientUIGridScrollerControl: 'grid', ClientUIKeyHintControl: 'keyhint',
  ClientUIAnimationControl: 'anim', ClientUIFullscreenAnimationControl: 'fullscreen', ClientUIReferenceControl: 'reference',
};
const fmtNum = (n) => String(Math.round(n * 100) / 100);

/** spec → 树描述 DSL（能被 parseTreeDsl 读回；布局只输出 位置+尺寸 或 stretch，锚点 / 轴心不在 DSL 里） */
export function specToDsl(spec) {
  const L = spec.layout;
  let lay = '';
  if (L?.anchorMax && L.anchorMax[0] === 1 && L.anchorMax[1] === 1 && (!L.anchorMin || (L.anchorMin[0] === 0 && L.anchorMin[1] === 0))) lay = '@stretch';
  else if (L?.size) lay = L.position && (L.position[0] || L.position[1]) ? `@${fmtNum(L.position[0])},${fmtNum(L.position[1])},${fmtNum(L.size[0])}x${fmtNum(L.size[1])}` : `@${fmtNum(L.size[0])}x${fmtNum(L.size[1])}`;
  const kids = (spec.children ?? []).map(specToDsl);
  return `${spec.name}:${TYPE_TO_ALIAS[spec.type] ?? spec.type}${lay}${kids.length ? `(${kids.join(',')})` : ''}`;
}

/** spec 的缩进文本（命令行提示用） */
export function formatSpec(spec, indent = '') {
  const L = spec.layout;
  const lay = L?.size ? `  ${fmtNum(L.size[0])}×${fmtNum(L.size[1])}${L.position ? ` @(${fmtNum(L.position[0])}, ${fmtNum(L.position[1])})` : ''}` : '';
  return [`${indent}${spec.name} [${spec.type}]${lay}`, ...(spec.children ?? []).map((c) => formatSpec(c, `${indent}  `))].join('\n');
}
