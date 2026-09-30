/**
 * cfloat.mjs —— 按 C 语言 printf 的规则把浮点数格式化成 %f / %e / %g
 *
 * 为什么不用 JS 自带的 toFixed / toExponential / toPrecision：
 *   遇到「精确平局」时两者舍入方向不同。C 的 printf 对精确值平局取偶（banker's），JS 取较大者：
 *       string.format("%.1f", 0.25)  C → 0.2    JS toFixed → 0.3
 *       string.format("%.0f", 2.5)   C → 2      JS toFixed → 3
 *   x.5 / x.25 / x.75 这类值在分数、倍率、百分比显示里很常见，差一位就是「真机显示 2.2，模拟器显示 2.3」。
 * 做法：把 double 精确展开成 尾数 × 2^指数（BigInt），用整数除法 + 余数比较做「四舍六入五取偶」。
 *
 * 所有函数的 x 要求是有限的非负数；符号、inf、nan 由调用方处理。
 */

const buf = new DataView(new ArrayBuffer(8));

/** double → { mant: BigInt, exp: number }，x = mant × 2^exp */
export function decompose(x) {
  buf.setFloat64(0, x);
  const hi = buf.getUint32(0);
  const lo = buf.getUint32(4);
  const e = (hi >>> 20) & 0x7ff;
  const frac = (BigInt(hi & 0xfffff) << 32n) | BigInt(lo);
  if (e === 0) return { mant: frac, exp: -1074 };
  return { mant: frac | (1n << 52n), exp: e - 1075 };
}

/** round_half_even(x × 10^k)，k 可正可负；返回 BigInt */
function scaledRound(x, k) {
  const { mant, exp } = decompose(x);
  let num = mant;
  let den = 1n;
  if (exp >= 0) num <<= BigInt(exp); else den <<= BigInt(-exp);
  if (k >= 0) num *= 10n ** BigInt(k); else den *= 10n ** BigInt(-k);
  const q = num / den;
  const r2 = (num % den) * 2n;
  if (r2 > den || (r2 === den && (q & 1n) === 1n)) return q + 1n;
  return q;
}

/** %.{prec}f */
export function fmtFixed(x, prec) {
  const q = scaledRound(x, prec).toString();
  if (prec === 0) return q;
  const s = q.padStart(prec + 1, '0');
  return `${s.slice(0, -prec)}.${s.slice(-prec)}`;
}

/** 十进制科学计数的数字部分：prec+1 位有效数字与十进制指数（x > 0） */
function sci(x, prec) {
  let E = Math.floor(Math.log10(x));
  const lo = 10n ** BigInt(prec);
  const hi = lo * 10n;
  for (let i = 0; i < 4; i++) {
    const d = scaledRound(x, prec - E);
    if (d < lo) { E--; continue; }
    if (d >= hi) { E++; continue; }
    return { digits: d.toString(), exp: E };
  }
  throw new Error('cfloat.sci 没有收敛');                     // 不应该发生
}

const pad2 = (n) => String(n).padStart(2, '0');

/** %.{prec}e（指数至少两位，与 C 一致） */
export function fmtExp(x, prec) {
  if (x === 0) return `${prec > 0 ? `0.${'0'.repeat(prec)}` : '0'}e+00`;
  const { digits, exp } = sci(x, prec);
  const mant = prec > 0 ? `${digits[0]}.${digits.slice(1)}` : digits;
  return `${mant}e${exp < 0 ? '-' : '+'}${pad2(Math.abs(exp))}`;
}

/** %.{prec}g；alt=true 相当于 # 标志（保留末尾的 0） */
export function fmtGC(x, prec, alt = false) {
  if (prec === 0) prec = 1;
  if (x === 0) return alt && prec > 1 ? `0.${'0'.repeat(prec - 1)}` : '0';
  const { digits, exp } = sci(x, prec - 1);
  const strip = (s) => (alt || !s.includes('.') ? s : s.replace(/0+$/, '').replace(/\.$/, ''));
  if (exp < -4 || exp >= prec) {
    const mant = strip(prec > 1 ? `${digits[0]}.${digits.slice(1)}` : digits);
    return `${mant}e${exp < 0 ? '-' : '+'}${pad2(Math.abs(exp))}`;
  }
  return strip(fmtFixed(x, prec - 1 - exp));
}
