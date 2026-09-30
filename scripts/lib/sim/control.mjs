/**
 * control.mjs —— 客户端控件（ClientUI*Control）宿主对象
 *
 * 字段 / 方法清单来自 client-api.json（官方「客户端控件API文档」逐表解析），不在这里手抄。
 * 行为依据（证据等级写在每条旁边）：
 *   【真机】契约 §4   控件 userdata 按类型封死：读不存在的字段 = nil（静默），写不存在的字段报 cannot set <字段>, no such field
 *   【真机】契约 §3   标识是属性不是方法：.id / .name / .prefabIndex；大写 Id 读为 nil；没有 GetName() / GetId()
 *   【真机】契约 §6   fontSize 必须是整数：传 23.56 报 bad argument #2 to 'fontSize' (integer expected, got number)
 *   【真机】契约 §3d  GetChildren() 返回数组式表；GetChild 按名字取直接子控件；pairs(控件) 报错；tostring(控件) = 类型名:id
 *   【文档】           Get* 布局方法返回多个值；SetSiblingIndex/SetAsFirstSibling/SetAsLastSibling 返回 boolean；
 *                      同级索引越大越靠后、显示越靠上；无父层级时以画布左下为原点，有父层级时是与父层级中心的相对偏移
 *   【文档】           光标监听只在预设按钮 / 光标检测区域上（其它控件没有 AddCursorEventListener 这个方法 → 调用时报 nil）
 *   【文档 C3】        Remove*Listener 必须传注册时的同一个回调引用
 *   【模型】（文档与真机都没写，按常理建模，并在行为发生时给出诊断）：
 *       布尔 / 数字 / 枚举字段的类型校验严格程度、只读字段写入的报错措辞、已销毁控件上的调用、
 *       SetLocalScale 只传两个参数、网格视窗 RefreshItems 的 index 起点
 */

import { Host, LuaClosure, LuaTable, luaTypeName, toInteger, tostr, utf8Decode, utf8Encode } from '../lua/value.mjs';
import { controlSpec } from './client-api.mjs';
import { EnumItem } from './enums.mjs';

const isNum = (v) => typeof v === 'bigint' || typeof v === 'number';
const isFn = (v) => v instanceof LuaClosure || typeof v === 'function';
const tn = (v) => (v === undefined || v === null ? 'nil' : v instanceof Host ? v.typeName : luaTypeName(v));

/** 布局字段名 → [布局向量名, 分量下标] */
export const LAYOUT_FIELDS = {
  anchoredPositionX: ['pos', 0], anchoredPositionY: ['pos', 1],
  sizeDeltaX: ['size', 0], sizeDeltaY: ['size', 1],
  anchorMinX: ['anchorMin', 0], anchorMinY: ['anchorMin', 1],
  anchorMaxX: ['anchorMax', 0], anchorMaxY: ['anchorMax', 1],
  pivotX: ['pivot', 0], pivotY: ['pivot', 1],
  localScaleX: ['scale', 0], localScaleY: ['scale', 1], localScaleZ: ['scale', 2],
  localRotationX: ['rot', 0], localRotationY: ['rot', 1], localRotationZ: ['rot', 2],
};

// ─────────────────────────── 参数检查 ───────────────────────────

/**
 * 参数规格：'n' 数字 | 'i' 整数 | 'b' 布尔 | 's' 字符串 | 'f' 函数 | 'c' 控件 | 'e:组名' 枚举值 | 'a' 任意；后缀 ? = 可省略
 * 返回规整后的参数数组（整数 → BigInt，字符串不动）。
 */
export function checkArgs(interp, name, sig, args) {
  const out = [];
  for (let i = 0; i < sig.length; i++) {
    let code = sig[i];
    const optional = code.endsWith('?');
    if (optional) code = code.slice(0, -1);
    const v = args[i];
    if (v === undefined && optional) { out.push(undefined); continue; }
    const fail = (want) => interp.rtError(`bad argument #${i + 1} to '${name}' (${want} expected, got ${i >= args.length ? 'no value' : tn(v)})`);
    switch (code) {
      case 'n': if (!isNum(v)) throw fail('number'); out.push(v); break;
      case 'i': { const b = isNum(v) ? toInteger(v) : undefined; if (b === undefined) throw fail('integer'); out.push(b); break; }
      case 'b': if (typeof v !== 'boolean') throw fail('boolean'); out.push(v); break;
      case 's': if (typeof v !== 'string') throw fail('string'); out.push(v); break;
      case 'f': if (!isFn(v)) throw fail('function'); out.push(v); break;
      case 'c': if (!(v instanceof Control)) throw fail('ClientUIBaseControl'); out.push(v); break;
      case 'a': out.push(v); break;
      default:
        if (code.startsWith('e:')) {
          const group = code.slice(2);
          if (!(v instanceof EnumItem) || v.group !== group) throw fail(`Enum.${group}`);
          out.push(v);
        } else throw new Error(`未知参数规格 ${code}`);
    }
  }
  return out;
}

