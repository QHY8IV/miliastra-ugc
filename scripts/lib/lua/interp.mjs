/**
 * interp.mjs —— Lua 5.3 树遍历解释器
 *
 * 语义对齐 Lua 5.3 的地方（逐条都有自检用例，见 scripts/check-lua-sim.mjs）：
 *   · 整数/浮点两个子类型：4/2 → 2.0，7//2 → 3，2^2 → 4.0，整数 64 位回绕，整除/取模为 0 报错，
 *     字符串参与算术时按 luaO_str2num 转换，浮点键 t[1.0] 等同 t[1]
 *   · 字节串：#"圆" == 3，string.sub 按字节
 *   · 元表：__index / __newindex / __call / __eq / __lt / __le / __concat / __len / __unm / 算术与位运算 / __tostring / __pairs
 *   · goto / 标签、尾调用、可变参数、多重赋值先求值后赋值（且从右向左赋）、每轮循环是新的局部变量
 *   · 报错带「块名:行号:」前缀，变量描述照 Lua：(local 'x') (global 'x') (field 'x') (method 'x') (upvalue 'x')
 *
 * 与真机不同、需要你心里有数的地方：
 *   · 宿主对象（控件等）由 scripts/lib/sim 提供，其行为是「我对引擎的建模」，不是引擎
 *   · 递归深度受 JS 栈限制（maxDepth，默认几百层），真机允许更深
 *   · 步数预算（stepLimit）用来拦死循环；真机遇到死循环会卡死而不是报错
 *   · table 遍历顺序：数组部分按下标，哈希部分默认按插入序——真机的顺序是哈希序，依赖顺序的脚本在真机上可能表现不同
 *     （pairsOrder: 'reverse' / 函数 可以打乱顺序来暴露这类依赖）
 */

import {
  Host, LuaClosure, LuaError, LuaTable, ScriptTimeout, isTruthy, luaTypeName, str2num, toInteger, tostr,
  utf8Decode, utf8Encode, wrap64,
} from './value.mjs';
import { parse } from './parser.mjs';
import { resolve } from './resolve.mjs';

const EMPTY = Object.freeze([]);
const BREAK = { type: 'break' };

const ARITH_EVENT = {
  '+': '__add', '-': '__sub', '*': '__mul', '/': '__div', '%': '__mod', '^': '__pow', '//': '__idiv',
  '&': '__band', '|': '__bor', '~': '__bxor', '<<': '__shl', '>>': '__shr',
};
const BITWISE = new Set(['&', '|', '~', '<<', '>>']);

export class Interp {
  /**
   * opts:
   *   stepLimit   单次宿主回调允许的最大「步」数（语句 + 调用），默认 5000 万
   *   maxDepth    Lua 调用嵌套上限，默认 200
   *   pairsOrder  'insertion'（默认）| 'reverse' | 函数(keys)→keys
   *   onPrint(level, text)  print / printerr 的输出；text 已解码成 JS 字符串
   *   requireHook(name, interp)  require 的实现（由模拟世界提供）
   */
  constructor(opts = {}) {
    this.opts = opts;
    this.stepLimit = opts.stepLimit ?? 50_000_000;
    this.maxDepth = opts.maxDepth ?? 1000;       // 实际先撞上的通常是 JS 栈（约 500~900 层），见 callFromHost
    this.steps = 0;
    this.depth = 0;
    this.frame = null;
    this.inNative = false;                  // 当前执行的是不是某个原生函数的函数体
    this.nativeCaller = false;              // 这个原生函数，是不是被另一个原生函数直接调用的（pcall(error, "x")）
    this.stringLib = undefined;             // stdlib 安装后指向 string 表
  }

  // ─────────────────────────── 加载与调用 ───────────────────────────

  /** 解析 + 作用域解析。src 是 JS 字符串（内部转字节串）。语法错误抛 LuaSyntaxError。 */
  compile(src, chunk = 'main') {
    const ast = parse(utf8Encode(src), chunk);
    const info = resolve(ast);
    return { ast, info };
  }

  /** 编译并返回主函数的闭包（env = 这段脚本自己的全局表 G） */
  load(src, chunk, G) {
    const { ast, info } = this.compile(src, chunk);
    ast.main.chunkName = chunk;
    return { closure: new LuaClosure(ast.main, [], G), ast, info };
  }

