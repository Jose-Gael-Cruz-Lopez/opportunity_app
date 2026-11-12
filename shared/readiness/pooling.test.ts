import { describe, expect, it } from "vitest";
import { createRng } from "./math/random";
import { regularizedIncompleteBeta } from "./math/special";
import {
  betaBinomialPmf,
  betaMixtureSummary,
  empiricalBayesBetaBinomial,
  hierarchicalBetaBinomial,
  kishEffectiveSize,
  weightedStageCounts,
  type PoolGroup,
} from "./pooling";

/** Synthetic programs (rates ~ Beta(5, 15), 8-40 reports each), as in the study's simulation. */
function syntheticGroups(rng: ReturnType<typeof createRng>, programs: number): { groups: PoolGroup[]; truth: number[] } {
  const truth: number[] = [];
  const groups = Array.from({ length: programs }, (_, j) => {
    const p = rng.beta(5, 15);
    const n = 8 + rng.int(33);
    truth.push(p);
    return { id: `program-${String(j).padStart(2, "0")}`, k: rng.binomial(n, p), n };
  });
  return { groups, truth };
}

function coverage(programs: number, replicates: number, seed: number, fit: (g: PoolGroup[]) => readonly { id: string; lo: number; hi: number }[]): number {
  const rng = createRng(seed);
  let covered = 0;
  let total = 0;
  for (let r = 0; r < replicates; r++) {
    const { groups, truth } = syntheticGroups(rng, programs);
    for (const est of fit(groups)) {
      const p = truth[Number(est.id.slice(-2))]!;
      if (p >= est.lo && p <= est.hi) covered++;
      total++;
    }
  }
  return covered / total;
}

describe("Kish effective size and weighted counts", () => {
  it("matches the textbook definition", () => {
    expect(kishEffectiveSize([1, 1, 1, 1])).toBe(4);
    expect(kishEffectiveSize([0.6, 0.6, 1])).toBeCloseTo((2.2 * 2.2) / (0.36 + 0.36 + 1), 12);
    expect(kishEffectiveSize([])).toBe(0);
  });

  it("rescales tier-weighted counts to n_eff", () => {
    const c = weightedStageCounts([
      { weight: 1, passed: true },
      { weight: 0.6, passed: false },
      { weight: 0.8, passed: true },
      { weight: 0.6, passed: false },
    ]);
    expect(c.ybar).toBeCloseTo(1.8 / 3, 12);
    expect(c.nStar).toBeCloseTo(c.nEff, 12);
    expect(c.kStar).toBeCloseTo(c.ybar * c.nEff, 12);
  });
});

describe("Beta mixture summaries", () => {
  it("inverts the mixture CDF to within 1e-4", () => {
    const comps = [
      { w: 0.5, A: 3.2, B: 11.5 },
      { w: 0.3, A: 30, B: 80 },
      { w: 0.2, A: 0.7, B: 4 },
    ];
    const { mean, quantiles } = betaMixtureSummary(comps, [0.1, 0.5, 0.9]);
    const cdf = (x: number) => comps.reduce((s, c) => s + c.w * regularizedIncompleteBeta(x, c.A, c.B), 0);
    quantiles.forEach((q, i) => expect(Math.abs(cdf(q) - [0.1, 0.5, 0.9][i]!)).toBeLessThan(1e-4));
    expect(mean).toBeCloseTo(0.5 * (3.2 / 14.7) + 0.3 * (30 / 110) + 0.2 * (0.7 / 4.7), 12);
  });
});

describe("hierarchical beta-binomial (BDA3 grid, full Bayes)", () => {
  it("falls back to Jeffreys intervals below five programs", () => {
    const res = hierarchicalBetaBinomial([
      { id: "a", k: 3, n: 10 },
      { id: "b", k: 5, n: 12 },
    ]);
    expect(res.pooled).toBe(false);
    expect(res.groups.every((g) => g.method === "jeffreys")).toBe(true);
  });

  it("shrinks toward similar programs and beats the raw rate on error", () => {
    const rng = createRng(21);
    let sePooled = 0;
    let seRaw = 0;
    for (let r = 0; r < 30; r++) {
      const { groups, truth } = syntheticGroups(rng, 10);
      for (const g of hierarchicalBetaBinomial(groups).groups) {
        const p = truth[Number(g.id.slice(-2))]!;
        sePooled += (g.mean - p) ** 2;
        seRaw += (g.k / g.n - p) ** 2;
      }
    }
    expect(sePooled).toBeLessThan(0.8 * seRaw);
    // 30 grid fits take about 1.7 s alone; the default 5 s timed out under a loaded parallel run.
  }, 60_000);

  it("80% intervals cover 75-85% of true rates at 5, 10 and 20 programs", () => {
    const pooled = (g: PoolGroup[]) => hierarchicalBetaBinomial(g).groups;
    // Replicates are sized so each estimate rests on 300-1,000 intervals (measured: 0.797, 0.775, 0.773).
    for (const [programs, replicates] of [
      [5, 60],
      [10, 100],
      [20, 50],
    ] as const) {
      const c = coverage(programs, replicates, 1000 + programs, pooled);
      expect(c, `coverage at J=${programs}`).toBeGreaterThanOrEqual(0.75);
      expect(c, `coverage at J=${programs}`).toBeLessThanOrEqual(0.85);
    }
  }, 60_000);

  it("plug-in empirical Bayes undercovers, which is why the full hierarchy is the default", () => {
    const eb = coverage(5, 60, 1005, (g) => empiricalBayesBetaBinomial(g));
    const full = coverage(5, 60, 1005, (g) => hierarchicalBetaBinomial(g).groups);
    expect(eb).toBeLessThan(0.72);
    expect(full - eb).toBeGreaterThan(0.08);
  }, 60_000);

  it("the conflict check pulls a clear outlier out of the pool and restores some coverage", () => {
    const rng = createRng(77);
    let flagged = 0;
    let coveredWith = 0;
    let coveredWithout = 0;
    const replicates = 40;
    for (let r = 0; r < replicates; r++) {
      const groups = Array.from({ length: 10 }, (_, j) => {
        const p = j === 0 ? 0.6 : rng.beta(5, 15);
        return { id: `program-${String(j).padStart(2, "0")}`, k: rng.binomial(40, p), n: 40 };
      });
      const withCheck = hierarchicalBetaBinomial(groups).groups.find((g) => g.id === "program-00")!;
      const without = hierarchicalBetaBinomial(groups, { conflictAlpha: 0 }).groups.find((g) => g.id === "program-00")!;
      if (withCheck.method === "jeffreys") flagged++;
      if (0.6 >= withCheck.lo && 0.6 <= withCheck.hi) coveredWith++;
      if (0.6 >= without.lo && 0.6 <= without.hi) coveredWithout++;
    }
    // With 40 reports per program the check flags the outlier about half the time (two-sided
    // leave-one-out p < 0.05); with 20 it is weaker. Flagged programs keep their own interval.
    expect(flagged / replicates).toBeGreaterThanOrEqual(0.4);
    expect(coveredWith).toBeGreaterThan(coveredWithout);
  }, 60_000);

  it("is deterministic and order-independent", () => {
    const groups = syntheticGroups(createRng(5), 8).groups;
    const a = hierarchicalBetaBinomial(groups);
    const b = hierarchicalBetaBinomial([...groups].reverse());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });
});

