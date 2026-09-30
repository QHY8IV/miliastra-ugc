/**
 * lint.mjs —— 基于语法树的静态检查（规则号 LS***）。和 scripts/check-lua-ui.mjs 的正则规则（LX***）互补：
 *   正则规则擅长「客户端 API 用法」；这里擅长语言层：语法错误、作用域、拼写、标准库成员、数字类型陷阱。
 *
 *   LS001 语法错误（真机加载期就会失败）              error
 *   LS002 读了没声明的全局                            error     拼写错误 / local 声明在使用之后 / 用了被裁掉的库
 *   LS003 只写不读的全局                              warning   典型的拼写错误形态
 *   LS004 生命周期函数被声明成 local                  warning   宿主按名字找全局函数，local 的宿主看不到（文档 A2）
 *   LS005 疑似生命周期名拼错 / 照搬别的引擎的名字      warning   onStart / Start / Update / OnClick …（文档 A2）
 *   LS006 局部变量从未被读取                          info
 *   LS007 标准库里没有这个成员                        error     math.pow / table.getn / os.execute …（常是 5.1 写法或被裁剪）
 *   LS008 定义了 OnUpdate 却没 EnableUpdate(true)     warning   死代码（契约 §1，真机确证）
 *   LS011 typeof(x) 和 nil 比较                       warning   typeof 总返回字符串，包括 typeof(nil) == "nil"（契约 §9，真机确证）
 *   LS018 浮点结果拼进文本                            info      Lua 5.3 里 / 和 ^ 总得浮点数，"HP:" .. 100/2 得到 "HP:50.0"
 *   LS019 fontSize 赋了可能带小数的值                 warning   真机报 bad argument #2 to 'fontSize' (integer expected, got number)（契约 §6）
 *   LS022 大写 Id / GetName() / GetId()               info      控件标识是小写 id / name 属性，没有 getter（契约 §3）
 *
 * 语言版本按 Lua 5.3（官方文档 §3）：<const>、5.4 的新库函数、5.1 的 unpack / loadstring / setfenv 都不可用。
 */

import { Interp } from './interp.mjs';
import { createGlobals } from './stdlib.mjs';
import { LuaSyntaxError, LuaTable, utf8Decode } from './value.mjs';

export const LIFECYCLE = ['OnInit', 'OnStart', 'OnEnable', 'OnDisable', 'OnUpdate', 'OnLevelUpdate', 'OnDestroy'];
const ENGINE_GLOBALS = ['Enum', 'Color', 'game', 'script'];

/** 常见的「照搬别的引擎」的生命周期名 → 应该写成什么 */
const WRONG_LIFECYCLE = {
  Start: 'OnStart', Awake: 'OnInit', Init: 'OnInit', Update: 'OnUpdate', FixedUpdate: 'OnUpdate', LateUpdate: 'OnUpdate', Tick: 'OnUpdate',
  OnAwake: 'OnInit', OnLoad: 'OnInit', OnTick: 'OnUpdate', OnFixedUpdate: 'OnUpdate', OnExit: 'OnDestroy', OnQuit: 'OnDestroy', Destroy: 'OnDestroy',
  OnClick: '（没有脚本级点击回调，用 AddCursorEventListener(Enum.CursorEventType.CursorClick, …)）',
  Register: '（不是宿主回调；要在 OnStart 里自己调用）',
};

