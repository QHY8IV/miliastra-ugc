/**
 * proto.mjs —— 极简 .proto（proto3 子集）解析器
 *
 * 只支持本技能的 schema 文件用得到的语法：
 *   message / enum（可嵌套）、字段（repeated / optional）、oneof、reserved、option、注释。
 *   不支持：map<>、extend、service、group、import 解析（import 语句被忽略）。
 *
 * 解析结果是一个 Schema：
 *   schema.messages : Map<全名, MessageDef>       全名形如 "PinInstance" 或 "TypedValue.InstanceTracker"
 *   schema.enums    : Map<全名, EnumDef>
 *   MessageDef.fields : Map<字段号, FieldDef>
 *   FieldDef = { number, name, type, repeated, optional, oneof, kind, ref }
 *     kind = 'scalar' | 'message' | 'enum'；ref 是解析后的 MessageDef / EnumDef（scalar 为 null）
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

const SCALARS = new Set([
  'double', 'float', 'int32', 'int64', 'uint32', 'uint64', 'sint32', 'sint64',
  'fixed32', 'fixed64', 'sfixed32', 'sfixed64', 'bool', 'string', 'bytes',
]);

export class ProtoError extends Error {}

// ─────────────────────────── 词法 ───────────────────────────

function tokenize(text, file) {
  const toks = [];
  let i = 0;
  let line = 1;
  const n = text.length;
  while (i < n) {
    const c = text[i];
    if (c === '\n') { line++; i++; continue; }
    if (/\s/.test(c)) { i++; continue; }
    if (c === '/' && text[i + 1] === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < n && !(text[i] === '*' && text[i + 1] === '/')) { if (text[i] === '\n') line++; i++; }
      i += 2;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === '\\') j++; j++; }
      toks.push({ t: 'str', v: text.slice(i + 1, j), line });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      let j = i + 1;
      while (j < n && /[A-Za-z0-9_.]/.test(text[j])) j++;
      toks.push({ t: 'id', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if (/[0-9-]/.test(c)) {
      let j = i + 1;
      while (j < n && /[0-9xXa-fA-F.]/.test(text[j])) j++;
      toks.push({ t: 'num', v: text.slice(i, j), line });
      i = j;
      continue;
    }
    if ('{}[]()<>=;,'.includes(c)) { toks.push({ t: 'p', v: c, line }); i++; continue; }
    throw new ProtoError(`${file}:${line}: 无法识别的字符 ${JSON.stringify(c)}`);
  }
  return toks;
}

// ─────────────────────────── 语法 ───────────────────────────

class Parser {
  constructor(toks, file, schema) { this.toks = toks; this.i = 0; this.file = file; this.schema = schema; }
  peek() { return this.toks[this.i]; }
  next() { return this.toks[this.i++]; }
  err(msg, tok = this.peek()) { return new ProtoError(`${this.file}:${tok ? tok.line : '末尾'}: ${msg}`); }
  isP(v) { const t = this.peek(); return t && t.t === 'p' && t.v === v; }
  isId(v) { const t = this.peek(); return t && t.t === 'id' && (v == null || t.v === v); }
  expectP(v) {
    const t = this.next();
    if (!t || t.t !== 'p' || t.v !== v) throw this.err(`应为 "${v}"`, t);
    return t;
  }
  expectId() {
    const t = this.next();
    if (!t || t.t !== 'id') throw this.err('应为标识符', t);
    return t.v;
  }
  skipStatement() { while (this.peek() && !this.isP(';')) { if (this.isP('{')) this.skipBlock(); else this.next(); } this.next(); }
  skipBlock() {
    this.expectP('{');
    let depth = 1;
    while (depth > 0 && this.peek()) { const t = this.next(); if (t.t === 'p' && t.v === '{') depth++; else if (t.t === 'p' && t.v === '}') depth--; }
  }
  skipOptions() { if (this.isP('[')) { while (this.peek() && !this.isP(']')) this.next(); this.next(); } }

  parseFile() {
    while (this.peek()) {
      if (this.isId('syntax') || this.isId('package') || this.isId('import') || this.isId('option')) this.skipStatement();
      else if (this.isId('message')) this.parseMessage(null);
      else if (this.isId('enum')) this.parseEnum(null);
      else if (this.isP(';')) this.next();
      else throw this.err(`顶层不认识的语句 "${this.peek().v}"`);
    }
  }

  parseEnum(parent) {
    this.next(); // enum
    const name = this.expectId();
    const fullName = parent ? `${parent.fullName}.${name}` : name;
    const def = { kind: 'enum', name, fullName, parent, values: new Map(), byNumber: new Map() };
    this.expectP('{');
    while (!this.isP('}')) {
      if (this.isId('option') || this.isId('reserved')) { this.skipStatement(); continue; }
      if (this.isP(';')) { this.next(); continue; }
      const vname = this.expectId();
      this.expectP('=');
      const num = Number(this.next().v);
      this.skipOptions();
      this.expectP(';');
      def.values.set(vname, num);
      if (!def.byNumber.has(num)) def.byNumber.set(num, vname);
    }
    this.expectP('}');
    this.schema.enums.set(fullName, def);
    if (parent) parent.nestedEnums.set(name, def);
    return def;
  }

  parseMessage(parent) {
    this.next(); // message
    const name = this.expectId();
    const fullName = parent ? `${parent.fullName}.${name}` : name;
    const def = {
      kind: 'message', name, fullName, parent, fields: new Map(), byName: new Map(),
      nestedMessages: new Map(), nestedEnums: new Map(),
    };
    this.expectP('{');
    while (!this.isP('}')) {
      if (this.isP(';')) { this.next(); continue; }
      if (this.isId('message')) { this.parseMessage(def); continue; }
      if (this.isId('enum')) { this.parseEnum(def); continue; }
      if (this.isId('option') || this.isId('reserved') || this.isId('extensions')) { this.skipStatement(); continue; }
      if (this.isId('oneof')) {
        this.next();
        const oname = this.expectId();
        this.expectP('{');
        while (!this.isP('}')) {
          if (this.isId('option')) { this.skipStatement(); continue; }
          this.parseField(def, oname);
        }
        this.expectP('}');
        continue;
      }
      this.parseField(def, null);
    }
    this.expectP('}');
    this.schema.messages.set(fullName, def);
    if (parent) parent.nestedMessages.set(name, def);
    return def;
  }

  parseField(msg, oneof) {
    let repeated = false;
    let optional = false;
    if (this.isId('repeated')) { this.next(); repeated = true; }
    else if (this.isId('optional')) { this.next(); optional = true; }
    if (this.isId('map')) throw this.err('不支持 map<>');
    const type = this.expectId();
    const name = this.expectId();
    this.expectP('=');
    const number = Number(this.next().v);
    this.skipOptions();
    this.expectP(';');
    if (!Number.isInteger(number) || number < 1) throw this.err(`字段 ${name} 的字段号非法`);
    if (msg.fields.has(number)) throw this.err(`消息 ${msg.fullName} 里字段号 ${number} 重复`);
    const f = { number, name, type, repeated, optional, oneof, kind: null, ref: null };
    msg.fields.set(number, f);
    msg.byName.set(name, f);
  }
}

// ─────────────────────────── 名字解析 ───────────────────────────

function lookup(schema, scope, dotted) {
  const parts = dotted.split('.');
  for (let s = scope; ; s = s.parent) {
    // 在 s 的作用域里找第一段
    const first = s
      ? (s.nestedMessages.get(parts[0]) || s.nestedEnums.get(parts[0]))
      : (schema.messages.get(parts[0]) || schema.enums.get(parts[0]));
    if (first) {
      let cur = first;
      for (let k = 1; k < parts.length && cur; k++) {
        cur = (cur.nestedMessages && cur.nestedMessages.get(parts[k])) || (cur.nestedEnums && cur.nestedEnums.get(parts[k]));
      }
      if (cur) return cur;
    }
    if (!s) return null;
  }
}

function resolveAll(schema) {
  for (const msg of schema.messages.values()) {
    for (const f of msg.fields.values()) {
      if (SCALARS.has(f.type)) { f.kind = 'scalar'; continue; }
      const ref = lookup(schema, msg, f.type);
      if (!ref) throw new ProtoError(`消息 ${msg.fullName} 的字段 ${f.name}：找不到类型 ${f.type}`);
      f.kind = ref.kind;
      f.ref = ref;
    }
  }
}

// ─────────────────────────── 对外 ───────────────────────────

/** 把一个或多个 .proto 文本合并解析成一个 Schema（共用一个全局命名空间） */
export function parseProto(sources) {
  const schema = { messages: new Map(), enums: new Map() };
  for (const { text, file } of Array.isArray(sources) ? sources : [sources]) {
    new Parser(tokenize(text, file || '<proto>'), file || '<proto>', schema).parseFile();
  }
  resolveAll(schema);
  return schema;
}

/** 从文件加载（Node 环境） */
export async function loadProtoFiles(paths) {
  const { readFileSync } = await import('node:fs');
  return parseProto(paths.map((file) => ({ file, text: readFileSync(file, 'utf8') })));
}

export const isScalarType = (t) => SCALARS.has(t);
