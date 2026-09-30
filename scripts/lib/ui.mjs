/**
 * ui.mjs —— 从 .gil 的界面控件板块（顶层字段 9）还原控件树，并把 Lua 里的 GetChild 链与之对照
 *
 * 控件节点（gil.proto 的 UiNode）：guid / parent / children（兄弟顺序）/ slots（数据槽）
 *   槽 (slot_id, slot_type) 的组合决定它存什么：(2,15)=名字，(1,11|12)=变换 …
 *   控件类型 = 看节点带了哪些「类型专属槽」，见 WIDGETS。
 *   脚本绑定：槽 (63,83) 里嵌着 74.502.1.1 = 客户端脚本资产的 GUID。
 *
 * 【证据】
 *   - 树形结构（guid/parent/children/名字）与脚本绑定：【官方示例】样本 客户端脚本.gil（3.21 教程），
 *     还原出的树与教程要求的层级逐项一致（容器节点 → 背景 / 分数文本 / 圆圈容器 → 圆圈图片 / 圆圈点击区域）。
 *   - 5 种「新式客户端控件」的识别：【官方示例】同一份样本，签名逐个对照过教程对控件类型的说明。
 *   - 老式界面控件（文本框、进度条、计时器……）的识别：【逆向推断】由样本里的控件名与签名归纳，
 *     只有在名字与签名一致出现多次时才收进表，且只作提示，不当作事实。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

// 控件类型识别表。requires 里每个 "slot_id:slot_type" 都在节点上才算匹配；越靠前越优先（更具体的放前面）。
export const WIDGETS = [
  // —— 新式客户端控件（Lua 脚本操作的那套）——
  { label: '图片控件', requires: ['63:83', '73:96', '74:97'], evidence: '官方示例' },
  { label: '文本控件', requires: ['63:83', '64:84'], evidence: '官方示例' },
  { label: '光标检测区域', requires: ['63:83', '65:85'], evidence: '官方示例' },
  { label: '容器控件', requires: ['63:83', '68:91'], evidence: '官方示例' },
  // —— 老式界面控件（逆向推断，仅作提示）——
  { label: '文本框(推测)', requires: ['9:25'], evidence: '逆向推断' },
  { label: '进度条(推测)', requires: ['10:26'], evidence: '逆向推断' },
  { label: '计时器(推测)', requires: ['11:27'], evidence: '逆向推断' },
  { label: '自定义按钮(推测)', requires: ['7:22'], evidence: '逆向推断' },
  { label: '弹窗(推测)', requires: ['8:24'], evidence: '逆向推断' },
  { label: '图片(推测)', requires: ['21:38'], evidence: '逆向推断' },
  { label: '素材组(推测)', requires: ['38:56'], evidence: '逆向推断' },
];

const has = (sig, req) => req.every((r) => sig.has(r));

/** 递归取 _u 记录里的路径：uget(rec, 503, 74, 502, 1, 1) → 最后一层的 varint 值（找不到 undefined） */
export function uget(holder, ...path) {
  let cur = holder;
  for (let i = 0; i < path.length; i++) {
    const list = Array.isArray(cur) ? cur : cur?._u ?? (Array.isArray(cur?.msg) ? cur.msg : null);
    if (!list) return undefined;
    const hit = list.find((u) => u.f === path[i]);
    if (!hit) return undefined;
    if (i === path.length - 1) return hit.v ?? hit.text ?? hit;
    cur = hit.msg ? hit.msg : hit;
  }
  return cur;
}

// ─────────────────────────── 布局（变换）槽 ───────────────────────────

const recOf = (list, f) => (Array.isArray(list) ? list.find((u) => u.f === f) : undefined);
const f32of = (rec) => {
  const h = String(rec?.hex ?? '').replace(/^0x/, '');
  return h.length === 8 ? Buffer.from(h, 'hex').readFloatLE(0) : 0;
};
/** 一个向量消息 → [x, y(, z)]；消息整个缺席或为空 = 0（canonical 编码不写默认值） */
function vecOf(group, fieldNo, names) {
  const msg = recOf(group, fieldNo)?.msg;
  return names.map((n) => { const r = recOf(msg, n); return r && r.w === 'i32' ? f32of(r) : 0; });
}