const GLOBAL_HINTS = {
  unpack: 'Lua 5.3 没有全局 unpack，用 table.unpack',
  loadstring: '被裁剪（load / loadstring / loadfile / dofile 都不可用）',
  load: '被裁剪（load / loadstring / loadfile / dofile 都不可用）',
  loadfile: '被裁剪', dofile: '被裁剪',
  setfenv: '那是 Lua 5.1 的函数，5.3 没有', getfenv: '那是 Lua 5.1 的函数，5.3 没有', module: '那是 Lua 5.1 的函数，5.3 没有',
  bit: '5.3 用运算符 & | ~ << >>，没有 bit 库', bit32: '5.3 用运算符 & | ~ << >>，没有 bit32 库',
  io: 'io 库在客户端运行时被裁剪（官方文档 §3）', coroutine: 'coroutine 库被裁剪（官方文档 §3）',
  package: '没有 package 库（契约 §7）', collectgarbage: '被裁剪（契约 §7）',
  self: '在非方法函数里没有 self；方法要写成 function obj:method() 或显式加 self 参数',
  typeOf: '函数名是 typeof（全小写）', Typeof: '函数名是 typeof（全小写）',
  printerror: '函数名是 printerr', printError: '函数名是 printerr', print_err: '函数名是 printerr',
  tween: '补间用 game.Tween(...)', Tween: '补间用 game.Tween(...)', TweenSequence: '用 game.TweenSequence()',
  Vector3: '客户端 Lua 没有 Vector3 构造函数；向量参数用 {x=,y=,z=} 表', Vector2: '没有 Vector2；坐标用 x, y 两个标量',
  Color3: '颜色用 Color(r, g, b, a?)', Color4: '颜色用 Color(r, g, b, a?)',
};

const MEMBER_HINTS = {
  'math.pow': '5.3 里用 x ^ y（标准 5.3 不含 math.pow，客户端运行时也没有）',
  'math.log10': '用 math.log(x, 10)', 'math.atan2': '用 math.atan(y, x)', 'math.cosh': '5.3 没有双曲函数', 'math.sinh': '5.3 没有双曲函数', 'math.tanh': '5.3 没有双曲函数',
  'math.ldexp': '5.3 已移除', 'math.frexp': '5.3 已移除', 'math.mod': '用 math.fmod 或 % 运算符',
  'table.getn': '用 #t', 'table.setn': '5.3 已移除', 'table.maxn': '5.3 已移除', 'table.foreach': '5.3 已移除，用 for k, v in pairs(t)', 'table.foreachi': '5.3 已移除，用 ipairs',
  'string.gfind': '用 string.gmatch', 'string.dump': '被裁剪（官方文档 §3）', 'string.pack': '被裁剪（契约 §7）', 'string.unpack': '被裁剪（契约 §7）',
  'os.execute': '被裁剪：os 只剩 time / date / clock / difftime', 'os.getenv': '被裁剪：os 只剩 time / date / clock / difftime',
  'os.exit': '被裁剪：os 只剩 time / date / clock / difftime', 'os.remove': '被裁剪', 'os.rename': '被裁剪', 'os.tmpname': '被裁剪', 'os.setlocale': '被裁剪',
  'debug.getinfo': 'debug 只剩 traceback（契约 §9）', 'debug.sethook': 'debug 只剩 traceback', 'debug.getlocal': 'debug 只剩 traceback', 'debug.getmetatable': 'debug 只剩 traceback',
  'math.isnaf': '文档异常行提到的 math.isnaf 没有任何语义记载，不提供；判 NaN 用 math.isnan（契约 §7）',
};

let cachedEnv;
/** 运行时真实的全局表 / 库表（lint 与运行时共用同一份清单，不会各说各话） */
function runtimeEnv() {
  if (cachedEnv) return cachedEnv;
  const interp = new Interp({});
  const G = createGlobals(interp, 'lint');
  const known = new Set(ENGINE_GLOBALS);
  for (const k of G.keys()) known.add(utf8Decode(k));
  cachedEnv = { known, libs: interp.libs };
  return cachedEnv;
}

// ─────────────────────────── 语法树遍历 ───────────────────────────

