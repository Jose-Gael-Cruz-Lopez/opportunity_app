import { describe, expect, it } from "vitest";
import {
  conformalQuantile,
  empiricalLogit,
  empiricalLogitVariance,
  forwardChainLevelZero,
  levelZeroForecast,
  levelZeroGate,
  pooledTau2,
  type StageHistoryPoint,
} from "./level0";
import { createRng } from "./math/random";
import { expit } from "./math/special";

/** Synthetic official-count histories: θ_p per program plus year-to-year noise with variance τ². */
function syntheticHistories(seed: number, programs: number, years: number, tau2: number) {
  const rng = createRng(seed);
  return Array.from({ length: programs }, (_, j) => {
    const theta = -2.5 + 2 * rng.uniform();
    const history: StageHistoryPoint[] = Array.from({ length: years }, (_, y) => {
      const n = 200 + rng.int(1800);
      return { cycleYear: 2019 + y, k: rng.binomial(n, expit(theta + Math.sqrt(tau2) * rng.normal())), n };
    });
    return { id: `synthetic-${String(j).padStart(2, "0")}`, history };
  });
}

describe("Level 0 next-cycle odds (plan 7.5.4)", () => {
  it("uses the empirical logit and its sampling variance", () => {
    expect(empiricalLogit(454, 1485)).toBeCloseTo(Math.log(454.5 / 1031.5), 12);
    expect(empiricalLogitVariance(454, 1485)).toBeCloseTo(1 / 454.5 + 1 / 1031.5, 12);
  });

  it("with one cycle the centre is that cycle's smoothed rate, inside its interval", () => {
    const f = levelZeroForecast([{ cycleYear: 2026, k: 454, n: 1485 }])!;
    expect(f.p50).toBeCloseTo(454.5 / 1486, 10);
    expect(f.tau2).toBe(0.09);
    expect(f.lo).toBeLessThan(f.p50);
    expect(f.hi).toBeGreaterThan(f.p50);
    expect(f.range).toEqual({ minRate: 454 / 1485, maxRate: 454 / 1485, firstYear: 2026, lastYear: 2026 });
  });

  it("weights recent cycles more (0.7 per year of age)", () => {
    const old = { cycleYear: 2020, k: 100, n: 1000 };
    const recent = { cycleYear: 2026, k: 300, n: 1000 };
    const f = levelZeroForecast([old, recent], { tau2: 0.05 })!;
    expect(f.p50).toBeGreaterThan(0.2);
  });

  it("includes the next cycle's own binomial noise: small pools get wider intervals", () => {
    const big = levelZeroForecast([{ cycleYear: 2026, k: 300, n: 3000 }], { tau2: 0.01 })!;
    const small = levelZeroForecast([{ cycleYear: 2026, k: 10, n: 100 }], { tau2: 0.01 })!;
    expect(small.vNext).toBeGreaterThan(big.vNext);
    expect(small.hi - small.lo).toBeGreaterThan(big.hi - big.lo);
    expect(levelZeroForecast([])).toBeNull();
  });

  it("estimates τ² from programs with three or more cycles, else returns null", () => {
    const programs = syntheticHistories(3, 25, 6, 0.09).map((p) => p.history);
    const tau2 = pooledTau2(programs)!;
    expect(tau2).toBeGreaterThan(0.05);
    expect(tau2).toBeLessThan(0.14);
    expect(pooledTau2([[{ cycleYear: 2026, k: 1, n: 10 }]])).toBeNull();
  });

  it("forward chaining reaches about 80% coverage and passes the display gate", () => {
    const programs = syntheticHistories(11, 30, 6, 0.09);
    const tau2 = pooledTau2(programs.map((p) => p.history));
    const forecasts = forwardChainLevelZero(programs, { tau2 });
    expect(forecasts).toHaveLength(30 * 4);
    const gate = levelZeroGate(forecasts);
    expect(gate.coverage).toBeGreaterThan(0.7);
    expect(gate.coverage).toBeLessThan(0.9);
    expect(gate.passes).toBe(true);
  });

  it("an overconfident forecaster (τ² = 0) fails the gate", () => {
    const programs = syntheticHistories(11, 30, 6, 0.09);
    const gate = levelZeroGate(forwardChainLevelZero(programs, { tau2: 0 }));
    expect(gate.coverage).toBeLessThan(0.7);
    expect(gate.passes).toBe(false);
  });

  it("the gate needs at least 60 pooled forecasts", () => {
    const few = Array.from({ length: 40 }, (_, i) => ({ covered: i % 5 !== 0 }));
    expect(levelZeroGate(few).passes).toBe(false);
    const enough = Array.from({ length: 80 }, (_, i) => ({ covered: i % 5 !== 0 }));
    expect(levelZeroGate(enough).passes).toBe(true);
  });

  it("split-conformal quantile takes rank ⌈(m + 1)·0.8⌉ and recalibrates the interval", () => {
    expect(conformalQuantile([0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9])).toBeCloseTo(0.8, 12);
    expect(conformalQuantile([1, 2, 3])).toBe(Infinity);
    const programs = syntheticHistories(5, 30, 6, 0.09);
    const residuals = forwardChainLevelZero(programs, { tau2: pooledTau2(programs.map((p) => p.history)) }).map((f) => f.standardizedResidual);
    const q = conformalQuantile(residuals);
    expect(q).toBeGreaterThan(0.9);
    expect(q).toBeLessThan(1.8);
    const recalibrated = levelZeroForecast(programs[0]!.history, { conformalQ: q })!;
    expect(recalibrated.q).toBe(q);
  });
});