describe("prior-data conflict (study item 5)", () => {
  it("flags an outlier at 0.6 among peers at 0.25 at least 80% of the time", () => {
    const rng = createRng(91);
    const replicates = 30;
    let flagged = 0;
    let peersFlagged = 0;
    for (let r = 0; r < replicates; r++) {
      const groups = Array.from({ length: 10 }, (_, j) => ({ id: `program-${String(j).padStart(2, "0")}`, k: rng.binomial(40, j === 0 ? 0.6 : 0.25), n: 40 }));
      const result = hierarchicalBetaBinomial(groups).groups;
      if (result.find((g) => g.id === "program-00")!.method === "jeffreys") flagged++;
      peersFlagged += result.filter((g) => g.id !== "program-00" && g.method === "jeffreys").length;
    }
    expect(flagged / replicates).toBeGreaterThanOrEqual(0.8);
    // Peers are rarely pulled out (a 5% test applied to each of nine programs).
    expect(peersFlagged / (9 * replicates)).toBeLessThan(0.1);
  }, 60_000);
});

describe("beta-binomial pmf at extreme grid points", () => {
  it("sums to 1 when the k = 0 term underflows (large a, small b)", () => {
    // ln pmf[0] is about -1083 here: a linear-space recurrence cannot start from it.
    const high = betaBinomialPmf(500, 2832, 149);
    const low = betaBinomialPmf(500, 149, 2832);
    const sum = (xs: Float64Array): number => xs.reduce((s, v) => s + v, 0);
    expect(sum(high)).toBeCloseTo(1, 10);
    expect(sum(low)).toBeCloseTo(1, 10);
    for (let k = 0; k <= 500; k++) expect(high[k]!).toBeCloseTo(low[500 - k]!, 12);
  });

  it("matches the closed form at moderate parameters", () => {
    // Beta-binomial(n = 3, a = 1, b = 1) is uniform on 0..3.
    for (const v of betaBinomialPmf(3, 1, 1)) expect(v).toBeCloseTo(0.25, 12);
  });
});

describe("prior-data conflict is mirror-symmetric", () => {
  const mirror = (groups: PoolGroup[]): PoolGroup[] => groups.map((g) => ({ ...g, k: g.n - g.k }));

  it("flags the same outlier whether rates are low or high", () => {
    const low: PoolGroup[] = [25, 30, 20, 35, 22, 100].map((k, j) => ({ id: `program-${j}`, k, n: 500 }));
    const lowResult = hierarchicalBetaBinomial(low).groups;
    const highResult = hierarchicalBetaBinomial(mirror(low)).groups;
    const outlierLow = lowResult.find((g) => g.id === "program-5")!;
    const outlierHigh = highResult.find((g) => g.id === "program-5")!;
    expect(outlierLow.method).toBe("jeffreys");
    expect(outlierHigh.method).toBe("jeffreys");
    for (let j = 0; j < low.length; j++) {
      expect(highResult[j]!.conflictP!).toBeCloseTo(lowResult[j]!.conflictP!, 6);
    }
  });

  it("gives high-rate sets the same conflict p-values as their mirror", () => {
    const low: PoolGroup[] = [25, 30, 20, 35, 22].map((k, j) => ({ id: `program-${j}`, k, n: 500 }));
    const pLow = hierarchicalBetaBinomial(low).groups.map((g) => g.conflictP!);
    const pHigh = hierarchicalBetaBinomial(mirror(low)).groups.map((g) => g.conflictP!);
    expect(pHigh.some((p) => p < 1)).toBe(true);
    pHigh.forEach((p, j) => expect(p).toBeCloseTo(pLow[j]!, 6));
  });
});