  /**
   * 从宿主进入 Lua（生命周期回调、事件回调）：重置步数预算。
   * JS 栈耗尽（RangeError）统一转成 Lua 的 stack overflow 错误：上层只需要处理 LuaError / ScriptTimeout。
   */
  callFromHost(fn, args = []) {
    this.steps = 0;
    try {
      return this.callValue(fn, args);
    } catch (e) {
      if (e instanceof RangeError) throw this.stackOverflow();
      throw e;
    }
  }

  stackOverflow() {
    return new LuaError(utf8Encode('stack overflow（模拟器的 JS 栈耗尽；真机允许的递归深度远大于此，但真机也有上限）'), { frame: this.frame });
  }

  /**
   * 调用一个原生函数。原生函数被「另一个原生函数」直接调用时（pcall(error, "x")），
   * 它的第 1 层调用者是 C 函数，Lua 不会给错误消息加「块名:行号:」前缀——inNative / nativeCaller 记的就是这个。
   * 从 Lua 代码（含 for 迭代器、元方法等 VM 发起的调用）调用原生函数则有前缀。
   */
  invokeNative(fn, args) {
    const sIn = this.inNative;
    const sCaller = this.nativeCaller;
    this.nativeCaller = sIn;
    this.inNative = true;
    try { return fn(args, this) ?? EMPTY; } finally { this.inNative = sIn; this.nativeCaller = sCaller; }
  }

  callValue(fn, args) {
    if (fn instanceof LuaClosure) return this.callClosure(fn, args);
    if (typeof fn === 'function') return this.invokeNative(fn, args);
    const mm = this.metamethod(fn, '__call');
    if (mm !== undefined) return this.callValue(mm, [fn, ...args]);
    throw this.rtError(`attempt to call a ${luaTypeName(fn)} value`);
  }

  callClosure(cl, args) {
    if (this.depth >= this.maxDepth) throw this.rtError('stack overflow');
    const caller = this.frame;
    const savedIn = this.inNative;
    const savedCaller = this.nativeCaller;
    this.inNative = false;                  // 进入 Lua 函数：里面执行的是 Lua 代码
    this.nativeCaller = false;
    this.depth++;
    try {
      let proto = cl.proto;
      for (;;) {
        if (++this.steps > this.stepLimit) this.timeout();
        const fr = { cl, cells: new Array(proto.nslots), varargs: EMPTY, line: proto.line, parent: caller };
        const np = proto.params.length;
        for (let i = 0; i < np; i++) fr.cells[i] = { v: args[i] };
        if (proto.isVararg) fr.varargs = args.length > np ? args.slice(np) : EMPTY;
        this.frame = fr;
        const sig = this.execBlock(proto.body, fr);
        if (sig === undefined) return EMPTY;
        if (sig.type === 'return') return sig.values;
        if (sig.type === 'tail') {
          if (sig.fn instanceof LuaClosure) { cl = sig.fn; proto = cl.proto; args = sig.args; continue; }
          if (typeof sig.fn === 'function') return this.invokeNative(sig.fn, sig.args);      // 尾调用原生函数：调用方仍是这个 Lua 函数
          return this.callValue(sig.fn, sig.args);
        }
        return EMPTY;           // goto / break 不会逃出函数（语法阶段已保证）
      }
    } finally {
      this.frame = caller;
      this.depth--;
      this.inNative = savedIn;
      this.nativeCaller = savedCaller;
    }
  }

  timeout() {
    throw new ScriptTimeout(`脚本在一次回调里执行了超过 ${this.stepLimit} 步（语句 + 调用），疑似死循环（真机遇到死循环会直接卡住）`);
  }

  /** 取全局函数（生命周期回调）；不存在返回 undefined */
  getGlobal(G, name) {
    if (G.meta === undefined) return G.get(name);
    return this.index(G, name);
  }

  // ─────────────────────────── 错误 ───────────────────────────

  /** 构造带「块名:行号:」前缀的运行时错误（msg 是 JS 字符串）。原生函数被原生函数直接调用时没有前缀（见 callValue） */
  rtError(msg) {
    const fr = this.frame;
    const where = fr && !(this.inNative && this.nativeCaller) ? `${fr.cl.proto.chunkName ?? fr.cl.G?.chunkName ?? 'main'}:${fr.line}: ` : '';
    return new LuaError(utf8Encode(where + msg), { frame: fr });
  }

  /** error(msg, level) 用：level=1 取调用 error 的函数的当前行，level=2 取它的调用者 … */
  whereOf(level) {
    if (level === 1 && this.inNative && this.nativeCaller) return '';
    let fr = this.frame;
    for (let i = 1; fr && i < level; i++) fr = fr.parent;
    return fr ? `${fr.cl.proto.chunkName ?? 'main'}:${fr.line}: ` : '';
  }

