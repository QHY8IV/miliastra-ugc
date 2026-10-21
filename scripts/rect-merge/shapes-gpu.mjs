/**
 * shapes-gpu.mjs —— 形状搜索的 GPU 客户端（2026-10-21）。
 *
 * 启动 gpu_search_server.py 子进程（PyTorch + Triton，见该文件头部的帧格式），负责：
 *   · 把搜索快照（cur / err / topArr / vis / alive / bb）同步给 GPU：第一次全量，之后只发「比上次发出去的多变了什么」（增量，
 *     用一份影子数组逐元素比对得到，不需要改 fitShapes 里任何热路径）；
 *   · 把一批种子的起点列表发过去，取回每个种子最好的候选（种类、参数、得分）。
 * 起点列表（initFromRegion + initsFor）仍由 JS 算（shapes-core.mjs 的 startsFor），打分与爬山在 GPU 上，
 * tryAdd 仍是 CPU 上的精确判据——所以 GPU 只影响「候选从哪来」，不影响结果的正确性。
 */
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const buf = (a) => Buffer.from(a.buffer, a.byteOffset, a.byteLength);
const u32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n >>> 0); return b; };

export async function startGpu({ python = 'python', meta, raw, weights, log = () => {} }) {
  const proc = spawn(python, ['-X', 'utf8', path.join(HERE, 'gpu_search_server.py')], { cwd: HERE, stdio: ['pipe', 'pipe', 'pipe'] });
  let chunks = [], have = 0, dead = null;
  const waiters = [];
  const pump = () => {
    while (waiters.length && have >= waiters[0].n) {
      const w = waiters.shift(); const all = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
      const out = Buffer.from(all.subarray(0, w.n)); const rest = all.subarray(w.n);
      chunks = rest.length ? [rest] : []; have = rest.length; w.res(out);
    }
  };
  proc.stdout.on('data', (d) => { chunks.push(d); have += d.length; pump(); });
  const fail = (e) => { dead = dead || e; waiters.splice(0).forEach((w) => w.rej(dead)); };
  proc.on('exit', (c) => fail(new Error(`GPU 进程已退出（${c}）`)));
  proc.on('error', (e) => fail(e));
  proc.stdin.on('error', (e) => fail(e));
  const stderrTail = [];
  proc.stderr.on('data', (d) => { const s = String(d).trim(); if (s) { stderrTail.push(s); if (stderrTail.length > 20) stderrTail.shift(); if (process.env.DSH_GPU_LOG) log('[gpu] ' + s); } });
  const readN = (n) => new Promise((res, rej) => { if (dead) return rej(dead); waiters.push({ n, res, rej }); pump(); });
  const write = (b) => new Promise((res, rej) => { if (dead) return rej(dead); proc.stdin.write(b, (e) => (e ? rej(e) : res())); });
  const rpc = async (op, payload) => {
    const hdr = Buffer.alloc(9); hdr.writeUInt8(op, 0); hdr.writeBigUInt64LE(BigInt(payload.length), 1);
    await write(hdr); if (payload.length) await write(payload);
    const h = await readN(5); const st = h.readUInt8(0), ln = h.readUInt32LE(1);
    const body = ln ? await readN(ln) : Buffer.alloc(0);
    if (st !== 0) throw new Error(body.toString('utf8') || 'GPU 服务返回错误');
    return body;
  };
  const mj = Buffer.from(JSON.stringify(meta), 'utf8');
  try { await rpc(1, Buffer.concat([u32(mj.length), mj, buf(raw), ...(weights ? [buf(weights)] : [])])); }
  catch (e) { try { proc.kill(); } catch { /* 已退出 */ } throw new Error(e.message + (stderrTail.length ? '（' + stderrTail.slice(-3).join(' | ').slice(0, 300) + '）' : '')); }

  // ---- 状态同步 ----
  const { W, H, CAP } = meta, N = W * H;
  let sCur = null, sErr = null, sTop = null, sVis = null, sAlive = null, sBb = null;
  const idx = new Int32Array(N);                                  // 增量里变了的像素序号（最多 N 个），反复使用
  const tm = { scan: 0, rpcSync: 0, rpcSearch: 0, pack: 0, nsync: 0, nsearch: 0, px: 0, sh: 0 };
  async function sync(cur, err, topArr, vis, aliveArr, bbArr, nShapes) {
    const tS = Date.now(); tm.nsync++;
    if (!sCur) {
      await rpc(2, Buffer.concat([buf(cur), buf(err), buf(topArr), buf(vis), buf(aliveArr), buf(bbArr)]));
      sCur = new Float32Array(cur); sErr = new Float32Array(err); sTop = new Int32Array(topArr); sVis = new Int32Array(vis); sAlive = new Uint8Array(aliveArr); sBb = new Int32Array(bbArr);
      tm.rpcSync += Date.now() - tS; return { px: N, shapes: CAP };
    }
    let np = 0;
    for (let p = 0; p < N; p++) {
      const p3 = p * 3;
      if (err[p] !== sErr[p] || topArr[p] !== sTop[p] || cur[p3] !== sCur[p3] || cur[p3 + 1] !== sCur[p3 + 1] || cur[p3 + 2] !== sCur[p3 + 2]) {
        idx[np++] = p; sErr[p] = err[p]; sTop[p] = topArr[p]; sCur[p3] = cur[p3]; sCur[p3 + 1] = cur[p3 + 1]; sCur[p3 + 2] = cur[p3 + 2];
      }
    }
    let ns = 0; const sid = new Int32Array(nShapes);
    for (let i = 0; i < nShapes; i++) {
      const i4 = i * 4;
      if (vis[i] !== sVis[i] || aliveArr[i] !== sAlive[i] || bbArr[i4] !== sBb[i4] || bbArr[i4 + 1] !== sBb[i4 + 1] || bbArr[i4 + 2] !== sBb[i4 + 2] || bbArr[i4 + 3] !== sBb[i4 + 3]) {
        sid[ns++] = i; sVis[i] = vis[i]; sAlive[i] = aliveArr[i]; sBb[i4] = bbArr[i4]; sBb[i4 + 1] = bbArr[i4 + 1]; sBb[i4 + 2] = bbArr[i4 + 2]; sBb[i4 + 3] = bbArr[i4 + 3];
      }
    }
    tm.scan += Date.now() - tS; tm.px += np; tm.sh += ns;
    if (!np && !ns) return { px: 0, shapes: 0 };
    const tR = Date.now();
    const ip = idx.subarray(0, np), is = sid.subarray(0, ns);
    const cp = new Float32Array(np * 3), ep = new Float32Array(np), tp = new Int32Array(np);
    for (let k = 0; k < np; k++) { const p = ip[k]; cp[k * 3] = cur[p * 3]; cp[k * 3 + 1] = cur[p * 3 + 1]; cp[k * 3 + 2] = cur[p * 3 + 2]; ep[k] = err[p]; tp[k] = topArr[p]; }
    const vs = new Int32Array(ns), as = new Uint8Array(ns), bs = new Int32Array(ns * 4);
    for (let k = 0; k < ns; k++) { const i = is[k]; vs[k] = vis[i]; as[k] = aliveArr[i]; bs[k * 4] = bbArr[i * 4]; bs[k * 4 + 1] = bbArr[i * 4 + 1]; bs[k * 4 + 2] = bbArr[i * 4 + 2]; bs[k * 4 + 3] = bbArr[i * 4 + 3]; }
    await rpc(3, Buffer.concat([u32(np), u32(ns), buf(Int32Array.from(ip)), buf(cp), buf(ep), buf(tp), buf(Int32Array.from(is)), buf(vs), buf(as), buf(bs)]));
    tm.rpcSync += Date.now() - tR; return { px: np, shapes: ns };
  }

  /** 一批种子（{ rb, starts: [{ kind, v }] }）→ { found, kind, q, j }（按输入顺序） */
  async function search(batch) {
    const n = batch.length; let tot = 0; for (const s of batch) tot += s.starts.length;
    const rb = new Float32Array(n), nst = new Uint16Array(n), kind = new Uint8Array(tot), v = new Int32Array(tot * 6);
    let o = 0;
    batch.forEach((s, i) => { rb[i] = s.rb; nst[i] = s.starts.length; for (const st of s.starts) { kind[o] = st.kind; for (let k = 0; k < 6; k++) v[o * 6 + k] = st.v[k]; o++; } });
    const tP = Date.now(); tm.nsearch++;
    const payload = Buffer.concat([u32(n), buf(rb), buf(nst), buf(kind), buf(v)]); tm.pack += Date.now() - tP;
    const tQ = Date.now(); const r = await rpc(4, payload); tm.rpcSearch += Date.now() - tQ;
    const cp = (a, b) => new Uint8Array(r.subarray(a, b)).slice();
    return { found: cp(0, n), kind: cp(n, 2 * n), q: new Int32Array(cp(2 * n, 2 * n + n * 24).buffer), j: new Float32Array(cp(2 * n + n * 24, 2 * n + n * 28).buffer) };
  }

  async function close() {
    if (process.env.DSH_GPU_LOG) log(`[gpu 客户端计时] 同步 ${tm.nsync} 次：扫描 ${(tm.scan / 1000).toFixed(2)}s、传输 ${(tm.rpcSync / 1000).toFixed(2)}s、共 ${tm.px} 像素 / ${tm.sh} 形状；搜索 ${tm.nsearch} 次：打包 ${(tm.pack / 1000).toFixed(2)}s、往返 ${(tm.rpcSearch / 1000).toFixed(2)}s`); try { await rpc(5, Buffer.alloc(0)); } catch { /* 已退出 */ } try { proc.kill(); } catch { /* 已退出 */ } }
  return { sync, search, close };
}
