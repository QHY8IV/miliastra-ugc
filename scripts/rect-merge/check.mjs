#!/usr/bin/env node
/**
 * check.mjs —— 矩形合并绘制（scripts/rect-merge）的离线检查，零第三方 Node 依赖
 *
 *   node scripts/rect-merge/check.mjs --selftest
 *       需要 Python 3 + Pillow + numpy（与 compress.py 相同）。用合成图走完整条链路：
 *       compress.py 三种编码（p64 / b64 / hex）→ 用技能自带的 Lua 5.3 解释器跑 render.lua →
 *       逐像素核对；另外用独立的 JS 实现复算 V1.0 贪心，要求 compress.py 的块逐个相同。
 *
 *   node scripts/rect-merge/check.mjs render <render.lua> <数据.lua> [--budget 秒] [--measure]
 *       把 compress.py 的输出拼进 render.lua 的数据区，在离线解释器里跑 OnStart + 逐帧 OnUpdate。
 *       引擎接口用替身（InstantiateClientUIControl / SetSizeDelta / imageColor / SetActive …），
 *       替身带模拟时钟：新建 0.223 ms、改属性 0.012 ms（第三方工具包 README 的真机实测值）。
 *       核对：控件数 = 块数；N×N 每个像素恰好覆盖一次；每个像素颜色与数据解码结果一致；
 *             BIG_FIRST 时按面积从大到小建立；FRAME_BUDGET>0 时分多帧；再建一次全部复用；
 *             隐藏分组建立（分组数 = min(GROUPS, 块数)、每块建立时父级隐藏、建完每组都已显示）。
 *       另有「视觉预算」一组：焦点 JSON 的解析与报错口径、三条路径（纯矩形 / 分层 / 形状）的
 *       加权恒等（权重全 1 时与不加权逐字节相同）与效果（边缘带 MAE 降、其余升）。
 *       --measure 只输出脚本侧解释器步数与引擎调用次数（比较写法用，不是真机耗时）。
 *
 * 口径：全部是离线模拟，不代表千星奇域真机结果（控件上限、建立耗时、帧率都要真机确认）。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { runLua } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'lua', 'run.mjs')).href);

import { parseData, decode } from './blocks.mjs';
import { buildGia } from './to-gia.mjs';
import { buildGil, paintLua } from './to-gil.mjs';
import { allItems, decodeShapes } from './blocks.mjs';
import { layered, budgetMultiplier, tile } from './layered.mjs';
import { renderItems, maeOf, insideImage, shapeParams, coverageInto, fitShapes } from './shapes.mjs';
import { coverageRef } from './coverage-ref.mjs';
import { verifyGil } from './verify-gil.mjs';
const GI = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'gifile.mjs')).href);

function pixelChecksum(blocks, N, H = N) {
  const pix = new Int32Array(N * H).fill(-1);
  let overlap = 0;
  for (const b of blocks) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
    const k = y * N + x;
    if (pix[k] >= 0) overlap++;
    pix[k] = b.col;
  }
  let holes = 0, sum = 0;
  for (let k = 0; k < pix.length; k++) {
    if (pix[k] < 0) { holes++; continue; }
    sum = (sum + pix[k] * (k % 9973 + 1)) % 2147483647;
  }
  return { holes, overlap, sum };
}

// ───────────────────────── 引擎替身（Lua） ─────────────────────────
const STUBS = `
local CLOCK = 0
os.clock = function() return CLOCK end
local CALLS = 0
local created, alive = 0, {}
local ctrlMeta = {}
ctrlMeta.__index = ctrlMeta
local function tick(dt) CALLS = CALLS + 1; CLOCK = CLOCK + dt end
function ctrlMeta.SetAnchorMin(c) tick(0.000012) end
function ctrlMeta.SetAnchorMax(c) tick(0.000012) end
function ctrlMeta.SetPivot(c) tick(0.000012) end
function ctrlMeta.SetSizeDelta(c, w, h) c.w, c.h = w, h; tick(0.000012) end
function ctrlMeta.SetAnchoredPosition(c, x, y) c.x, c.y = x, y; tick(0.000012) end
function ctrlMeta.SetImage(c) tick(0.000012) end
function ctrlMeta.SetActive(c, v) c.active = v; tick(0.000012) end
function ctrlMeta.SetVisible(c, v) c.visible = v; tick(0.000012) end
local function makeControl(id)
  local raw = setmetatable({ id = id, active = true, isControl = true }, ctrlMeta)
  return setmetatable({}, {
    __index = raw,
    __newindex = function(t, k, v) if k == "imageType" or k == "imageColor" then tick(0.000012) end; raw[k] = v end,
  }), raw
end
game = {}
function game.GetUICanvasSize() return 1599, 899 end
function game.InstantiateClientUIControl(id, host)
  if id ~= 1073741931 then return nil end
  created = created + 1
  tick(0.000223)
  local c, raw = makeControl(created)
  -- 父级链：分组直接挂在宿主（script.object）下，块挂在分组下
  raw.parent = host
  raw.wrapper = c
  raw.bornHidden = (host ~= nil and host.isControl == true and host.active == false)
  alive[#alive + 1] = raw
  return c
end
function game.DestroyClientUIControl(c) c.dead = true end
Color = { FromRGBA = function(r, g, b, a) return { r = r, g = g, b = b, a = a } end }
Enum = { ImageSource = { StaticReference = 1 }, ImageType = { Stretch = 1 } }
printerr = print
script = { object = { alive = true }, EnableUpdate = function() tick(0) end }
`;

const VERIFY_DRIVER = `
OnStart()
local frames = 0
while (job or revealIdx > 0) and frames < 1000000 do OnUpdate(1/60); frames = frames + 1 end
local firstCreated, firstClock = created, CLOCK
local N = IMG.N
local unit = math.min(1599, 899) * RENDER.MAX_RATIO / N
local half = N * unit * 0.5
local mg = RENDER.MARGIN
local cover, holes, overlap, sum, active, orderOk, prevArea = {}, 0, 0, 0, 0, true, math.huge
local groupCount = #groups
local gset = {}
for i = 1, #groups do gset[groups[i]] = true end
local function isGroup(c) return gset[c.wrapper] == true end
local function parentHidden(c) local p = c.parent return p ~= nil and (p.dead or p.active == false) end
local bornHidden, shownGroups = 0, 0
for _, c in ipairs(alive) do
  if isGroup(c) then
    if c.active and c.visible and not c.dead then shownGroups = shownGroups + 1 end
  elseif c.active and not c.dead and not parentHidden(c) then
    active = active + 1
    if c.bornHidden then bornHidden = bornHidden + 1 end
    local w = math.floor((c.w - 2 * mg) / unit + 0.5)
    local h = math.floor((c.h - 2 * mg) / unit + 0.5)
    local x = math.floor((c.x + half) / unit - w * 0.5 + 0.5)
    local y = math.floor((half - c.y) / unit - h * 0.5 + 0.5)
    local col = c.imageColor.r * 65536 + c.imageColor.g * 256 + c.imageColor.b
    -- 画家顺序：alive 按创建顺序排列，后创建的盖在上面
    for yy = y, y + h - 1 do for xx = x, x + w - 1 do
      local k = yy * N + xx
      if cover[k] then overlap = overlap + 1 end
      cover[k] = col
    end end
    if w * h > prevArea then orderOk = false end
    prevArea = w * h
  end
end
for k = 0, N * N - 1 do
  local col = cover[k]
  if not col then holes = holes + 1 else sum = (sum + col * (k % 9973 + 1)) % 2147483647 end
end
print(string.format("RESULT active=%d created=%d frames=%d clock=%.3f holes=%d overlap=%d sum=%d bigFirst=%s",
  active, firstCreated, frames, firstClock, holes, overlap, sum, tostring(orderOk)))
print(string.format("GROUPS groups=%d bornHidden=%d shown=%d", groupCount, bornHidden, shownGroups))
local before = created
build()
local f2 = 0
while (job or revealIdx > 0) and f2 < 1000000 do OnUpdate(1/60); f2 = f2 + 1 end
local act2 = 0
for _, c in ipairs(alive) do
  if not isGroup(c) and c.active and not c.dead and not parentHidden(c) then act2 = act2 + 1 end
end
print(string.format("REBUILD created=%d active=%d", created - before, act2))
`;

const MEASURE_DRIVER = `
OnStart()
local frames = 0
while (job or revealIdx > 0) and frames < 1000000 do OnUpdate(1/60); frames = frames + 1 end
print(string.format("MEASURE calls=%d created=%d frames=%d groups=%d", CALLS, created, frames, #groups))
`;

function splice(renderSrc, dataSrc, budget) {
  const a = renderSrc.indexOf('local IMG = {}');
  const b = renderSrc.indexOf('-- ▲▲▲ 数据区结束 ▲▲▲');
  if (a < 0 || b < 0) throw new Error('render.lua 里找不到数据区标记（local IMG = {} … ▲▲▲ 数据区结束 ▲▲▲）');
  let s = renderSrc.slice(0, a) + dataSrc + '\n' + renderSrc.slice(b);
  if (budget !== undefined) s = s.replace(/FRAME_BUDGET = [0-9.]+/, 'FRAME_BUDGET = ' + budget);
  return s;
}

function runRender(renderPath, dataPath, { budget, measure } = {}) {
  const renderSrc = fs.readFileSync(renderPath, 'utf8');
  const dataSrc = fs.readFileSync(dataPath, 'utf8');
  const info = parseData(dataSrc);
  const src = splice(renderSrc, dataSrc, budget);
  const opts = { stepLimit: 4_000_000_000 };
  if (measure) {
    const r0 = runLua(STUBS + src.replace(/IMG\.NBLK = \d+/, 'IMG.NBLK = 0') + '\nOnStart()', opts);
    const r1 = runLua(STUBS + src + '\n' + MEASURE_DRIVER, opts);
    if (r1.error || r1.syntax || r1.timeout) throw new Error(`Lua 失败：${r1.error || r1.syntax || r1.timeout}\n${r1.out}`);
    const m = /MEASURE calls=(\d+) created=(\d+) frames=(\d+)/.exec(r1.out);
    return { steps: r1.interp.steps - r0.interp.steps, calls: Number(m[1]), created: Number(m[2]), frames: Number(m[3]) };
  }
  const blocks = decode(info);
  const expect = pixelChecksum(blocks, info.N, info.H);
  const res = runLua(STUBS + src + '\n' + VERIFY_DRIVER, opts);
  if (res.error || res.syntax || res.timeout) throw new Error(`Lua 失败：${res.error || res.syntax || res.timeout}\n${res.out}`);
  const m = /RESULT active=(\d+) created=(\d+) frames=(\d+) clock=([\d.]+) holes=(\d+) overlap=(\d+) sum=(\d+) bigFirst=(\w+)/.exec(res.out);
  const r = /REBUILD created=(\d+) active=(\d+)/.exec(res.out);
  const g = /GROUPS groups=(\d+) bornHidden=(\d+) shown=(\d+)/.exec(res.out);
  const usedBudget = Number(/FRAME_BUDGET = ([0-9.]+)/.exec(src)?.[1] ?? 0);
  const wantGroups = Number(/GROUPS = (\d+)/.exec(src)?.[1] ?? 0);
  const hideOn = /GROUP_HIDE = true/.test(src);
  const n = blocks.length;
  const L = info.layered;
  const wantK = hideOn && wantGroups > 0 ? Math.min(wantGroups, Math.max(1, n)) : 0;
  return [
    L ? ['数据本身（分层）：按绘制顺序叠完无空洞', expect.holes === 0, `空洞 ${expect.holes}，重叠像素 ${expect.overlap}`]
      : ['数据本身：解码后无空洞、无重叠', expect.holes === 0 && expect.overlap === 0, `空洞 ${expect.holes}，重叠 ${expect.overlap}`],
    ['块数与 IMG.NBLK 一致', info.NBLK === n, `${n} / ${info.NBLK}`],
    ['控件数 = 块数', Number(m[1]) === n, `${m[1]} / ${n}`],
    L ? ['画出来无空洞（分层数据允许重叠）', m[5] === '0', `空洞 ${m[5]}，重叠像素 ${m[6]}`]
      : ['画出来无空洞、无重叠', m[5] === '0' && m[6] === '0', `空洞 ${m[5]}，重叠 ${m[6]}`],
    [L ? '逐像素颜色与独立解码一致（按创建顺序叠放）' : '逐像素颜色与独立解码一致', Number(m[7]) === expect.sum, `${m[7]} / ${expect.sum}`],
    L ? ['分层数据按数据顺序建立（不重排）', true, '由上一项的叠放结果保证']
      : ['大块优先', m[8] === 'true', m[8]],
    [usedBudget > 0 ? '分帧建立' : '一次建完', usedBudget > 0 ? Number(m[3]) > 1 : Number(m[3]) === 0,
      `${m[3]} 帧，模拟建立耗时 ${m[4]} s`],
    ['隐藏分组建立、建完分帧显示',
      !!g && Number(g[1]) === wantK && Number(g[2]) === (hideOn ? n : 0) && Number(g[3]) === wantK,
      g ? `分组 ${g[1]}/${wantK}，建立期间隐藏 ${g[2]}/${n} 块，已显示 ${g[3]}/${g[1]} 组` : '无结果'],
    ['再建一次全部复用、不新建', !!r && r[1] === '0' && Number(r[2]) === n, r ? `新建 ${r[1]}，在用 ${r[2]}` : '无结果'],
  ];
}

/**
 * BUILD_MODE = "auto" 的两条分支：预估 ≤ SINGLE_SAFE_MS 时一次建完；
 * 把 SINGLE_SAFE_MS 压到 0 强制走分帧。判据只看帧数与控件数，不依赖具体常数。
 */