// ─────────────────────────── 控件 ───────────────────────────

export class Control extends Host {
  /**
   * opts: { layout, prefabIndex, dynamic, values, active, visible }
   *   layout   { anchorMin, anchorMax, position, size, pivot, scale }（来自 .gil 的布局解码或手写）
   *   dynamic  运行时由 InstantiateClientUIControl 创建（契约 §8：对刚实例化的图片写 imageType 会报 no such field）
   */
  constructor(sim, typeName, name, opts = {}) {
    super(typeName);
    this.sim = sim;
    this.spec = controlSpec(typeName) ?? controlSpec('ClientUIBaseControl');
    this.id = sim.nextControlId();
    this.prefabIndex = opts.prefabIndex ?? 0;
    this.nameStr = name;
    this.parent = null;
    this.children = [];
    this.alive = true;
    this.active = opts.active ?? true;            // 【真机】契约 §2：未改过的客户端模板实例 active 为 true
    this.visible = opts.visible ?? true;
    this.canFocus = true;
    this.dynamic = !!opts.dynamic;
    const L = opts.layout ?? {};
    this.layout = {
      anchorMin: [...(L.anchorMin ?? [0.5, 0.5])],
      anchorMax: [...(L.anchorMax ?? [0.5, 0.5])],
      pos: [...(L.position ?? [0, 0])],
      size: [...(L.size ?? [100, 100])],
      pivot: [...(L.pivot ?? [0.5, 0.5])],
      scale: [...(L.scale ?? [1, 1, 1])],
      rot: [0, 0, 0],
    };
    this.values = new Map();
    this.cursorListeners = new Map();             // 事件名 → [回调]
    this.keyListeners = new Map();
    this.navListeners = new Map();
    this.navConfig = new Map();                   // 方向名 → {mode, target}
    this.bound = new Map();
    this.isGridItem = false;
    this.initDefaults();
    if (opts.values) for (const [k, v] of opts.values) this.values.set(k, v);
  }

