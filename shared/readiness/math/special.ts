/**
 * Special functions for the readiness statistics: log-gamma, the regularized incomplete beta and
 * its inverse, the normal CDF and quantile, and the logit helpers. Pure, deterministic and free
 * of dependencies, so the browser, the Worker and Node produce identical numbers.
 */

/** Lanczos coefficients (g = 7, n = 9); relative error about 1e-15 for x > 0. */
const LANCZOS = [
  0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
  12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7,
] as const;
const HALF_LOG_TWO_PI = 0.5 * Math.log(2 * Math.PI);

/** ln Γ(x) for x > 0 (reflection below 0.5 keeps the Lanczos series accurate). */
export function logGamma(x: number): number {
  if (!(x > 0)) return x === 0 ? Infinity : NaN;
  if (x < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * x)) - logGamma(1 - x);
  const z = x - 1;
  let sum = LANCZOS[0];
  for (let i = 1; i < LANCZOS.length; i++) sum += LANCZOS[i]! / (z + i);
  const t = z + 7.5;
  return HALF_LOG_TWO_PI + (z + 0.5) * Math.log(t) - t + Math.log(sum);
}

/** ln B(a, b). */
export function logBeta(a: number, b: number): number {
  return logGamma(a) + logGamma(b) - logGamma(a + b);
}

/** Digamma ψ(x) for x > 0: recurrence up to 6, then the asymptotic series. */
export function digamma(x: number): number {
  let result = 0;
  let v = x;
  while (v < 6) {
    result -= 1 / v;
    v += 1;
  }
  const inv = 1 / v;
  const inv2 = inv * inv;
  return (
    result +
    Math.log(v) -
    0.5 * inv -
    inv2 * (1 / 12 - inv2 * (1 / 120 - inv2 * (1 / 252 - inv2 * (1 / 240 - inv2 * (1 / 132)))))
  );
}

/** Trigamma ψ'(x) for x > 0. */
export function trigamma(x: number): number {
  let result = 0;
  let v = x;
  while (v < 6) {
    result += 1 / (v * v);
    v += 1;
  }
  const inv = 1 / v;
  const inv2 = inv * inv;
  return (
    result +
    inv +
    0.5 * inv2 +
    inv * inv2 * (1 / 6 - inv2 * (1 / 30 - inv2 * (1 / 42 - inv2 * (1 / 30 - inv2 * (5 / 66)))))
  );
}

const CF_EPS = 1e-15;
const CF_TINY = 1e-300;
const CF_MAX_ITER = 10_000;

/** Continued fraction for the incomplete beta (modified Lentz, Numerical Recipes 6.4). */
function betaContinuedFraction(x: number, a: number, b: number): number {
  const qab = a + b;
  const qap = a + 1;
  const qam = a - 1;
  let c = 1;
  let d = 1 - (qab * x) / qap;
  if (Math.abs(d) < CF_TINY) d = CF_TINY;
  d = 1 / d;
  let h = d;
  for (let m = 1; m <= CF_MAX_ITER; m++) {
    const m2 = 2 * m;
    let aa = (m * (b - m) * x) / ((qam + m2) * (a + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < CF_TINY) d = CF_TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < CF_TINY) c = CF_TINY;
    d = 1 / d;
    h *= d * c;
    aa = (-(a + m) * (qab + m) * x) / ((a + m2) * (qap + m2));
    d = 1 + aa * d;
    if (Math.abs(d) < CF_TINY) d = CF_TINY;
    c = 1 + aa / c;
    if (Math.abs(c) < CF_TINY) c = CF_TINY;
    d = 1 / d;
    const delta = d * c;
    h *= delta;
    if (Math.abs(delta - 1) < CF_EPS) break;
  }
  return h;
}