  describe(e) {
    if (!e) return '';
    switch (e.type) {
      case 'Name': return ` (${e.kind === 'global' ? 'global' : e.kind === 'upval' ? 'upvalue' : 'local'} '${utf8Decode(e.name)}')`;
      case 'Index': return e.key.type === 'String' ? ` (field '${utf8Decode(e.key.value)}')` : '';
      default: return '';                       // 调用结果、字面量等没有名字
    }
  }

  /** debug.traceback 风格的调用栈文本 */
  traceback(msg, level = 1, startFrame = this.frame) {
    const lines = [];
    let fr = startFrame;
    for (let i = 1; fr && i < level; i++) fr = fr.parent;
    for (; fr; fr = fr.parent) {
      const p = fr.cl.proto;
      const chunk = p.chunkName ?? 'main';
      const what = p.name === 'main chunk' ? 'main chunk' : p.name ? `function '${p.name}'` : `function <${chunk}:${p.line}>`;
      lines.push(`\t${chunk}:${fr.line}: in ${what}`);
    }
    const head = msg === undefined ? '' : `${msg}\n`;
    return `${head}stack traceback:\n${lines.join('\n')}`;
  }

  // ─────────────────────────── 元表 ───────────────────────────

  metatable(v) {
    if (v instanceof LuaTable) return v.meta;
    return undefined;           // 字符串的元表对 Lua 隐藏；宿主对象没有元表
  }

  metamethod(v, event) {
    const mt = this.metatable(v);
    return mt === undefined ? undefined : mt.get(event);
  }

  tostringValue(v) {
    if (v instanceof LuaTable && v.meta !== undefined) {
      const mm = v.meta.get('__tostring');
      if (mm !== undefined) {
        const r = this.callValue(mm, [v])[0];
        if (typeof r !== 'string') throw this.rtError("'__tostring' must return a string");
        return r;
      }
    }
    return tostr(v);
  }

  // ─────────────────────────── 索引 ───────────────────────────

  index(o, k, srcExpr) {
    if (o instanceof LuaTable) {
      const v = o.get(k);
      if (v !== undefined || o.meta === undefined) return v;
      const h = o.meta.get('__index');
      if (h === undefined) return undefined;
      if (typeof h === 'function' || h instanceof LuaClosure) return this.callValue(h, [o, k])[0];
      return this.index(h, k);
    }
    if (o instanceof Host) return o.index(k, this);
    if (typeof o === 'string') return this.stringLib === undefined ? undefined : this.stringLib.get(k);
    throw this.rtError(`attempt to index a ${luaTypeName(o)} value${this.describe(srcExpr)}`);
  }

  setIndex(o, k, v, srcExpr) {
    if (o instanceof LuaTable) {
      if (o.meta !== undefined && o.get(k) === undefined) {
        const h = o.meta.get('__newindex');
        if (h !== undefined) {
          if (typeof h === 'function' || h instanceof LuaClosure) { this.callValue(h, [o, k, v]); return; }
          this.setIndex(h, k, v); return;
        }
      }
      this.rawSet(o, k, v);
      return;
    }
    if (o instanceof Host) { o.newindex(k, v, this); return; }
    throw this.rtError(`attempt to index a ${luaTypeName(o)} value${this.describe(srcExpr)}`);
  }

  rawSet(t, k, v) {
    if (k === undefined || k === null) throw this.rtError('table index is nil');
    if (typeof k === 'number' && Number.isNaN(k)) throw this.rtError('table index is NaN');
    t.set(k, v);
  }

  // ─────────────────────────── 运算 ───────────────────────────