  /** 各类型控件的字段初始值。【未确认】文档没写默认值；唯一有真机出处的是容器 showCursor 默认 false（契约 C1） */
  initDefaults() {
    const e = (g, n) => this.sim.enumItem(g, n);
    const v = this.values;
    const white = 0xffffffffn;
    const T = this.typeName;
    if (T === 'ClientUIImageControl') {
      v.set('imageSource', e('ImageSource', 'StaticReference')); v.set('imageId', 0n);
      v.set('imageColor', white); v.set('imageType', e('ImageType', 'Basic'));
      v.set('enableMask', false); v.set('enableSoftEdge', false); v.set('softEdgeMode', e('ImageMaskSoftEdgeMode', 'Percentage'));
      for (const k of ['softEdgeWidthX', 'softEdgeWidthY', 'horizontalSoftRange', 'verticalSoftRange']) v.set(k, 0);
      v.set('reverseMaskArea', false); v.set('fillType', e('ImageFillType', 'Unused'));
      v.set('fillHorizontalType', e('ImageFillHorizontalType', 'Left')); v.set('fillVerticalType', e('ImageFillVerticalType', 'Bottom'));
      v.set('fillRadial90Type', e('ImageFillRadial90Type', 'BottomLeft')); v.set('fillRadialType', e('ImageFillRadialType', 'Bottom'));
      v.set('fillAmount', 1);
    } else if (T === 'ClientUITextBoxControl' || T === 'ClientUITextWindowControl') {
      v.set('text', ''); v.set('fontSize', 20n); v.set('fontColor', white); v.set('bgColor', 0x00ffffffn); v.set('outlineColor', 0x33333333n);
      v.set('enableOutline', false); v.set('adaptiveFontSize', false); v.set('minimumFontSize', 12n);
      v.set('horizontalAlignment', e('TextHorizontalAlignment', 'Middle')); v.set('verticalAlignment', e('TextVerticalAlignment', 'Middle'));
      if (T === 'ClientUITextWindowControl') { v.set('interactable', true); v.set('showScrollBar', true); }
    } else if (T === 'ClientUIPresetButtonControl') {
      v.set('interactable', true); v.set('clickAudioId', 0n); v.set('raycastTarget', true);
    } else if (T === 'ClientUICursorEventAreaControl') {
      v.set('raycastTarget', true);
    } else if (T === 'ClientUIGridScrollerControl') {
      v.set('itemCount', 0n); v.set('itemPrefabIndex', 0n); v.set('raycastTarget', true); v.set('showScrollBar', true); v.set('interactable', true);
      v.set('scrollDirection', e('ScrollDirection', 'Vertical')); v.set('layoutConstraint', e('ScrollLayoutConstraint', 'AutoWrap'));
      v.set('layoutConstraintFixedCount', 0); v.set('scrollProgress', 0);
    } else if (T === 'ClientUIKeyHintControl') {
      v.set('keyboardKeyCode', e('KeyboardKeyCode', 'None')); v.set('controllerKeyCode', e('ControllerKeyCode', 'None'));
    } else if (T === 'ClientUIAnimationControl') {
      v.set('animationId', 0n); v.set('playSoundEffect', false); v.set('layer', e('UIAnimationLayer', 'AboveAllControls'));
    } else if (T === 'ClientUIFullscreenAnimationControl') {
      v.set('animationId', 0n); v.set('playSoundEffect', false);
    } else if (T === 'ClientUIContainerControl') {
      v.set('isolateNavigation', false); v.set('disableKeyEventPassthrough', false); v.set('disableCursorEventPassthrough', false);
      v.set('showCursor', false);                 // 【真机】契约 C1：新建容器默认 false，光标事件一律收不到
    } else if (T === 'ClientUIReferenceControl') {
      v.set('referencedPrefabIndex', 0n);
    }
  }

  // ───────── 层级 ─────────

  get activeInHierarchy() { return this.active && (!this.parent || this.parent.activeInHierarchy); }
  get visibleInHierarchy() { return this.visible && (!this.parent || this.parent.visibleInHierarchy); }

  addChild(child) { child.parent = this; this.children.push(child); return child; }

  siblingIndex() { return this.parent ? this.parent.children.indexOf(this) : 0; }

  /** 移到同级第 idx 位（0 起）；越界返回 false */
  moveSibling(idx) {
    if (!this.parent) return false;
    const list = this.parent.children;
    if (idx < 0 || idx >= list.length) return false;
    list.splice(list.indexOf(this), 1);
    list.splice(idx, 0, this);
    return true;
  }

  setActive(v) {
    if (this.active === v) return;
    this.active = v;
    this.sim.onActiveChanged();
  }

  /** 递归销毁：alive=false，摘出父节点，清掉监听 */
  destroy() {
    for (const c of [...this.children]) c.destroy();
    this.alive = false;
    if (this.parent) {
      const list = this.parent.children;
      const i = list.indexOf(this);
      if (i >= 0) list.splice(i, 1);
    }
    this.cursorListeners.clear(); this.keyListeners.clear(); this.navListeners.clear();
  }

  /** 深拷贝成一棵新的子树（新 id）。模板实例化、网格视窗列表项用 */
  cloneTo(parent, { dynamic = true } = {}) {
    const c = new Control(this.sim, this.typeName, this.nameStr, {
      layout: { anchorMin: this.layout.anchorMin, anchorMax: this.layout.anchorMax, position: this.layout.pos, size: this.layout.size, pivot: this.layout.pivot, scale: this.layout.scale },
      prefabIndex: this.prefabIndex, dynamic, active: this.active, visible: this.visible, values: this.values,
    });
    if (parent) parent.addChild(c);
    for (const ch of this.children) ch.cloneTo(c, { dynamic });
    return c;
  }

