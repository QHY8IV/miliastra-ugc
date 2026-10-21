#!/usr/bin/env node
/**
 * to-gil.mjs —— 把 compress.py 的块数据编进关卡存档 .gil：图片控件预先建好（位置、尺寸写在存档里），
 *               开局时一段很短的 Lua 只给每块填颜色。打开关卡即可，不用另外导入素材组、不用准备控件模板。
 *
 *   node scripts/rect-merge/to-gil.mjs <数据.lua> --seed <底关卡.gil> -o 输出.gil [--unit 2] [--margin 0] [--name 关卡名] [--force]
 *   --static 用老式布局「图片」控件，颜色写进存档、不要 Lua（底关卡里需要有一个老式图片控件作原型）；
 *            一个布局最多 1 万个控件【真机 2026-10-16】，只适合小图
 *   --default-layout-only 每个控件只留默认布局（省约 40% 体积；另外三份推测是其他平台的布局）。
 *            【真机 2026-10-16】脚本版 30,811 块 14.59 MiB 能打开、通过校验、显示正确（电脑端；其他平台未试）
 *   --margin 默认 0：2026-10-15 真机（1920×1440 截图）外扩 0 / 0.2 / 0.5 画面逐像素相同，没有拼缝
 *
 *   --seed  底关卡：需要有一个绑定了客户端脚本的容器控件，以及至少一个图片控件、一个容器控件作克隆原型。
 *           推荐官方教程 3.21「客户端脚本」示例（scripts/fetch-official-samples.mjs 可下载；mh47p30a87qo_客户端脚本.gil）。
 *           本工具会清空那个容器下原有的控件，并把它的脚本换成填色脚本；底关卡本身不改（必须 -o 新路径）。
 *
 * 为什么颜色不直接写进存档：新式客户端图片控件的颜色字段还没有证据——官方样本与本机关卡里的图片控件全是默认白色，
 *   protobuf 不写默认值，看不到颜色存在哪。位置 / 尺寸 / 锚点 / 轴心字段已用官方样本核对（skill 的 layoutOfNode）。
 *   找到颜色字段的办法：编辑器里只把一张图片改成红色、各存一份，`node scripts/gi.mjs diff A.gil B.gil`。
 *
 * 结构：容器（绑定脚本）→「批1…批K」容器（每批 64 块）→「块1…块N」图片控件。兄弟顺序 = 块数据顺序 = 绘制顺序（先画的在下面）。
 * 证据：【官方示例】控件结构与布局字段；【逆向推断】克隆方式（与死亡细胞复刻的 build.mjs 相同）；**未在真机验证**。
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseData, allItems } from './blocks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const lib = (p) => import(pathToFileURL(path.join(HERE, '..', 'lib', p)).href);
const { readGi, encodeGi, writeGi } = await lib('gifile.mjs');
const { setScriptSource } = await lib('gil.mjs');
const { buildUiTree, checkUiTree, layoutOfNode } = await lib('ui.mjs');

export const BATCH = 64;
const f32 = (v) => { const b = Buffer.alloc(4); b.writeFloatLE(v); return '0x' + b.toString('hex'); };
const first = (list, f) => list?.find((u) => u.f === f);
const nameOf = (n) => n.slots?.find((s) => s.name)?.name?.text;

function remapGuid(obj, from, to) {
  if (Array.isArray(obj)) { obj.forEach((o) => remapGuid(o, from, to)); return; }
  if (!obj || typeof obj !== 'object') return;
  for (const [k, v] of Object.entries(obj)) {
    if ((k === 'v' || k === 'guid') && v === from) obj[k] = to;
    else if (v && typeof v === 'object') remapGuid(v, from, to);
  }
}

/** 改写新式控件的布局槽 (1,12)：每一条平台 / 状态变体都写同一份 */
function setLayout(node, { x, y, w, h }, { defaultOnly = false } = {}) {
  const slot = node.slots.find((s) => !s.name && s.slot_id === 1 && s.slot_type === 12);
  if (!slot) throw new Error(`控件 ${nameOf(node)} 没有布局槽 (1,12)`);
  const holder = first(first(first(slot._u, 503)?.msg, 13)?.msg, 12);
  // 布局有一条默认 + 三条带编号的变体（推测是不同平台）；defaultOnly 时只留默认那条，每个控件省约 317 字节
  if (defaultOnly && holder?.msg) holder.msg = holder.msg.filter((u) => !(u.f === 501 && u.msg?.some((x) => x.f === 501 && x.w === 'varint')));
  const variants = holder?.msg?.filter((u) => u.f === 501) || [];
  if (!variants.length) throw new Error(`控件 ${nameOf(node)} 的布局槽里没有变体`);
  for (const v of variants) {
    const rect = first(v.msg, 502).msg;
    const put = (field, vals, keys = [501, 502]) => {
      const i = rect.findIndex((e) => e.f === field);
      const e = { f: field, w: 'len', msg: keys.map((k, j) => ({ f: k, w: 'i32', hex: f32(vals[j]) })) };
      if (i >= 0) rect[i] = e; else rect.push(e);
    };
    put(501, [1, 1, 1], [1, 2, 3]);
    put(502, [0.5, 0.5]);
    put(503, [0.5, 0.5]);
    put(504, [x, y]);
    put(505, [w, h]);
    put(506, [0.5, 0.5]);
    rect.sort((a, b) => a.f - b.f);
  }
}