function autoModeChecks(render, dataPath) {
  const renderSrc = fs.readFileSync(render, 'utf8');
  const dataSrc = fs.readFileSync(dataPath, 'utf8');
  const n = decode(parseData(dataSrc)).length;
  const make = (repl) => {
    let s = splice(renderSrc, dataSrc);
    s = s.replace(/BUILD_MODE = "manual"/, 'BUILD_MODE = "auto"');
    if (repl) s = s.replace(repl[0], repl[1]);
    const r = runLua(STUBS + s + '\n' + MEASURE_DRIVER, { stepLimit: 4_000_000_000 });
    if (r.error || r.syntax || r.timeout) return { fail: r.error || r.syntax || r.timeout };
    const m = /MEASURE calls=(\d+) created=(\d+) frames=(\d+)/.exec(r.out);
    return m ? { created: Number(m[2]), frames: Number(m[3]) } : { fail: r.out };
  };
  const a = make(null);
  const b = make([/SINGLE_SAFE_MS = 10000/, 'SINGLE_SAFE_MS = 0']);
  return [
    ['auto：预估 ≤ SINGLE_SAFE_MS 时一次建完', !a.fail && a.frames === 0 && a.created >= n,
      a.fail || `${a.created} 控件（块 ${n} + 分组）/ ${a.frames} 帧`],
    ['auto：SINGLE_SAFE_MS = 0 时改为分帧', !b.fail && b.frames > 1,
      b.fail || `${b.created} 控件 / ${b.frames} 帧`],
  ];
}

/** 分层数据的画质不变式：每个矩形露出来的像素（它是最上层的那些）标准差 ≤ T，颜色 = 露出像素的均值；不允许完全被盖住的矩形 */
function layeredInvariant(blocks, raw, W, H, T) {
  const top = new Int32Array(W * H).fill(-1);
  blocks.forEach((b, i) => { for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) top[y * W + x] = i; });
  const acc = blocks.map(() => ({ n: 0, s: [0, 0, 0], q: [0, 0, 0] }));
  for (let k = 0; k < W * H; k++) {
    const a = acc[top[k]];
    a.n++;
    for (let c = 0; c < 3; c++) { const v = raw[k * 3 + c]; a.s[c] += v; a.q[c] += v * v; }
  }
  let hidden = 0, overStd = 0, badColor = 0, worst = 0;
  blocks.forEach((b, i) => {
    const a = acc[i];
    if (a.n === 0) { hidden++; return; }
    let m = 0;
    const col = [];
    for (let c = 0; c < 3; c++) {
      const mean = a.s[c] / a.n, v = a.q[c] / a.n - mean * mean;
      if (v > m) m = v;
      col.push(Math.round(mean));
    }
    const sd = m > 0 ? Math.sqrt(m) : 0;
    worst = Math.max(worst, sd);
    if (sd > T + 1e-6) overStd++;
    if (((col[0] << 16) | (col[1] << 8) | col[2]) !== b.col) badColor++;
  });
  return { hidden, overStd, badColor, worst };
}

/**
 * 独立算一张"边缘掩码"（不做 Python 侧的高斯模糊，阈值因此只是近似）。
 * 用途只有一个：给"边缘带的 MAE 是不是真的降了"提供一个**不依赖被测算术**的判据。
 */
function edgeMask(raw, W, H) {
  const n = W * H, L = new Float64Array(n), g = new Float64Array(n);
  for (let i = 0; i < n; i++) L[i] = 0.299 * raw[i * 3] + 0.587 * raw[i * 3 + 1] + 0.114 * raw[i * 3 + 2];
  const at = (x, y) => L[Math.min(H - 1, Math.max(0, y)) * W + Math.min(W - 1, Math.max(0, x))];
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const gx = (at(x + 1, y - 1) + 2 * at(x + 1, y) + at(x + 1, y + 1))
             - (at(x - 1, y - 1) + 2 * at(x - 1, y) + at(x - 1, y + 1));
    const gy = (at(x - 1, y + 1) + 2 * at(x, y + 1) + at(x + 1, y + 1))
             - (at(x - 1, y - 1) + 2 * at(x, y - 1) + at(x + 1, y - 1));
    g[y * W + x] = Math.sqrt(gx * gx + gy * gy) / 4;
  }
  const sorted = Array.from(g).sort((a, b) => a - b);
  const ref = Math.max(sorted[Math.floor(n * 0.95)], 24);
  const m = new Uint8Array(n);
  for (let i = 0; i < n; i++) m[i] = g[i] > 0.355 * ref ? 1 : 0;
  return m;
}

/** 把块铺成像素后，只统计掩码内（或掩码外）的平均绝对色差。 */
function maeWithMask(raw, blocks, W, H, mask, invert = false) {
  const img = new Uint8Array(W * H * 3);
  for (const b of blocks) {
    for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) {
      const o = (y * W + x) * 3;
      img[o] = (b.col >> 16) & 255; img[o + 1] = (b.col >> 8) & 255; img[o + 2] = b.col & 255;
    }
  }
  let s = 0, c = 0;
  for (let i = 0; i < W * H; i++) {
    if (Boolean(mask[i]) === Boolean(invert)) continue;
    for (let ch = 0; ch < 3; ch++) s += Math.abs(img[i * 3 + ch] - raw[i * 3 + ch]);
    c += 3;
  }
  return c ? s / c : 0;
}