/** Regularized incomplete beta I_x(a, b): the CDF of Beta(a, b) at x. */
export function regularizedIncompleteBeta(x: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0) || Number.isNaN(x)) return NaN;
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  const logFront = a * Math.log(x) + b * Math.log1p(-x) - logBeta(a, b);
  // The continued fraction converges fast only on the side of the mean, so use the symmetry
  // I_x(a, b) = 1 - I_{1-x}(b, a) past it.
  if (x < (a + 1) / (a + b + 2)) return (Math.exp(logFront) * betaContinuedFraction(x, a, b)) / a;
  return 1 - (Math.exp(logFront) * betaContinuedFraction(1 - x, b, a)) / b;
}

/** Beta(a, b) density at x in (0, 1). */
export function betaDensity(x: number, a: number, b: number): number {
  if (x <= 0 || x >= 1) return 0;
  return Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - logBeta(a, b));
}

/**
 * Quantile of Beta(a, b): safeguarded Newton on I_x(a, b) = p with a shrinking bracket.
 * The start comes from the exact logit-scale moments (ψ(a) − ψ(b), ψ'(a) + ψ'(b)).
 */
export function betaQuantile(p: number, a: number, b: number): number {
  if (!(a > 0) || !(b > 0) || Number.isNaN(p)) return NaN;
  if (p <= 0) return 0;
  if (p >= 1) return 1;
  let lo = 0;
  let hi = 1;
  const meanLogit = digamma(a) - digamma(b);
  const sdLogit = Math.sqrt(trigamma(a) + trigamma(b));
  let x = expit(meanLogit + normalQuantile(p) * sdLogit);
  if (!(x > 0 && x < 1)) x = a / (a + b);
  const logB = logBeta(a, b);
  for (let i = 0; i < 200; i++) {
    const f = regularizedIncompleteBeta(x, a, b) - p;
    if (f === 0) return x;
    if (f < 0) lo = x;
    else hi = x;
    const density = Math.exp((a - 1) * Math.log(x) + (b - 1) * Math.log1p(-x) - logB);
    let next = density > 0 && Number.isFinite(density) ? x - f / density : NaN;
    if (!(next > lo && next < hi)) next = 0.5 * (lo + hi);
    if (Math.abs(next - x) <= 1e-15 * Math.max(x, 1e-300) || hi - lo <= 1e-16) return next;
    x = next;
  }
  return x;
}

/**
 * Standard normal CDF, Hart's double-precision algorithm as given by West (2005); absolute
 * error below 1e-14 across the real line.
 */
export function normalCdf(z: number): number {
  if (Number.isNaN(z)) return NaN;
  const x = Math.abs(z);
  let tail: number;
  if (x > 37) {
    tail = 0;
  } else {
    const e = Math.exp((-x * x) / 2);
    if (x < 7.07106781186547) {
      let num = 3.52624965998911e-2 * x + 0.700383064443688;
      num = num * x + 6.37396220353165;
      num = num * x + 33.912866078383;
      num = num * x + 112.079291497871;
      num = num * x + 221.213596169931;
      num = num * x + 220.206867912376;
      let den = 8.83883476483184e-2 * x + 1.75566716318264;
      den = den * x + 16.064177579207;
      den = den * x + 86.7807322029461;
      den = den * x + 296.564248779674;
      den = den * x + 637.333633378831;
      den = den * x + 793.826512519948;
      den = den * x + 440.413735824752;
      tail = (e * num) / den;
    } else {
      let b = x + 0.65;
      b = x + 4 / b;
      b = x + 3 / b;
      b = x + 2 / b;
      b = x + 1 / b;
      tail = e / b / 2.506628274631;
    }
  }
  return z > 0 ? 1 - tail : tail;
}

function horner(coefficients: readonly number[], x: number): number {
  let value = 0;
  for (let i = coefficients.length - 1; i >= 0; i--) value = value * x + coefficients[i]!;
  return value;
}