/** 填色脚本：颜色串每块 4 个字符（字符 = 字节 − 48，24 位 RGB），顺序 = 「块」编号 */
export function paintLua(colors, nBatch, shapes = null, nRects = colors.length,
  { setImage = true, hide = null, extraLua = '', shpVersion = null, unit = 2 } = {}) {
  // extraLua：填完色之后追加执行的 Lua（形状校准关卡用）；里面可以用 blk(k) 取第 k 个块的控件
  // hide：'active' | 'visible' —— 填色期间把所有批容器 SetActive(false) / SetVisible(false)，最后一起恢复（探针：怀疑每次改控件都会触发整个画布重建）
  // shapes：[{ img, rotDeg, aq, fxq, fyq }]，对应第 nRects+1 … N 个块（每个形状都要有一项，顺序 = 块顺序）。
  //   img = 静态图片 ID（100001 矩形、100002 椭圆、100003 三角形、100006 圆环）；软边也用 100001，羽化靠 enableSoftEdge；
  //   rotDeg = SetLocalRotation 的 z 角（0.5° 的倍数，Unity 约定逆时针为正）；aq = 不透明度 × 32（1～32，缺省 32）；
  //   fxq / fyq = 软边的羽化宽度 × 2（0.5 源像素为单位，0～255；0 = 该方向不渐隐）。
  // shpVersion：形状串版本。null = 自动（有 fxq / fyq 非零的软边就 3，否则 2）。
  // unit：1 源像素 = 多少布局单位（SetSoftEdgeWidth 收布局单位，要按它换算）。
  // 编成字符串（v2 每块 3 个字符 / v3 每块 6 个字符）而不是 Lua 表构造器：构造器太多会让引擎编译失败（实测 8.9 万个无日志）。
  const hasShapes = !!(shapes && shapes.length);
  const shpVer = shpVersion ?? (hasShapes && shapes.some((s) => s.fxq || s.fyq) ? 3 : 2);
  if (shpVer !== 2 && shpVer !== 3) throw new Error(`不认识的形状串版本 ${shpVer}（只写 2 / 3）`);
  const longStr = (data) => {
    let lv = 0;
    while ((data + ']' + '='.repeat(lv) + ']').indexOf(']' + '='.repeat(lv) + ']') !== data.length) lv++;
    return `[${'='.repeat(lv)}[${data}]${'='.repeat(lv)}]`;
  };
  // 图片 ID → Lua 端 SHAPE_IMG 的序号；必须与下面生成的 SHAPE_IMG 表一致（0 矩形 1 椭圆 2 三角形 3 圆环）。
  // 注意序号 0 = 100001 = 沿用控件默认图，Lua 端 `if im ~= 0 then imgId = SHAPE_IMG[im] end` 会跳过换图，
  // 所以「拿不到 idx」绝不能落到 0，必须报错。
  const IMG_IDX = { 100001: 0, 100002: 1, 100003: 2, 100006: 3 };
  let shapeData = '';
  if (hasShapes) {
    if (nRects + shapes.length !== colors.length) throw new Error(`形状数 ${shapes.length} + 矩形数 ${nRects} ≠ 块数 ${colors.length}`);
    for (const s of shapes) {
      const zq = (Math.round(s.rotDeg * 2) % 720 + 720) % 720;
      // s.ellipse 是给「只给形状种类、不给图片 ID」的老调用留的兼容分支。两个都没有时必须报错：
      // 旧代码在这里退回 0，于是 Lua 端不换图 → 形状被静默画成不透明硬边矩形（软边就是这样被吞掉的）。
      const idx = s.img !== undefined ? IMG_IDX[s.img] : (s.ellipse ? 1 : undefined);
      if (idx === undefined) throw new Error(`形状缺少可用的静态图片 ID（img=${JSON.stringify(s.img)}，`
        + `ellipse=${JSON.stringify(s.ellipse)}）；已知 ${Object.keys(IMG_IDX).join(' / ')}。`);
      const aq = s.aq ?? 32, fxq = s.fxq ?? 0, fyq = s.fyq ?? 0;
      if (shpVer >= 3 && !(fxq >= 0 && fxq <= 255 && fyq >= 0 && fyq <= 255)) {
        throw new Error(`软边羽化宽度超出范围（fxq / fyq 取 0～255，即 0～127.5 源像素）：fxq=${fxq} fyq=${fyq}`);
      }
      if (shpVer >= 3) {
        // 6 字符 = 36 位：im(3) zq(10) aq(6) fxq(8) fyq(8)。v 约 1.6e10 > 2^31，
        // 必须用除法取位（JS 的 >> / & 会先把操作数截成 32 位，结果就错了）
        const v = ((idx * 1024 + zq) * 64 + aq) * 65536 + fxq * 256 + fyq;
        shapeData += [30, 24, 18, 12, 6, 0].map((sh) => String.fromCharCode(48 + (Math.floor(v / 2 ** sh) % 64))).join('');
      } else {
        const v = (idx * 1024 + zq) * 64 + aq;
        shapeData += [12, 6, 0].map((sh) => String.fromCharCode(48 + ((v >> sh) & 63))).join('');
      }
    }
  }
  const P = (v) => [18, 12, 6, 0].map((s) => String.fromCharCode(48 + ((v >> s) & 63))).join('');
  const data = colors.map(P).join('');
  const shapeDecl = !hasShapes ? '' : (shpVer >= 3
    ? `-- 形状：每个 6 个字符（字符 = 值 - 48），v = (((图片序号 * 1024 + z 角量化) * 64 + 不透明度 * 32) * 65536 + fxq * 256 + fyq)
-- 图片序号 0 矩形 1 椭圆 2 三角形 3 圆环（软边也用 0 = 100001 的矩形图，羽化靠 enableSoftEdge）；z 角以 0.5° 为单位、模 720
-- fxq / fyq = 羽化宽度 * 2（0.5 源像素为单位）；第 NR+1 … N 个块是形状，按顺序对应
local SHP = ${longStr(shapeData)}
local SHAPE_IMG = { [0] = 100001, [1] = 100002, [2] = 100003, [3] = 100006 }
`
    : `-- 形状：每个 3 个字符（字符 = 值 - 48），v = (图片序号 * 1024 + z 角量化) * 64 + 不透明度 * 32；图片序号 0 矩形 1 椭圆 2 三角形 3 圆环；z 角以 0.5° 为单位、模 720；第 NR+1 … N 个块是形状，按顺序对应
local SHP = ${longStr(shapeData)}
local SHAPE_IMG = { [0] = 100001, [1] = 100002, [2] = 100003, [3] = 100006 }
`);
  const shapeLua = !hasShapes ? '' : (shpVer >= 3 ? `
                    if k > NR then
                        local o2 = (k - NR - 1) * 6
                        local sv = 0
                        for i = o2 + 1, o2 + 6 do sv = sv * 64 + (byte(SHP, i) - 48) end
                        local fyq = sv % 256; sv = sv // 256
                        local fxq = sv % 256; sv = sv // 256
                        local aq = sv % 64; sv = sv // 64
                        local zq = sv % 1024; local im = sv // 1024
                        if im ~= 0 then imgId = SHAPE_IMG[im] end
                        if zq ~= 0 then rotZ = (zq <= 360 and zq or zq - 720) * 0.5 end
                        if aq < 32 then alpha = (aq * 255 + 16) // 32 end
                        if fxq > 0 or fyq > 0 then
                            -- 软边【真机 28 / 29 号校准】：enableMask 必须开，否则羽化不生效；用 Pixel 模式；
                            -- SetSoftEdgeWidth 收布局单位，而 fxq / fyq 是 0.5 源像素，所以要 * UNIT / 2
                            c.enableMask = true
                            c.enableSoftEdge = true
                            c.softEdgeMode = Enum.ImageMaskSoftEdgeMode.Pixel
                            c:SetSoftEdgeWidth(fxq * ${unit} / 2, fyq * ${unit} / 2)
                        end
                    end`
    : `
                    if k > NR then
                        local o2 = (k - NR - 1) * 3
                        local s1, s2, s3 = byte(SHP, o2 + 1, o2 + 3)
                        local sv = (s1 * 64 + s2) * 64 + s3 - 199728
                        local aq, zq, im = sv % 64, (sv // 64) % 1024, sv // 65536
                        if im ~= 0 then imgId = SHAPE_IMG[im] end
                        if zq ~= 0 then rotZ = (zq <= 360 and zq or zq - 720) * 0.5 end
                        if aq < 32 then alpha = (aq * 255 + 16) // 32 end
                    end`);
  const call = hide === 'active' ? 'SetActive' : 'SetVisible';
  const hideOn = hide ? `            group:${call}(false)
` : '';
  const hideOff = hide ? `    for b = 1, NBATCH do
        local group = groups[b]
        if group ~= nil then group:${call}(true) end
    end
` : '';
  return `-- 矩形合并绘制（静态版）：图片控件已预先建好在存档里，开局只填颜色${hasShapes ? '，形状块再换椭圆图 / 旋转' : ''}。由 miliastra-ugc scripts/rect-merge/to-gil.mjs 生成。
-- 颜色每块 4 个字符：字符 = 字节 - 48，24 位 RGB；常数 12782640 = 48 * (64^3 + 64^2 + 64 + 1)
local COLORS = ${longStr(data)}
${shapeDecl}local N, NR, NBATCH, BATCH = ${colors.length}, ${nRects}, ${nBatch}, ${BATCH}
local SET_IMAGE = ${setImage ? 'true' : 'false'}   -- 每块先设成纯色矩形图 100001（控件默认图片未确认时保险；确认默认就是纯色后可改 false 省一半写入）

function OnStart()
    local root = script.object
    local byte, t0 = string.byte, os.clock()
    local done, missing, byName = 0, 0, 0
    local groups = root:GetChildren()          -- 【真机】GetChildren 返回数组式表；按兄弟顺序取，比按名字逐个 GetChild 快得多
    local KIDS, ORD = {}, {}
    for b = 1, NBATCH do
        local group = groups[b]
        if group == nil or group.name ~= "批" .. b then group = root:GetChild("批" .. b) end
        groups[b] = group
        if group ~= nil then
            local first = (b - 1) * BATCH + 1
            local last = math.min(N, b * BATCH)
            local kids = group:GetChildren()
            -- 守卫：数量、首尾名字都对得上才按顺序取，否则这一批退回按名字找
            KIDS[b] = kids
            ORD[b] = #kids == last - first + 1 and kids[1].name == "块" .. first and kids[#kids].name == "块" .. last
${hideOn}        end
    end
    for b = 1, NBATCH do
        local group = groups[b]
        if group == nil then
            missing = missing + 1
        else
            local first = (b - 1) * BATCH + 1
            local last = math.min(N, b * BATCH)
            local kids, ordered = KIDS[b], ORD[b]
            if not ordered then byName = byName + 1 end
            for k = first, last do
                local c
                if ordered then c = kids[k - first + 1] else c = group:GetChild("块" .. k) end
                if c == nil then
                    missing = missing + 1
                else
                    local o = (k - 1) * 4
                    local c1, c2, c3, c4 = byte(COLORS, o + 1, o + 4)
                    local v = ((c1 * 64 + c2) * 64 + c3) * 64 + c4 - 12782640
                    local imgId, rotZ, alpha = 100001, 0, 255${shapeLua}
                    if imgId ~= 100001 or SET_IMAGE then c:SetImage(Enum.ImageSource.StaticReference, imgId) end
                    if rotZ ~= 0 then c:SetLocalRotation(0, 0, rotZ) end
                    c.imageColor = Color.FromRGBA(v // 65536, v // 256 % 256, v % 256, alpha)
                    done = done + 1
                end
            end
        end
    end
${hideOff}${extraLua ? `    local function blk(k) return KIDS[(k - 1) // BATCH + 1][(k - 1) % BATCH + 1] end
${extraLua}
` : ''}    print(string.format("[rect-merge] 填色 %d 块（缺 %d，按名字回退 %d 批），用时 %.2f s", done, missing, byName, os.clock() - t0))
end
`;
}

export const SIZE_LIMIT_MIB = 20;   // 【真机 2026-10-15】编辑器校验：「关卡存档大小达到上限: 25.06019, 上限20」
export const EDITOR_SIZE_FACTOR = 1.042;   // 同一关卡文件 24.05 MiB，编辑器记 25.06；只量过这一个点

export function buildGil(seedPath, blocks, { W, H, unit = 2, margin = 0, name = null, defaultOnly = false, shapes = null, nRects = blocks.length, setImage = true, hide = null, extraLua = '' } = {}) {
  const f = readGi(seedPath);
  const root = f.root;
  const nodes = root.ui?.nodes;
  if (!nodes) throw new Error('底关卡没有界面控件');
  const tree = buildUiTree(root);
  const bound = [...tree.nodes.values()].filter((n) => n.script != null);
  if (bound.length !== 1) throw new Error(`底关卡里绑定了客户端脚本的控件应恰好 1 个（找到 ${bound.length} 个）`);
  const owner = nodes.find((n) => n.guid === bound[0].guid);
  const kindOf = (g) => tree.nodes.get(g)?.label;
  const image = nodes.find((n) => kindOf(n.guid) === '图片控件');
  const container = nodes.find((n) => n.guid !== owner.guid && kindOf(n.guid) === '容器控件' && layoutOfNode(n));
  if (!image || !container) throw new Error('底关卡里要有至少一个图片控件和一个（非脚本宿主的）容器控件作克隆原型');
  const imageProto = structuredClone(image), containerProto = structuredClone(container);
  // 清空宿主下原有控件
  const removed = new Set();
  const descend = (n) => { for (const id of n.children || []) { removed.add(id); const c = nodes.find((v) => v.guid === id); if (c) descend(c); } };
  descend(owner);
  root.ui.nodes = nodes.filter((n) => !removed.has(n.guid));
  owner.children = [];
  let next = Math.max(0x40001000, ...root.ui.nodes.map((n) => n.guid + 1));
  const add = (proto, name, parent) => {
    const n = structuredClone(proto), guid = next++;
    remapGuid(n, proto.guid, guid);
    n.guid = guid; n.parent = parent.guid; n.children = [];
    n.slots.find((s) => s.name).name.text = name;
    parent.children.push(guid);
    root.ui.nodes.push(n);
    return n;
  };
  const nBatch = Math.ceil(blocks.length / BATCH);
  const full = { x: 0, y: 0, w: W * unit, h: H * unit };
  setLayout(owner, full);
  blocks.forEach((b, i) => {
    let group;
    if (i % BATCH === 0) { group = add(containerProto, '批' + (i / BATCH + 1), owner); setLayout(group, full, { defaultOnly }); }
    group = root.ui.nodes.find((n) => n.guid === owner.children[Math.floor(i / BATCH)]);
    const c = add(imageProto, '块' + (i + 1), group);
    setLayout(c, { x: (b.x + b.w / 2 - W / 2) * unit, y: (H / 2 - (b.y + b.h / 2)) * unit,
      w: b.w * unit + 2 * margin, h: b.h * unit + 2 * margin }, { defaultOnly });
  });
  setScriptSource(root, null, paintLua(blocks.map((b) => b.col), nBatch, shapes, nRects, { setImage, hide, extraLua, unit }));
  if (name) root.level_name = name;
  const issues = checkUiTree(buildUiTree(root));
  if (issues.some((p) => p.level === 'error')) throw new Error('控件树检查失败：' + JSON.stringify(issues.slice(0, 3)));
  return { bytes: encodeGi({ kind: 'gil', root, version: f.container?.version ?? 1 }), nBatch, issues };
}

/** 【真机 2026-10-16】校验「布局中开关控件数量超标，当前为44433，最大值为10000」：
 *  计数 = 布局里带槽 4 的控件（red.gil 的 15 个子控件里恰好 6 个带槽 4，44,427 + 6 = 44,433） */
export const LAYOUT_SWITCH_LIMIT = 10000;
const countsAsSwitch = (n) => n?.slots?.some((s) => s.slot_id === 4);

/**
 * 全静态：用老式布局「图片」控件（槽 (21,38)），位置、尺寸、颜色全部写进存档，不需要 Lua。
 * 颜色字段【真机对照 2026-10-15】：槽 (21,38) → 503 → #31 → #4，ARGB 打包；#31 #2 = 图片 ID（100001 纯色）。
 * 底关卡里要有至少一个老式图片控件（作原型），它所在的布局就是放图的地方；原型本身会被移除。
 * 叠放【真机 2026-10-16】：按「后面的兄弟在上」写的 3 块试验顺序不对，所以改成前景在前（与图片素材组 .gia 相同），
 *   并让 GUID、名字编号都和列表顺序一致（块1 = 最上面），不论编辑器按哪一个排序结果都相同。
 * 上限：一个布局最多 LAYOUT_SWITCH_LIMIT 个计数控件，超了能试玩但校验不过——大图用脚本版（不受这个上限）。
 */
export function buildStaticGil(seedPath, blocks, { W, H, unit = 2, margin = 0, name = null, defaultOnly = false, force = false } = {}) {
  const f = readGi(seedPath);
  const root = f.root;
  const nodes = root.ui?.nodes;
  if (!nodes) throw new Error('底关卡没有界面控件');
  const proto = nodes.find((n) => n.slots?.some((s) => s.slot_id === 21 && s.slot_type === 38));
  if (!proto) throw new Error('底关卡里没有老式「图片」控件（槽 21:38）可作原型：在编辑器的界面布局里放一个图片控件再存档');
  const layout = nodes.find((n) => n.guid === proto.parent);
  if (!layout) throw new Error('找不到原型图片控件所在的布局');
  const tpl = structuredClone(proto);
  root.ui.nodes = nodes.filter((n) => n.guid !== proto.guid);
  layout.children = (layout.children || []).filter((g) => g !== proto.guid);
  const byGuid = new Map(root.ui.nodes.map((n) => [n.guid, n]));
  let others = 0;
  const walk = (g) => { const n = byGuid.get(g); if (!n) return; if (countsAsSwitch(n)) others++; (n.children || []).forEach(walk); };
  layout.children.forEach(walk);
  const total = others + (countsAsSwitch(tpl) ? blocks.length : 0);
  if (total > LAYOUT_SWITCH_LIMIT && !force) {
    throw new Error(`布局里计数控件会有 ${total} 个（图片 ${blocks.length} + 原有 ${others}），超过编辑器上限 ${LAYOUT_SWITCH_LIMIT}：`
      + `降分辨率 / 提高 STD 到 ${LAYOUT_SWITCH_LIMIT - others} 块以内，或改用脚本版（不加 --static）。确要生成试玩用的超限关卡加 --force`);
  }
  let next = Math.max(0x40001000, ...root.ui.nodes.map((n) => n.guid + 1));
  // 前景在前：倒序遍历块数据（最后画的 = 最上面 = 列表第一个、GUID 最小、名字「块1」）
  [...blocks].reverse().forEach((b, i) => {
    const n = structuredClone(tpl), guid = next++;
    remapGuid(n, tpl.guid, guid);
    n.guid = guid; n.parent = layout.guid;
    n.slots.find((s) => s.name).name.text = '块' + (i + 1);
    setLayout(n, { x: (b.x + b.w / 2 - W / 2) * unit, y: (H / 2 - (b.y + b.h / 2)) * unit,
      w: b.w * unit + 2 * margin, h: b.h * unit + 2 * margin }, { defaultOnly });
    const img = first(first(n.slots.find((s) => s.slot_id === 21 && s.slot_type === 38)._u, 503).msg, 31).msg;
    const id = first(img, 2); if (id) id.v = 100001; else img.unshift({ f: 2, w: 'varint', v: 100001 });
    const argb = 0xff000000 + (b.col & 0xffffff);
    const c = first(img, 4); if (c) c.v = argb; else img.push({ f: 4, w: 'varint', v: argb });
    layout.children.push(guid);
    root.ui.nodes.push(n);
  });
  if (name) root.level_name = name;
  const issues = checkUiTree(buildUiTree(root));
  if (issues.some((p) => p.level === 'error')) throw new Error('控件树检查失败：' + JSON.stringify(issues.slice(0, 3)));
  return { bytes: encodeGi({ kind: 'gil', root, version: f.container?.version ?? 1 }), nBatch: 0, issues, layout: layout.guid, switches: total };
}

if (process.argv[1] && fs.realpathSync(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  const args = process.argv.slice(2);
  const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
  const valued = new Set(['-o', '--seed', '--unit', '--margin', '--name', '--hide']);
  const input = args.find((a, i) => !a.startsWith('-') && !valued.has(args[i - 1]));
  const out = opt('-o'), seed = opt('--seed');
  if (!input || !out || !seed) {
    console.log('用法：node scripts/rect-merge/to-gil.mjs <数据.lua> --seed <底关卡.gil> -o 输出.gil [--unit 2] [--margin 0] [--name 关卡名] [--default-layout-only] [--static] [--force]');
    process.exit(1);
  }
  if (path.resolve(out) === path.resolve(seed)) { console.error('-o 不能等于 --seed（不覆盖原关卡）'); process.exit(1); }
  const info = parseData(fs.readFileSync(input, 'utf8'));
  const blocks = allItems(info);        // 矩形再形状（绘制顺序）；形状用中心 + 全尺寸，带 shape:{img, rotDeg}
  const nRects = blocks.filter((b) => !b.shape).length;       // 矩形在前、形状在后
  const noRotate = args.includes('--no-rotate');                // 探针：形状当成它的包围盒矩形画，不换椭圆也不旋转
  const shapeList = noRotate ? [] : blocks.slice(nRects).map((b) => ({ img: b.shape.img, rotDeg: b.shape.rotDeg, aq: b.shape.aq ?? 32, fxq: b.shape.fxq ?? 0, fyq: b.shape.fyq ?? 0 }));
  const o = { W: info.W, H: info.H, unit: Number(opt('--unit', 2)), margin: Number(opt('--margin', 0)), name: opt('--name', null),
    defaultOnly: args.includes('--default-layout-only'), force: args.includes('--force'), shapes: shapeList, nRects, setImage: !args.includes('--no-set-image'), hide: opt('--hide', null) };
  if (shapeList.length && args.includes('--static')) { console.error('✗ 带旋转矩形 / 椭圆 / 软边的数据不能用 --static（换图、旋转、羽化都要靠脚本）'); process.exit(1); }
  let r;
  try { r = args.includes('--static') ? buildStaticGil(seed, blocks, o) : buildGil(seed, blocks, o); }
  catch (e) { console.error('✗ ' + e.message); process.exit(1); }
  writeGi(out, r.bytes, { force: args.includes('--force') });
  const back = readGi(out);
  const mib = r.bytes.length / 1048576, editor = mib * EDITOR_SIZE_FACTOR;
  console.log(`已写出 ${out}（${mib.toFixed(2)} MiB，编辑器约记 ${editor.toFixed(2)}；${blocks.length} 个图片控件${args.includes('--static') ? `，老式图片全静态，无脚本；布局计数控件 ${r.switches} / ${LAYOUT_SWITCH_LIMIT}` : `，${r.nBatch} 个批容器${shapeList.length ? `，其中 ${shapeList.length} 个形状${noRotate ? '（探针：不旋转不换椭圆）' : ''}` : ''}`}）`);
  if (editor > SIZE_LIMIT_MIB) console.log(`⚠ 估计超过编辑器校验上限 ${SIZE_LIMIT_MIB}：能试玩，但保存 / 发布时会报「关卡存档大小达到上限」。可加 --default-layout-only、提高 STD 或降低分辨率`);
  console.log(`回读：容器校验 ${back.container.ok ? '通过' : '失败'}；控件树检查 ${r.issues.length} 条提示`);
  console.log('⚠ 未在真机验证：先用小图试，确认显示、颜色与叠放，再逐级加大。');
}
