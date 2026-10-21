/**
 * blocks.mjs —— compress.py 输出的数据文件解析与独立解码（check.mjs、to-gia.mjs 共用）
 * 与 render.lua 无关的 JS 实现：p64 / b64 / hex 三种编码，返回绘制顺序的块列表。
 */
export function parseData(text) {
  const num = (k) => { const m = new RegExp(`IMG\\.${k} = (\\d+)`).exec(text); return m ? Number(m[1]) : undefined; };
  const enc = /IMG\.ENC = "(\w+)"/.exec(text)?.[1];
  let data;
  const q = /IMG\.DATA = "([^"]*)"/.exec(text);
  if (q) data = q[1];
  else {
    const l = /IMG\.DATA = \[(=*)\[([\s\S]*?)\]\1\]/.exec(text);
    if (l) data = l[2];
  }
  if (data === undefined || !enc) throw new Error('数据文件里找不到 IMG.ENC / IMG.DATA');
  const layered = /IMG\.LAYERED = true/.test(text);
  // 形状（compress.py --shapes）：IMG.NSHP 个；IMG.SHPV = 2 时每个 15 个字符（含不透明度），没有 SHPV 的旧数据每个 14 个字符、不透明
  let shp = '';
  const sq = /IMG\.SHP = \[(=*)\[([\s\S]*?)\]\1\]/.exec(text);
  if (sq) shp = sq[2];
  return { N: num('N'), W: num('W') ?? num('N'), H: num('H') ?? num('N'), NBLK: num('NBLK'), NSHP: num('NSHP') ?? 0, SHPV: num('SHPV') ?? 1, enc, data, layered, shp };
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64V = Object.fromEntries([...B64].map((c, i) => [c.charCodeAt(0), i]));

/** 与 render.lua 无关的独立解码，返回 [{x,y,w,h,col}] */
export function decode({ enc, data, N }) {
  const out = [];
  if (enc === 'p64') {
    for (let o = 0; o + 11 <= data.length; o += 11) {
      const c = [...data.slice(o, o + 11)].map((ch) => ch.charCodeAt(0) - 48);
      const sx = c[0] * 64 + c[1], sy = c[2] * 64 + c[3];
      const wh = (c[4] * 64 + c[5]) * 64 + c[6];
      const col = ((c[7] * 64 + c[8]) * 64 + c[9]) * 64 + c[10];
      const w = Math.floor(wh / 512), h = wh % 512;
      out.push({ x: (sx - w) / 2, y: (sy - h) / 2, w, h, col });
    }
    return out;
  }
  const occ = new Array(N).fill(-1);
  let ci = 0, cj = 0;
  const step = enc === 'b64' ? 7 : 10;
  for (let o = 0; o + step <= data.length; o += step) {
    let w, h, col;
    if (enc === 'b64') {
      const v = [...data.slice(o, o + 7)].map((ch) => B64V[ch.charCodeAt(0)]);
      const a = ((v[0] * 64 + v[1]) * 64 + v[2]) * 64 + v[3];
      const b = (v[4] * 64 + v[5]) * 64 + v[6];
      w = a >> 16; h = (a >> 8) & 255; col = ((a & 255) << 16) | b;
    } else {
      const bytes = [0, 1, 2, 3, 4].map((k) => parseInt(data.slice(o + 2 * k, o + 2 * k + 2), 16));
      [w, h] = bytes; col = (bytes[2] << 16) | (bytes[3] << 8) | bytes[4];
    }
    for (;;) {
      while (ci < N && occ[ci] >= cj) ci++;
      if (ci < N) break;
      cj++; ci = 0;
    }
    out.push({ x: ci, y: cj, w, h, col });
    for (let xx = ci; xx < Math.min(N, ci + w); xx++) occ[xx] = Math.max(occ[xx], cj + h - 1);
    ci += w;
  }
  return out;
}


/** 形状串 → [{kind, cx, cy, hw, hh, thq, th(弧度，屏幕上顺时针), aq, alpha, fxq, fyq, col}]；单位 = 源像素。
 *  kind 1 椭圆（静态图片 100002）、2 旋转矩形（100001）、3 三角形（100003）、4 圆环（100006）、
 *  5 软边矩形（100001 + enableMask / enableSoftEdge / SetSoftEdgeWidth）。
 *  版本：v1 = 14 字符（没有不透明度）、v2 = 15 字符、v3 = 19 字符（v2 再插 fxq(2) fyq(2)，软边要用）。 */