/**
 * 读新式客户端控件的布局：槽 (1,12) → 503 → 13 → 12 → 若干条 501（一条默认 + 三条带状态号的变体）。
 * 取「没有状态号」的那一条的 502 组：
 *   501{1,2,3}=localScale  502=anchorMin  503=anchorMax  504=anchoredPosition  505=sizeDelta  506=pivot
 * 省略的向量分量按 0 处理。
 *
 * 【证据：逆向推断】依据官方示例 客户端脚本.gil（3.21 教程）：根容器 anchorMax=(1,1)（全屏拉伸）、
 * 背景 sizeDelta=1600×900、分数文本 sizeDelta=218×68 位置 (0,350)，且 419 个新式控件的字段形状全部一致（普查 48 个样本）。
 * 没有官方文档逐字段说明这些编号，所以只当作模拟用的布局提示，不当作事实。
 * 三个「状态变体」分别对应什么（横竖屏 / 设备？）未知，本函数不读它们。
 * 返回 null = 该节点没有 (1,12) 槽（内置控件 / 布局节点）。
 */
export function layoutOfNode(uiNode) {
  const slot = (uiNode.slots || []).find((s) => !s.name && s.slot_id === 1 && s.slot_type === 12);
  if (!slot) return null;
  const l12 = recOf(recOf(recOf(slot._u, 503)?.msg, 13)?.msg, 12)?.msg;
  const entries = (l12 || []).filter((u) => u.f === 501 && Array.isArray(u.msg));
  const base = entries.find((e) => !e.msg.some((x) => x.f === 501 && x.w === 'varint')) ?? entries[0];
  const group = recOf(base?.msg, 502)?.msg;
  if (!group) return null;
  const scale = vecOf(group, 501, [1, 2, 3]);
  return {
    scale: scale,
    anchorMin: vecOf(group, 502, [501, 502]),
    anchorMax: vecOf(group, 503, [501, 502]),
    position: vecOf(group, 504, [501, 502]),
    size: vecOf(group, 505, [501, 502]),
    pivot: vecOf(group, 506, [501, 502]),
  };
}

/** 从槽里找脚本 GUID（槽 (63,83) 的 503 → 74 → 502 → 1 → 1）；找不到 null */
function scriptOfSlot(slot) {
  const id = uget(slot, 503, 74, 502, 1, 1);
  return typeof id === 'number' ? id : null;
}

/**
 * 还原控件树。
 * @param {object} gil  decodeMessage(schema,'GilFile',…) 的结果
 * @returns {{ nodes: Map, roots: number[], scripts: Map<number,number> }}
 *   nodes: guid → { guid, name, parent, children[], label, evidence, sig[], builtin, script }
 *   scripts: 脚本 GUID → 绑定它的控件节点 GUID
 */
export function buildUiTree(gil) {
  const nodes = new Map();
  const scripts = new Map();
  for (const n of gil.ui?.nodes || []) {
    const slots = n.slots || [];
    const sig = new Set(slots.filter((s) => !s.name).map((s) => `${s.slot_id}:${s.slot_type}`));
    const nameSlot = slots.find((s) => s.name);
    const wid = WIDGETS.find((w) => has(sig, w.requires));
    const isLayoutOrRoot = (n.info || []).some((i) => i.slot_id !== 1);
    let script = null;
    for (const s of slots) { const g = scriptOfSlot(s); if (g != null) { script = g; break; } }
    const node = {
      guid: n.guid,
      name: nameSlot?.name?.text ?? '',
      parent: n.parent || 0,
      children: n.children || [],
      label: wid ? wid.label : isLayoutOrRoot ? '布局/根' : sig.has('63:83') ? '客户端控件(类型未识别)' : '内置控件/布局',
      evidence: wid ? wid.evidence : '',
      sig: [...sig].sort((a, b) => Number(a.split(':')[0]) - Number(b.split(':')[0])),
      script,
      layout: layoutOfNode(n),             // 【逆向推断】见 layoutOfNode；内置控件为 null
    };
    nodes.set(node.guid, node);
    if (script != null) scripts.set(script, node.guid);
  }
  const roots = [...nodes.values()].filter((n) => !n.parent || !nodes.has(n.parent)).map((n) => n.guid);
  return { nodes, roots, scripts };
}