function report(title, checks) {
  let ok = true;
  console.log(title);
  for (const [name, pass, detail, known] of checks) {
    if (known) { console.log(`  ! ${name}（${detail}）`); continue; }   // 已知缺陷：只报数，不计入失败
    console.log(`  ${pass ? '✓' : '✗'} ${name}（${detail}）`); ok &&= pass;
  }
  return ok;
}

// ───────────────────────── V1.0 贪心的独立 JS 实现（用于核对 compress.py） ─────────────────────────
function refGreedy(raw, W, H, T, maxSide) {
  const SW = W + 1, S = [], Q = [];
  for (let c = 0; c < 3; c++) {
    const s = new Float64Array(SW * (H + 1)), q = new Float64Array(SW * (H + 1));
    for (let y = 0; y < H; y++) {
      let row = 0, row2 = 0;
      for (let x = 0; x < W; x++) {
        const v = raw[(y * W + x) * 3 + c]; row += v; row2 += v * v;
        s[(y + 1) * SW + x + 1] = s[y * SW + x + 1] + row; q[(y + 1) * SW + x + 1] = q[y * SW + x + 1] + row2;
      }
    }
    S.push(s); Q.push(q);
  }
  const std = (x, y, w, h) => {
    const n = w * h, a = y * SW + x, b = a + w, cc = (y + h) * SW + x, d = cc + w;
    let m = 0;
    for (let ch = 0; ch < 3; ch++) {
      const mean = (S[ch][d] - S[ch][b] - S[ch][cc] + S[ch][a]) / n;
      const v = (Q[ch][d] - Q[ch][b] - Q[ch][cc] + Q[ch][a]) / n - mean * mean;
      if (v > 0) m = Math.max(m, Math.sqrt(v));
    }
    return m;
  };
  const occ = new Array(W).fill(-1), out = [];
  for (let j = 0; j < H; j++) {
    const maxh = Math.min(H - j, maxSide);
    for (let i = 0; i < W; i++) {
      if (occ[i] >= j) continue;
      let w = 1;
      while (i + w < W && w < maxSide && occ[i + w] < j && !(std(i, j, w + 1, 1) > T)) w++;
      const hc = (ww) => { let h = 1; while (h < maxh && !(std(i, j, ww, h + 1) > T)) h++; return h; };
      let bw = w, bh = hc(w);
      for (let w2 = w - 1; w2 >= 1; w2--) { const hh = hc(w2); if (w2 * hh > bw * bh) { bw = w2; bh = hh; } }
      for (let xx = i; xx < i + bw; xx++) occ[xx] = j + bh - 1;
      out.push([i, j, bw, bh]);
      i += bw - 1;
    }
  }
  return out;
}

// ───────────────────────── 素材组 GIA：编码 + 第三方读取器交叉核对 ─────────────────────────
const READER_DIR = path.join(HERE, '..', '..', 'references', 'community', '1475505__Miliastra-toolbox-primitive-shape');
function giaRoundTrip(blocks, info, tmp, tag, py, env) {
  const { readGi } = GI;
  const bytes = buildGia(blocks, { W: info.W, H: info.H, unit: 2, margin: 0.5, name: tag });
  const giaPath = path.join(tmp, `${tag}.gia`);
  fs.writeFileSync(giaPath, bytes);
  const back = readGi(giaPath);
  const checks = [['素材组 GIA：容器校验通过、关联资产数 = 块数', back.container.ok && back.root.related.length === blocks.length,
    `${back.root.related.length} / ${blocks.length}，${bytes.length} 字节`]];
  if (!fs.existsSync(path.join(READER_DIR, 'gia_lua.py'))) {
    checks.push(['素材组 GIA：第三方读取器交叉核对', true, '跳过：本机没有 references/community/1475505__…/gia_lua.py']);
    return checks;
  }
  const expect = path.join(tmp, `${tag}.expect.json`);
  fs.writeFileSync(expect, JSON.stringify({ unit: 2, margin: 0.5, W: info.W, H: info.H, blocks: blocks.map((b) => [b.x, b.y, b.w, b.h, b.col]) }));
  const r = spawnSync(py, [path.join(HERE, 'gia_crosscheck.py'), giaPath, expect, READER_DIR], { encoding: 'utf8', env });
  let res = null;
  try { res = JSON.parse(r.stdout); } catch { /* 下面报错 */ }
  checks.push(['素材组 GIA：第三方 MIT 读取器逐条一致（位置/尺寸/颜色/绘制顺序）', !!res && res.records === blocks.length && res.bad.length === 0 && !res.ignored_mask,
    res ? `${res.records} 条，不一致 ${res.bad.length}${res.bad.length ? '：' + res.bad[0] : ''}` : (r.stderr || r.stdout).slice(0, 200)]);
  return checks;
}

// ───────────────────────── 关卡 .gil：编进底关卡 + 在模拟器里运行逐像素核对 ─────────────────────────
// 底关卡用官方 3.21「客户端脚本」示例：环境变量 RECT_MERGE_SEED 指定，或放在 references/samples/ 下；都没有就跳过。
const SEED_CANDIDATES = [process.env.RECT_MERGE_SEED,
  path.join(HERE, '..', '..', 'references', 'samples', 'mh47p30a87qo_客户端脚本.gil')].filter(Boolean);
async function gilRoundTrip(blocks, info, dataPath, tmp, tag) {
  const seed = SEED_CANDIDATES.find((p) => fs.existsSync(p));
  if (!seed) return [['关卡 .gil：编进底关卡并在模拟器里核对', true, '跳过：没有底关卡（设 RECT_MERGE_SEED 指向官方 3.21 示例 .gil）']];
  const { bytes } = buildGil(seed, blocks, { W: info.W, H: info.H, unit: 2, margin: 0 });
  const gil = path.join(tmp, `${tag}.gil`);
  fs.writeFileSync(gil, bytes);
  const r = await verifyGil(gil, dataPath, 2);
  return [['关卡 .gil：模拟器运行填色脚本后，控件数、覆盖、逐像素颜色（按兄弟顺序叠放）一致',
    !r.error && r.images === blocks.length && r.holes === 0 && r.diff === 0,
    r.error || `控件 ${r.images}，空洞 ${r.holes}，不一致像素 ${r.diff}，重叠像素 ${r.overlap}`]];
}

// ───────────────────────── 旋转矩形 / 椭圆（shapes.mjs，compress.py --shapes） ─────────────────────────
async function shapesCheck(py, env, png, raw, tmp, ok) {
  const out = path.join(tmp, 'out_shapes.lua');
  const cli = [path.join(HERE, 'compress.py'), '--input', png, '--output', out, '--std', '6', '--size', '320x320', '--shapes', '--shape-passes', '1', '--shape-kinds', 'ellipse,rotrect,triangle,ring', '--shape-alpha'];
  const r = spawnSync(py, cli, { encoding: 'utf8', env });
  if (r.status !== 0) { console.log(`✗ compress.py ${cli.slice(1).join(' ')} 失败
${r.stdout}
${r.stderr}`); return false; }
  const text = fs.readFileSync(out, 'utf8');
  const info = parseData(text);
  const items = allItems(info);
  const shapes = decodeShapes(info.shp, info.SHPV ?? 1);
  const rects = decode(info).map((b) => [b.x, b.y, b.w, b.h, (b.col >> 16) & 255, (b.col >> 8) & 255, b.col & 255]);
  const q = shapes.map((s) => [s.kind, Math.round(s.cx * 4), Math.round(s.cy * 4), Math.round(s.hw * 4), Math.round(s.hh * 4), s.thq, s.aq, (s.col >> 16) & 255, (s.col >> 8) & 255, s.col & 255]);
  const mae = maeOf(raw, renderItems(320, 320, rects, q));
  const outside = shapes.filter((s) => !insideImage(s.kind, shapeParams([s.cx * 4, s.cy * 4, s.hw * 4, s.hh * 4, s.thq, s.aq]), 320, 320)).length;
  const layeredN = layered(raw, 320, 320, 6).rects.length + 1;   // 同 STD 的纯分层矩形（含 1 个均色底板）
  // Python 侧解码同一个形状串，与 JS 解码逐字段比对（两种语言各写一遍编解码）
  const dec = spawnSync(py, ['-c', `
import sys, json
sys.path.insert(0, sys.argv[2])
from blockcodec import unpack_shapes
t = open(sys.argv[1], encoding='utf-8').read()
key = 'IMG.SHP = '
start = t.index(key) + len(key)
j = start + 1
lvl = 0
while t[j] == '=':
    lvl += 1
    j += 1
j += 1
body = t[j:t.index(']' + '=' * lvl + ']', j)]
print(json.dumps(unpack_shapes(body)))`, out, HERE], { encoding: 'utf8', env });
  let codec = false, codecMsg = dec.stderr.trim();
  if (dec.status === 0) {
    const pyShapes = JSON.parse(dec.stdout);
    codec = pyShapes.length === q.length && pyShapes.every((t, i) => t.every((v, k) => v === q[i][k]));
    codecMsg = `${pyShapes.length} 个`;
  }
  const checks = [
    ['形状数据：NSHP = 形状串长度 / 15（v2），控件总数 = 矩形 + 形状', info.NSHP === shapes.length && info.shp.length === 15 * info.NSHP && items.length === info.NBLK + info.NSHP, `${info.NBLK} + ${info.NSHP}`],
    ['有形状被接受（合成图里有圆和渐变）', info.NSHP > 0, `${info.NSHP} 个`],
    ['每个形状的外延都在图内（否则控件画到图外）', outside === 0, `图外 ${outside}`],
    ['Python 与 JS 对形状串的解码逐字段一致', codec, codecMsg],
    ['带形状的总控件数少于同 STD 的纯分层矩形', items.length < layeredN, `${items.length} / ${layeredN}`],
    [`渲染 MAE 在合理范围（模型值 ${mae.toFixed(2)}）`, mae > 0 && mae < 12, mae.toFixed(2)],
  ];
  const seed = SEED_CANDIDATES.find((p) => fs.existsSync(p));
  if (seed) {
    const nR = items.filter((b) => !b.shape).length;
    const shapeList = items.slice(nR).map((b) => ({ img: b.shape.img, rotDeg: b.shape.rotDeg, aq: b.shape.aq }));
    const { bytes } = buildGil(seed, items, { W: info.W, H: info.H, unit: 2, margin: 0, defaultOnly: true, shapes: shapeList, nRects: nR });
    const gil = path.join(tmp, 'gil_shapes.gil');
    fs.writeFileSync(gil, bytes);
    const v = await verifyGil(gil, out, 2);
    checks.push(['关卡 .gil：模拟器里的控件（位置、尺寸、颜色、图片 ID、旋转角）还原出的画面与数据直接渲染一致',
      !v.error && v.images === items.length && v.diff === 0 && v.rotated === v.rotatedExpected && v.ellipses === v.ellipsesExpected && v.triangles === v.trianglesExpected && v.rings === v.ringsExpected && v.translucent === v.translucentExpected,
      v.error || `控件 ${v.images}，旋转 ${v.rotated}，椭圆 ${v.ellipses}，三角形 ${v.triangles}，圆环 ${v.rings}，半透明 ${v.translucent}，不一致像素 ${v.diff}，最大差 ${v.maxDiff}`]);
  } else checks.push(['关卡 .gil 带形状', true, '跳过：没有底关卡']);
  return report(`== 形状 STD=6  控件 ${items.length}（矩形 ${info.NBLK} + 形状 ${info.NSHP}）`, checks) && ok;
}