  /** 画布坐标系（左下为原点，y 向上）里的矩形。Unity RectTransform 的标准换算；忽略旋转 */
  worldRect() {
    const pr = this.parent ? this.parent.worldRect() : this.sim.canvasRect();
    const L = this.layout;
    const [ax0, ay0] = L.anchorMin;
    const [ax1, ay1] = L.anchorMax;
    const w = (ax1 - ax0) * pr.w + L.size[0];
    const h = (ay1 - ay0) * pr.h + L.size[1];
    const cx = pr.x + ((ax0 + ax1) / 2) * pr.w;
    const cy = pr.y + ((ay0 + ay1) / 2) * pr.h;
    const px = cx + L.pos[0];
    const py = cy + L.pos[1];
    const sw = w * L.scale[0];
    const sh = h * L.scale[1];
    return { x: px - L.pivot[0] * sw, y: py - L.pivot[1] * sh, w: sw, h: sh };
  }

  // ───────── 给测试 / 补间用的直读直写（不走 Lua 校验） ─────────

  /** 读字段的 Lua 值（布局字段是浮点；其它是存着的 Lua 值） */
  rawGet(field) {
    const lf = LAYOUT_FIELDS[field];
    if (lf) return this.layout[lf[0]][lf[1]];
    return this.values.get(field);
  }

  rawSet(field, value) {
    const lf = LAYOUT_FIELDS[field];
    if (lf) { this.layout[lf[0]][lf[1]] = Number(value); return; }
    this.values.set(field, value);
  }

  /** 转成 JS 友好的值：整数 → Number，字符串解码；枚举 → 值名 */
  read(field) {
    let v;
    switch (field) {
      case 'name': return this.nameStr;
      case 'id': return this.id;
      case 'alive': return this.alive;
      case 'active': return this.active;
      case 'activeInHierarchy': return this.activeInHierarchy;
      case 'visible': return this.visible;
      default: v = this.rawGet(field);
    }
    if (typeof v === 'bigint') return Number(v);
    if (typeof v === 'string') return utf8Decode(v);
    if (v instanceof EnumItem) return v.name;
    return v;
  }

  // ───────── Lua 侧：字段与方法 ─────────

  index(key, interp) {
    if (typeof key !== 'string') return undefined;
    const name = utf8Decode(key);
    if (this.spec.methods.has(name)) return this.boundMethod(name, interp);
    const def = this.spec.fields.get(name);
    if (def) return this.getField(name);
    this.sim.noteUnknownField(this.typeName, name);        // 【真机】读不存在的字段：静默 nil
    return undefined;
  }

  getField(name) {
    switch (name) {
      case 'alive': return this.alive;
      case 'id': return BigInt(this.id);
      case 'prefabIndex': return BigInt(this.prefabIndex);
      case 'active': return this.active;
      case 'activeInHierarchy': return this.activeInHierarchy;
      case 'visible': return this.visible;
      case 'name': return utf8Encode(this.nameStr);
      case 'parent': return this.parent ?? undefined;
      case 'canControllerFocus': return this.canFocus;
      default: return this.rawGet(name);
    }
  }

  newindex(key, v, interp) {
    const name = typeof key === 'string' ? utf8Decode(key) : tostr(key);
    const def = typeof key === 'string' ? this.spec.fields.get(name) : undefined;
    // 【真机】契约 §4：当前类型没有的字段，写报 cannot set <字段>, no such field
    // 【模型】只读字段的报错措辞没有真机出处，沿用同一句
    if (!def || def.access === 'r') throw interp.rtError(`cannot set ${name}, no such field`);
    // 【真机】契约 §8：对刚实例化的图片赋值 imageType 报 no such field
    if (name === 'imageType' && this.dynamic) throw interp.rtError('cannot set imageType, no such field');
    if (!this.alive) this.sim.diag('warn', 'SIM071', `对已销毁的控件「${this.nameStr}」写字段 ${name}`, '模型');
    const val = this.coerce(name, def.type, v, interp);
    switch (name) {
      case 'name': this.nameStr = utf8Decode(val); return;
      case 'parent': { if (this.parent) this.parent.children.splice(this.parent.children.indexOf(this), 1); val.addChild(this); return; }
      case 'canControllerFocus': this.canFocus = val; return;
      default: this.rawSet(name, val);
    }
  }

