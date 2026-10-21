#!/usr/bin/env python3
"""GPU 形状搜索服务（2026-10-21）：由 shapes.mjs 以子进程方式启动，通过 stdin / stdout 交换二进制帧。

只做 shapes-core.mjs searchSeed 里「打分 + 爬山」这一半：起点列表（initFromRegion + initsFor）由 Node 算好发来，
这里在 GPU 上给所有起点打分 → 每个（种子, 种类）取最好的 1 个（三角形 2 个）→ 并行爬山 → 每个种子取最好的候选。
对拍结果（400 px，3000 个种子）：种类一致 99.8%，种类与参数完全一致 99.3%，得分相对差中位数 6e-8。

依赖：torch（CUDA）+ triton（Windows 上是 triton-windows）。导入失败或没有 CUDA 时 shapes.mjs 自动退回 CPU 线程池。

帧：[u8 操作码][u64 小端长度][载荷]；回复：[u8 状态 0 = ok / 1 = 出错][u32 长度][载荷]。
  1 INIT        载荷 = u32 jsonLen + json + raw u8[N*3] + （hasWeights 时）w f32[N]
  2 SYNC_FULL   载荷 = cur f32[N*3] | err f32[N] | top i32[N] | vis i32[CAP] | alive u8[CAP] | bb i32[CAP*4]
  3 SYNC_DELTA  载荷 = u32 np, u32 ns | idx i32[np] cur f32[np*3] err f32[np] top i32[np] | ids i32[ns] vis i32[ns] alive u8[ns] bb i32[ns*4]
  4 SEARCH      载荷 = u32 n | rb f32[n] | nst u16[n] | kind u8[S] | v i32[S*6]    回复 = found u8[n] kind u8[n] q i32[n*6] j f32[n]
  5 QUIT
"""
import json
import struct
import sys
import time

import numpy as np

out_stream = sys.stdout.buffer
sys.stdout = sys.stderr            # 任何 print / 库的输出都走 stderr，stdout 只留给帧
inp = sys.stdin.buffer


def log(*a):
    print('[gpu]', *a, file=sys.stderr, flush=True)


def read_exact(n):
    buf = bytearray()
    while len(buf) < n:
        chunk = inp.read(n - len(buf))
        if not chunk:
            raise EOFError('stdin 关闭')
        buf += chunk
    return bytes(buf)


def reply(status, payload=b''):
    out_stream.write(struct.pack('<BI', status, len(payload)) + payload)
    out_stream.flush()


try:
    import torch
    import triton
    import gpu_search_kernels as G
    if not torch.cuda.is_available():
        raise RuntimeError('torch.cuda 不可用')
except Exception as e:                                  # noqa: BLE001
    # 起不来也要回一帧，让 Node 知道原因并退回 CPU
    op = inp.read(1)
    reply(1, f'GPU 搜索不可用：{type(e).__name__}: {e}'.encode('utf-8'))
    sys.exit(2)

dev = torch.device('cuda')
S = {}                                                  # 服务状态：meta、静态张量、动态张量、私有计数数组


def to_t(a, dt):
    return torch.from_numpy(np.ascontiguousarray(a)).to(dev, dtype=dt)


def op_init(p):
    jl = struct.unpack('<I', p[:4])[0]
    meta = json.loads(p[4:4 + jl].decode('utf-8'))
    W, H = meta['W'], meta['H']; N = W * H
    body = p[4 + jl:]
    raw = np.frombuffer(body, np.uint8, N * 3, 0)
    S.update(meta=meta, W=W, H=H, N=N, CAP=meta['CAP'], weighted=bool(meta['hasWeights']))
    S['raw'] = to_t(raw, torch.uint8)
    S['w'] = to_t(np.frombuffer(body, np.float32, N, N * 3), torch.float32) if S['weighted'] else torch.zeros(1, device=dev)
    S['nprog'] = int(meta.get('nprog', 1024)); S['side'] = int(meta.get('side', 8)); S['warps'] = int(meta.get('warps', 2))
    S['capf'] = S['CAP'] + 8
    S['f'] = torch.zeros(S['nprog'] * S['capf'], dtype=torch.int32, device=dev)
    S['scr_n'] = int(meta.get('scr', 65536))                 # 每个程序的覆盖率缓存（float 个数）；候选更大时退回重算
    S['scr'] = torch.zeros(max(1, S['nprog'] * S['scr_n']), dtype=torch.float32, device=dev)
    kinds = meta['kinds']
    code = {'ellipse': 1, 'rotrect': 2, 'triangle': 3, 'ring': 4}
    if any(k not in code for k in kinds): raise ValueError('GPU 搜索只支持 ellipse / rotrect / triangle / ring，收到 %r' % (kinds,))
    S['krank'] = np.full(8, 99, np.int64)
    for r, k in enumerate(kinds): S['krank'][code[k]] = r
    S['npar'] = 6 if meta['alphaOn'] else 5
    return b'ok'


