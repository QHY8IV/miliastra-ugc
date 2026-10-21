/**
 * shapes-worker.mjs —— 形状拟合的工作线程。由 shapes.mjs 的 fitShapes 启动，两种任务：
 *   · 搜索（默认）：接收 { id, seeds:[{i,col,bb,px}] }，回复 { id, out:[{i,cand}] }。只读共享内存里的快照，不写。
 *   · 精修分块（type = 'refine'）：接收 { id, type, job, sweeps }，在自己的局部像素堆栈上精修一个分块里的形状，
 *     把有变化的形状回传 { id, res }；cur / err 直接写共享内存（各分块的像素互不重叠）。见 shapes-tiles.mjs。
 */
import { parentPort, workerData } from 'node:worker_threads';
import { makeSearch } from './shapes-core.mjs';
import { makeTileWorker } from './shapes-tiles.mjs';

const d = workerData;
const search = makeSearch({
  raw: new Uint8Array(d.rawBuf), W: d.W, H: d.H, T: d.T, LAMBDA: d.LAMBDA,
  cur: new Float32Array(d.curBuf), err: new Float32Array(d.errBuf), topArr: new Int32Array(d.topBuf),
  vis: new Int32Array(d.visBuf), aliveArr: new Uint8Array(d.aliveBuf), bbArr: new Int32Array(d.bbBuf),
  kinds: d.kinds, noRotation: d.noRotation, rotCost: d.rotCost, preferRot: d.preferRot, maxEval: d.maxEval, alphaOn: d.alphaOn,
  weights: d.weightsBuf ? new Float32Array(d.weightsBuf) : null,
});
let tileRun = null;
parentPort.on('message', (m) => {
  if (m.type === 'refine') {
    tileRun ??= makeTileWorker(d);
    const { res, transfer } = tileRun(m.job, m.sweeps);
    parentPort.postMessage({ id: m.id, res }, transfer);
    return;
  }
  parentPort.postMessage({ id: m.id, out: m.seeds.map((s) => ({ i: s.i, cand: search.searchSeed(s) })) });
});