  /** 按字段类型校验 / 规整写入的值 */
  coerce(name, typ, v, interp) {
    const bad = (want) => interp.rtError(`bad argument #2 to '${name}' (${want} expected, got ${tn(v)})`);
    switch (typ) {
      case 'boolean': if (typeof v !== 'boolean') throw bad('boolean'); return v;
      case 'string':
        if (typeof v === 'string') return v;
        if (isNum(v)) {
          this.sim.diag('warn', 'SIM041', `给 ${name} 赋了数字 ${tostr(v)}：真机是否会自动转成字符串文档没写，建议写 tostring(…)`, '未确认');
          return tostr(v);
        }
        throw bad('string');
      case 'integer': {
        if (typeof v === 'bigint') return v;
        if (typeof v === 'number') {
          const b = toInteger(v);
          if (b !== undefined) return b;
          throw interp.rtError(`bad argument #2 to '${name}' (integer expected, got number)`);       // 【真机】契约 §6 的原话
        }
        throw bad('integer');
      }
      case 'number': {
        if (!isNum(v)) throw bad('number');
        const x = Number(v);
        if (!Number.isFinite(x)) this.sim.diag('warn', 'SIM040', `给 ${name} 写入了非有限数（${Number.isNaN(x) ? 'NaN' : 'inf'}）：摇杆 / 坐标 / 补间参数建议先用 math.isnan / math.isinf 校验（官方文档 §3）`, '文档');
        return x;
      }
      case 'ColorValue': if (typeof v !== 'bigint') throw bad('Color'); return BigInt.asUintN(32, v);
      case 'ClientUIBaseControl': if (!(v instanceof Control)) throw bad('ClientUIBaseControl'); return v;
      default:
        if (v instanceof EnumItem && v.group === typ) return v;
        throw bad(`Enum.${typ}`);
    }
  }

  boundMethod(name) {
    let fn = this.bound.get(name);
    if (fn) return fn;
    const m = METHODS[name];
    if (!m) {           // 文档里有、模拟器没实现：不能悄悄当成功，给出显眼的诊断（selftest 会校验覆盖度，正常不会走到这里）
      fn = () => { this.sim.diag('error', 'SIM099', `模拟器没有实现 ${this.typeName}:${name}（文档里有这个方法）——这次调用被当成空操作`, '模型'); return []; };
      this.bound.set(name, fn);
      return fn;
    }
    fn = (args, interp) => {
      const self = args[0];
      if (!(self instanceof Control)) throw interp.rtError(`bad argument #1 to '${name}' (${this.typeName} expected, got ${args.length === 0 ? 'no value' : tn(self)})`);
      if (!self.alive) self.sim.diag('warn', 'SIM071', `对已销毁的控件「${self.nameStr}」调用 ${name}`, '模型');
      const a = checkArgs(interp, name, m.sig, args.slice(1));
      return m.fn(self, a, interp) ?? [];
    };
    fn.lname = name;
    this.bound.set(name, fn);
    return fn;
  }

  tostring() { return `${this.typeName}:${this.id}`; }       // 【真机】契约 §3b：ClientUIContainerControl:1

  /** 文本树（game.PrintClientUITree 用） */
  describeTree(indent = '') {
    const lines = [`${indent}${this.nameStr}  (${this.typeName})  id=${this.id}${this.active ? '' : '  [inactive]'}`];
    for (const c of this.children) lines.push(c.describeTree(`${indent}  `));
    return lines.join('\n');
  }
}

// ─────────────────────────── 方法 ───────────────────────────

const f2 = (x, y) => [Number(x), Number(y)];
const finiteNote = (c, name, ...vals) => {
  for (const x of vals) {
    if (x !== undefined && !Number.isFinite(Number(x))) {
      c.sim.diag('warn', 'SIM040', `${name} 收到非有限数（NaN / inf）：建议先用 math.isnan / math.isinf 校验（官方文档 §3）`, '文档');
      return;
    }
  }
};

function setVec(c, key, name, x, y, z) {
  finiteNote(c, name, x, y, z);
  const v = c.layout[key];
  v[0] = Number(x);
  v[1] = Number(y);
  if (z !== undefined) v[2] = Number(z);
}

function addListener(map, evName, cb, c, what) {
  const list = map.get(evName) ?? [];
  if (list.includes(cb)) c.sim.diag('warn', 'SIM030', `对「${c.nameStr}」重复注册了同一个${what}回调（${evName}）`, '模型');
  else if (list.length) c.sim.diag('warn', 'SIM030', `「${c.nameStr}」的 ${evName} 已经有${what}监听，又注册了一个：重复注册是「替换」还是「叠加」文档没写（契约 §10），模拟器按叠加处理`, '未确认');
  list.push(cb);
  map.set(evName, list);
}

