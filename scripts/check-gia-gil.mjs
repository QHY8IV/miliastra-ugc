#!/usr/bin/env node
/**
 * check-gia-gil.mjs —— .gil / .gia 的静态检查器（规则 GG***，见 scripts/lib/check.mjs 头部）
 *
 * 用法：
 *   node scripts/check-gia-gil.mjs --selftest              先确认检查器本身正常（离线，不需要样本）
 *   node scripts/check-gia-gil.mjs <文件>...                检查一个或多个 .gil/.gia
 *   cat x.gia | node scripts/check-gia-gil.mjs -            从标准输入读二进制（不落盘）
 *   node scripts/check-gia-gil.mjs --samples [目录]         对官方样本全量回归（默认 references/samples/；error 必须为 0）
 *
 * 退出码：0 没有 error / 1 有 error / 2 用法错误或自检失败。
 * 静态检查通过 ≠ 编辑器一定接受：真机导入检验流程见 references/formats/README.md。
 *
 * 依赖：Node >= 22，零第三方依赖。
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { GI_TYPE, buildContainer, parseContainer } from './lib/container.mjs';
import { WireError, parseFields, readVarint, writeVarint } from './lib/wire.mjs';
import { parseProto } from './lib/proto.mjs';
import { decodeMessage, encodeMessage } from './lib/codec.mjs';
import { decodeGi, encodeGi } from './lib/gifile.mjs';
import { checkGi } from './lib/check.mjs';
import { loadNodeTable } from './lib/nodes.mjs';
import { GraphError, buildGiaFromSpecs, compileGraph, decompileGraph } from './lib/graph.mjs';
import { buildUiTree, checkLuaAgainstTree, luaChildRefs } from './lib/ui.mjs';
import { listGraphs } from './lib/gil.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SAMPLES = join(HERE, '..', 'references', 'samples');

// ─────────────────────────── 输出 ───────────────────────────

function report(label, problems) {
  console.log(label);
  const order = { error: 0, warn: 1, info: 2 };
  for (const p of [...problems].filter((x) => x.level !== 'info').sort((a, b) => order[a.level] - order[b.level])) {
    console.log(`  ${p.level === 'error' ? '✗' : '⚠'} ${p.code} ${p.where ? `[${p.where}] ` : ''}${p.msg}`);
  }
  const e = problems.filter((p) => p.level === 'error').length;
  const w = problems.filter((p) => p.level === 'warn').length;
  console.log(e || w ? `  → ${e} 个 error，${w} 个 warn` : '  → 未发现问题');
  return e;
}

function checkBuffer(buf, label) {
  let file;
  try { file = decodeGi(buf, { lenient: true, path: label }); } catch (e) {
    return report(label, [{ level: 'error', code: e.code || 'GG003', msg: e.code ? e.message : `解析失败：${e.message}` }]);
  }
  return report(label, checkGi(file));
}

// ─────────────────────────── 自检 ───────────────────────────

const EXAMPLE = {
  name: '自检示例', kind: 'entity',
  nodes: [
    { id: 'e', node: '进入碰撞触发器时', pos: [0, 0], then: 'set' },
    { id: 'get', node: '获取自定义变量', T: 'Int', pos: [0, 220], in: { 目标实体: { from: 'e.进入者实体' }, 变量名: '积分' } },
    { id: 'add', node: '加法运算', T: 'Int', pos: [320, 220], in: { a: { from: 'get.变量值' }, b: 1 } },
    { id: 'set', node: '设置自定义变量', T: 'Int', pos: [640, 0], in: { 目标实体: { from: 'e.进入者实体' }, 变量名: '积分', 变量值: { from: 'add.结果' }, 是否触发事件: false }, then: 'del' },
    { id: 'del', node: '销毁实体', pos: [960, 0], in: { 目标实体: { from: 'e.触发器实体' } } },
  ],
};

function runSelftest() {
  const cases = [];
  const test = (name, fn) => cases.push({ name, fn });
  const j = (x) => JSON.stringify(x, (_, v) => (typeof v === 'bigint' ? `${v}n` : v));
  const eq = (a, b, msg) => { if (j(a) !== j(b)) throw new Error(`${msg || '不相等'}：${j(a)} ≠ ${j(b)}`); };
  const ok = (c, msg) => { if (!c) throw new Error(msg || '断言失败'); };
  const throws = (fn, re, msg) => { try { fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${msg}：报错内容不对：${e.message}`); return; } throw new Error(`${msg}：应当报错但没有`); };
  const table = loadNodeTable();

  // —— wire ——
  test('wire: varint 往返（含 2^63、2^64-1、负数按 64 位补码）', () => {
    for (const v of [0n, 1n, 127n, 128n, 300n, 2n ** 32n, 2n ** 53n, 2n ** 63n, 2n ** 64n - 1n]) {
      const [back, pos] = readVarint(writeVarint(v), 0);
      eq(back, v, `varint ${v}`); eq(pos, writeVarint(v).length, '长度');
    }
    eq(writeVarint(-1).length, 10, '负数 10 字节');
    eq(BigInt.asIntN(64, readVarint(writeVarint(-5), 0)[0]), -5n, '负数还原');
  });
  test('wire: 截断 / 越界 / group 都报错而不是返回半截结果', () => {
    throws(() => parseFields(Buffer.from([0x08, 0x80])), /截断/, '截断 varint');
    throws(() => parseFields(Buffer.from([0x12, 0x05, 0x01])), /越界/, '长度越界');
    throws(() => parseFields(Buffer.from([0x0b])), /不支持/, 'group');
  });

  // —— container ——
  test('container: 第三方文档给出的最小合法 .gia（24 字节）能通过', () => {
    const buf = Buffer.from('000000140000000100000326000000030000000000000679', 'hex');
    const c = parseContainer(buf);
    ok(c.ok, c.errors.join()); eq(c.typeName, 'gia', '类型'); eq(c.payload.length, 0, '空载荷');
  });
  test('container: 头标/尾标/长度字段被篡改会被发现', () => {
    const good = buildContainer({ type: 'gil', payload: Buffer.from([0x12, 0x00]) });
    ok(parseContainer(good).ok, '正常的应通过');
    const a = Buffer.from(good); a.writeUInt32BE(0x327, 8);
    ok(/0x0326/.test(parseContainer(a).errors.join()), '头标');
    const b = Buffer.from(good); b.writeUInt32BE(0x680, b.length - 4);
    ok(/0x0679/.test(parseContainer(b).errors.join()), '尾标');
    const c = Buffer.from(good); c.writeUInt32BE(9999, 0);
    ok(/长度字段/.test(parseContainer(c).errors.join()), '长度');
  });

  // —— proto / codec ——
  const PROTO = `syntax = "proto3";
    message Inner { string s = 1; sint32 z = 2; }
    message Outer {
      enum Color { RED = 0; GREEN = 1; BLUE = 2; }
      int32 a = 1; int64 b = 2; uint32 c = 3; bool d = 4; float f = 5; double g = 6;
      fixed32 h = 7; sfixed64 i = 8; string name = 9; bytes raw = 10;
      repeated int32 packed = 11; repeated string tags = 12; Inner inner = 13; repeated Inner list = 14;
      Color color = 15; oneof pick { int32 x = 20; string y = 21; }
    }`;
  const sch = parseProto({ text: PROTO, file: 'selftest' });
  test('codec: 各种标量/嵌套/打包/枚举 往返，且编码是规范的（字段号升序）', () => {
    const obj = {
      a: -7, b: '9007199254740993', c: 4000000000, d: true, f: 1.5, g: -2.25, h: 123456, i: -99, name: '千星奇域', raw: '0x00ff10',
      packed: [1, 2, 300, -1], tags: ['甲', '乙'], inner: { s: 'x', z: -3 }, list: [{ s: 'p' }, { z: 5 }], color: 'BLUE', y: 'hi',
    };
    const bytes = encodeMessage(sch, 'Outer', obj);
    const back = decodeMessage(sch, 'Outer', bytes);
    eq(back, obj, '往返');
    const fns = parseFields(bytes).map((f) => f.fn);
    eq(fns, [...fns].sort((x, y) => x - y), '字段号升序');
  });
  test('codec: 未知字段不丢（含猜测模式的嵌套结构），编码后字节完全一致', () => {
    const inner = Buffer.concat([Buffer.from([0x08, 0x05]), Buffer.from([0x12, 0x03]), Buffer.from('abc')]);
    const raw = Buffer.concat([Buffer.from([0x08, 0x01]), Buffer.from([0xa2, 0x06, inner.length]), inner, Buffer.from([0xb0, 0x06, 0x2a])]);
    const noSchema = parseProto({ text: 'syntax="proto3"; message Empty { }', file: 'e' });
    for (const guess of [false, true]) {
      const obj = decodeMessage(noSchema, 'Empty', raw, { guess });
      const back = encodeMessage(noSchema, 'Empty', JSON.parse(JSON.stringify(obj)));
      ok(Buffer.compare(back, raw) === 0, `未知字段往返（guess=${guess}）`);
    }
  });

  // —— 节点图 ——
  test('图: 示例编译 → 写成 .gia → 读回 → 检查器 0 error，规格不动点', () => {
    const { graph } = compileGraph(EXAMPLE, table, { guid: 0x40000001 });
    const { bundle } = buildGiaFromSpecs([EXAMPLE], table, { now: 1 });
    const file = decodeGi(encodeGi({ kind: 'gia', root: bundle }), { path: 'x.gia' });
    const errs = checkGi(file).filter((p) => p.level === 'error');
    eq(errs, [], '检查器不应有 error');
    const s1 = decompileGraph(graph, table).spec;
    const g2 = compileGraph(s1, table, { guid: 0x40000001 }).graph;
    eq(decompileGraph(g2, table).spec, s1, '反编译→编译→反编译 应不动');
    eq(listGraphs(file).length, 1, '文件里 1 张图');
  });
  test('图: 泛型节点选对 kernel（设置自定义变量 T=Int→22，T=Str→23）', () => {
    const mk = (T) => compileGraph({ name: 't', nodes: [{ id: 'a', node: '设置自定义变量', T, pos: [0, 0] }] }, table).graph.nodes[0].kernel_ref.runtime_id;
    eq([mk('Int'), mk('Str')], [22, 23], 'kernel');
  });
  test('图: 常见写错都有具体报错（找不到节点/引脚/类型不匹配/泛型没写 T/入口节点当目标）', () => {
    const c = (nodes) => () => compileGraph({ name: 't', nodes }, table);
    throws(c([{ id: 'a', node: '不存在的节点', pos: [0, 0] }]), /找不到服务器节点/, '未知节点');
    throws(c([{ id: 'a', node: '销毁实体', in: { 不存在的引脚: 1 } }]), /没有数据入引脚/, '未知引脚');
    throws(c([{ id: 'a', node: '设置自定义变量', pos: [0, 0] }]), /泛型节点/, '泛型没写 T');
    throws(c([{ id: 'e', node: '进入碰撞触发器时', then: 'e2' }, { id: 'e2', node: '进入碰撞触发器时' }]), /没有执行流入引脚/, '事件节点不能当执行流目标');
    throws(c([{ id: 'a', node: '进入碰撞触发器时' }, { id: 'b', node: '销毁实体', in: { 目标实体: { from: 'a.触发器序号' } } }]), /类型不匹配/, '数据类型不匹配');
    throws(c([{ id: 'a', node: '销毁实体', in: { 目标实体: 5 } }]), /实体类型的引脚不能写常量/, '实体不能写常量');
  });

  // —— 检查器 ——
  const goodFile = () => decodeGi(encodeGi({ kind: 'gia', root: buildGiaFromSpecs([EXAMPLE], table, { now: 1 }).bundle }), { path: 'x.gia' });
  test('检查器: 能发现 连向不存在节点(GG102) / 序号重复(GG101) / 引脚不存在(GG104) / GUID 重复(GG109)', () => {
    const codes = (f) => new Set(checkGi(f).map((p) => p.code));
    let f = goodFile();
    f.root.assets[0].graph_data.inner.graph.nodes[0].pins[0].connections[0].target_node_index = 99;
    ok(codes(f).has('GG102'), 'GG102');
    f = goodFile();
    f.root.assets[0].graph_data.inner.graph.nodes[1].index = 1;
    ok(codes(f).has('GG101'), 'GG101');
    f = goodFile();
    f.root.assets[0].graph_data.inner.graph.nodes[4].pins[0].shell_sig.index = 40;
    ok(codes(f).has('GG104'), 'GG104');
    f = goodFile();
    f.root.assets.push(structuredClone(f.root.assets[0]));
    ok(codes(f).has('GG109'), 'GG109');
  });

  // —— UI / Lua ——
  const TREE_GIL = () => {
    const bind = { f: 503, w: 'len', msg: [{ f: 74, w: 'len', msg: [{ f: 502, w: 'len', msg: [{ f: 1, w: 'len', msg: [{ f: 1, w: 'varint', v: 0x40000002 }] }] }] }] };
    const slot = (name, extra = []) => ({ name: { text: name }, slot_id: 2, slot_type: 15, _u: extra });
    return decodeGi(encodeGi({ kind: 'gil', root: {
      level_name: '自检', engine_version: '7.1.0',
      client_scripts: { scripts: [{ guid: 0x40000002, name: '演示', file_name: 'main.lua', source: 'local this = script.object\nlocal a = this:GetChild("按钮")\nlocal b = a:GetChild("图标")\r\n' }], field_2: 1 },
      ui: { nodes: [
        { guid: 0x40000001, children: [0x40000002], slots: [slot('根'), { slot_id: 63, slot_type: 83, _u: [bind] }, { slot_id: 68, slot_type: 91 }] },
        { guid: 0x40000002, parent: 0x40000001, children: [0x40000003], slots: [slot('按钮'), { slot_id: 63, slot_type: 83 }, { slot_id: 68, slot_type: 91 }] },
        { guid: 0x40000003, parent: 0x40000002, slots: [slot('图标'), { slot_id: 63, slot_type: 83 }, { slot_id: 73, slot_type: 96 }, { slot_id: 74, slot_type: 97 }] },
      ] },
    } }), { path: 'x.gil' });
  };
  test('UI: 控件树、控件类型、脚本绑定都能还原', () => {
    const f = TREE_GIL();
    const t = buildUiTree(f.root);
    eq(t.scripts.get(0x40000002), 0x40000001, '脚本绑定在「根」上');
    eq([...t.nodes.values()].map((n) => `${n.name}:${n.label}`), ['根:容器控件', '按钮:容器控件', '图标:图片控件'], '类型');
    eq(checkGi(f).filter((p) => p.level === 'error'), [], '该 .gil 不应有 error');
  });
  test('Lua: GetChild 链能提取（含 \\r\\n 换行），对不上控件树会精确指出哪一行哪一层', () => {
    const f = TREE_GIL();
    const t = buildUiTree(f.root);
    const src = f.root.client_scripts.scripts[0].source;
    eq(luaChildRefs(src).refs.map((r) => r.path.join('/')), ['按钮', '按钮/图标'], '提取');
    eq(checkLuaAgainstTree(t, 0x40000001, src), [], '正确的脚本应无问题');
    const bad = checkLuaAgainstTree(t, 0x40000001, src.replace('"图标"', '"图标X"'));
    ok(bad.length === 1 && /第 3 行/.test(bad[0].msg) && /图标X/.test(bad[0].msg), `应指出第 3 行：${JSON.stringify(bad)}`);
    eq(luaChildRefs('-- this:GetChild("注释里的")\nlocal this = script.object').refs, [], '注释里的不算');
  });

  // —— 官方样本（有则测）——
  const haveSamples = existsSync(SAMPLES) && readdirSync(SAMPLES).some((f) => /\.(gil|gia)$/.test(f));
  if (haveSamples) {
    test('样本: 全部官方 .gil/.gia 的容器合法、JSON 往返字节一致、检查器 0 个 error', () => {
      let n = 0;
      for (const f of readdirSync(SAMPLES).filter((x) => /\.(gil|gia)$/.test(x))) {
        const buf = readFileSync(join(SAMPLES, f));
        const file = decodeGi(buf, { path: f });
        const back = encodeGi({ kind: file.kind, root: JSON.parse(JSON.stringify(file.root)), version: file.container.version });
        ok(Buffer.compare(back, buf) === 0, `${f} JSON 往返不一致`);
        const errs = checkGi(file).filter((p) => p.level === 'error');
        ok(!errs.length, `${f} 报了 error：${errs[0]?.code} ${errs[0]?.msg}`);
        n++;
      }
      ok(n >= 40, `样本数量异常：${n}`);
    });
  }

  let pass = 0;
  for (const c of cases) {
    try { c.fn(); pass++; console.log(`  ✓ ${c.name}`); } catch (e) { console.log(`  ✗ ${c.name}\n      ${e.message}`); }
  }
  console.log(pass === cases.length ? `\n全部 ${cases.length} 项通过${haveSamples ? '' : '（未找到 references/samples/，跳过官方样本回归；先运行 fetch-official-samples.mjs）'}` : `\n通过 ${pass}/${cases.length}，检查器自检失败`);
  return pass === cases.length ? 0 : 2;
}

// ─────────────────────────── 入口 ───────────────────────────

async function main() {
  const args = process.argv.slice(2);
  if (!args.length || args.includes('--help') || args.includes('-h')) {
    console.log('用法：node scripts/check-gia-gil.mjs --selftest | <文件>... | - | --samples [目录]');
    return args.length ? 0 : 2;
  }
  if (args.includes('--selftest')) return runSelftest();
  if (args[0] === '--samples') {
    const dir = args[1] || SAMPLES;
    if (!existsSync(dir)) { console.error(`没有 ${dir}，先运行 node scripts/fetch-official-samples.mjs`); return 2; }
    let errs = 0, n = 0;
    for (const f of readdirSync(dir).filter((x) => /\.(gil|gia)$/.test(x))) {
      const file = decodeGi(readFileSync(join(dir, f)), { path: f, lenient: true });
      const e = checkGi(file).filter((p) => p.level === 'error');
      errs += e.length; n++;
      for (const p of e) console.log(`✗ ${f} ${p.code} ${p.msg}`);
    }
    console.log(`${n} 个官方样本，共 ${errs} 个 error（应为 0）`);
    return errs ? 1 : 0;
  }
  let total = 0;
  for (const a of args) {
    if (a === '-') {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      total += checkBuffer(Buffer.concat(chunks), '<stdin>');
    } else {
      if (!existsSync(a)) { console.error(`找不到文件：${a}`); return 2; }
      total += checkBuffer(readFileSync(a), a);
    }
  }
  return total ? 1 : 0;
}

main().then((c) => { process.exitCode = c; }, (e) => { console.error(`失败：${e.message}`); process.exitCode = 2; });