  arith(op, a, b, e) {
    let x = a, y = b;
    if (typeof x === 'string') { const n = str2num(x); if (n !== undefined) x = n; }
    if (typeof y === 'string') { const n = str2num(y); if (n !== undefined) y = n; }
    const nx = typeof x === 'bigint' || typeof x === 'number';
    const ny = typeof y === 'bigint' || typeof y === 'number';
    if (nx && ny) {
      if (BITWISE.has(op)) return this.bitop(op, x, y);
      if (typeof x === 'bigint' && typeof y === 'bigint') {
        switch (op) {
          case '+': return wrap64(x + y);
          case '-': return wrap64(x - y);
          case '*': return wrap64(x * y);
          case '/': return Number(x) / Number(y);
          case '^': return Math.pow(Number(x), Number(y));
          case '//': {
            if (y === 0n) throw this.rtError("attempt to perform 'n//0'");
            let q = x / y;
            if (x % y !== 0n && (x < 0n) !== (y < 0n)) q -= 1n;
            return wrap64(q);
          }
          case '%': {
            if (y === 0n) throw this.rtError("attempt to perform 'n%0'");     // C 源码里写作 'n%%0'，格式化后是一个 %
            let r = x % y;
            if (r !== 0n && (r < 0n) !== (y < 0n)) r += y;
            return r;
          }
          default: break;
        }
      }
      const fx = Number(x), fy = Number(y);
      switch (op) {
        case '+': return fx + fy;
        case '-': return fx - fy;
        case '*': return fx * fy;
        case '/': return fx / fy;
        case '^': return Math.pow(fx, fy);
        case '//': return Math.floor(fx / fy);
        case '%': {
          let m = fx % fy;
          if (m > 0 ? fy < 0 : (m < 0 && fy !== m)) m += fy;
          return m;
        }
        default: break;
      }
    }
    // 元方法（先看第一个操作数，再看第二个）
    const ev = ARITH_EVENT[op];
    let mm = this.metamethod(a, ev);
    if (mm === undefined) mm = this.metamethod(b, ev);
    if (mm !== undefined) return this.callValue(mm, [a, b])[0];
    const bad = !nx ? a : b;
    const badExpr = e && (!nx ? e.left : e.right);
    if (BITWISE.has(op)) {
      if (typeof bad === 'string' || typeof bad === 'bigint' || typeof bad === 'number') throw this.rtError('number has no integer representation');
      throw this.rtError(`attempt to perform bitwise operation on a ${luaTypeName(bad)} value${this.describe(badExpr)}`);
    }
    throw this.rtError(`attempt to perform arithmetic on a ${luaTypeName(bad)} value${this.describe(badExpr)}`);
  }

  bitop(op, x, y) {
    const ix = toInteger(x), iy = toInteger(y);
    if (ix === undefined || iy === undefined) throw this.rtError('number has no integer representation');
    switch (op) {
      case '&': return wrap64(ix & iy);
      case '|': return wrap64(ix | iy);
      case '~': return wrap64(ix ^ iy);
      case '<<': return shiftLeft(ix, iy);
      case '>>': return shiftLeft(ix, -iy);
      default: throw new Error(`未实现的位运算 ${op}`);
    }
  }

  unm(v, e) {
    let x = v;
    if (typeof x === 'string') { const n = str2num(x); if (n !== undefined) x = n; }
    if (typeof x === 'bigint') return wrap64(-x);
    if (typeof x === 'number') return -x;
    const mm = this.metamethod(v, '__unm');
    if (mm !== undefined) return this.callValue(mm, [v, v])[0];
    throw this.rtError(`attempt to perform arithmetic on a ${luaTypeName(v)} value${this.describe(e)}`);
  }

  bnot(v, e) {
    let x = v;
    if (typeof x === 'string') { const n = str2num(x); if (n !== undefined) x = n; }
    if (typeof x === 'bigint' || typeof x === 'number') {
      const i = toInteger(x);
      if (i === undefined) throw this.rtError('number has no integer representation');
      return wrap64(~i);
    }
    const mm = this.metamethod(v, '__bnot');
    if (mm !== undefined) return this.callValue(mm, [v, v])[0];
    throw this.rtError(`attempt to perform bitwise operation on a ${luaTypeName(v)} value${this.describe(e)}`);
  }

  len(v, e) {
    if (typeof v === 'string') return BigInt(v.length);
    if (v instanceof LuaTable) {
      if (v.meta !== undefined) {
        const mm = v.meta.get('__len');
        if (mm !== undefined) return this.callValue(mm, [v])[0];
      }
      return BigInt(v.length());
    }
    const mm = this.metamethod(v, '__len');
    if (mm !== undefined) return this.callValue(mm, [v])[0];
    throw this.rtError(`attempt to get length of a ${luaTypeName(v)} value${this.describe(e)}`);
  }

