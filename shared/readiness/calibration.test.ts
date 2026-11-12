import { describe, expect, it } from "vitest";
import {
  auc,
  brierScore,
  brierSkill,
  calibrationInTheLarge,
  calibrationSlope,
  clusterBootstrap,
  clusterCount,
  corpDecomposition,
  fairnessGate,
  heldOutGates,
  logLoss,
  maxReliabilityGap,
  pavIsotonic,
  plattApply,
  plattFit,
  reliabilityBins,
  spiegelhalterZ,
  type GroupScored,
  type Scored,
} from "./calibration";
import { createRng } from "./math/random";
import { expit, logit } from "./math/special";

/** SYNTHETIC forecasts: true logits ~ N(-1, 1); `distort` maps the true probability to the forecast. */
function forecasts(seed: number, n: number, distort: (p: number) => number = (p) => p, clusters = 20): Scored[] {
  const rng = createRng(seed);
  return Array.from({ length: n }, (_, i) => {
    const p = expit(-1 + rng.normal());
    return { p: distort(p), y: rng.bernoulli(p) ? 1 : 0, cluster: `c${i % clusters}` };
  });
}

describe("scores", () => {
  it("Brier score and skill against a constant reference", () => {
    const items: Scored[] = [
      { p: 0.2, y: 0 },
      { p: 0.8, y: 1 },
    ];
    expect(brierScore(items)).toBeCloseTo(0.04, 12);
    expect(brierSkill(items, 0.5)).toBeCloseTo(1 - 0.04 / 0.25, 12);
    expect(brierScore([{ p: 0.3, y: 1, w: 3 }, { p: 0.3, y: 0, w: 1 }])).toBeCloseTo((3 * 0.49 + 0.09) / 4, 12);
    expect(Number.isNaN(brierScore([]))).toBe(true);
  });

  it("log loss and AUC on known cases (ties count half)", () => {
    expect(logLoss([{ p: 0.5, y: 1 }])).toBeCloseTo(Math.log(2), 12);
    expect(auc([{ p: 0.1, y: 0 }, { p: 0.9, y: 1 }])).toBe(1);
    expect(auc([{ p: 0.9, y: 0 }, { p: 0.1, y: 1 }])).toBe(0);
    expect(auc([{ p: 0.5, y: 0 }, { p: 0.5, y: 1 }])).toBe(0.5);
    expect(auc([{ p: 0.2, y: 0 }, { p: 0.4, y: 1 }, { p: 0.6, y: 0 }, { p: 0.8, y: 1 }])).toBeCloseTo(0.75, 12);
    expect(Number.isNaN(auc([{ p: 0.5, y: 1 }]))).toBe(true);
  });
});

describe("isotonic (PAV), CORP and reliability", () => {
  it("pools adjacent violators and ties", () => {
    const { fitted, blocks } = pavIsotonic([
      { p: 0.1, y: 1 },
      { p: 0.2, y: 0 },
      { p: 0.3, y: 1 },
      { p: 0.4, y: 1 },
    ]);
    expect(fitted).toEqual([0.5, 0.5, 1, 1]);
    expect(blocks.map((b) => [b.pLo, b.pHi, b.value])).toEqual([
      [0.1, 0.2, 0.5],
      [0.3, 0.4, 1],
    ]);
    const tied = pavIsotonic([{ p: 0.5, y: 1 }, { p: 0.5, y: 0 }, { p: 0.7, y: 1 }]).fitted;
    expect(tied[0]).toBe(tied[1]);
  });

  it("CORP: BS = MCB − DSC + UNC with non-negative components", () => {
    for (const seed of [1, 2, 3]) {
      const items = forecasts(seed, 800, (p) => expit(1.5 * logit(p)));
      const c = corpDecomposition(items);
      expect(c.bs).toBeCloseTo(c.mcb - c.dsc + c.unc, 12);
      expect(c.mcb).toBeGreaterThanOrEqual(-1e-12);
      expect(c.dsc).toBeGreaterThanOrEqual(-1e-12);
    }
    // A calibrated forecaster has a smaller miscalibration term than a distorted one.
    expect(corpDecomposition(forecasts(4, 4000)).mcb).toBeLessThan(corpDecomposition(forecasts(4, 4000, (p) => expit(2 * logit(p)))).mcb);
  });

  it("reliability bins: calibrated forecasts track the diagonal", () => {
    const bins = reliabilityBins(forecasts(5, 6000), { bins: 5 });
    expect(bins).toHaveLength(5);
    expect(bins.reduce((s, b) => s + b.count, 0)).toBe(6000);
    expect(maxReliabilityGap(bins)).toBeLessThan(0.04);
    const shifted = reliabilityBins(forecasts(5, 6000, (p) => Math.min(0.99, p + 0.15)), { bins: 5 });
    expect(maxReliabilityGap(shifted)).toBeGreaterThan(0.1);
    expect(reliabilityBins([{ p: 0.05, y: 0 }, { p: 0.95, y: 1 }], { bins: 10, strategy: "uniform" }).map((b) => b.count)).toEqual([1, 1]);
  });
});