function removeListener(map, evName, cb, c, what) {
  const list = map.get(evName) ?? [];
  const i = list.indexOf(cb);
  if (i < 0) {
    c.sim.diag('warn', 'SIM032', `Remove${what}Listener 没有找到要移除的回调：必须传注册时的同一个引用，匿名函数移不掉（文档 C3）`, '文档');
    return;
  }
  list.splice(i, 1);
  if (!list.length) map.delete(evName);
}

const METHODS = {
  // —— 层级 ——
  GetChildren: { sig: [], fn: (c) => [LuaTable.fromArray(c.children.slice())] },
  GetChild: {
    sig: ['s'],
    fn: (c, a) => {
      const name = utf8Decode(a[0]);
      const ch = c.children.find((x) => x.nameStr === name);
      if (!ch) c.sim.noteMissingChild(c, name, 'GetChild');
      return [ch];
    },
  },
  FindChild: {
    sig: ['s'],
    fn: (c, a) => {
      const path = utf8Decode(a[0]);
      if (path.includes('/')) c.sim.diag('info', 'SIM080', 'FindChild 的 "A/B" 路径写法没有真机验证（契约 §10）', '未确认');
      let cur = c;
      const segs = path.split('/').filter(Boolean);
      for (const seg of segs) cur = cur?.children.find((x) => x.nameStr === seg);
      if (!cur || !segs.length) c.sim.noteMissingChild(c, path, 'FindChild');
      return [segs.length ? cur : undefined];
    },
  },
  SetActive: { sig: ['b'], fn: (c, a) => { c.setActive(a[0]); } },
  SetVisible: { sig: ['b'], fn: (c, a) => { c.visible = a[0]; } },
  GetSiblingIndex: { sig: [], fn: (c) => [BigInt(c.siblingIndex())] },
  SetSiblingIndex: { sig: ['i'], fn: (c, a) => [c.moveSibling(Number(a[0]))] },
  SetAsFirstSibling: { sig: [], fn: (c) => [c.moveSibling(0)] },
  SetAsLastSibling: { sig: [], fn: (c) => [c.parent ? c.moveSibling(c.parent.children.length - 1) : false] },

  // —— 布局与变换（Get* 返回多个值，不是表）——
  GetAnchoredPosition: { sig: [], fn: (c) => [...c.layout.pos] },
  SetAnchoredPosition: { sig: ['n', 'n'], fn: (c, a) => { setVec(c, 'pos', 'SetAnchoredPosition', a[0], a[1]); } },
  GetSizeDelta: { sig: [], fn: (c) => [...c.layout.size] },
  SetSizeDelta: { sig: ['n', 'n'], fn: (c, a) => { setVec(c, 'size', 'SetSizeDelta', a[0], a[1]); } },
  GetAnchorMin: { sig: [], fn: (c) => [...c.layout.anchorMin] },
  SetAnchorMin: { sig: ['n', 'n'], fn: (c, a) => { setVec(c, 'anchorMin', 'SetAnchorMin', a[0], a[1]); } },
  GetAnchorMax: { sig: [], fn: (c) => [...c.layout.anchorMax] },
  SetAnchorMax: { sig: ['n', 'n'], fn: (c, a) => { setVec(c, 'anchorMax', 'SetAnchorMax', a[0], a[1]); } },
  GetPivot: { sig: [], fn: (c) => [...c.layout.pivot] },
  SetPivot: { sig: ['n', 'n'], fn: (c, a) => { setVec(c, 'pivot', 'SetPivot', a[0], a[1]); } },
  GetLocalScale: { sig: [], fn: (c) => [...c.layout.scale] },
  SetLocalScale: {
    sig: ['n', 'n', 'n?'],
    fn: (c, a) => {
      if (a[2] === undefined) c.sim.diag('info', 'SIM082', 'SetLocalScale 的官方签名是 (x, y, z)，这里只传了两个：真机是否接受未确认（z 保持原值）', '未确认');
      setVec(c, 'scale', 'SetLocalScale', a[0], a[1], a[2]);
    },
  },
  GetLocalRotation: { sig: [], fn: (c) => [...c.layout.rot] },
  SetLocalRotation: { sig: ['n', 'n', 'n?'], fn: (c, a) => { setVec(c, 'rot', 'SetLocalRotation', a[0], a[1], a[2]); } },

  // —— 脚本访问 ——
  GetScriptByPath: { sig: ['s'], fn: (c, a) => [c.sim.scriptOn(c, (s) => s.pathStr === utf8Decode(a[0]))] },
  GetScript: { sig: ['i'], fn: (c, a) => [c.sim.scriptOn(c, (s) => BigInt(s.mappingId) === a[0])] },
  GetScripts: { sig: [], fn: (c) => { const s = c.sim.scriptOn(c, () => true); return [LuaTable.fromArray(s ? [s] : [])]; } },

  // —— 按键事件 ——
  AddKeyEventListener: { sig: ['e:KeyEventType', 'f'], fn: (c, a) => { addListener(c.keyListeners, a[0].name, a[1], c, '按键'); } },
  RemoveKeyEventListener: { sig: ['e:KeyEventType', 'f'], fn: (c, a) => { removeListener(c.keyListeners, a[0].name, a[1], c, 'Key'); } },
  RemoveKeyEventListeners: { sig: ['e:KeyEventType'], fn: (c, a) => { c.keyListeners.delete(a[0].name); } },
  RemoveAllKeyEventListeners: { sig: [], fn: (c) => { c.keyListeners.clear(); } },

  // —— 手柄导航 ——
  AddNavigationEventListener: { sig: ['e:ControllerNavigationEventType', 'f'], fn: (c, a) => { addListener(c.navListeners, a[0].name, a[1], c, '导航'); } },
  RemoveNavigationEventListener: { sig: ['e:ControllerNavigationEventType', 'f'], fn: (c, a) => { removeListener(c.navListeners, a[0].name, a[1], c, 'Navigation'); } },
  RemoveNavigationEventListeners: { sig: ['e:ControllerNavigationEventType'], fn: (c, a) => { c.navListeners.delete(a[0].name); } },
  RemoveAllNavigationEventListeners: { sig: [], fn: (c) => { c.navListeners.clear(); } },
  SetControllerNavigation: {
    sig: ['e:ControllerNavigationDir', 'e:ControllerNavigationMode', 'c?'],
    fn: (c, a) => { c.navConfig.set(a[0].name, { mode: a[1], target: a[2] }); },
  },
  GetControllerNavigation: {
    sig: ['e:ControllerNavigationDir'],
    fn: (c, a) => { const n = c.navConfig.get(a[0].name); return [n ? n.mode : c.sim.enumItem('ControllerNavigationMode', 'None'), n?.target]; },
  },

  // —— 图片 ——
  SetImage: {
    sig: ['e:ImageSource', 'i'],
    fn: (c, a) => { c.values.set('imageSource', a[0]); c.values.set('imageId', a[1]); },
  },
  SetSoftEdgeWidth: { sig: ['n', 'n'], fn: (c, a) => { c.values.set('softEdgeWidthX', Number(a[0])); c.values.set('softEdgeWidthY', Number(a[1])); } },
  SetFillUnused: { sig: [], fn: (c) => { c.values.set('fillType', c.sim.enumItem('ImageFillType', 'Unused')); } },
  SetFillHorizontal: {
    sig: ['e:ImageFillHorizontalType', 'n'],
    fn: (c, a) => { c.values.set('fillType', c.sim.enumItem('ImageFillType', 'Horizontal')); c.values.set('fillHorizontalType', a[0]); c.values.set('fillAmount', Number(a[1])); },
  },
  SetFillVertical: {
    sig: ['e:ImageFillVerticalType', 'n'],
    fn: (c, a) => { c.values.set('fillType', c.sim.enumItem('ImageFillType', 'Vertical')); c.values.set('fillVerticalType', a[0]); c.values.set('fillAmount', Number(a[1])); },
  },
  SetFillRadial90: {
    sig: ['e:ImageFillRadial90Type', 'n'],
    fn: (c, a) => { c.values.set('fillType', c.sim.enumItem('ImageFillType', 'Radial90')); c.values.set('fillRadial90Type', a[0]); c.values.set('fillAmount', Number(a[1])); },
  },
  SetFillRadial180: {
    sig: ['e:ImageFillRadialType', 'n'],
    fn: (c, a) => { c.values.set('fillType', c.sim.enumItem('ImageFillType', 'Radial180')); c.values.set('fillRadialType', a[0]); c.values.set('fillAmount', Number(a[1])); },
  },
  SetFillRadial360: {
    sig: ['e:ImageFillRadialType', 'n'],
    fn: (c, a) => { c.values.set('fillType', c.sim.enumItem('ImageFillType', 'Radial360')); c.values.set('fillRadialType', a[0]); c.values.set('fillAmount', Number(a[1])); },
  },

  // —— 光标事件（预设按钮 / 光标检测区域）——
  AddCursorEventListener: { sig: ['e:CursorEventType', 'f'], fn: (c, a) => { addListener(c.cursorListeners, a[0].name, a[1], c, '光标'); } },
  RemoveCursorEventListener: { sig: ['e:CursorEventType', 'f'], fn: (c, a) => { removeListener(c.cursorListeners, a[0].name, a[1], c, 'Cursor'); } },
  RemoveCursorEventListeners: { sig: ['e:CursorEventType'], fn: (c, a) => { c.cursorListeners.delete(a[0].name); } },
  RemoveAllCursorEventListeners: { sig: [], fn: (c) => { c.cursorListeners.clear(); } },
  SimulateCursorClick: { sig: [], fn: (c) => { c.sim.simulateCursorClick(c); } },

  // —— 网格视窗 ——
  RefreshItems: {
    sig: ['i', 'f'],
    fn: (c, a) => {
      const n = Number(a[0]);
      c.sim.diag('info', 'SIM081', 'RefreshItems 回调里的 index 起点文档没写（「以运行时传入和返回的 index 为准」），模拟器按 0 起；不要假定它和 Lua 数组下标对齐', '未确认');
      for (const ch of c.children.filter((x) => x.isGridItem)) ch.destroy();
      const items = [];
      for (let i = 0; i < n; i++) {
        const item = c.sim.instantiateTemplate(Number(c.values.get('itemPrefabIndex') ?? 0n), c) ?? c.addChild(new Control(c.sim, 'ClientUIContainerControl', `列表项${i}`, { dynamic: true }));
        item.isGridItem = true;
        items.push(item);
      }
      c.values.set('itemCount', BigInt(n));
      items.forEach((item, i) => c.sim.callLua('RefreshItems 回调', a[1], [item, BigInt(i)]));
    },
  },
  GetItemIndex: { sig: ['c'], fn: (c, a) => { const i = c.children.filter((x) => x.isGridItem).indexOf(a[0]); return [i < 0 ? undefined : BigInt(i)]; } },
  GetItemSize: { sig: [], fn: () => [0, 0] },
  GetItemSpacing: { sig: [], fn: () => [0, 0] },
  GetPadding: { sig: [], fn: () => [0, 0, 0, 0] },
  ScrollToItemAt: { sig: ['i', 'e:ScrollAlignType'], fn: () => undefined },
  GetContentLength: { sig: [], fn: () => [0] },

  // —— 动效 ——
  PlayAnimation: { sig: [], fn: (c) => { c.animationPlaying = true; } },
  StopAnimation: { sig: [], fn: (c) => { c.animationPlaying = false; } },
};