  concat(a, b, e) {
    const sa = typeof a === 'string' || typeof a === 'bigint' || typeof a === 'number';
    const sb = typeof b === 'string' || typeof b === 'bigint' || typeof b === 'number';
    if (sa && sb) return tostr(a) + tostr(b);
    let mm = this.metamethod(a, '__concat');
    if (mm === undefined) mm = this.metamethod(b, '__concat');
    if (mm !== undefined) return this.callValue(mm, [a, b])[0];
    const badFirst = !sa;
    throw this.rtError(`attempt to concatenate a ${luaTypeName(badFirst ? a : b)} value${this.describe(e && (badFirst ? e.left : e.right))}`);
  }

  eq(a, b) {
    if (a === b) return true;
    const ta = typeof a, tb = typeof b;
    if ((ta === 'bigint' && tb === 'number') || (ta === 'number' && tb === 'bigint')) return a == b; // eslint-disable-line eqeqeq
    if (a === undefined || a === null) return b === undefined || b === null;
    if (a instanceof LuaTable && b instanceof LuaTable) {
      let mm = a.meta === undefined ? undefined : a.meta.get('__eq');
      if (mm === undefined && b.meta !== undefined) mm = b.meta.get('__eq');
      if (mm !== undefined) return isTruthy(this.callValue(mm, [a, b])[0]);
    }
    return false;
  }

  lt(a, b) {
    const ta = typeof a, tb = typeof b;
    if ((ta === 'bigint' || ta === 'number') && (tb === 'bigint' || tb === 'number')) return a < b;
    if (ta === 'string' && tb === 'string') return a < b;
    let mm = this.metamethod(a, '__lt');
    if (mm === undefined) mm = this.metamethod(b, '__lt');
    if (mm !== undefined) return isTruthy(this.callValue(mm, [a, b])[0]);
    throw this.compareError(a, b);
  }

  le(a, b) {
    const ta = typeof a, tb = typeof b;
    if ((ta === 'bigint' || ta === 'number') && (tb === 'bigint' || tb === 'number')) return a <= b;
    if (ta === 'string' && tb === 'string') return a <= b;
    let mm = this.metamethod(a, '__le');
    if (mm === undefined) mm = this.metamethod(b, '__le');
    if (mm !== undefined) return isTruthy(this.callValue(mm, [a, b])[0]);
    throw this.compareError(a, b);
  }

  compareError(a, b) {
    const t1 = luaTypeName(a), t2 = luaTypeName(b);
    return this.rtError(t1 === t2 ? `attempt to compare two ${t1} values` : `attempt to compare ${t1} with ${t2}`);
  }

  // ─────────────────────────── 语句 ───────────────────────────

  execBlock(stmts, fr) {
    const n = stmts.length;
    let i = 0;
    while (i < n) {
      const sig = this.execStmt(stmts[i], fr);
      if (sig !== undefined) {
        if (sig.type === 'goto') {
          const at = stmts.labels.get(sig.label);
          if (at !== undefined) { i = at + 1; if (++this.steps > this.stepLimit) this.timeout(); continue; }
        }
        return sig;
      }
      i++;
    }
    return undefined;
  }

  execStmt(s, fr) {
    if (++this.steps > this.stepLimit) this.timeout();
    fr.line = s.line;
    switch (s.type) {
      case 'Local': {
        const slots = s.slots;
        if (s.exprs.length === 0) { for (let i = 0; i < slots.length; i++) fr.cells[slots[i]] = { v: undefined }; return undefined; }
        if (slots.length === 1 && s.exprs.length === 1) { fr.cells[slots[0]] = { v: this.ev(s.exprs[0], fr) }; return undefined; }
        const vals = this.evList(s.exprs, fr);
        for (let i = 0; i < slots.length; i++) fr.cells[slots[i]] = { v: vals[i] };
        return undefined;
      }
      case 'LocalFunction': {
        const cell = { v: undefined };
        fr.cells[s.slot] = cell;
        cell.v = this.makeClosure(s.fn, fr);
        return undefined;
      }
      case 'Assign': this.execAssign(s, fr); return undefined;
      case 'CallStat': this.evMulti(s.call, fr); return undefined;
      case 'Do': return this.execBlock(s.body, fr);
      case 'While': {
        while (isTruthy(this.ev(s.cond, fr))) {
          const sig = this.execBlock(s.body, fr);
          if (sig !== undefined) { if (sig.type === 'break') break; return sig; }
          if (++this.steps > this.stepLimit) this.timeout();
        }
        return undefined;
      }
      case 'Repeat': {
        for (;;) {
          const sig = this.execBlock(s.body, fr);
          if (sig !== undefined) { if (sig.type === 'break') break; return sig; }
          if (isTruthy(this.ev(s.cond, fr))) break;
          if (++this.steps > this.stepLimit) this.timeout();
        }
        return undefined;
      }
      case 'If': {
        for (const c of s.clauses) {
          if (isTruthy(this.ev(c.cond, fr))) return this.execBlock(c.body, fr);
        }
        return s.orelse ? this.execBlock(s.orelse, fr) : undefined;
      }
      case 'NumFor': return this.execNumFor(s, fr);
      case 'GenFor': return this.execGenFor(s, fr);
      case 'Return': return this.execReturn(s, fr);
      case 'Break': return BREAK;
      case 'Goto': return s.sig ?? (s.sig = { type: 'goto', label: s.label });
      case 'Label': return undefined;
      default: throw new Error(`未实现的语句 ${s.type}`);
    }
  }