function walk(node, fn) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const x of node) walk(x, fn); return; }
  if (node.type) fn(node);
  switch (node.type) {
    case 'Chunk': walk(node.body, fn); break;
    case 'Function': walk(node.body, fn); break;
    case 'Local': walk(node.exprs, fn); break;
    case 'LocalFunction': walk(node.fn, fn); break;
    case 'Assign': walk(node.targets, fn); walk(node.exprs, fn); break;
    case 'CallStat': walk(node.call, fn); break;
    case 'Do': walk(node.body, fn); break;
    case 'While': walk(node.cond, fn); walk(node.body, fn); break;
    case 'Repeat': walk(node.body, fn); walk(node.cond, fn); break;
    case 'If': for (const c of node.clauses) { walk(c.cond, fn); walk(c.body, fn); } walk(node.orelse, fn); break;
    case 'NumFor': walk(node.start, fn); walk(node.stop, fn); walk(node.step, fn); walk(node.body, fn); break;
    case 'GenFor': walk(node.exprs, fn); walk(node.body, fn); break;
    case 'Return': walk(node.exprs, fn); break;
    case 'Index': walk(node.obj, fn); walk(node.key, fn); break;
    case 'Call': walk(node.fn, fn); walk(node.args, fn); break;
    case 'MethodCall': walk(node.obj, fn); walk(node.args, fn); break;
    case 'Binop': walk(node.left, fn); walk(node.right, fn); break;
    case 'Unop': walk(node.operand, fn); break;
    case 'Paren': walk(node.expr, fn); break;
    case 'Table': for (const it of node.items) { if (it.key) walk(it.key, fn); walk(it.value, fn); } break;
    default: break;
  }
}

const stripBom = (s) => (s.charCodeAt(0) === 0xfeff ? s.slice(1) : s);
const unparen = (e) => { while (e && e.type === 'Paren') e = e.expr; return e; };
const isGlobalName = (e, name) => e && e.type === 'Name' && e.kind === 'global' && (name === undefined || e.name === name);
const str = (e) => (e && e.type === 'String' ? utf8Decode(e.value) : undefined);

/** RHS 里是不是可能带小数：含 / ^ 、浮点字面量、或者 * 与浮点字面量一起；被 math.floor / ceil / tointeger 包住的不算 */
function maybeFractional(e) {
  e = unparen(e);
  if (!e) return false;
  if (e.type === 'Number') return typeof e.value === 'number';
  if (e.type === 'Call') {
    const f = e.fn;
    if (f.type === 'Index' && isGlobalName(f.obj, 'math') && ['floor', 'ceil', 'tointeger'].includes(str(f.key))) return false;
    if (f.type === 'Index' && isGlobalName(f.obj, 'math') && ['sqrt', 'sin', 'cos', 'tan', 'exp', 'log', 'random'].includes(str(f.key))) return str(f.key) !== 'random' || e.args.length === 0;
    return false;
  }
  if (e.type === 'Binop') {
    if (e.op === '/' || e.op === '^') return true;
    if (['+', '-', '*', '%', '//'].includes(e.op)) return maybeFractional(e.left) || maybeFractional(e.right);
  }
  if (e.type === 'Unop' && e.op === '-') return maybeFractional(e.operand);
  return false;
}

// ─────────────────────────── 主函数 ───────────────────────────

/**
 * @param {string} source  Lua 源码（JS 字符串）
 * @param {{chunk?: string}} opts
 * @returns {{ syntaxError?: {message: string, line: number}, findings: Array<{sev:'error'|'warning'|'info', code:string, line:number, msg:string, hint?:string}> }}
 */
