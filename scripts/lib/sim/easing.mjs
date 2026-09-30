/**
 * easing.mjs —— Enum.EaseType 的 31 个缓动曲线（t ∈ [0,1] → 进度）
 *
 * 用的是通行的 Penner 缓动公式（easings.net 版本）。
 * 【模型】官方文档只给了名字与中文说明（「回弹缓出」…），没给曲线；引擎实际用的可能是 DOTween 一类的实现，
 * 弹性 / 回弹的振幅与周期可能有细微差别。所以离线模拟只应该断言「起点 / 终点 / 是否过冲」，不要断言中间帧的精确值。
 */

const c1 = 1.70158;
const c2 = c1 * 1.525;
const c3 = c1 + 1;
const c4 = (2 * Math.PI) / 3;
const c5 = (2 * Math.PI) / 4.5;

const outBounce = (t) => {
  const n1 = 7.5625;
  const d1 = 2.75;
  if (t < 1 / d1) return n1 * t * t;
  if (t < 2 / d1) return n1 * (t -= 1.5 / d1) * t + 0.75;
  if (t < 2.5 / d1) return n1 * (t -= 2.25 / d1) * t + 0.9375;
  return n1 * (t -= 2.625 / d1) * t + 0.984375;
};

export const EASE = {
  Linear: (t) => t,
  InSine: (t) => 1 - Math.cos((t * Math.PI) / 2),
  OutSine: (t) => Math.sin((t * Math.PI) / 2),
  InOutSine: (t) => -(Math.cos(Math.PI * t) - 1) / 2,
  InQuad: (t) => t * t,
  OutQuad: (t) => 1 - (1 - t) * (1 - t),
  InOutQuad: (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2),
  InCubic: (t) => t ** 3,
  OutCubic: (t) => 1 - (1 - t) ** 3,
  InOutCubic: (t) => (t < 0.5 ? 4 * t ** 3 : 1 - ((-2 * t + 2) ** 3) / 2),
  InQuart: (t) => t ** 4,
  OutQuart: (t) => 1 - (1 - t) ** 4,
  InOutQuart: (t) => (t < 0.5 ? 8 * t ** 4 : 1 - ((-2 * t + 2) ** 4) / 2),
  InQuint: (t) => t ** 5,
  OutQuint: (t) => 1 - (1 - t) ** 5,
  InOutQuint: (t) => (t < 0.5 ? 16 * t ** 5 : 1 - ((-2 * t + 2) ** 5) / 2),
  InExpo: (t) => (t === 0 ? 0 : 2 ** (10 * t - 10)),
  OutExpo: (t) => (t === 1 ? 1 : 1 - 2 ** (-10 * t)),
  InOutExpo: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5 ? 2 ** (20 * t - 10) / 2 : (2 - 2 ** (-20 * t + 10)) / 2),
  InCirc: (t) => 1 - Math.sqrt(1 - t * t),
  OutCirc: (t) => Math.sqrt(1 - (t - 1) ** 2),
  InOutCirc: (t) => (t < 0.5 ? (1 - Math.sqrt(1 - (2 * t) ** 2)) / 2 : (Math.sqrt(1 - (-2 * t + 2) ** 2) + 1) / 2),
  InBack: (t) => c3 * t ** 3 - c1 * t * t,
  OutBack: (t) => 1 + c3 * (t - 1) ** 3 + c1 * (t - 1) ** 2,
  InOutBack: (t) => (t < 0.5 ? ((2 * t) ** 2 * ((c2 + 1) * 2 * t - c2)) / 2 : ((2 * t - 2) ** 2 * ((c2 + 1) * (t * 2 - 2) + c2) + 2) / 2),
  InElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : -(2 ** (10 * t - 10)) * Math.sin((t * 10 - 10.75) * c4)),
  OutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : 2 ** (-10 * t) * Math.sin((t * 10 - 0.75) * c4) + 1),
  InOutElastic: (t) => (t === 0 ? 0 : t === 1 ? 1 : t < 0.5
    ? -(2 ** (20 * t - 10) * Math.sin((20 * t - 11.125) * c5)) / 2
    : (2 ** (-20 * t + 10) * Math.sin((20 * t - 11.125) * c5)) / 2 + 1),
  InBounce: (t) => 1 - outBounce(1 - t),
  OutBounce: outBounce,
  InOutBounce: (t) => (t < 0.5 ? (1 - outBounce(1 - 2 * t)) / 2 : (1 + outBounce(2 * t - 1)) / 2),
};