describe("calibration tests and recalibration", () => {
  it("Spiegelhalter's z is about N(0, 1) for calibrated forecasts and large when they are off", () => {
    let inside = 0;
    const runs = 200;
    for (let seed = 0; seed < runs; seed++) if (Math.abs(spiegelhalterZ(forecasts(100 + seed, 300))) < 1.645) inside++;
    expect(inside / runs).toBeGreaterThan(0.84);
    expect(inside / runs).toBeLessThan(0.96);
    expect(Math.abs(spiegelhalterZ(forecasts(9, 2000, (p) => expit(2 * logit(p)))))).toBeGreaterThan(3);
  });

  it("calibration slope ≈ 1 when calibrated and ≈ 0.5 for an overconfident model", () => {
    const calibrated = calibrationSlope(forecasts(10, 6000));
    expect(calibrated.slope).toBeGreaterThan(0.9);
    expect(calibrated.slope).toBeLessThan(1.1);
    expect(Math.abs(calibrated.intercept)).toBeLessThan(0.1);
    expect(calibrated.seSlope).toBeGreaterThan(0);
    const overfit = calibrationSlope(forecasts(10, 6000, (p) => expit(2 * logit(p) + 1)));
    expect(overfit.slope).toBeGreaterThan(0.4);
    expect(overfit.slope).toBeLessThan(0.6);
  });

  it("calibration in the large: positive when forecasts run low", () => {
    expect(calibrationInTheLarge(forecasts(11, 6000, (p) => expit(logit(p) - 0.5)))).toBeGreaterThan(0.35);
    expect(Math.abs(calibrationInTheLarge(forecasts(11, 6000)))).toBeLessThan(0.1);
  });

  it("two-parameter Platt scaling, fitted on an earlier cycle, repairs an overconfident model", () => {
    const distort = (p: number) => expit(2 * logit(p) + 1);
    const fit = plattFit(forecasts(12, 4000, distort));
    const later = forecasts(13, 4000, distort);
    const repaired = later.map((it) => ({ ...it, p: plattApply(it.p, fit) }));
    expect(brierScore(repaired)).toBeLessThan(brierScore(later));
    expect(calibrationSlope(repaired).slope).toBeCloseTo(1, 0);
  });

  it("cluster bootstrap is seeded, resamples whole clusters and brackets the estimate", () => {
    const items = forecasts(14, 600);
    const a = clusterBootstrap(items, brierScore, { resamples: 300, seed: 1 });
    const b = clusterBootstrap(items, brierScore, { resamples: 300, seed: 1 });
    expect(a).toEqual(b);
    expect(a.lo).toBeLessThanOrEqual(a.estimate);
    expect(a.hi).toBeGreaterThanOrEqual(a.estimate);
  });
});

describe("fairness pass test (plan 7.5.6)", () => {
  function grouped(seed: number, shiftB: number, sizeB = 600): GroupScored[] {
    const a = forecasts(seed, 600).map((it) => ({ ...it, group: "group_a" }));
    const b = forecasts(seed + 1, sizeB, (p) => Math.max(0.001, Math.min(0.999, p + shiftB))).map((it) => ({ ...it, group: "group_b" }));
    return [...a, ...b];
  }

  it("passes when every group is calibrated", () => {
    const r = fairnessGate(grouped(20, 0), { resamples: 400 });
    expect(r.passes).toBe(true);
    for (const g of r.groups) expect(g.upper90).toBeLessThan(0.1);
  });

  it("fails a group whose forecasts are 20 points off, and a group too small to assess", () => {
    const off = fairnessGate(grouped(22, 0.2), { resamples: 400 });
    expect(off.passes).toBe(false);
    expect(off.groups.find((g) => g.group === "group_b")!.passes).toBe(false);
    const tiny = fairnessGate(grouped(24, 0, 12), { resamples: 400 });
    expect(tiny.groups.find((g) => g.group === "group_b")!.passes).toBe(false);
  });

  it("fails a group drawn from too few programs, whose bootstrap cannot show uncertainty", () => {
    // 25 items at p = 0.31 with 10 admits: gap 0.09, all from one program.
    const items = (cluster: (i: number) => string | undefined): GroupScored[] =>
      Array.from({ length: 25 }, (_, i) => ({ p: 0.31, y: i < 10 ? 1 : 0, cluster: cluster(i), group: "group_a" }));
    const one = fairnessGate(items(() => "programA"), { resamples: 400 }).groups[0]!;
    expect(one.clusters).toBe(1);
    expect(one.upper90).toBeCloseTo(0.09, 10);
    expect(one.passes).toBe(false);
    // The same data with every item its own cluster has a real bound, and it is above 10 points.
    const own = fairnessGate(items(() => undefined), { resamples: 400 }).groups[0]!;
    expect(own.clusters).toBe(25);
    expect(own.upper90).toBeGreaterThan(0.1);
    expect(own.passes).toBe(false);
  });

  it("counts clusters the way the bootstrap does", () => {
    expect(clusterCount([{ p: 0.5, y: 1, cluster: "a" }, { p: 0.5, y: 0, cluster: "a" }, { p: 0.5, y: 0 }])).toBe(2);
  });
});

describe("held-out gates need enough programs", () => {
  it("fails with too_few_clusters below the minimum, whatever the intervals say", () => {
    const items = forecasts(31, 900, (p) => p, 3);
    const r = heldOutGates(items, 0.27, { resamples: 300 });
    expect(r.clusters).toBe(3);
    expect(r.failures).toContain("too_few_clusters");
    expect(r.outcome).not.toBe("pass");
    const many = heldOutGates(forecasts(31, 900, (p) => p, 20), 0.27, { resamples: 300 });
    expect(many.failures).not.toContain("too_few_clusters");
  });
});