export function lintLua(source, { chunk = 'main' } = {}) {
  const findings = [];
  const add = (sev, code, line, msg, hint) => findings.push({ sev, code, line, msg, hint });
  let ast;
  let info;
  try {
    const interp = new Interp({});
    ({ ast, info } = interp.compile(stripBom(source), chunk));
  } catch (e) {
    if (e instanceof LuaSyntaxError) {
      const msg = e.message.replace(/^[^:]*:\d+:\s*/, '');
      return { syntaxError: { message: e.message, line: e.line }, findings: [{ sev: 'error', code: 'LS001', line: e.line, msg: `语法错误：${msg}`, hint: '真机加载脚本时就会失败，整个脚本一个回调都不会执行' }] };
    }
    throw e;
  }
  const { known, libs } = runtimeEnv();
  const writes = info.globalWrites;
  const reads = info.globalReads;

  // LS002 没声明的全局
  for (const [name, lines] of reads) {
    const n = utf8Decode(name);
    if (known.has(n) || writes.has(name)) continue;
    add('error', 'LS002', lines[0], `读了没有声明的全局变量「${n}」${lines.length > 1 ? `（共 ${lines.length} 处：第 ${lines.join('、')} 行）` : ''}`,
      GLOBAL_HINTS[n] ?? '拼写错误？或者 local 声明在使用之后？（没声明的全局读出来是 nil，之后通常以 attempt to … a nil value 的形式爆出来）');
  }

  // 收集：全局函数声明 / 全局赋值 / local 生命周期
  const globalDecls = new Map();      // 名字 → {line, isFunc}
  const topLocals = [];
  const enableUpdateTrue = { found: false };
  walk(ast.body, (n) => {
    if (n.type === 'Assign') {
      for (const tg of n.targets) {
        if (tg.type === 'Name' && tg.kind === 'global') {
          const nm = utf8Decode(tg.name);
          if (!globalDecls.has(nm)) globalDecls.set(nm, { line: n.line, isFunc: !!n.isFunctionDecl || (n.exprs[0] && n.exprs[0].type === 'Function') });
        }
        // LS019 fontSize
        if (tg.type === 'Index' && ['fontSize', 'minimumFontSize'].includes(str(tg.key)) && n.exprs.length === 1 && maybeFractional(n.exprs[0])) {
          add('warning', 'LS019', n.line, `${str(tg.key)} 赋的值可能带小数：真机要求整数，传小数报 bad argument #2 to '${str(tg.key)}' (integer expected, got number)`, '用 math.floor(…) 取整（契约 §6，真机日志：38 * .62 = 23.56 报错）');
        }
      }
    }
    if (n.type === 'MethodCall' && n.name === 'EnableUpdate' && isGlobalName(n.obj, 'script')) {
      const a = n.args[0];
      if (!a || a.type !== 'False') enableUpdateTrue.found = true;
    }
    // LS022
    if (n.type === 'Index' && str(n.key) === 'Id') add('info', 'LS022', n.line, '「.Id」大写：控件的标识字段是小写 .id，大写 Id 在真机读为 nil（契约 §3）', '如果这不是控件而是你自己的表，可以忽略');
    if (n.type === 'MethodCall' && (n.name === 'GetName' || n.name === 'GetId')) add('info', 'LS022', n.line, `「:${n.name}()」：控件没有 getter 方法，标识是属性 .name / .id（真机报 attempt to call a nil value (method '${n.name}')，契约 §3c）`, '如果这不是控件而是你自己的对象，可以忽略');
    // LS011
    if (n.type === 'Binop' && (n.op === '==' || n.op === '~=')) {
      const a = unparen(n.left), b = unparen(n.right);
      const isTypeof = (x) => x && x.type === 'Call' && isGlobalName(x.fn, 'typeof');
      if ((isTypeof(a) && b && b.type === 'Nil') || (isTypeof(b) && a && a.type === 'Nil')) {
        add('warning', 'LS011', n.line, `typeof(x) ${n.op} nil 永远是 ${n.op === '==' ? 'false' : 'true'}：typeof 总是返回字符串，typeof(nil) 是字符串 "nil"`, '判 nil 直接写 x == nil（契约 §9，真机确证）');
      }
    }
    // LS018
    if (n.type === 'Binop' && n.op === '..') {
      for (const side of [n.left, n.right]) {
        const s = unparen(side);
        if (s && s.type === 'Binop' && (s.op === '/' || s.op === '^')) {
          add('info', 'LS018', n.line, `文本拼接里有 ${s.op === '/' ? '除法' : '乘方'}：Lua 5.3 里 ${s.op} 总得浮点数，拼进文本会带小数点（例如 "HP:" .. 100 / 2 得到 "HP:50.0"）`, '要整数用 //（整除）或 math.floor(…)；需要小数位就用 string.format("%.1f", …)');
        }
      }
    }
    // LS007
    if (n.type === 'Index' && n.obj.type === 'Name' && n.obj.kind === 'global' && ['string', 'table', 'math', 'os', 'debug', 'utf8'].includes(n.obj.name) && n.key.type === 'String') {
      const lib = libs[n.obj.name];
      const member = utf8Decode(n.key.value);
      if (lib instanceof LuaTable && lib.get(n.key.value) === undefined) {
        add('error', 'LS007', n.line, `${n.obj.name}.${member} 不存在`, MEMBER_HINTS[`${n.obj.name}.${member}`] ?? `${n.obj.name} 库里没有 ${member}（读出来是 nil，调用时报 attempt to call a nil value (field '${member}')）`);
      }
    }
  });
  for (const s of ast.body) {
    if (s.type === 'LocalFunction' && LIFECYCLE.includes(s.name)) topLocals.push({ name: s.name, line: s.line });
    if (s.type === 'Local') for (const nm of s.names) if (LIFECYCLE.includes(nm)) topLocals.push({ name: nm, line: s.line });
  }

  // LS004
  for (const l of topLocals) add('warning', 'LS004', l.line, `${l.name} 被声明成了 local：宿主按固定名字找的是全局函数，local 的宿主看不到，它永远不会被调用`, '去掉 local（文档 A2）');

  // LS005 / LS003
  const lowerLife = LIFECYCLE.map((x) => x.toLowerCase());
  const lev = (a, b) => {
    const dp = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array(b.length).fill(0)]);
    for (let j = 1; j <= b.length; j++) dp[0][j] = j;
    for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    return dp[a.length][b.length];
  };
  for (const [name, d] of globalDecls) {
    if (LIFECYCLE.includes(name)) continue;
    let fix = WRONG_LIFECYCLE[name];
    if (!fix && d.isFunc) {
      const low = name.toLowerCase().replace(/_/g, '');
      const i = lowerLife.findIndex((x) => x === low || (x.length >= 6 && lev(low, x) <= 1));
      if (i >= 0) fix = LIFECYCLE[i];
    }
    if (fix && d.isFunc) add('warning', 'LS005', d.line, `函数「${name}」不是宿主回调：宿主只按名字调用这七个 ${LIFECYCLE.join(' / ')}`, `是不是想写 ${fix}？（文档 A2：写错名字 = 函数定义了却永远不会被调用，脚本「没反应」）`);
  }
  for (const [name, lines] of writes) {
    const n = utf8Decode(name);
    if (LIFECYCLE.includes(n) || known.has(n) || reads.has(name)) continue;
    const d = globalDecls.get(n);
    if (d && d.isFunc) continue;
    add('warning', 'LS003', lines[0], `全局变量「${n}」被赋值但从未被读取${lines.length > 1 ? `（${lines.length} 处）` : ''}`, '笔误的典型形态：忘写 local，或者变量名写错；写错名字不会报错，只会悄悄多出一个新的全局变量');
  }

  // LS006
  for (const l of info.locals) {
    if (l.used || l.isParam || l.isLoopVar || l.name.startsWith('_') || l.name === 'self') continue;
    add('info', 'LS006', l.line, `局部变量「${utf8Decode(l.name)}」声明后从未被读取`);
  }

  // LS008
  const hasUpdate = ['OnUpdate', 'OnLevelUpdate'].filter((n) => globalDecls.has(n));
  if (hasUpdate.length && !enableUpdateTrue.found) {
    add('warning', 'LS008', globalDecls.get(hasUpdate[0]).line, `定义了 ${hasUpdate.join(' / ')}，但脚本里没有调用 script:EnableUpdate(true)：它们是死代码——不报错、不执行、日志里什么都没有`, '在 OnStart 里加 script:EnableUpdate(true)（契约 §1，真机：不调 0 帧，调后 3080 帧）');
  }

  findings.sort((a, b) => a.line - b.line);
  return { findings };
}
