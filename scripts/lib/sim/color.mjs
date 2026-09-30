/**
 * color.mjs —— Color(r,g,b,a) 的打包与拆包
 *
 * 【文档】Color(r,g,b,a?) 取 0–255，a 省略或 nil = 255。【真机】运行时 Color 是打包整数（契约 §8）。
 * 【未确认】通道字节序。这里取 0xAARRGGBB；脚本不应该依赖打包后的数值，只应通过 Color.ToRGBA 拆。
 */

export function packColor(r, g, b, a = 255) {
  const c = (x) => Math.max(0, Math.min(255, Math.round(x)));
  return BigInt(((c(a) * 2 ** 24) + (c(r) << 16) + (c(g) << 8) + c(b)));
}

export function unpackColor(v) {
  const n = Number(BigInt.asUintN(32, BigInt(v)));
  return { r: (n >>> 16) & 255, g: (n >>> 8) & 255, b: n & 255, a: Math.floor(n / 2 ** 24) & 255 };
}
