/**
 * parser.mjs —— Lua 5.3 语法分析（递归下降，结构照 lparser.c）
 *
 * 产出 AST（节点都带 line）。与真机加载期一致的静态检查：
 *   · goto / 标签：重复标签、找不到可见标签、跳进局部变量作用域（标签在块尾时算作已出作用域，与 5.3 一致）
 *   · break 必须在循环里
 *   · ... 只能出现在可变参数函数里
 *   · return 必须是块里的最后一条语句（违反时错误落在外层的 'end' expected 上，与 5.3 一致）
 * 错误信息：「块名:行号: 消息 near 'xxx'」，'end' expected 带「(to close 'function' at line N)」。
 *
 * AST 节点一览（type 字段）：
 *   语句  Local / LocalFunction / Assign / CallStat / Do / While / Repeat / If / NumFor / GenFor / Return / Break / Goto / Label
 *   表达式 Nil / True / False / Number / String / Vararg / Function / Table / Name / Index / Call / MethodCall / Binop / Unop / Paren
 * 块是语句数组，另带 .labels（Map：标签名 → 语句下标）供解释器做 goto。
 */

import { LuaSyntaxError } from './value.mjs';
import { lex, tokenText } from './lexer.mjs';

// 二元运算符优先级 [左, 右]（照 lparser.c 的 priority 表）
const PRI = {
  '+': [10, 10], '-': [10, 10], '*': [11, 11], '%': [11, 11], '^': [14, 13], '/': [11, 11], '//': [11, 11],
  '&': [6, 6], '|': [4, 4], '~': [5, 5], '<<': [7, 7], '>>': [7, 7], '..': [9, 8],
  '==': [3, 3], '<': [3, 3], '<=': [3, 3], '~=': [3, 3], '>': [3, 3], '>=': [3, 3],
  and: [2, 2], or: [1, 1],
};
const UNARY_PRI = 12;