// ───────────────────────── 旋转优先（--shape-prefer-rotation） ─────────────────────────
// 目的：斜边上的台阶是轴对齐矩形拼的，旋转矩形/椭圆能把边压在斜线上。这条检查只证明
// "开了之后确实更多形状在转、而且没有把控件数抬上去"，画质要靠人眼看。
async function rotationCheck(py, env, png, raw, tmp, ok) {
  const runs = [];
  for (const pr of [0, 16]) {
    const out = path.join(tmp, `out_rot_${pr}.lua`);
    const cli = [path.join(HERE, 'compress.py'), '--input', png, '--output', out, '--std', '6', '--size', '320x320',
      '--shapes', '--shape-passes', '1', '--shape-kinds', 'ellipse,rotrect', '--shape-prefer-rotation', String(pr)];
    const r = spawnSync(py, cli, { encoding: 'utf8', env });
    if (r.status !== 0) { console.log(`✗ compress.py ${cli.slice(1).join(' ')} 失败\n${r.stdout}\n${r.stderr}`); return false; }
    const info = parseData(fs.readFileSync(out, 'utf8'));
    const sh = decodeShapes(info.shp, info.SHPV ?? 1);
    runs.push({ pr, n: sh.length, rot: sh.filter((s) => s.thq !== 0).length, controls: info.NBLK + info.NSHP });
  }
  const [a, b] = runs;
  return report(`== 旋转优先（prefer-rotation ${a.pr} → ${b.pr}）  旋转形状 ${a.rot} → ${b.rot}`, [
    ['开了旋转优先之后旋转形状变多', b.rot > a.rot, `${a.rot} → ${b.rot}（共 ${a.n} → ${b.n}）`],
    ['控件总数没有明显增加（≤ 3%）', b.controls <= a.controls * 1.03, `${a.controls} → ${b.controls}`],
  ]) && ok;
}

/** 静默退化回归（零 Python 依赖）：
 *  ① 软边（kind 5）只有 SHPV = 3 的形状串才带 fxq / fyq；v2 数据里出现 kind 5 过去会被静默吞掉
 *     （allItems 给出 img=undefined → paintLua 序号退成 0 → Lua 端 `if im ~= 0` 跳过换图 → 画成不透明硬边矩形）。
 *  ② to-gia 只取矩形，形状过去是**静默消失**（输出控件数比数据少）。
 *  ③ v3 接通后软边必须能真的落盘：数据串 19 字符 → allItems 放行 → paintLua 6 字符 SHP + 软边属性。
 *  这三件事都在这里钉住。 */
function degradeGuardCheck(tmp, ok) {
  const ch = (v) => String.fromCharCode(48 + v);
  const c2 = (v) => ch(Math.floor(v / 64)) + ch(v % 64);
  const c4 = (v) => [18, 12, 6, 0].map((s) => ch((v >> s) & 63)).join('');
  const rect11 = (x, y, w, h, col) => c2(2 * x + w) + c2(2 * y + h) + c2(Math.floor((w * 512 + h) / 64)) + ch((w * 512 + h) % 64) + c4(col);
  const shape15 = (kind, cx, cy, hw, hh, thq, aq, col) =>
    c2(cx * 4) + c2(cy * 4) + c2(hw * 4) + c2(hh * 4) + c2((kind - 1) * 512 + thq) + ch(aq) + c4(col);
  const shape19 = (kind, cx, cy, hw, hh, thq, aq, fxq, fyq, col) =>
    c2(cx * 4) + c2(cy * 4) + c2(hw * 4) + c2(hh * 4) + c2((kind - 1) * 512 + thq) + ch(aq) + c2(fxq) + c2(fyq) + c4(col);
  const mk = (shpBody, ver = 2) => `IMG.N = 8
IMG.W = 8
IMG.H = 8
IMG.NBLK = 1
IMG.NSHP = ${shpBody ? 1 : 0}
IMG.SHPV = ${ver}
IMG.ENC = "p64"
IMG.DATA = "${rect11(0, 0, 2, 2, 0x336699)}"
IMG.SHP = [[${shpBody || ''}]]
`;
  const shpOf = (lua) => /local SHP = \[(=*)\[([\s\S]*?)\]\1\]/.exec(lua)?.[2] ?? '';
  const throws = (fn) => { try { fn(); return null; } catch (e) { return e.message; } };
  // 1. v2 数据里出现软边：allItems 必须报错（而不是给出 img=undefined 让下游静默降级）
  const softMsg = throws(() => allItems(parseData(mk(shape15(5, 4, 4, 2, 2, 0, 32, 0xff0000), 2))));
  // 2. 有效形状（椭圆）仍要正常工作：图片 ID 必须一路传到 paintLua 的 SHP 串
  const ellShape = allItems(parseData(mk(shape15(1, 4, 4, 2, 2, 0, 32, 0xff0000), 2))).find((i) => i.shape)?.shape;
  const ellLua = (() => { try { return paintLua([0, 0], 1, [{ img: ellShape.img, rotDeg: ellShape.rotDeg, aq: ellShape.aq }], 1); } catch { return ''; } })();
  const ellB = [...shpOf(ellLua)].map((c) => c.charCodeAt(0));
  const ellIm = ellB.length === 3 ? ((ellB[0] * 64 + ellB[1]) * 64 + ellB[2] - 199728) >> 16 : -1;
  // 3. v3：软边必须能落盘（19 字符数据串 → 放行 → 6 字符 SHP → 软边属性）
  const v3Items = allItems(parseData(mk(shape19(5, 4, 4, 2, 2, 0, 32, 20, 0, 0xff0000), 3)));
  const v3Soft = v3Items.find((i) => i.shape)?.shape;
  const v3Lua = (() => {
    try {
      return paintLua(v3Items.map((i) => i.col), 1,
        [{ img: v3Soft.img, rotDeg: v3Soft.rotDeg, aq: v3Soft.aq, fxq: v3Soft.fxq, fyq: v3Soft.fyq }],
        v3Items.filter((i) => !i.shape).length, { unit: 2 });
    } catch (e) { return 'ERR:' + e.message; }
  })();
  const v3S = shpOf(v3Lua);
  // 按生成的 Lua 端同一算式回读 6 字符
  const rd6 = (s) => {
    let v = 0;
    for (let k = 0; k < 6; k++) v = v * 64 + (s.charCodeAt(k) - 48);
    const fyq = v % 256; v = Math.floor(v / 256);
    const fxq = v % 256; v = Math.floor(v / 256);
    const aq = v % 64; v = Math.floor(v / 64);
    const zq = v % 1024;
    return { im: Math.floor(v / 1024), zq, aq, fxq, fyq };
  };
  const d6 = v3S.length === 6 ? rd6(v3S) : null;
  // 4. paintLua 拿不到 / 不认识图片 ID 时必须报错（绝不能退回序号 0 = 沿用默认图 = 不换图）
  const luaNoImg = throws(() => paintLua([0], 1, [{ img: undefined, rotDeg: 0, aq: 32 }], 0));
  const luaBadImg = throws(() => paintLua([0], 1, [{ img: 999999, rotDeg: 0, aq: 32 }], 0));
  // 5. to-gia 遇到形状块必须报错（而不是只写矩形、静默丢掉形状）
  const dataFile = path.join(tmp, 'degrade_shapes.lua');
  fs.writeFileSync(dataFile, mk(shape15(1, 4, 4, 2, 2, 0, 32, 0xff0000), 2));
  const giaRun = spawnSync(process.execPath, [path.join(HERE, 'to-gia.mjs'), dataFile, '-o', path.join(tmp, 'degrade.gia')], { encoding: 'utf8' });
  const giaMsg = `${giaRun.stderr || giaRun.stdout || ''}`.trim();
  const short = (s, n = 58) => (s.length > n ? s.slice(0, n) + '…' : s);
  return report('== 静默退化守卫 + v3 软边落盘（形状）', [
    ['v2 数据里的软边：allItems 明确报错，不再静默给出 img=undefined', !!softMsg && /软边/.test(softMsg), softMsg ? short(softMsg) : '没有报错（下游会静默画成硬边矩形）'],
    ['有效形状（椭圆 kind 1）：图片 ID 100002 传到 paintLua，SHP 序号 = 1', ellShape?.img === 100002 && ellIm === 1, `img=${ellShape?.img} 序号=${ellIm}`],
    ['v3 软边：allItems 放行，img=100001、soft=true、fxq / fyq 原样带出', v3Soft?.img === 100001 && v3Soft?.soft === true && v3Soft?.fxq === 20 && v3Soft?.fyq === 0, JSON.stringify(v3Soft)],
    ['v3 软边：paintLua 写 6 字符 SHP，回读 im / zq / aq / fxq / fyq 全对', !!d6 && d6.im === 0 && d6.zq === 0 && d6.aq === 32 && d6.fxq === 20 && d6.fyq === 0, `${v3S.length} 字符 ${JSON.stringify(d6)}`],
    ['v3 软边：生成 enableMask / enableSoftEdge / Pixel / SetSoftEdgeWidth（布局单位换算）',
      /c\.enableMask = true/.test(v3Lua) && /c\.enableSoftEdge = true/.test(v3Lua) && /Enum\.ImageMaskSoftEdgeMode\.Pixel/.test(v3Lua)
      && /c:SetSoftEdgeWidth\(fxq \* 2 \/ 2, fyq \* 2 \/ 2\)/.test(v3Lua),
      (/c:SetSoftEdgeWidth\([^)]*\)/.exec(v3Lua) ?? ['(没找到)'])[0]],
    ['paintLua：缺少图片 ID 时明确报错（不再退回序号 0 = 不换图）', !!luaNoImg && /静态图片 ID/.test(luaNoImg), luaNoImg ? short(luaNoImg) : '没有报错'],
    ['paintLua：图片 ID 不认识时明确报错', !!luaBadImg && /静态图片 ID/.test(luaBadImg), luaBadImg ? short(luaBadImg) : '没有报错'],
    ['to-gia：数据含形状块时明确报错（不再只写矩形、静默丢掉形状）', giaRun.status !== 0 && /形状/.test(giaMsg), giaRun.status !== 0 ? `退出码 ${giaRun.status}：${short(giaMsg.split('\n')[0])}` : '没报错（形状会被丢掉）'],
  ]) && ok;
}