def op_sync_full(p):
    N, CAP = S['N'], S['CAP']; o = 0
    S['cur'] = to_t(np.frombuffer(p, np.float32, N * 3, o), torch.float32); o += N * 12
    S['err'] = to_t(np.frombuffer(p, np.float32, N, o), torch.float32); o += N * 4
    S['top'] = to_t(np.frombuffer(p, np.int32, N, o), torch.int32); o += N * 4
    S['vis'] = to_t(np.frombuffer(p, np.int32, CAP, o), torch.int32); o += CAP * 4
    S['alive'] = to_t(np.frombuffer(p, np.uint8, CAP, o), torch.uint8); o += CAP
    S['bb'] = to_t(np.frombuffer(p, np.int32, CAP * 4, o), torch.int32)
    return b'ok'


def op_sync_delta(p):
    npx, ns = struct.unpack('<II', p[:8]); o = 8
    if npx:
        idx = to_t(np.frombuffer(p, np.int32, npx, o), torch.int64); o += npx * 4
        cur = to_t(np.frombuffer(p, np.float32, npx * 3, o), torch.float32).view(npx, 3); o += npx * 12
        err = to_t(np.frombuffer(p, np.float32, npx, o), torch.float32); o += npx * 4
        top = to_t(np.frombuffer(p, np.int32, npx, o), torch.int32); o += npx * 4
        S['cur'].view(-1, 3)[idx] = cur; S['err'][idx] = err; S['top'][idx] = top
    if ns:
        ids = to_t(np.frombuffer(p, np.int32, ns, o), torch.int64); o += ns * 4
        S['vis'][ids] = to_t(np.frombuffer(p, np.int32, ns, o), torch.int32); o += ns * 4
        S['alive'][ids] = to_t(np.frombuffer(p, np.uint8, ns, o), torch.uint8); o += ns
        S['bb'].view(-1, 4)[ids] = to_t(np.frombuffer(p, np.int32, ns * 4, o), torch.int32).view(ns, 4)
    return b'ok'


def snap():
    return (S['raw'], S['cur'], S['err'], S['top'], S['vis'], S['alive'], S['bb'], S['w'])