// Wichura's AS 241 (PPND16) coefficients, lowest order first; about 1e-16 relative accuracy.
const AS241_A = [3.387132872796366608, 133.14166789178437745, 1971.5909503065514427, 13731.693765509461125, 45921.953931549871457, 67265.770927008700853, 33430.575583588128105, 2509.0809287301226727];
const AS241_B = [1, 42.313330701600911252, 687.1870074920579083, 5394.1960214247511077, 21213.794301586595867, 39307.89580009271061, 28729.085735721942674, 5226.495278852545925];
const AS241_C = [1.42343711074968357734, 4.6303378461565452959, 5.7694972214606914055, 3.64784832476320460504, 1.27045825245236838258, 0.24178072517745061177, 0.0227238449892691845833, 7.7454501427834140764e-4];
const AS241_D = [1, 2.05319162663775882187, 1.6763848301838038494, 0.68976733498510000455, 0.14810397642748007459, 0.0151986665636164571966, 5.475938084995344946e-4, 1.05075007164441684324e-9];
const AS241_E = [6.6579046435011037772, 5.4637849111641143699, 1.7848265399172913358, 0.29656057182850489123, 0.026532189526576123093, 0.0012426609473880784386, 2.71155556874348757815e-5, 2.01033439929228813265e-7];
const AS241_F = [1, 0.59983220655588793769, 0.13692988092273580531, 0.0148753612908506148525, 7.868691311456132591e-4, 1.8463183175100546818e-5, 1.4215117583164458887e-7, 2.04426310338993978564e-15];

/** Standard normal quantile (inverse CDF). */
export function normalQuantile(p: number): number {
  if (Number.isNaN(p)) return NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  const q = p - 0.5;
  if (Math.abs(q) <= 0.425) {
    const r = 0.180625 - q * q;
    return (q * horner(AS241_A, r)) / horner(AS241_B, r);
  }
  let r = Math.sqrt(-Math.log(q < 0 ? p : 1 - p));
  let value: number;
  if (r <= 5) {
    r -= 1.6;
    value = horner(AS241_C, r) / horner(AS241_D, r);
  } else {
    r -= 5;
    value = horner(AS241_E, r) / horner(AS241_F, r);
  }
  return q < 0 ? -value : value;
}

/** z for a two-sided 80% interval (1.2815515655446004), used throughout the band rules. */
export const Z80 = normalQuantile(0.9);
/** z for a two-sided 90% interval, equal to a one-sided 95% bound (1.6448536269514722). */
export const Z90 = normalQuantile(0.95);

/**
 * Student-t quantile with ν degrees of freedom, through the incomplete-beta identity
 * P(|T| > t) = I_{ν/(ν+t²)}(ν/2, 1/2).
 */
export function studentTQuantile(p: number, nu: number): number {
  if (!(nu > 0) || Number.isNaN(p)) return NaN;
  if (p <= 0) return -Infinity;
  if (p >= 1) return Infinity;
  if (p === 0.5) return 0;
  const tailTwoSided = 2 * Math.min(p, 1 - p);
  const x = betaQuantile(tailTwoSided, nu / 2, 0.5);
  const t = Math.sqrt((nu * (1 - x)) / x);
  return p < 0.5 ? -t : t;
}

/** Logistic function, written to avoid overflow for large |x|. */
export function expit(x: number): number {
  if (x >= 0) return 1 / (1 + Math.exp(-x));
  const e = Math.exp(x);
  return e / (1 + e);
}

/** Log-odds; ±Infinity at 0 and 1. */
export function logit(p: number): number {
  return Math.log(p) - Math.log1p(-p);
}

/** ln(1 + e^x) without overflow (softplus). */
export function log1pExp(x: number): number {
  return x > 0 ? x + Math.log1p(Math.exp(-x)) : Math.log1p(Math.exp(x));
}

/** Clamp a probability away from 0 and 1 before taking logits. */
export function clampProbability(p: number, eps = 1e-12): number {
  return Math.min(1 - eps, Math.max(eps, p));
}