// ───────────────────────── 自检 ─────────────────────────
function findPython() {
  for (const exe of [process.env.PYTHON, 'python', 'python3'].filter(Boolean)) {
    const r = spawnSync(exe, ['-c', 'import PIL, numpy; print("ok")'], { encoding: 'utf8' });
    if (r.status === 0 && r.stdout.includes('ok')) return exe;
  }
  return null;
}

// ───────────────────────── 预算对齐系数（2026-10-18 修 §2.14） ─────────────────────────
/**
 * `budgetMultiplier` 只钉两件事，但都是这次修复的要害：
 *   ① 权重全为 1 → m 恒为 1（老路径逐字节不变）；
 *   ② 给一组真权重 → 用 T×m 铺满的块数回到不加权 T 的块数（预算守恒，不是「差不多」）。
 * 纯 JS、不依赖 Python，所以跑得比整条管线快一个量级。
 */
function budgetCalibrationChecks() {
  const W = 240, H = 160, N = W * H, T = 3;
  // 合成图必须同时有两个特征，否则这条自检没意义（踩过：全是渐变时加权与不加权块数一样）：
  //   ① 大片平滑渐变 —— 块数由容差决定，权重放宽能真的省块；
  //   ② 一条硬边带 —— 权重收紧在那里，用来制造「加权后预算被缩掉」的现象。
  const raw = new Uint8Array(N * 3);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const o = (y * W + x) * 3;
    raw[o] = Math.min(255, Math.round(x * 0.45));
    raw[o + 1] = Math.min(255, Math.round(y * 0.9));
    raw[o + 2] = (x > 118 && x < 126) ? 220 : 30;
  }
  const uni = new Float32Array(N).fill(1);
  const weighted = new Float32Array(N);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    weighted[y * W + x] = (x >= 117 && x <= 127) ? 2.2 : 0.58;
  }
  const plain = tile(raw, W, H, T, 511, null).length;
  const a = budgetMultiplier(raw, W, H, T, uni, { maxSide: 511 });
  const b = budgetMultiplier(raw, W, H, T, weighted, { maxSide: 511 });
  const got = tile(raw, W, H, T * b.m, 511, weighted).length;
  const skew = tile(raw, W, H, T, 511, weighted).length;   // 不对齐时的块数（旧行为）
  return [
    ['权重全为 1 → m=1（老路径不变）', a.m === 1 && a.exact, `m=${a.m}`],
    ['真权重 → m≠1，且 T×m 的块数回到不加权水平', b.m !== 1 && Math.abs(got - plain) <= Math.max(2, plain * 0.02),
      `铺满 ${plain} 块；m=${b.m.toFixed(3)} → ${got} 块（不对齐是 ${skew} 块）`],
    ['不对齐真的会缩预算（证明这条修复有实际作用）', skew < plain * 0.97, `${plain} → ${skew}（${((skew / plain - 1) * 100).toFixed(1)}%）`],
  ];
}

