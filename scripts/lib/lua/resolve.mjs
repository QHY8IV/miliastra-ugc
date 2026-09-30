/**
 * resolve.mjs —— 作用域解析：给 AST 标注变量槽位 / upvalue，并顺手收集 lint 信息
 *
 * 标注（解释器直接用）：
 *   Function   .nslots（局部槽总数，参数占 0..n-1）、.upvals[{fromLocal, index, name}]
 *   Name       .kind = 'local' | 'upval' | 'global'，.slot / .index
 *   Local      .slots[]     LocalFunction .slot     NumFor .slot     GenFor .slots[]
 * 每个「声明语句」各占一个槽（不复用）：循环体里的 local 每轮都是新变量，闭包因此各抓各的（与 Lua 一致）。
 *
 * lint 信息（lint.mjs 用）：
 *   globalReads / globalWrites : Map<名字, 行号[]>
 *   locals   : [{name, line, used, isParam, isLoopVar}]   —— 「声明后从未读取」= used=false
 */

export function resolve(ast) {
  const globalReads = new Map();
  const globalWrites = new Map();
  const locals = [];

  let fs = null;     // 当前函数作用域

  const note = (map, name, line) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(line);
  };

  const newFunc = (node) => ({ parent: fs, node, blocks: [], nslots: 0, upvals: [], upvalOf: new Map() });
  const push = () => fs.blocks.push(new Map());
  const pop = () => fs.blocks.pop();

  function declare(name, line, opts = {}) {
    const info = { name, slot: fs.nslots++, line, used: false, fs, ...opts };
    fs.blocks[fs.blocks.length - 1].set(name, info);
    locals.push(info);
    return info;
  }

  function findLocal(f, name) {
    for (let i = f.blocks.length - 1; i >= 0; i--) {
      const v = f.blocks[i].get(name);
      if (v) return v;
    }
    return null;
  }

  /** 在函数 f 里取得对变量 v（属于某个外层函数）的 upvalue 下标，必要时沿途登记 */
  function upvalIndex(f, v) {
    if (f.upvalOf.has(v)) return f.upvalOf.get(v);
    let entry;
    if (v.fs === f.parent) entry = { fromLocal: true, index: v.slot, name: v.name };
    else entry = { fromLocal: false, index: upvalIndex(f.parent, v), name: v.name };
    const idx = f.upvals.length;
    f.upvals.push(entry);
    f.upvalOf.set(v, idx);
    return idx;
  }

  /** 给 Name 节点标注；asRead=true 表示「读」 */
  function bindName(e, asRead) {
    const own = findLocal(fs, e.name);
    if (own) {
      e.kind = 'local'; e.slot = own.slot;
      if (asRead) own.used = true;
      return;
    }
    for (let f = fs.parent; f; f = f.parent) {
      const v = findLocal(f, e.name);
      if (v) {
        e.kind = 'upval'; e.index = upvalIndex(fs, v);
        if (asRead) v.used = true;
        return;
      }
    }
    e.kind = 'global';
    note(asRead ? globalReads : globalWrites, e.name, e.line);
  }

  function expr(e) {
    if (!e) return;
    switch (e.type) {
      case 'Name': bindName(e, true); break;
      case 'Index': expr(e.obj); expr(e.key); break;
      case 'Call': expr(e.fn); e.args.forEach(expr); break;
      case 'MethodCall': expr(e.obj); e.args.forEach(expr); break;
      case 'Binop': expr(e.left); expr(e.right); break;
      case 'Unop': expr(e.operand); break;
      case 'Paren': expr(e.expr); break;
      case 'Table': for (const it of e.items) { if (it.key) expr(it.key); expr(it.value); } break;
      case 'Function': func(e); break;
      default: break;
    }
  }

  function func(node) {
    const f = newFunc(node);
    fs = f;
    push();
    for (const pn of node.params) declare(pn, node.line, { isParam: true });
    stmts(node.body);
    pop();
    node.nslots = f.nslots;
    node.upvals = f.upvals;
    fs = f.parent;
  }

  function stmts(list) { for (const s of list) stmt(s); }
  function scoped(list) { push(); stmts(list); pop(); }

  function stmt(s) {
    switch (s.type) {
      case 'Local':
        s.exprs.forEach(expr);
        s.slots = s.names.map((n) => declare(n, s.line).slot);
        break;
      case 'LocalFunction': {
        const v = declare(s.name, s.line, { isFunc: true });
        s.slot = v.slot;
        func(s.fn);
        break;
      }
      case 'Assign':
        s.exprs.forEach(expr);
        for (const tg of s.targets) {
          if (tg.type === 'Name') bindName(tg, false);
          else { expr(tg.obj); expr(tg.key); }
        }
        break;
      case 'CallStat': expr(s.call); break;
      case 'Do': scoped(s.body); break;
      case 'While': expr(s.cond); scoped(s.body); break;
      case 'Repeat':
        push(); stmts(s.body); expr(s.cond); pop();        // 条件里看得见循环体的局部变量
        break;
      case 'If':
        for (const c of s.clauses) { expr(c.cond); scoped(c.body); }
        if (s.orelse) scoped(s.orelse);
        break;
      case 'NumFor':
        expr(s.start); expr(s.stop); expr(s.step);
        push(); s.slot = declare(s.name, s.line, { isLoopVar: true }).slot; stmts(s.body); pop();
        break;
      case 'GenFor':
        s.exprs.forEach(expr);
        push(); s.slots = s.names.map((n) => declare(n, s.line, { isLoopVar: true }).slot); stmts(s.body); pop();
        break;
      case 'Return': s.exprs.forEach(expr); break;
      default: break;     // Break / Goto / Label
    }
  }

  // 主块当成一个可变参数函数
  const main = { type: 'Function', params: [], isVararg: true, body: ast.body, line: 0, endLine: 0, name: 'main chunk' };
  func(main);
  ast.main = main;
  return { globalReads, globalWrites, locals };
}