  execReturn(s, fr) {
    const ex = s.exprs;
    if (ex.length === 0) return { type: 'return', values: EMPTY };
    if (ex.length === 1) {
      const e = ex[0];
      if (e.type === 'Call') {
        const fn = this.ev(e.fn, fr);
        const args = this.evList(e.args, fr);
        fr.line = e.line;
        if (!this.callable(fn)) throw this.rtError(`attempt to call a ${luaTypeName(fn)} value${this.describe(e.fn)}`);
        return { type: 'tail', fn, args };
      }
      if (e.type === 'MethodCall') {
        const obj = this.ev(e.obj, fr);
        fr.line = e.line;
        const fn = this.index(obj, e.name, e.obj);
        const args = [obj, ...this.evList(e.args, fr)];
        if (!this.callable(fn)) throw this.rtError(`attempt to call a ${luaTypeName(fn)} value (method '${utf8Decode(e.name)}')`);
        return { type: 'tail', fn, args };
      }
      if (e.type === 'Vararg') return { type: 'return', values: fr.varargs };
      return { type: 'return', values: [this.ev(e, fr)] };
    }
    return { type: 'return', values: this.evList(ex, fr) };
  }

  execAssign(s, fr) {
    const targets = s.targets;
    if (targets.length === 1 && s.exprs.length === 1) {
      const tg = targets[0];
      if (tg.type === 'Name') {
        this.assignName(tg, this.ev(s.exprs[0], fr), fr);
      } else {
        const o = this.ev(tg.obj, fr);
        const k = this.ev(tg.key, fr);
        const v = this.ev(s.exprs[0], fr);
        fr.line = tg.line;
        this.setIndex(o, k, v, tg.obj);
      }
      return;
    }
    // 多重赋值：先求值所有目标的「表、键」，再求值右边，最后从右向左赋值
    const prepared = targets.map((tg) => (tg.type === 'Name' ? null : { o: this.ev(tg.obj, fr), k: this.ev(tg.key, fr) }));
    const vals = this.evList(s.exprs, fr);
    for (let i = targets.length - 1; i >= 0; i--) {
      const tg = targets[i];
      if (tg.type === 'Name') this.assignName(tg, vals[i], fr);
      else { fr.line = tg.line; this.setIndex(prepared[i].o, prepared[i].k, vals[i], tg.obj); }
    }
  }

  assignName(tg, v, fr) {
    switch (tg.kind) {
      case 'local': fr.cells[tg.slot].v = v; break;
      case 'upval': fr.cl.upcells[tg.index].v = v; break;
      default: {
        const G = fr.cl.G;
        if (G.meta === undefined) G.set(tg.name, v); else this.setIndex(G, tg.name, v);
      }
    }
  }

  execNumFor(s, fr) {
    let a = this.ev(s.start, fr);
    let b = this.ev(s.stop, fr);
    let c = s.step ? this.ev(s.step, fr) : 1n;
    const num = (v, what) => {
      const n = typeof v === 'string' ? str2num(v) : v;
      if (typeof n !== 'bigint' && typeof n !== 'number') throw this.rtError(`'for' ${what} must be a number`);
      return n;
    };
    a = num(a, 'initial value'); b = num(b, 'limit'); c = num(c, 'step');
    const slot = s.slot;
    if (typeof a === 'bigint' && typeof c === 'bigint') {
      if (c === 0n) throw this.rtError("'for' step is zero");
      let lim;
      if (typeof b === 'bigint') lim = b;
      else {
        if (Number.isNaN(b)) return undefined;
        const f = c > 0n ? Math.floor(b) : Math.ceil(b);
        if (f >= 9223372036854775807) { if (c < 0n) return undefined; lim = 9223372036854775807n; }
        else if (f <= -9223372036854775808) { if (c > 0n) return undefined; lim = -9223372036854775808n; }
        else lim = BigInt(f);
      }
      for (let i = a; c > 0n ? i <= lim : i >= lim; i += c) {
        fr.cells[slot] = { v: i };
        const sig = this.execBlock(s.body, fr);
        if (sig !== undefined) { if (sig.type === 'break') break; return sig; }
        if (++this.steps > this.stepLimit) this.timeout();
      }
      return undefined;
    }
    const fa = Number(a), fb = Number(b), fc = Number(c);
    if (fc === 0) throw this.rtError("'for' step is zero");
    for (let i = fa; fc > 0 ? i <= fb : i >= fb; i += fc) {
      fr.cells[slot] = { v: i };
      const sig = this.execBlock(s.body, fr);
      if (sig !== undefined) { if (sig.type === 'break') break; return sig; }
      if (++this.steps > this.stepLimit) this.timeout();
    }
    return undefined;
  }