async function edgeAwareChecks(py, env, png, raw, tmp, render) {
  const W = 320, H = 320;
  const run = (name, extra) => {
    const out = path.join(tmp, 'ea_' + name + '.lua');
    const r = spawnSync(py, [path.join(HERE, 'compress.py'), '--input', png, '--output', out,
      '--std', '3', '--size', W + 'x' + H, ...extra], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error('compress.py ' + extra.join(' ') + ' 失败\n' + r.stdout + '\n' + r.stderr);
    return out;
  };
  const baseOut = run('base', []);
  const identOut = run('ident', ['--edge-aware', '--edge-boost', '0', '--smooth-slack', '0']);
  const edgeOut = run('edge', ['--edge-aware']);
  const base = decode(parseData(fs.readFileSync(baseOut, 'utf8')));
  const edge = decode(parseData(fs.readFileSync(edgeOut, 'utf8')));
  const mask = edgeMask(raw, W, H);
  const be = maeWithMask(raw, base, W, H, mask);
  const ee = maeWithMask(raw, edge, W, H, mask);
  const bs = maeWithMask(raw, base, W, H, mask, true);
  const es = maeWithMask(raw, edge, W, H, mask, true);
  // 三个新旋钮：色差不大处更便宜、明显色差处更贵、精细区封顶。
  // 2026-10-18 起判据改了：**块数由 --std 决定，权重只决定花在哪**（预算对齐 m）。
  // 所以这里不再用块数判旋钮方向，改看「同一份预算下的边带 / 其余 MAE」。
  const runBlocks = (name, extra) => decode(parseData(fs.readFileSync(run(name, extra), 'utf8')));
  const capLo = runBlocks('caplo', ['--edge-aware', '--edge-cap', '1.05']);
  const capHi = runBlocks('caphi', ['--edge-aware', '--edge-cap', '4']);
  const slackLo = runBlocks('slacklo', ['--edge-aware', '--smooth-slack', '0.15']);
  const slackHi = runBlocks('slackhi', ['--edge-aware', '--smooth-slack', '0.8']);
  const unbal = runBlocks('unbal', ['--edge-aware', '--edge-unbalanced']);
  const [capLoE, capLoS] = [maeWithMask(raw, capLo, W, H, mask), maeWithMask(raw, capLo, W, H, mask, true)];
  const [capHiE, capHiS] = [maeWithMask(raw, capHi, W, H, mask), maeWithMask(raw, capHi, W, H, mask, true)];
  const [sloE, sloS] = [maeWithMask(raw, slackLo, W, H, mask), maeWithMask(raw, slackLo, W, H, mask, true)];
  const [shiE, shiS] = [maeWithMask(raw, slackHi, W, H, mask), maeWithMask(raw, slackHi, W, H, mask, true)];
  const rangePy = path.join(tmp, 'ea_range.py');
  fs.writeFileSync(rangePy, [
    'import sys, numpy as np',
    'sys.path.insert(0, sys.argv[1])',
    'from compress import edge_importance',
    'rng = np.random.RandomState(0)',
    'img = np.zeros((64, 64, 3)); img[:32] = 40; img[32:] = 235',
    'img = np.clip(img + rng.rand(64, 64, 3) * 6, 0, 255)',
    'I = edge_importance(img)',
    'print("%.4f %.4f" % (I.min(), I.max()))',
  ].join('\n'));
  const rr = spawnSync(py, [rangePy, HERE], { encoding: 'utf8', env });
  const [iMin, iMax] = (rr.stdout || '').trim().split(/\s+/).map(Number);
  return [
    ['boost=slack=0 时与不加权逐字节相同',
      fs.readFileSync(baseOut, 'utf8') === fs.readFileSync(identOut, 'utf8'), '两个 .lua 文件相等'],
    ['预算对齐：块数与基线差 ≤ 5%（权重只挪预算，不缩预算）',
      Math.abs(edge.length - base.length) <= 0.05 * base.length,
      `${base.length} → ${edge.length}（${((edge.length / base.length - 1) * 100).toFixed(1)}%）`],
    ['默认参数：边缘带 MAE 下降 ≥ 10%', ee < be * 0.9, `${be.toFixed(3)} → ${ee.toFixed(3)}`],
    ['默认参数：其余区域 MAE 上升（预算确实挪走了）', es > bs, `${bs.toFixed(3)} → ${es.toFixed(3)}`],
    ['色差不大处被压到 1−slack（=0.58）', Math.abs(iMin - 0.58) < 0.02, `I 最低 ${iMin}`],
    ['精细区被 cap 封顶（=2.2，不是 1+boost=2.6）', Math.abs(iMax - 2.2) < 0.02, `I 最高 ${iMax}`],
    ['cap 越大：边带越准、其余越糊（1.05 → 4）', capHiE < capLoE && capHiS > capLoS,
      `边带 ${capLoE.toFixed(3)} → ${capHiE.toFixed(3)}；其余 ${capLoS.toFixed(3)} → ${capHiS.toFixed(3)}`],
    ['slack 越大：其余越糊、边带更准（0.15 → 0.8）', shiS > sloS && shiE < sloE,
      `其余 ${sloS.toFixed(3)} → ${shiS.toFixed(3)}；边带 ${sloE.toFixed(3)} → ${shiE.toFixed(3)}`],
    ['--edge-unbalanced 复现旧行为：块数明显少于基线（逃逸口还在）',
      unbal.length < base.length * 0.98, `${base.length} → ${unbal.length}（旧行为，预算被缩）`],
    ...runRender(render, edgeOut, { budget: 0.012 }),
  ];
}

// ───────────────────────── 视觉预算：焦点 / 分层 / 形状（加权） ─────────────────────────
/** 焦点 JSON 的解析与报错口径（纯 Python 侧，不跑压缩） */
function focusParseChecks(py, env, tmp) {
  const good = path.join(tmp, 'focus_good.json');
  const badKey = path.join(tmp, 'focus_badkey.json');
  const missing = path.join(tmp, 'focus_missing.json');
  const empty = path.join(tmp, 'focus_empty.json');
  fs.writeFileSync(good, JSON.stringify({ space: 'px', boxes: [{ x: 10, y: 5, w: 20, h: 20, feather: 4 }] }));
  fs.writeFileSync(badKey, JSON.stringify({ boxes: [], colour: 'x' }));
  fs.writeFileSync(missing, JSON.stringify({ boxes: [{ x: 1, y: 2, w: 3 }] }));
  fs.writeFileSync(empty, JSON.stringify({ boxes: [], points: [] }));
  const code = `
import sys, json
sys.path.insert(0, sys.argv[1])
from compress import load_focus
out = {}
F = load_focus(sys.argv[2], 40, 30)
out["shape"] = list(F.shape); out["center"] = float(F[15, 20]); out["far"] = float(F[0, 0])
for name in sys.argv[3:]:
    try:
        load_focus(name, 40, 30); out[name] = "OK"
    except Exception as exc:
        out[name] = str(exc)
print(json.dumps(out, ensure_ascii=False))
`;
  const r = spawnSync(py, ['-c', code, HERE, good, badKey, missing, empty], { encoding: 'utf8', env });
  let j = null;
  try { j = JSON.parse(r.stdout); } catch { /* 下面报错 */ }
  const ok = !!j;
  const short = (s) => String(s ?? '').slice(0, 70);
  return [
    ['焦点 JSON：boxes 生效，中心 F≈1、远处 F=0', ok && j.shape[0] === 30 && j.shape[1] === 40 && j.center > 0.9 && j.far === 0,
      ok ? `形状 ${j.shape.join('×')}，中心 ${Number(j.center).toFixed(2)}，远处 ${j.far}` : short(r.stderr || r.stdout)],
    ['焦点 JSON：多余的键报错（不静默忽略）', ok && /多余的键/.test(j[badKey] || ''), short(ok ? j[badKey] : '')],
    ['焦点 JSON：缺字段报错', ok && /缺少字段/.test(j[missing] || ''), short(ok ? j[missing] : '')],
    ['焦点 JSON：没有任何区域时报错', ok && /没有任何区域/.test(j[empty] || ''), short(ok ? j[empty] : '')],
  ];
}

/** 把块 / 形状数据渲染成图，按掩码拆 MAE（与 Python 侧 mae_split 同口径：每像素每通道） */
function maeSplitOf(raw, img, W, H, mask) {
  let se = 0, ce = 0, so = 0, co = 0;
  for (let i = 0; i < W * H; i++) {
    let s = 0;
    for (let c = 0; c < 3; c++) s += Math.abs(img[i * 3 + c] - raw[i * 3 + c]);
    if (mask[i]) { se += s; ce += 3; } else { so += s; co += 3; }
  }
  return [ce ? se / ce : 0, co ? so / co : 0];
}

/** 从 compress.py 的输出里还原「矩形 + 形状」的渲染结果（与 verifyGil 用的是同一套 renderItems） */
function renderFromLua(text) {
  const info = parseData(text);
  const rects = decode(info).map((b) => [b.x, b.y, b.w, b.h, (b.col >> 16) & 255, (b.col >> 8) & 255, b.col & 255]);
  const shapes = decodeShapes(info.shp, info.SHPV ?? 1);
  const q = shapes.map((s) => [s.kind, Math.round(s.cx * 4), Math.round(s.cy * 4), Math.round(s.hw * 4), Math.round(s.hh * 4), s.thq, s.aq,
    (s.col >> 16) & 255, (s.col >> 8) & 255, s.col & 255]);
  return { info, img: renderItems(info.W, info.H, rects, q), n: rects.length + q.length };
}

/**
 * 三条路径的加权预算（纯矩形 / 分层 / 形状）共用同一套判据。
 * 这里钉两件事：
 *   ① **恒等**：权重全为 1 时与不加权**逐字节相同**（不是"近似等价"，文件哈希相同）；
 *   ② **真的挪了预算**：边缘带 MAE 必须下降、其余区域必须上升。
 * 焦点另钉两件事：给了焦点之后，焦点区 MAE 必须下降、其余区域不得下降（预算往焦点挪）。
 */
async function visualBudgetChecks(py, env, png, tmp) {
  const W = 200, H = 200;
  // 参考图必须和被测管线用**同一个**重建核（默认已是 box，2026-10-18 定案）。
  const makeRaw = (resample) => {
    const p = path.join(tmp, `vb_200_${resample}.rgb`);
    const r = spawnSync(py, ['-c', `
import sys, numpy as np
sys.path.insert(0, sys.argv[1])
from compress import load_and_prepare
a = load_and_prepare(sys.argv[2], ${W}, ${H}, False, sys.argv[4])
open(sys.argv[3], 'wb').write(np.clip(a, 0, 255).astype(np.uint8).tobytes())
`, HERE, png, p, resample], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error('生成缩放原图失败\n' + r.stderr);
    return fs.readFileSync(p);
  };
  const raw = makeRaw('box');
  const mask = edgeMask(raw, W, H);
  const run = (name, extra) => {
    const out = path.join(tmp, 'vb_' + name + '.lua');
    const r = spawnSync(py, [path.join(HERE, 'compress.py'), '--input', png, '--output', out,
      '--std', '3', '--size', W + 'x' + H, ...extra], { encoding: 'utf8', env });
    if (r.status !== 0) throw new Error('compress.py ' + extra.join(' ') + ' 失败\n' + r.stdout + '\n' + r.stderr);
    return out;
  };
  const same = (a, b) => fs.readFileSync(a, 'utf8') === fs.readFileSync(b, 'utf8');

  // ① 分层：恒等 + 效果
  const lBase = run('lbase', ['--layered']);
  const lIdent = run('lident', ['--layered', '--edge-aware', '--edge-boost', '0', '--smooth-slack', '0']);
  const lEdge = run('ledge', ['--layered', '--edge-aware']);
  const lb = decode(parseData(fs.readFileSync(lBase, 'utf8')));
  const le = decode(parseData(fs.readFileSync(lEdge, 'utf8')));
  const lbe = maeWithMask(raw, lb, W, H, mask), lee = maeWithMask(raw, le, W, H, mask);
  const lbs = maeWithMask(raw, lb, W, H, mask, true), les = maeWithMask(raw, le, W, H, mask, true);

  // ② 焦点：左半张图
  const focusPath = path.join(tmp, 'focus_half.json');
  fs.writeFileSync(focusPath, JSON.stringify({ space: 'norm', boxes: [{ x: 0, y: 0, w: 0.5, h: 1, feather: 0.05 }] }));
  const fBase = run('fbase', []);
  const fIdent = run('fident', ['--focus', focusPath, '--focus-gain', '0', '--edge-aware', '--edge-boost', '0', '--smooth-slack', '0']);
  const fFocus = run('ffocus', ['--focus', focusPath]);
  const fb = decode(parseData(fs.readFileSync(fBase, 'utf8')));
  const ff = decode(parseData(fs.readFileSync(fFocus, 'utf8')));
  const boxMask = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W / 2; x++) boxMask[y * W + x] = 1;
  const [fce, fco] = maeSplitOf(raw, (() => { const img = new Uint8Array(W * H * 3); for (const b of ff) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { const o = (y * W + x) * 3; img[o] = (b.col >> 16) & 255; img[o + 1] = (b.col >> 8) & 255; img[o + 2] = b.col & 255; } return img; })(), W, H, boxMask);
  const [fbe, fbo] = maeSplitOf(raw, (() => { const img = new Uint8Array(W * H * 3); for (const b of fb) for (let y = b.y; y < b.y + b.h; y++) for (let x = b.x; x < b.x + b.w; x++) { const o = (y * W + x) * 3; img[o] = (b.col >> 16) & 255; img[o + 1] = (b.col >> 8) & 255; img[o + 2] = b.col & 255; } return img; })(), W, H, boxMask);

  // ③ 形状：恒等 + 效果（固定 2 线程，保证两次运行可比）。
  //    2026-10-18 起 `--edge-aware` 在形状路径上也**预算守恒**（compress.py 先用 m 把加权容差
  //    折算回 T×m，见 references/rect-merge-playbook.md §2.14）。以前 box 采样下边带 MAE 反而
  //    上升，是因为加权把预算缩掉了 30%～45%，不是加权数学错了。
  const shapeFamily = (resample) => {
    const core = ['--std', '6', '--size', W + 'x' + H, '--shapes', '--shape-passes', '1',
      '--shape-kinds', 'ellipse,rotrect', '--shape-threads', '2', '--resample', resample];
    const args = [...core, '--shape-no-refine'];
    return {
      base: run(`sbase_${resample}`, args),
      ident: run(`sident_${resample}`, [...args, '--edge-aware', '--edge-boost', '0', '--smooth-slack', '0']),
      edge: run(`sedge_${resample}`, [...args, '--edge-aware']),
      refW: run(`srefw_${resample}`, [...core, '--edge-aware']),
    };
  };
  const countOf = (p) => decode(parseData(fs.readFileSync(p, 'utf8'))).length;
  const rawL = makeRaw('lanczos'), maskL = edgeMask(rawL, W, H);
  const sbL = shapeFamily('lanczos'), sbB = shapeFamily('box');
  const [sbeL, sbsL] = maeSplitOf(rawL, renderFromLua(fs.readFileSync(sbL.base, 'utf8')).img, W, H, maskL);
  const [seeL, sesL] = maeSplitOf(rawL, renderFromLua(fs.readFileSync(sbL.edge, 'utf8')).img, W, H, maskL);
  const [sbeB, sbsB] = maeSplitOf(raw, renderFromLua(fs.readFileSync(sbB.base, 'utf8')).img, W, H, mask);
  const [seeB, sesB] = maeSplitOf(raw, renderFromLua(fs.readFileSync(sbB.edge, 'utf8')).img, W, H, mask);

  // ④ 加权下的精修：颜色重拟合 / 几何微调 / 矩形边 / 修剪都必须让模型变好，
  //    不能像 2026-10-17 那次 bug 一样把颜色整体拉偏（分母多乘了一次 I）。这里只要求"精修不变差"。
  const refMaeB = maeOf(raw, renderFromLua(fs.readFileSync(sbB.refW, 'utf8')).img);
  // 不精修那一版就是 sbB.edge（shapeArgs 已带 --shape-no-refine + --edge-aware），不必再跑一次
  const noRefMaeB = maeOf(raw, renderFromLua(fs.readFileSync(sbB.edge, 'utf8')).img);

  return report('== 视觉预算：焦点 / 分层 / 形状（加权）', [
    ...focusParseChecks(py, env, tmp),
    ['分层：权重全为 1 时与不加权逐字节相同', same(lBase, lIdent), '两个 .lua 文件相等'],
    [`分层：边缘带 MAE 下降 ≥ 10%（${lbe.toFixed(2)} → ${lee.toFixed(2)}）`, lee < lbe * 0.9, `${lbe.toFixed(3)} → ${lee.toFixed(3)}`],
    ['分层：其余区域 MAE 上升（预算挪走了）', les > lbs, `${lbs.toFixed(3)} → ${les.toFixed(3)}`],
    ['焦点：与不加权逐字节相同（gain 0）', same(fBase, fIdent), '两个 .lua 文件相等'],
    ['焦点：焦点区 MAE 下降 ≥ 20%', fce < fbe * 0.8, `${fbe.toFixed(3)} → ${fce.toFixed(3)}`],
    ['焦点：其余区域基本不变（|Δ| < 3%，预算没从那里漏出去）', Math.abs(fco - fbo) < 0.03 * fbo, `${fbo.toFixed(3)} → ${fco.toFixed(3)}`],
    ['形状：权重全为 1 时与不加权逐字节相同（box）', same(sbB.base, sbB.ident), '两个 .lua 文件相等'],
    ['形状：边缘带 MAE 下降（lanczos；加权数学的回归位）', seeL < sbeL, `${sbeL.toFixed(3)} → ${seeL.toFixed(3)}`],
    ['形状：其余区域 MAE 上升（预算挪走了，lanczos）', sesL > sbsL, `${sbsL.toFixed(3)} → ${sesL.toFixed(3)}`],
    ['形状：加权下的精修不把模型改坏（MAE 不高于不精修的 1.05 倍，box）', refMaeB <= noRefMaeB * 1.05,
      `精修 ${refMaeB.toFixed(2)} / 不精修 ${noRefMaeB.toFixed(2)}`],
    ['形状 + --edge-aware（box）：块数与不加权差 ≤ 15%（预算守恒）',
      Math.abs(countOf(sbB.edge) - countOf(sbB.base)) <= 0.15 * countOf(sbB.base),
      `${countOf(sbB.base)} → ${countOf(sbB.edge)}`],
    ['形状 + --edge-aware（box）：边缘带 MAE 下降 ≥ 10%', seeB < sbeB * 0.9, `${sbeB.toFixed(3)} → ${seeB.toFixed(3)}`],
    ['形状 + --edge-aware（box）：其余区域 MAE 上升（预算挪走了）', sesB > sbsB, `${sbsB.toFixed(3)} → ${sesB.toFixed(3)}`],
  ]);
}


/** 覆盖率光栅化对拍：当前 coverageInto 与冻结的参考实现（coverage-ref.mjs，优化前的原算法）逐像素、覆盖率逐位相同。
 *  形状参数按拟合器真实的量化取（位置 / 半轴 0.25 px，角度 0.5°），含对称整数的难例（采样点恰好落在边界上）。 */
function coverageRefCheck() {
  let seed = 20261020; const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const W = 200, H = 160, N = W * H;
  const A = { px: new Int32Array(N), cv: new Float32Array(N), bb: null }, B = { px: new Int32Array(N), cv: new Float32Array(N), bb: null };
  let bad = 0, first = '';
  const TOTAL = 1500;
  for (let it = 0; it < TOTAL; it++) {
    const kind = 1 + (it % 5), hard = it % 3 === 0;
    const hwq = 2 + Math.floor(rnd() * (hard ? 80 : 300)), hhq = hard ? hwq : 2 + Math.floor(rnd() * 240);
    const thq = hard ? [0, 90, 180, 270][Math.floor(rnd() * 4)] : Math.floor(rnd() * 360);
    const fxq = kind === 5 && rnd() < 0.7 ? Math.floor(rnd() * 60) : 0, fyq = kind === 5 && rnd() < 0.7 ? Math.floor(rnd() * 60) : 0;
    const q = [Math.floor(rnd() * W * 4), Math.floor(rnd() * H * 4), hwq, hhq, thq, 32, fxq, fyq], pr = shapeParams(q);
    const n1 = coverageRef(A, W, H, kind, pr.cx, pr.cy, pr.hw, pr.hh, pr.th, pr.fx, pr.fy);
    const n2 = coverageInto(B, W, H, kind, pr.cx, pr.cy, pr.hw, pr.hh, pr.th, pr.fx, pr.fy);
    let same = n1 === n2 && JSON.stringify(A.bb) === JSON.stringify(B.bb);
    if (same) for (let k = 0; k < n1; k++) if (A.px[k] !== B.px[k] || A.cv[k] !== B.cv[k]) { same = false; break; }
    if (!same) { bad++; if (!first) first = `kind ${kind} q=${JSON.stringify(q)} n ${n1}/${n2}`; }
  }
  return report('== 形状光栅化（coverageInto 对拍冻结的参考实现）', [
    [`随机 ${TOTAL} 个形状（五种）逐像素、覆盖率逐位相同`, bad === 0, bad ? `不一致 ${bad} 个，如 ${first}` : '不一致 0'],
  ]);
}

/** 精修的分块并行：与串行结果等价（MAE / 控件数差 ≤ 4%）、堆栈与共享内存里的误差缓存没有走偏（收尾自检 0 个不符）。
 *  串行路径（--no-parallel-refine）的逐位等价由开发时的对拍保证；这里只守「并行不比串行差」和「并行写入不出错」。 */
async function parallelRefineCheck() {
  const S = 256, raw = new Uint8Array(S * S * 3);
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {       // 渐变 + 圆 + 斜条，够多形状、够多跨分块的形状
    const o = (y * S + x) * 3, inC = (x - 90) ** 2 + (y - 100) ** 2 < 55 * 55, inD = Math.abs(x - y - 20) < 14;
    raw[o] = inC ? 240 : inD ? 30 : (x * 255 / S) | 0; raw[o + 1] = inC ? 60 : inD ? 200 : (y * 255 / S) | 0; raw[o + 2] = inC ? 40 : inD ? 120 : 128 + 60 * Math.sin(x / 13) * Math.cos(y / 19);
  }
  const T = 3, base = layered(raw, S, S, T);
  const opts = { strength: 0.9, passes: 2, kinds: ['ellipse', 'rotrect', 'triangle', 'ring'], preferRot: 8 };
  const ser = await fitShapes(raw, S, S, T, base.rects, { ...opts, threads: 1 });
  const par = await fitShapes(raw, S, S, T, base.rects, { ...opts, threads: 4, parallelRefine: true });
  const ctl = (r) => r.rects.length + r.shapes.length;
  return report('== 分块并行精修（shapes-tiles.mjs）', [
    ['并行收尾自检：缓存误差与堆栈重算一致（0 个像素不符）', par.stats.stackMismatch === 0, `不符 ${par.stats.stackMismatch}`],
    ['串行收尾自检同样为 0', ser.stats.stackMismatch === 0, `不符 ${ser.stats.stackMismatch}`],
    ['并行的 MAE 不比串行差 4% 以上', par.stats.mae <= ser.stats.mae * 1.04, `并行 ${par.stats.mae.toFixed(3)} / 串行 ${ser.stats.mae.toFixed(3)}`],
    ['并行的控件数与串行相差 ≤ 4%', Math.abs(ctl(par) - ctl(ser)) <= 0.04 * ctl(ser), `并行 ${ctl(par)} / 串行 ${ctl(ser)}`],
  ]);
}

function planCheck() {  const r = spawnSync(process.execPath, [path.join(HERE, 'plan.mjs'), '--selftest'], { encoding: 'utf8' });
  const lines = (r.stdout || '').trim().split('\n');
  return report('== plan.mjs（容量与建立路线决策）', [
    ['自检通过', r.status === 0, lines[lines.length - 1] || '(无输出)'],
  ]);
}

async function selftest() {
  const py = findPython();
  if (!py) { console.log('✗ 找不到带 Pillow + numpy 的 Python（可用环境变量 PYTHON 指定）。compress.py 依赖它们。'); return false; }
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'rect-merge-'));
  const env = { ...process.env, PYTHONUTF8: '1', PYTHONIOENCODING: 'utf-8' };
  // 合成图：渐变 + 圆 + 噪点 + 一条整宽纯色带（320 > 255，专门检查宽度上限的切分）
  const gen = `
import numpy as np, sys
from PIL import Image
N = 320
y, x = np.mgrid[0:N, 0:N]
img = np.zeros((N, N, 3), dtype=np.float64)
img[..., 0] = x * 255 / N
img[..., 1] = y * 255 / N
img[..., 2] = 128 + 60 * np.sin(x / 17.0) * np.cos(y / 23.0)
for cx, cy, r, col in [(80, 90, 40, (250, 40, 40)), (220, 160, 60, (30, 200, 90)), (150, 250, 30, (20, 20, 220))]:
    m = (x - cx) ** 2 + (y - cy) ** 2 < r * r
    img[m] = col
rng = np.random.default_rng(7)
img[200:260, 20:120] += rng.normal(0, 6, (60, 100, 3))
img[290:320, :] = (240, 240, 240)
img = np.clip(img, 0, 255).astype(np.uint8)
Image.fromarray(img).save(sys.argv[1])
open(sys.argv[2], 'wb').write(img.tobytes())
`;
  const png = path.join(tmp, 'synthetic.png'), rawPath = path.join(tmp, 'synthetic.rgb');
  let r = spawnSync(py, ['-c', gen, png, rawPath], { encoding: 'utf8', env });
  if (r.status !== 0) { console.log('✗ 生成合成图失败\n' + r.stderr); return false; }
  const raw = fs.readFileSync(rawPath);
  let ok = true;
  const render = path.join(HERE, 'render.lua');
  const tiledCount = {};
  for (const [enc, std, budget] of [['p64', 3, 0.012], ['b64', 3, 0], ['hex', 8, 0.012], ['layered', 3, 0.012], ['layered', 8, 0]]) {
    const isLayered = enc === 'layered';
    const out = path.join(tmp, `out_${enc}_${std}.lua`);
    const cli = [path.join(HERE, 'compress.py'), '--input', png, '--output', out, '--std', String(std), '--size', '320x320',
      '--enc', isLayered ? 'p64' : enc, ...(isLayered ? ['--layered'] : [])];
    r = spawnSync(py, cli, { encoding: 'utf8', env });
    if (r.status !== 0) { console.log(`✗ compress.py ${cli.slice(1).join(' ')} 失败\n${r.stdout}\n${r.stderr}`); ok = false; continue; }
    const info = parseData(fs.readFileSync(out, 'utf8'));
    const blocks = decode(info);
    const giaChecks = enc === 'p64' || isLayered ? giaRoundTrip(blocks, info, tmp, `${enc}_${std}`, py, env) : [];
    if (isLayered && std === 3) giaChecks.push(...await gilRoundTrip(blocks, info, out, tmp, `gil_${enc}_${std}`));
    if (isLayered) {
      const inv = layeredInvariant(blocks, raw, 320, 320, std);
      const ref = refGreedy(raw, 320, 320, std, 511).length;
      ok = report(`== 分层重长 p64  STD=${std}  FRAME_BUDGET=${budget}  块数 ${blocks.length}（铺满 ${ref}）`, [
        ['IMG.LAYERED = true', info.layered === true, String(info.layered)],
        ['块数不多于同 STD 的铺满', blocks.length <= ref, `${blocks.length} / ${ref}`],
        ['每个矩形露出的像素标准差 ≤ STD', inv.overStd === 0, `超标 ${inv.overStd}，最大 ${inv.worst.toFixed(3)}`],
        ['每个矩形颜色 = 露出像素均值', inv.badColor === 0, `不一致 ${inv.badColor}`],
        ['没有完全被盖住的矩形', inv.hidden === 0, `白建 ${inv.hidden}`],
        ...runRender(render, out, { budget }),
        ...giaChecks,
      ]) && ok;
      continue;
    }
    tiledCount[std] = blocks.length;
    const maxSide = enc === 'p64' ? 511 : 255;
    const ref = refGreedy(raw, 320, 320, std, maxSide);
    const key = (b) => `${b.x},${b.y},${b.w},${b.h}`;
    const got = new Set(blocks.map(key));
    const same = ref.length === blocks.length && ref.every(([x, y, w, h]) => got.has(`${x},${y},${w},${h}`));
    const widest = Math.max(...blocks.map((b) => b.w));
    ok = report(`== ${enc}  STD=${std}  FRAME_BUDGET=${budget}  块数 ${blocks.length}`, [
      ['compress.py 的块与独立 JS 贪心逐个相同', same, `${blocks.length} / ${ref.length}`],
      [`块宽不超过编码上限 ${maxSide}`, widest <= maxSide, `最宽 ${widest}`],
      ...runRender(render, out, { budget }),
      ...(enc === 'p64' ? autoModeChecks(render, out) : []),
      ...giaChecks,
    ]) && ok;
  }
  ok = report('== 边缘优先预算（--edge-aware）',
    await edgeAwareChecks(py, env, png, raw, tmp, path.join(HERE, 'render.lua'))) && ok;
  ok = report('== 预算对齐系数（layered.mjs budgetMultiplier）', budgetCalibrationChecks()) && ok;
  ok = planCheck() && ok;
  ok = coverageRefCheck() && ok;
  ok = await parallelRefineCheck() && ok;
  ok = await visualBudgetChecks(py, env, png, tmp) && ok;
  ok = await shapesCheck(py, env, png, raw, tmp, ok);
  ok = await rotationCheck(py, env, png, raw, tmp, ok);
  ok = degradeGuardCheck(tmp, ok);
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(ok ? '\n全部通过（离线模拟，不代表真机）' : '\n有失败项');
  return ok;
}

// ───────────────────────── 命令行 ─────────────────────────
const args = process.argv.slice(2);
const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
if (args[0] === '--selftest') {
  process.exit((await selftest()) ? 0 : 1);
} else if (args[0] === 'render' && args[1] && args[2]) {
  const budget = flag('--budget');
  if (args.includes('--measure')) {
    const m = runRender(args[1], args[2], { budget, measure: true });
    console.log(`脚本侧解释器步数 ${m.steps}，引擎调用 ${m.calls} 次，新建控件 ${m.created}，${m.frames} 帧（离线解释器口径，只用于比较写法）`);
  } else {
    process.exit(report(`== ${path.basename(args[2])}`, runRender(args[1], args[2], { budget })) ? 0 : 1);
  }
} else {
  console.log(`用法：
  node scripts/rect-merge/check.mjs --selftest
  node scripts/rect-merge/check.mjs render <render.lua> <数据.lua> [--budget 秒] [--measure]`);
  process.exit(args.length ? 1 : 0);
}
