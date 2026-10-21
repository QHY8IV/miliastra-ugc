#!/usr/bin/env node
/**
 * to-gia.mjs —— 把 compress.py 的块数据写成「图片素材组」.gia（超限模式），导入编辑器后是静态图片，
 *               游戏里不需要 Lua 现场新建控件。
 *
 *   node scripts/rect-merge/to-gia.mjs <数据.lua> -o 输出.gia [--unit 2] [--margin 0.5] [--name 名字]
 *                                      [--mask] [--force]
 *
 *   --unit    每个源像素对应多少界面单位（默认 2：300×300 → 600×600）
 *   --margin  每块四边各外扩多少界面单位，防拼缝（默认 0.5；分层数据外扩只影响边缘半个单位）
 *   --mask    保留素材组遮罩（裁剪到图片范围）；默认关闭
 *   --classic 写成经典模式（顶层字段 4 = 1）；默认超限模式
 *
 * 字段依据【第三方】：1475505/Miliastra-toolbox-primitive-shape（MIT）的 gia_lua.py 读取器与 image_template.gia：
 *   素材组 = resource_class 61；子控件 GUID 在根内容的 #503（前景在前）；根没有 GIA 字段 4 = 超限模式；
 *   图片组件 #505[#502=38] → #503 → #31：#2 图片 ID（100001 矩形）、#4 颜色（ARGB 打包 uint32）；
 *   变换组件 #505[#502=12] → #503 → #13 → #12 → #501[平台]：#502 布局 {501 缩放, 502/503 锚点, 504 位置, 505 尺寸, 506 轴心, 508 旋转}；
 *   遮罩组件 #505[#502=56] → #503 → #47：#1 偏移、#2 尺寸、#4 启用。
 * 骨架 gia-skeleton.json 取自该仓库的 image_template.gia（根资产 + 第一个图片控件作原型）。
 *
 * ⚠ 未在真机验证：素材组能放多少张图片、几万张静态图片的导入与帧率、子控件顺序与叠放的对应，都要导入试验确认。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseData, decode, decodeShapes } from './blocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { readGi, encodeGi, writeGi } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'gifile.mjs')).href);

const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return '0x' + b.toString('hex'); };
const first = (list, f) => list.find((u) => u.f === f);
const all = (list, f) => list.filter((u) => u.f === f);
const contentOf = (asset) => first(first(asset._u, 19).msg, 1).msg;
const component = (content, type) => all(content, 505).find((c) => first(c.msg, 502)?.v === type);

function setVec(rect, field, values, keys = [501, 502]) {
  let e = first(rect, field);
  if (!e) { e = { f: field, w: 'len', msg: [] }; rect.push(e); }
  e.msg = keys.map((k, i) => ({ f: k, w: 'i32', hex: f32(values[i]) }));
}

function replaceVarint(node, from, to) {
  if (Array.isArray(node)) { node.forEach((n) => replaceVarint(n, from, to)); return; }
  if (!node || typeof node !== 'object') return;
  if (node.w === 'varint' && node.v === from) node.v = to;
  for (const v of Object.values(node)) if (v && typeof v === 'object') replaceVarint(v, from, to);
}

export function buildGia(blocks, { W, H, unit = 2, margin = 0.5, name = '矩形合并', mask = false, classic = false } = {}) {
  const skel = JSON.parse(fs.readFileSync(path.join(HERE, 'gia-skeleton.json'), 'utf8'));
  const root = structuredClone(skel.root);
  const rootGuid = root.identity.asset_guid;
  const protoGuid = skel.unit.identity.asset_guid;
  root.internal_name = name;
  root.reference_list = [];
  const rootContent = contentOf(root);
  const maskComp = component(rootContent, 56);
  if (maskComp) {
    const m = first(first(maskComp.msg, 503).msg, 47).msg;
    setVec(m, 1, [0, 0]);
    setVec(m, 2, [W * unit, H * unit]);
    const en = first(m, 4);
    if (en) en.v = mask ? 1 : 0;
  }
  const related = [];
  const guids = [];
  const base = 0x40100000;   // 与模板 GUID 区间错开
  blocks.forEach((b, i) => {
    const guid = base + i;
    const u = structuredClone(skel.unit);
    replaceVarint(u._u, protoGuid, guid);
    u.identity.asset_guid = guid;
    u.internal_name = `矩形#${i + 1}`;
    const content = contentOf(u);
    const parent = first(content, 504);
    if (parent) parent.v = rootGuid;
    // 图片：矩形 + 颜色
    const img = first(first(component(content, 38).msg, 503).msg, 31).msg;
    first(img, 2).v = 100001;
    const r = (b.col >> 16) & 255, g = (b.col >> 8) & 255, bb = b.col & 255;
    first(img, 4).v = ((255 << 24) >>> 0) + (r << 16) + (g << 8) + bb;
    // 变换：每个平台的布局都写同一份
    const cx = (b.x + b.w / 2 - W / 2) * unit, cy = (H / 2 - (b.y + b.h / 2)) * unit;
    const sw = b.w * unit + 2 * margin, sh = b.h * unit + 2 * margin;
    const platforms = all(first(first(first(component(content, 12).msg, 503).msg, 13).msg, 12).msg, 501);
    for (const p of platforms) {
      const rect = first(p.msg, 502).msg;
      setVec(rect, 501, [1, 1, 1], [1, 2, 3]);
      setVec(rect, 502, [0.5, 0.5]);
      setVec(rect, 503, [0.5, 0.5]);
      setVec(rect, 504, [cx, cy]);
      setVec(rect, 505, [sw, sh]);
      setVec(rect, 506, [0.5, 0.5]);
      const rot = rect.findIndex((e) => e.f === 508);
      if (rot >= 0) rect.splice(rot, 1);
    }
    related.push(u);
    guids.push(guid);
  });
  // 子控件列表前景在前：块列表是绘制顺序（先画的在下面），所以倒过来
  for (const guid of [...guids].reverse()) rootContent.push({ f: 503, w: 'varint', v: guid });
  for (const guid of guids) root.reference_list.push({ service_domain: 'DEFAULT', kind: 'UI', asset_guid: guid });
  const bundle = { assets: [root], export_info: skel.export_info, engine_version: skel.engine_version, related };
  // 经典模式 = 顶层字段 4 写 varint 1；省略 = 超限模式【第三方：convert_to_classic.py / convert_to_overlimit.py】
  if (classic) bundle._u = [{ f: 4, w: 'varint', v: 1 }];
  return encodeGi({ kind: 'gia', version: skel.version, root: bundle });
}

if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const input = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '-o' && !['--unit', '--margin', '--name'].includes(args[i - 1]) && a !== '-o');
  const out = opt('-o');
  if (!input || !out) {
    console.log('用法：node scripts/rect-merge/to-gia.mjs <数据.lua> -o 输出.gia [--unit 2] [--margin 0.5] [--name 名字] [--mask] [--classic] [--force]');
    process.exit(1);
  }
  const info = parseData(fs.readFileSync(input, 'utf8'));
  // .gia 素材组是静态图片、没有脚本：形状块要靠脚本换图（椭圆等）或设旋转，素材组表达不了。
  // 旧代码只取 decode()（矩形），形状被**静默丢掉**——输出的控件数比数据少，却不报任何错。这里改成明确报错。
  const nShapes = decodeShapes(info.shp || '', info.SHPV ?? 1).length;
  if (nShapes) {
    console.error(`✗ 数据里有 ${nShapes} 个形状块（椭圆 / 旋转矩形 / 三角形 / 圆环 / 软边）：.gia 素材组是静态图片、`);
    console.error('  没有脚本，换图和旋转都写不进去，形状会被丢掉。带形状的图请用 to-gil.mjs 编进关卡（脚本版），');
    console.error('  或重跑 compress.py 时用 --shape-kinds 只留矩形。');
    process.exit(1);
  }
  const blocks = decode(info);
  const bytes = buildGia(blocks, { W: info.W, H: info.H, unit: Number(opt('--unit', 2)), margin: Number(opt('--margin', 0.5)),
    name: opt('--name', path.basename(input).replace(/\.lua$/, '')), mask: args.includes('--mask'), classic: args.includes('--classic') });
  writeGi(out, bytes, { force: args.includes('--force') });
  const back = readGi(out);
  console.log(`已写出 ${out}（${bytes.length} 字节，${blocks.length} 个图片控件${info.layered ? '，分层：子控件按前景在前排列' : ''}）`);
  console.log(`回读：容器校验 ${back.container.ok ? '通过' : '失败'}，关联资产 ${back.root.related.length} 个`);
  console.log('⚠ 未在真机验证：先在测试关卡导入一个小图（几十到几百块）确认显示、颜色与叠放，再逐级加大。');
}