  execGenFor(s, fr) {
    const init = this.evList(s.exprs, fr);
    const f = init[0], st = init[1];
    let ctl = init[2];
    const slots = s.slots;
    for (;;) {
      fr.line = s.line;
      if (!this.callable(f)) throw this.rtError(`attempt to call a ${luaTypeName(f)} value`);
      const rs = this.callValue(f, [st, ctl]);
      const first = rs[0];
      if (first === undefined || first === null) break;
      ctl = first;
      for (let i = 0; i < slots.length; i++) fr.cells[slots[i]] = { v: rs[i] };
      const sig = this.execBlock(s.body, fr);
      if (sig !== undefined) { if (sig.type === 'break') break; return sig; }
      if (++this.steps > this.stepLimit) this.timeout();
    }
    return undefined;
  }

  // ─────────────────────────── 表达式 ───────────────────────────

  callable(v) {
    return v instanceof LuaClosure || typeof v === 'function' || this.metamethod(v, '__call') !== undefined;
  }

  makeClosure(proto, fr) {
    const ups = proto.upvals;
    const cells = new Array(ups.length);
    for (let i = 0; i < ups.length; i++) {
      const u = ups[i];
      cells[i] = u.fromLocal ? fr.cells[u.index] : fr.cl.upcells[u.index];
    }
    if (proto.chunkName === undefined) proto.chunkName = fr.cl.proto.chunkName;
    return new LuaClosure(proto, cells, fr.cl.G);
  }

  evList(exprs, fr) {
    const n = exprs.length;
    if (n === 0) return EMPTY;
    if (n === 1) {
      const e = exprs[0];
      if (e.type === 'Call' || e.type === 'MethodCall' || e.type === 'Vararg') return this.evMulti(e, fr);
      return [this.ev(e, fr)];
    }
    const out = new Array(n);
    for (let i = 0; i < n - 1; i++) out[i] = this.ev(exprs[i], fr);
    const last = exprs[n - 1];
    if (last.type === 'Call' || last.type === 'MethodCall' || last.type === 'Vararg') {
      const rest = this.evMulti(last, fr);
      out.length = n - 1;
      for (let i = 0; i < rest.length; i++) out.push(rest[i]);
    } else out[n - 1] = this.ev(last, fr);
    return out;
  }

  /** 多值表达式（调用 / ...）→ 数组；其它表达式 → 单元素数组 */
  evMulti(e, fr) {
    switch (e.type) {
      case 'Call': {
        const fn = this.ev(e.fn, fr);
        const args = this.evList(e.args, fr);
        fr.line = e.line;
        if (fn instanceof LuaClosure) return this.callClosure(fn, args);
        if (typeof fn === 'function') return this.invokeNative(fn, args);
        if (!this.callable(fn)) throw this.rtError(`attempt to call a ${luaTypeName(fn)} value${this.describe(e.fn)}`);
        return this.callValue(fn, args);
      }
      case 'MethodCall': {
        const obj = this.ev(e.obj, fr);
        fr.line = e.line;
        const fn = this.index(obj, e.name, e.obj);
        const rest = this.evList(e.args, fr);              // 只读：可能是共享数组（EMPTY / 可变参数 / 别处的返回值）
        const args = new Array(rest.length + 1);
        args[0] = obj;
        for (let i = 0; i < rest.length; i++) args[i + 1] = rest[i];
        fr.line = e.line;
        if (fn instanceof LuaClosure) return this.callClosure(fn, args);
        if (typeof fn === 'function') return this.invokeNative(fn, args);
        if (!this.callable(fn)) throw this.rtError(`attempt to call a ${luaTypeName(fn)} value (method '${utf8Decode(e.name)}')`);
        return this.callValue(fn, args);
      }
      case 'Vararg': return fr.varargs;
      default: return [this.ev(e, fr)];
    }
  }