export function parse(srcBytes, chunk = 'main') {
  const toks = lex(srcBytes, chunk);
  let p = 0;

  // 函数级状态：当前激活的局部变量名（goto 进作用域检查要用）、块栈、是否可变参数
  let fs = null;

  const peek = () => toks[p];
  const next = () => toks[p++];
  const fail = (msg, tok = peek()) => {
    throw new LuaSyntaxError(`${chunk}:${tok.line}: ${msg} near ${tokenText(tok)}`, tok.line);
  };
  const failAt = (msg, line) => { throw new LuaSyntaxError(`${chunk}:${line}: ${msg}`, line); };

  const isOp = (v) => peek().type === 'op' && peek().value === v;
  const isKw = (v) => peek().type === 'kw' && peek().value === v;
  const acceptOp = (v) => (isOp(v) ? (p++, true) : false);
  const acceptKw = (v) => (isKw(v) ? (p++, true) : false);
  const expectOp = (v) => { if (!acceptOp(v)) fail(`'${v}' expected`); };
  const expectKw = (v) => { if (!acceptKw(v)) fail(`'${v}' expected`); };
  const expectName = () => { if (peek().type !== 'name') fail('<name> expected'); return next().value; };

  /** check_match：'end' expected (to close 'function' at line N) */
  function checkMatch(what, who, whereLine) {
    if (acceptKw(what) || acceptOp(what)) return;
    if (whereLine === peek().line) fail(`'${what}' expected`);
    else fail(`'${what}' expected (to close '${who}' at line ${whereLine})`);
  }

  /** 块是否到此为止。withUntil=false 用于标签判断（repeat 的 until 不算块尾，因为条件里还看得见局部变量） */
  const blockFollow = (withUntil) => {
    const t = peek();
    if (t.type === 'eof') return true;
    if (t.type !== 'kw') return false;
    return t.value === 'else' || t.value === 'elseif' || t.value === 'end' || (withUntil && t.value === 'until');
  };

  // ─────────── 块 / 作用域 / goto ───────────

  const enterFunction = (isVararg) => {
    fs = { parent: fs, actvars: [], blocks: [], isVararg };
  };
  const leaveFunction = () => { fs = fs.parent; };

  const enterBlock = (isLoop) => {
    const blk = { isLoop, nact: fs.actvars.length, labels: new Map(), pending: [] };
    fs.blocks.push(blk);
    return blk;
  };
  const leaveBlock = () => {
    const blk = fs.blocks.pop();
    fs.actvars.length = blk.nact;
    const outer = fs.blocks[fs.blocks.length - 1];
    for (const g of blk.pending) {
      if (!outer) failAt(`no visible label '${g.label}' for <goto> at line ${g.line}`, g.line);
      g.nact = Math.min(g.nact, blk.nact);        // 离开这个块，块内声明的局部变量已不在作用域
      outer.pending.push(g);
    }
  };
  const declareLocal = (name) => { fs.actvars.push(name); };

  /** 语句序列直到块尾；返回数组（附 .labels） */
  function statements() {
    const list = [];
    list.labels = new Map();
    while (!blockFollow(true)) {
      if (isKw('return')) { list.push(retStat()); break; }
      const s = statement();
      if (!s) continue;
      if (s.type === 'Label') list.labels.set(s.name, list.length);
      list.push(s);
    }
    return list;
  }

  function block(isLoop = false) {
    enterBlock(isLoop);
    const list = statements();
    leaveBlock();
    return list;
  }

  function retStat() {
    const line = next().line;
    let exprs = [];
    if (!blockFollow(true) && !isOp(';')) exprs = exprList();
    acceptOp(';');
    return { type: 'Return', exprs, line };
  }

  function labelStat(line) {
    const name = expectName();
    expectOp('::');
    // 重复标签：同一函数里仍然可见的同名标签
    for (const b of fs.blocks) {
      const prev = b.labels.get(name);
      if (prev) failAt(`label '${name}' already defined on line ${prev.line}`, line);
    }
    const blk = fs.blocks[fs.blocks.length - 1];
    // 吃掉紧随其后的空语句与标签，看是不是块尾
    let q = p;
    while (toks[q].type === 'op' && (toks[q].value === ';' || toks[q].value === '::')) {
      if (toks[q].value === ';') q++;
      else q += 3;
    }
    const t = toks[q];
    const atEnd = t.type === 'eof' || (t.type === 'kw' && (t.value === 'else' || t.value === 'elseif' || t.value === 'end'));
    const lab = { line, nact: atEnd ? blk.nact : fs.actvars.length };
    blk.labels.set(name, lab);
    // 解决同块里之前的待定 goto
    blk.pending = blk.pending.filter((g) => {
      if (g.label !== name) return true;
      if (g.nact < lab.nact) {
        failAt(`<goto ${name}> at line ${g.line} jumps into the scope of local '${fs.actvars[g.nact]}'`, g.line);
      }
      return false;
    });
    return { type: 'Label', name, line };
  }

  function gotoStat(line) {
    const label = expectName();
    // 向回跳：标签已可见，一定合法
    for (let i = fs.blocks.length - 1; i >= 0; i--) {
      if (fs.blocks[i].labels.has(label)) return { type: 'Goto', label, line };
    }
    fs.blocks[fs.blocks.length - 1].pending.push({ label, line, nact: fs.actvars.length });
    return { type: 'Goto', label, line };
  }

  // ─────────── 语句 ───────────

  function statement() {
    const tok = peek();
    const line = tok.line;
    if (acceptOp(';')) return null;
    if (tok.type === 'op' && tok.value === '::') { next(); return labelStat(line); }
    if (tok.type === 'kw') {
      switch (tok.value) {
        case 'if': return ifStat(line);
        case 'while': {
          next();
          const cond = expr();
          expectKw('do');
          const body = block(true);
          checkMatch('end', 'while', line);
          return { type: 'While', cond, body, line };
        }
        case 'do': {
          next();
          const body = block();
          checkMatch('end', 'do', line);
          return { type: 'Do', body, line };
        }
        case 'for': return forStat(line);
        case 'repeat': {
          next();
          enterBlock(true);
          const body = statements();
          checkMatch('until', 'repeat', line);
          const cond = expr();             // 条件里看得见 body 的局部变量
          leaveBlock();
          return { type: 'Repeat', body, cond, line };
        }
        case 'function': return funcStat(line);
        case 'local': {
          next();
          if (acceptKw('function')) {
            const name = expectName();
            declareLocal(name);
            const fn = funcBody(false, line, name);
            return { type: 'LocalFunction', name, fn, line };
          }
          const names = [];
          do { names.push(expectName()); } while (acceptOp(','));
          const exprs = acceptOp('=') ? exprList() : [];
          for (const nm of names) declareLocal(nm);
          return { type: 'Local', names, exprs, line };
        }
        case 'return': return retStat();
        case 'break': {
          next();
          if (!fs.blocks.some((b) => b.isLoop)) failAt(`<break> at line ${line} not inside a loop`, line);
          return { type: 'Break', line };
        }
        case 'goto': next(); return gotoStat(line);
        default: break;
      }
    }
    return exprStat(line);
  }

  function ifStat(line) {
    next();
    const clauses = [];
    let cond = expr();
    expectKw('then');
    clauses.push({ cond, body: block() });
    let orelse = null;
    for (;;) {
      if (acceptKw('elseif')) {
        cond = expr();
        expectKw('then');
        clauses.push({ cond, body: block() });
      } else if (acceptKw('else')) {
        orelse = block();
        checkMatch('end', 'if', line);
        break;
      } else { checkMatch('end', 'if', line); break; }
    }
    return { type: 'If', clauses, orelse, line };
  }

  function forStat(line) {
    next();
    const n1 = expectName();
    if (isOp('=')) {
      next();
      const start = expr();
      expectOp(',');
      const stop = expr();
      const step = acceptOp(',') ? expr() : null;
      expectKw('do');
      enterBlock(true);
      declareLocal(n1);
      const body = statements();
      leaveBlock();
      checkMatch('end', 'for', line);
      return { type: 'NumFor', name: n1, start, stop, step, body, line };
    }
    if (isOp(',') || isKw('in')) {
      const names = [n1];
      while (acceptOp(',')) names.push(expectName());
      expectKw('in');
      const exprs = exprList();
      expectKw('do');
      enterBlock(true);
      for (const nm of names) declareLocal(nm);
      const body = statements();
      leaveBlock();
      checkMatch('end', 'for', line);
      return { type: 'GenFor', names, exprs, body, line };
    }
    return fail("'=' or 'in' expected");
  }

  function funcStat(line) {
    next();
    let target = { type: 'Name', name: expectName(), line };
    let fullName = target.name;
    let isMethod = false;
    while (isOp('.') || isOp(':')) {
      const colon = next().value === ':';
      const key = expectName();
      fullName += (colon ? ':' : '.') + key;
      target = { type: 'Index', obj: target, key: { type: 'String', value: key }, line };
      if (colon) { isMethod = true; break; }
    }
    const fn = funcBody(isMethod, line, fullName);
    return { type: 'Assign', targets: [target], exprs: [fn], line, isFunctionDecl: true };
  }

  function exprStat(line) {
    const e = suffixedExp();
    if (isOp('=') || isOp(',')) {
      const checkVar = (t) => { if (t.type !== 'Name' && t.type !== 'Index') fail('syntax error'); };
      const targets = [e];
      checkVar(e);
      while (acceptOp(',')) { const t = suffixedExp(); checkVar(t); targets.push(t); }
      expectOp('=');
      return { type: 'Assign', targets, exprs: exprList(), line };
    }
    if (e.type !== 'Call' && e.type !== 'MethodCall') fail('syntax error');
    return { type: 'CallStat', call: e, line };
  }

  // ─────────── 函数 ───────────

  function funcBody(isMethod, line, name) {
    expectOp('(');
    const params = isMethod ? ['self'] : [];
    let isVararg = false;
    if (!isOp(')')) {
      do {
        if (acceptOp('...')) { isVararg = true; break; }
        if (peek().type !== 'name') fail("<name> or '...' expected");
        params.push(next().value);
      } while (acceptOp(','));
    }
    expectOp(')');
    enterFunction(isVararg);
    enterBlock(false);
    for (const pn of params) declareLocal(pn);
    const body = statements();
    const endTok = peek();
    leaveBlock();
    leaveFunction();
    checkMatch('end', 'function', line);
    return { type: 'Function', params, isVararg, body, line, endLine: endTok.line, name };
  }

  // ─────────── 表达式 ───────────

  function exprList() {
    const list = [expr()];
    while (acceptOp(',')) list.push(expr());
    return list;
  }

  function callArgs() {
    const tok = peek();
    if (tok.type === 'str') { next(); return [{ type: 'String', value: tok.value, line: tok.line }]; }
    if (isOp('{')) return [tableCons()];
    if (isOp('(')) {
      next();
      const args = isOp(')') ? [] : exprList();
      checkMatch(')', '(', tok.line);
      return args;
    }
    return fail('function arguments expected');
  }

  function primaryExp() {
    const tok = peek();
    if (tok.type === 'name') { next(); return { type: 'Name', name: tok.value, line: tok.line }; }
    if (isOp('(')) {
      next();
      const inner = expr();
      checkMatch(')', '(', tok.line);
      return { type: 'Paren', expr: inner, line: tok.line };
    }
    return fail('unexpected symbol');
  }

  function suffixedExp() {
    const startLine = peek().line;
    let e = primaryExp();
    for (;;) {
      const nt = peek();
      if (nt.type === 'op') {
        if (nt.value === '.') { next(); const k = expectName(); e = { type: 'Index', obj: e, key: { type: 'String', value: k }, line: nt.line }; continue; }
        if (nt.value === '[') { next(); const k = expr(); expectOp(']'); e = { type: 'Index', obj: e, key: k, line: nt.line }; continue; }
        if (nt.value === ':') { next(); const name = expectName(); const args = callArgs(); e = { type: 'MethodCall', obj: e, name, args, line: startLine }; continue; }
        if (nt.value === '(' || nt.value === '{') { const args = callArgs(); e = { type: 'Call', fn: e, args, line: startLine }; continue; }
      } else if (nt.type === 'str') { const args = callArgs(); e = { type: 'Call', fn: e, args, line: startLine }; continue; }
      return e;
    }
  }

  function tableCons() {
    const line = peek().line;
    expectOp('{');
    const items = [];
    while (!isOp('}')) {
      if (isOp('[')) {
        next();
        const k = expr();
        expectOp(']');
        expectOp('=');
        items.push({ key: k, value: expr() });
      } else if (peek().type === 'name' && toks[p + 1].type === 'op' && toks[p + 1].value === '=') {
        const k = next().value;
        next();
        items.push({ key: { type: 'String', value: k }, value: expr() });
      } else items.push({ key: null, value: expr() });
      if (!acceptOp(',') && !acceptOp(';')) break;
    }
    checkMatch('}', '{', line);
    return { type: 'Table', items, line };
  }

  function simpleExp() {
    const tok = peek();
    switch (tok.type) {
      case 'num': next(); return { type: 'Number', value: tok.value, line: tok.line };
      case 'str': next(); return { type: 'String', value: tok.value, line: tok.line };
      case 'kw':
        if (tok.value === 'nil') { next(); return { type: 'Nil', line: tok.line }; }
        if (tok.value === 'true') { next(); return { type: 'True', line: tok.line }; }
        if (tok.value === 'false') { next(); return { type: 'False', line: tok.line }; }
        if (tok.value === 'function') { next(); return funcBody(false, tok.line, undefined); }
        break;
      case 'op':
        if (tok.value === '...') {
          if (!fs.isVararg) fail("cannot use '...' outside a vararg function");
          next();
          return { type: 'Vararg', line: tok.line };
        }
        if (tok.value === '{') return tableCons();
        break;
      default: break;
    }
    return suffixedExp();
  }

  function expr(limit = 0) {
    let left;
    const tok = peek();
    if ((tok.type === 'kw' && tok.value === 'not') || (tok.type === 'op' && (tok.value === '-' || tok.value === '#' || tok.value === '~'))) {
      next();
      left = { type: 'Unop', op: tok.value, operand: expr(UNARY_PRI), line: tok.line };
    } else left = simpleExp();
    for (;;) {
      const nt = peek();
      const op = (nt.type === 'op' || (nt.type === 'kw' && (nt.value === 'and' || nt.value === 'or'))) ? nt.value : null;
      if (!op || !PRI[op] || PRI[op][0] <= limit) break;
      next();
      const right = expr(PRI[op][1]);
      left = { type: 'Binop', op, left, right, line: nt.line };
    }
    return left;
  }

  // ─────────── 入口 ───────────
  enterFunction(true);                         // 主块是可变参数函数
  enterBlock(false);
  const body = statements();
  if (peek().type !== 'eof') fail("'<eof>' expected");
  leaveBlock();
  leaveFunction();
  return { type: 'Chunk', body, chunk };
}