def op_search(p):
    n = struct.unpack('<I', p[:4])[0]; o = 4
    rb = np.frombuffer(p, np.float32, n, o); o += n * 4
    nst = np.frombuffer(p, np.uint16, n, o).astype(np.int64); o += n * 2
    tot = int(nst.sum())
    kind = np.frombuffer(p, np.uint8, tot, o).astype(np.int32); o += tot
    v = np.frombuffer(p, np.int32, tot * 6, o).reshape(tot, 6)
    meta = S['meta']; W, H = S['W'], S['H']; lam = float(meta['LAMBDA']); rotc = float(meta['rotCost'])
    found = np.zeros(n, np.uint8); okind = np.zeros(n, np.uint8); oq = np.zeros((n, 6), np.int32); oj = np.zeros(n, np.float32)
    if tot == 0:
        return found.tobytes() + okind.tobytes() + oq.tobytes() + oj.tobytes()
    seed_of = np.repeat(np.arange(n), nst)
    rb_s = rb[seed_of]
    v8 = np.zeros((tot, 8), np.int32); v8[:, :6] = v
    side, warps, nprog, capf = S['side'], S['warps'], S['nprog'], S['capf']
    wt = S['weighted']
    # ---- 阶段 A：所有起点打分 ----
    t_kind = to_t(kind, torch.int32); t_v = to_t(v8, torch.int32); t_rb = to_t(rb_s, torch.float32)
    sc_t = torch.empty(tot, dtype=torch.float32, device=dev)
    G.score_kernel[(nprog,)](t_kind, t_v, t_rb, S['f'], S['scr'], tot, *snap(), sc_t, W, H, lam, rotc, capf, WEIGHTED=wt, SIDE=side, SCR=S['scr_n'], num_warps=warps)
    sc = sc_t.cpu().numpy()
    # ---- 选起点：每个（种子, 种类）按得分稳定排序取最好 1 个（三角形 2 个），无限分跳过 ----
    key = seed_of * 8 + S['krank'][kind]
    order = np.lexsort((np.arange(tot), sc, key))
    sk = key[order]
    first = np.r_[True, sk[1:] != sk[:-1]]
    gstart = np.maximum.accumulate(np.where(first, np.arange(tot), 0))
    pos = np.arange(tot) - gstart
    lim = np.where(kind[order] == 3, 2, 1)
    sel = order[(pos < lim) & (sc[order] < 1e29)]
    if len(sel) == 0:
        return found.tobytes() + okind.tobytes() + oq.tobytes() + oj.tobytes()
    # ---- 阶段 B：并行爬山 ----
    m = len(sel)
    ov = torch.empty(m * 8, dtype=torch.int32, device=dev); ob = torch.empty(m, dtype=torch.float32, device=dev); oe = torch.empty(m, dtype=torch.int32, device=dev)
    G.climb_kernel[(nprog,)](to_t(kind[sel], torch.int32), to_t(v8[sel], torch.int32), to_t(sc[sel], torch.float32), to_t(rb_s[sel], torch.float32),
                             S['f'], S['scr'], m, *snap(), ov, ob, oe, W, H, lam, rotc, capf, int(meta['maxEval']), S['npar'], WEIGHTED=wt, SIDE=side, SCR=S['scr_n'], num_warps=warps)
    fv = ov.cpu().numpy().reshape(m, 8)[:, :6].copy(); fj = ob.cpu().numpy()
    fk = kind[sel]; fs = seed_of[sel]
    rnd = np.isin(fk, (1, 4)) & (fv[:, 2] == fv[:, 3])
    fv[rnd, 4] = 0                                           # 圆转不转都一样，不花旋转的代价
    # ---- 每个种子取得分最小且 < 0 的（并列取先出现的）----
    jj = np.where(fj < 0, fj, np.inf)
    ordr = np.lexsort((np.arange(m), jj, fs))
    fs_o = fs[ordr]; firstm = np.r_[True, fs_o[1:] != fs_o[:-1]]
    pick = ordr[firstm]
    pick = pick[np.isfinite(jj[pick])]
    found[fs[pick]] = 1; okind[fs[pick]] = fk[pick]; oq[fs[pick]] = fv[pick]; oj[fs[pick]] = fj[pick]
    return found.tobytes() + okind.tobytes() + oq.tobytes() + oj.tobytes()


OPS = {1: op_init, 2: op_sync_full, 3: op_sync_delta, 4: op_search}
log('就绪：torch', torch.__version__, '| triton', triton.__version__, '|', torch.cuda.get_device_name(0))
while True:
    try:
        hdr = inp.read(9)
        if len(hdr) < 9: break
        op = hdr[0]; ln = struct.unpack('<Q', hdr[1:])[0]
        if op == 5: reply(0, b'bye'); break
        payload = read_exact(ln) if ln else b''
        t0 = time.time()
        res = OPS[op](payload)
        if op == 4: torch.cuda.synchronize()
        reply(0, res)
    except EOFError:
        break
    except Exception as e:                              # noqa: BLE001
        import traceback
        log(traceback.format_exc())
        reply(1, f'{type(e).__name__}: {e}'.encode('utf-8'))