export { METHODS as CONTROL_METHODS };

// ─────────────────────────── 光标事件数据 ───────────────────────────

/** 【文档】CursorEventData：只读 dragging / touchId；方法 GetUIPos / GetPressUIPos / GetUIPosDelta（画布左下为原点） */
export class CursorEventData extends Host {
  constructor(sim, { pos = [0, 0], pressPos = pos, delta = [0, 0], dragging = false, touchId = 0 } = {}) {
    super('CursorEventData');
    this.sim = sim;
    this.pos = pos;
    this.pressPos = pressPos;
    this.delta = delta;
    this.dragging = dragging;
    this.touchId = touchId;
  }

  index(key, interp) {
    const k = typeof key === 'string' ? utf8Decode(key) : '';
    if (k === 'dragging') return this.dragging;
    if (k === 'touchId') return BigInt(this.touchId);
    const pick = { GetUIPos: 'pos', GetPressUIPos: 'pressPos', GetUIPosDelta: 'delta' }[k];
    if (pick) {
      const fn = (args) => {
        if (args[0] !== this) throw interp.rtError(`bad argument #1 to '${k}' (CursorEventData expected, got ${args.length === 0 ? 'no value' : tn(args[0])})`);
        return [...this[pick]];
      };
      fn.lname = k;
      return fn;
    }
    this.sim.noteUnknownField('CursorEventData', k);
    return undefined;
  }

  newindex(key, _v, interp) { throw interp.rtError(`cannot set ${utf8Decode(String(key))}, no such field`); }
}