  ev(e, fr) {
    switch (e.type) {
      case 'Nil': return undefined;
      case 'True': return true;
      case 'False': return false;
      case 'Number': case 'String': return e.value;
      case 'Vararg': return fr.varargs[0];
      case 'Name':
        if (e.kind === 'local') return fr.cells[e.slot].v;
        if (e.kind === 'upval') return fr.cl.upcells[e.index].v;
        return this.getGlobal(fr.cl.G, e.name);
      case 'Index': {
        const o = this.ev(e.obj, fr);
        const k = this.ev(e.key, fr);
        fr.line = e.line;
        return this.index(o, k, e.obj);
      }
      case 'Call': case 'MethodCall': return this.evMulti(e, fr)[0];
      case 'Function': return this.makeClosure(e, fr);
      case 'Paren': return this.ev(e.expr, fr);
      case 'Table': return this.evTable(e, fr);
      case 'Unop': {
        const v = this.ev(e.operand, fr);
        fr.line = e.line;
        switch (e.op) {
          case 'not': return !isTruthy(v);
          case '-': return typeof v === 'bigint' ? wrap64(-v) : typeof v === 'number' ? -v : this.unm(v, e.operand);
          case '#': return this.len(v, e.operand);
          default: return this.bnot(v, e.operand);
        }
      }
      case 'Binop': return this.evBinop(e, fr);
      default: throw new Error(`未实现的表达式 ${e.type}`);
    }
  }

  evBinop(e, fr) {
    const op = e.op;
    if (op === 'and') { const l = this.ev(e.left, fr); return isTruthy(l) ? this.ev(e.right, fr) : l; }
    if (op === 'or') { const l = this.ev(e.left, fr); return isTruthy(l) ? l : this.ev(e.right, fr); }
    const a = this.ev(e.left, fr);
    const b = this.ev(e.right, fr);
    fr.line = e.line;
    switch (op) {
      case '==': return this.eq(a, b);
      case '~=': return !this.eq(a, b);
      case '<': return this.lt(a, b);
      case '<=': return this.le(a, b);
      case '>': return this.lt(b, a);
      case '>=': return this.le(b, a);
      case '..': return this.concat(a, b, e);
      case '+':
        if (typeof a === 'number' && typeof b === 'number') return a + b;
        if (typeof a === 'bigint' && typeof b === 'bigint') return wrap64(a + b);
        return this.arith(op, a, b, e);
      case '-':
        if (typeof a === 'number' && typeof b === 'number') return a - b;
        if (typeof a === 'bigint' && typeof b === 'bigint') return wrap64(a - b);
        return this.arith(op, a, b, e);
      case '*':
        if (typeof a === 'number' && typeof b === 'number') return a * b;
        return this.arith(op, a, b, e);
      default: return this.arith(op, a, b, e);
    }
  }

  evTable(e, fr) {
    const t = new LuaTable();
    const items = e.items;
    const n = items.length;
    const pos = [];
    for (let i = 0; i < n; i++) {
      const it = items[i];
      if (it.key) {
        const k = this.ev(it.key, fr);
        const v = this.ev(it.value, fr);
        fr.line = e.line;
        this.rawSet(t, k, v);
      } else if (i === n - 1 && (it.value.type === 'Call' || it.value.type === 'MethodCall' || it.value.type === 'Vararg')) {
        const rest = this.evMulti(it.value, fr);
        for (let j = 0; j < rest.length; j++) pos.push(rest[j]);
      } else pos.push(this.ev(it.value, fr));
    }
    if (pos.length) {
      if (t.arr.length === 0 && t.hash.size === 0) {
        t.arr = pos;
        while (t.arr.length && t.arr[t.arr.length - 1] === undefined) t.arr.pop();
      } else for (let i = 0; i < pos.length; i++) t.set(BigInt(i + 1), pos[i]);
    }
    return t;
  }
}

/** 逻辑左移（n 为负则右移），64 位 */
function shiftLeft(x, n) {
  if (n <= -64n || n >= 64n) return 0n;
  if (n >= 0n) return wrap64(x << n);
  return wrap64(BigInt.asUintN(64, x) >> -n);
}