/** 一致性检查：children/parent 互相一致、没有环、没有悬空 GUID */
export function checkUiTree(tree) {
  const problems = [];
  const seenGuid = new Set();
  for (const n of tree.nodes.values()) {
    if (seenGuid.has(n.guid)) problems.push({ level: 'error', msg: `控件 GUID 0x${n.guid.toString(16)} 重复` });
    seenGuid.add(n.guid);
    for (const c of n.children) {
      const ch = tree.nodes.get(c);
      if (!ch) problems.push({ level: 'error', msg: `控件「${n.name}」的子节点 0x${c.toString(16)} 不存在` });
      else if (ch.parent !== n.guid) problems.push({ level: 'error', msg: `控件「${ch.name}」的 parent 与「${n.name}」的 children 不一致` });
    }
    if (n.parent && !tree.nodes.has(n.parent)) problems.push({ level: 'error', msg: `控件「${n.name}」的父节点 0x${n.parent.toString(16)} 不存在` });
    const sib = new Map();
    for (const c of n.children) {
      const nm = tree.nodes.get(c)?.name;
      if (nm) sib.set(nm, (sib.get(nm) || 0) + 1);
    }
    for (const [nm, k] of sib) if (k > 1) problems.push({ level: 'warn', msg: `「${n.name}」下有 ${k} 个同名子控件「${nm}」，GetChild(名字) 只会取到其中一个` });
  }
  // 环检测
  for (const n of tree.nodes.values()) {
    const seen = new Set();
    for (let cur = n; cur; cur = tree.nodes.get(cur.parent)) {
      if (seen.has(cur.guid)) { problems.push({ level: 'error', msg: `控件树里有环（经过「${cur.name}」）` }); break; }
      seen.add(cur.guid);
    }
  }
  return problems;
}

/** 文本树。opts.onlyCustom = 只显示新式客户端控件 */
export function formatUiTree(tree, opts = {}) {
  const lines = [];
  const walk = (guid, prefix, last) => {
    const n = tree.nodes.get(guid);
    if (!n) return;
    const branch = prefix === null ? '' : `${prefix}${last ? '└─ ' : '├─ '}`;
    const script = n.script != null ? `  ← 绑定脚本 0x${n.script.toString(16)}` : '';
    lines.push(`${branch}${n.name || '(无名)'}  [${n.label}]  0x${n.guid.toString(16)}${script}`);
    const next = prefix === null ? '' : prefix + (last ? '   ' : '│  ');
    n.children.forEach((c, i) => walk(c, next, i === n.children.length - 1));
  };
  const roots = opts.onlyCustom
    ? tree.roots.filter((g) => tree.nodes.get(g).label.startsWith('客户端控件') || tree.nodes.get(g).children.length || tree.nodes.get(g).script != null)
    : tree.roots;
  for (const r of roots) walk(r, null, true);
  return lines.join('\n');
}

/** 找某个节点下名字为 name 的直接子节点（GetChild 的语义）；找不到 null */
export function childByName(tree, guid, name) {
  const n = tree.nodes.get(guid);
  if (!n) return null;
  for (const c of n.children) if (tree.nodes.get(c)?.name === name) return tree.nodes.get(c);
  return null;
}

/** 按 "a/b/c" 路径找（FindChild 的语义）；返回节点或 null */
export function findByPath(tree, guid, path) {
  let cur = tree.nodes.get(guid);
  for (const seg of String(path).split('/').filter(Boolean)) {
    if (!cur) return null;
    cur = childByName(tree, cur.guid, seg);
  }
  return cur || null;
}

// ─────────────────────────── Lua 侧：提取 GetChild / FindChild 引用 ───────────────────────────

