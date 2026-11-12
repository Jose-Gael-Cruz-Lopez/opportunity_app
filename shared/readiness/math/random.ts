/**
 * Seeded pseudo-random numbers for simulations, bootstraps and tests. Production guidance never
 * draws random numbers; anything that does takes an explicit seed so runs are reproducible.
 */

/** mulberry32: a small, fast 32-bit generator with a full 2^32 period. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface Rng {
  /** Uniform on [0, 1). */
  uniform(): number;
  /** Standard normal (Box-Muller). */
  normal(): number;
  /** Gamma(shape, 1) by Marsaglia and Tsang. */
  gamma(shape: number): number;
  beta(a: number, b: number): number;
  bernoulli(p: number): boolean;
  /** Binomial(n, p) as a sum of Bernoulli draws (n is small in every caller). */
  binomial(n: number, p: number): number;
  /** Integer in [0, maxExclusive). */
  int(maxExclusive: number): number;
  /** Picks an index with probability proportional to its weight. */
  categorical(weights: readonly number[]): number;
}

export function createRng(seed: number): Rng {
  const next = mulberry32(seed);
  let spare: number | null = null;
  const uniform = (): number => next();
  const normal = (): number => {
    if (spare !== null) {
      const v = spare;
      spare = null;
      return v;
    }
    let u = 0;
    while (u <= 1e-300) u = next();
    const v = next();
    const radius = Math.sqrt(-2 * Math.log(u));
    spare = radius * Math.sin(2 * Math.PI * v);
    return radius * Math.cos(2 * Math.PI * v);
  };
  const gamma = (shape: number): number => {
    if (shape < 1) {
      // Boost: Gamma(a) = Gamma(a + 1) · U^(1/a).
      let u = 0;
      while (u <= 1e-300) u = next();
      return gamma(shape + 1) * Math.pow(u, 1 / shape);
    }
    const d = shape - 1 / 3;
    const c = 1 / Math.sqrt(9 * d);
    for (;;) {
      let x: number;
      let v: number;
      do {
        x = normal();
        v = 1 + c * x;
      } while (v <= 0);
      v = v * v * v;
      const u = next();
      if (u < 1 - 0.0331 * x * x * x * x) return d * v;
      if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v;
    }
  };
  return {
    uniform,
    normal,
    gamma,
    beta(a, b) {
      const x = gamma(a);
      const y = gamma(b);
      return x / (x + y);
    },
    bernoulli(p) {
      return next() < p;
    },
    binomial(n, p) {
      let k = 0;
      for (let i = 0; i < n; i++) if (next() < p) k++;
      return k;
    },
    int(maxExclusive) {
      return Math.floor(next() * maxExclusive);
    },
    categorical(weights) {
      const total = weights.reduce((s, w) => s + w, 0);
      let u = next() * total;
      for (let i = 0; i < weights.length; i++) {
        u -= weights[i]!;
        if (u < 0) return i;
      }
      return weights.length - 1;
    },
  };
}