export const SHP_STRIDE_BY_VER = { 1: 14, 2: 15, 3: 19 };
export function decodeShapes(shp, version = 2) {
  const stride = SHP_STRIDE_BY_VER[version];
  if (stride === undefined) throw new Error(`不认识的形状串版本 SHPV=${version}（支持 1 / 2 / 3）`);
  const out = [];
  for (let o = 0; o + stride <= shp.length; o += stride) {
    const c = [...shp.slice(o, o + stride)].map((ch) => ch.charCodeAt(0) - 48);
    const v = (a) => c[a] * 64 + c[a + 1];
    const kt = v(8), thq = kt % 512;
    const aq = version >= 2 ? c[10] : 32;
    const fxq = version >= 3 ? v(11) : 0, fyq = version >= 3 ? v(13) : 0;
    const k0 = version >= 3 ? 15 : version >= 2 ? 11 : 10;
    const col = ((c[k0] * 64 + c[k0 + 1]) * 64 + c[k0 + 2]) * 64 + c[k0 + 3];
    out.push({ kind: Math.floor(kt / 512) + 1, cx: v(0) / 4, cy: v(2) / 4, hw: v(4) / 4, hh: v(6) / 4,
      thq, th: (thq / 2) * Math.PI / 180, aq, alpha: aq / 32, fxq, fyq, col });
  }
  return out;
}

/** kind → 静态图片 ID。软边（kind 5）也走 100001（同一张矩形图），靠 enableMask + enableSoftEdge + SetSoftEdgeWidth 出羽化。
 *  【真机 28 / 29 号校准】软边只有 enableMask = true 时才生效；用 Pixel 模式（Percentage 不看宽度参数）；
 *  渐隐长度 L ≈ 0.82 × 宽度参数，宽度参数的单位是布局单位（不是源像素），水平 / 垂直独立相乘。
 *  软边要 fxq / fyq 两个字段，只有 SHPV = 3 的形状串才有；v2 遇到 kind 5 会在 allItems 里明确报错。 */
const IMAGE_ID = { 1: 100002, 2: 100001, 3: 100003, 4: 100006, 5: 100001 };
const SHAPE_NAME = { 1: '椭圆', 2: '旋转矩形', 3: '三角形', 4: '圆环', 5: '软边矩形' };

/** 数据文件 → 绘制顺序的控件列表（矩形再形状），都用中心 + 全尺寸表示，
 *  形状带 shape:{kind, img, rotDeg, thq, aq, fxq, fyq, soft}
 *  rotDeg 是千星 SetLocalRotation 的 z 角：按 Unity 约定逆时针为正，我们的 th 在屏幕上顺时针，所以取负【真机 2026-10-16 形状版关卡画面正确，方向已确认】
 *  遇到落不了盘的形状**直接抛错**：静默降级会生成「看起来成功、画面却不对」的关卡。 */
export function allItems(info) {
  const ver = info.SHPV ?? 1;
  const rects = decode(info).map((b) => ({ ...b }));
  const shapes = decodeShapes(info.shp || '', ver).map((s) => {
    const img = IMAGE_ID[s.kind];
    if (img === undefined) {
      const name = SHAPE_NAME[s.kind] ? `${SHAPE_NAME[s.kind]}（kind ${s.kind}）` : `kind ${s.kind}`;
      throw new Error(`形状 ${name} 还不能写进存档：只认 kind 1～5（椭圆 / 旋转矩形 / 三角形 / 圆环 / 软边）。`);
    }
    if (s.kind === 5 && ver < 3) {
      throw new Error(`软边形状（kind 5）要 fxq / fyq 两个字段，必须用 SHPV = 3 的形状串（每形状 ${SHP_STRIDE_BY_VER[3]} 字符）；`
        + `当前 SHPV = ${ver}（每形状 ${SHP_STRIDE_BY_VER[ver] ?? '?'} 字符），照矩形画会静默丢掉羽化变成硬边。`);
    }
    return {
      x: s.cx - s.hw, y: s.cy - s.hh, w: 2 * s.hw, h: 2 * s.hh, col: s.col,
      shape: { kind: s.kind, img, rotDeg: s.thq === 0 ? 0 : -(s.thq / 2), thq: s.thq, aq: s.aq,
        fxq: s.fxq, fyq: s.fyq, soft: s.kind === 5 },
    };
  });
  return [...rects, ...shapes];
}