/** 去掉 Lua 注释与字符串内容（保留引号，便于按位置匹配），避免注释里的 GetChild 被误算 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    if (c === '-' && src[i + 1] === '-') {
      if (src[i + 2] === '[' && /^\[=*\[/.test(src.slice(i + 2))) {
        const m = /^\[(=*)\[/.exec(src.slice(i + 2));
        const close = `]${m[1]}]`;
        const end = src.indexOf(close, i + 2 + m[0].length);
        const stop = end < 0 ? n : end + close.length;
        out += src.slice(i, stop).replace(/[^\n]/g, ' ');
        i = stop;
      } else {
        while (i < n && src[i] !== '\n') { out += ' '; i++; }
      }
    } else if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && src[j] !== c) { if (src[j] === '\\') j++; j++; }
      out += src.slice(i, j + 1);
      i = j + 1;
    } else { out += c; i++; }
  }
  return out;
}

/**
 * 提取「从脚本所属控件出发」的子控件引用。
 * 识别：
 *   local a = this:GetChild("名字")            this = script.object 的别名（也认 script.object 直接调用）
 *   local b = a:GetChild("名字")               a 必须是已识别的局部变量
 *   local c = a:FindChild("x/y")
 *   this:GetChild("甲"):GetChild("乙")          链式
 * 认不出来的（动态拼接名字、经由函数返回值传递）不报，宁漏勿误。
 * @returns {{ refs: {path: string[], line: number}[], unresolved: number }}
 */
export function luaChildRefs(source) {
  // 存档里的脚本常带 \r\n；JS 的 . 不匹配 \r，不规范化会让逐行的正则整行失配
  const src = stripComments(source.replace(/\r\n?/g, '\n'));
  const lines = src.split('\n');
  const alias = new Map(); // 变量名 → 从 owner 出发的路径数组
  const refs = [];
  let unresolved = 0;

  // this = script.object
  const thisNames = new Set();
  for (const ln of lines) {
    const m = /^\s*local\s+([A-Za-z_]\w*)\s*=\s*script\.object\s*$/.exec(ln);
    if (m) thisNames.add(m[1]);
  }
  const baseOf = (name) => (thisNames.has(name) || name === 'script.object' ? [] : alias.get(name));

  const chainRe = /([A-Za-z_][\w.]*)((?:\s*:\s*(?:GetChild|FindChild)\s*\(\s*"[^"]*"\s*\))+)/g;
  const callRe = /:\s*(GetChild|FindChild)\s*\(\s*"([^"]*)"\s*\)/g;

  lines.forEach((ln, idx) => {
    const line = idx + 1;
    const assign = /^\s*local\s+([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(ln);
    let m;
    chainRe.lastIndex = 0;
    while ((m = chainRe.exec(ln))) {
      const base = baseOf(m[1]);
      if (!base) { unresolved++; continue; }
      let path = [...base];
      let c;
      callRe.lastIndex = 0;
      while ((c = callRe.exec(m[2]))) {
        path = c[1] === 'FindChild' ? [...path, ...c[2].split('/').filter(Boolean)] : [...path, c[2]];
        refs.push({ path: [...path], line });
      }
      // local x = <链>   → 记下别名
      if (assign && ln.indexOf(m[0]) >= ln.indexOf('=')) {
        const rest = assign[2].trim();
        if (rest.startsWith(m[0].trim())) alias.set(assign[1], path);
      }
    }
  });
  return { refs, unresolved };
}

/**
 * 核对 Lua 里的控件引用是否都存在于 .gil 的控件树。
 * @returns 问题列表 [{level, msg}]
 */
export function checkLuaAgainstTree(tree, ownerGuid, source) {
  const problems = [];
  const owner = tree.nodes.get(ownerGuid);
  if (!owner) { problems.push({ level: 'error', msg: '没有找到绑定该脚本的控件节点' }); return problems; }
  const { refs } = luaChildRefs(source);
  const seen = new Set();
  for (const r of refs) {
    const key = r.path.join('/');
    if (seen.has(key)) continue;
    seen.add(key);
    // 逐层找，报第一个断掉的层
    let cur = owner;
    for (let i = 0; i < r.path.length; i++) {
      const nxt = childByName(tree, cur.guid, r.path[i]);
      if (!nxt) {
        const have = cur.children.map((g) => tree.nodes.get(g)?.name).filter(Boolean);
        problems.push({
          level: 'error',
          msg: `第 ${r.line} 行：「${cur.name}」下没有名为「${r.path[i]}」的子控件（已有：${have.join('、') || '无'}）`,
        });
        break;
      }
      const same = cur.children.filter((g) => tree.nodes.get(g)?.name === r.path[i]).length;
      if (same > 1) problems.push({ level: 'warn', msg: `第 ${r.line} 行：「${cur.name}」下有 ${same} 个同名子控件「${r.path[i]}」，GetChild 只会取到第一个` });
      cur = nxt;
    }
  }
  return problems;
}
