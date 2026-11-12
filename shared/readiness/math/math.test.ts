import { describe, expect, it } from "vitest";
import { jeffreysInterval, wilsonHalfWidth, wilsonInterval, wilsonLowerBound } from "./intervals";
import { cholesky, choleskySolve, quadraticForm, spdInverse } from "./linalg";
import { createRng, mulberry32 } from "./random";
import {
  betaQuantile,
  digamma,
  expit,
  log1pExp,
  logBeta,
  logGamma,
  logit,
  normalCdf,
  normalQuantile,
  regularizedIncompleteBeta,
  studentTQuantile,
  trigamma,
  Z80,
  Z90,
} from "./special";

describe("special functions match reference values", () => {
  it("log-gamma and log-beta", () => {
    expect(logGamma(0.5)).toBeCloseTo(Math.log(Math.sqrt(Math.PI)), 13);
    expect(logGamma(1)).toBeCloseTo(0, 13);
    expect(logGamma(10)).toBeCloseTo(Math.log(362880), 12);
    expect(logGamma(1000)).toBeCloseTo(5905.220423209181, 8);
    expect(logGamma(1e-3)).toBeCloseTo(6.907178885383854, 10);
    expect(logBeta(2, 3)).toBeCloseTo(Math.log(1 / 12), 13);
  });

  it("digamma and trigamma", () => {
    expect(digamma(1)).toBeCloseTo(-0.5772156649015329, 9);
    expect(digamma(0.5)).toBeCloseTo(-1.9635100260214235, 9);
    expect(trigamma(1)).toBeCloseTo((Math.PI * Math.PI) / 6, 9);
    expect(trigamma(0.5)).toBeCloseTo((Math.PI * Math.PI) / 2, 9);
  });

  it("regularized incomplete beta and its inverse", () => {
    expect(regularizedIncompleteBeta(0.5, 2, 3)).toBeCloseTo(11 / 16, 13);
    expect(regularizedIncompleteBeta(0.3, 1, 1)).toBeCloseTo(0.3, 13);
    expect(regularizedIncompleteBeta(0.2, 0.5, 0.5)).toBeCloseTo((2 / Math.PI) * Math.asin(Math.sqrt(0.2)), 12);
    for (const [p, a, b] of [[0.1, 454.5, 1031.5], [0.9, 0.7, 4], [0.5, 30, 80], [0.01, 2, 2000], [0.999, 5, 1]] as const) {
      expect(regularizedIncompleteBeta(betaQuantile(p, a, b), a, b)).toBeCloseTo(p, 10);
    }
    expect(betaQuantile(0, 2, 3)).toBe(0);
    expect(betaQuantile(1, 2, 3)).toBe(1);
  });

  it("normal CDF, quantile and the z constants", () => {
    expect(normalCdf(0)).toBe(0.5);
    expect(normalCdf(1.96)).toBeCloseTo(0.9750021048517795, 14);
    expect(normalCdf(-3)).toBeCloseTo(0.0013498980316301, 14);
    expect(normalQuantile(0.975)).toBeCloseTo(1.959963984540054, 13);
    expect(normalQuantile(1e-10)).toBeCloseTo(-6.361340902404056, 10);
    expect(Z80).toBeCloseTo(1.2815515655446004, 13);
    expect(Z90).toBeCloseTo(1.6448536269514722, 13);
    for (const p of [1e-6, 0.03, 0.4, 0.77, 0.999]) expect(normalCdf(normalQuantile(p))).toBeCloseTo(p, 12);
  });

  it("Student-t quantiles", () => {
    expect(studentTQuantile(0.9, 5)).toBeCloseTo(1.475884, 5);
    expect(studentTQuantile(0.975, 10)).toBeCloseTo(2.228139, 5);
    expect(studentTQuantile(0.1, 5)).toBeCloseTo(-1.475884, 5);
    expect(studentTQuantile(0.5, 3)).toBe(0);
  });

  it("logit helpers are stable at the extremes", () => {
    expect(expit(800)).toBe(1);
    expect(expit(-800)).toBe(0);
    expect(logit(expit(3.2))).toBeCloseTo(3.2, 12);
    expect(log1pExp(800)).toBeCloseTo(800, 10);
    expect(log1pExp(-800)).toBeCloseTo(0, 300);
  });
});

describe("proportion intervals", () => {
  it("Jeffreys interval for an official count is about ±1.5 points at Goldwater's 2026 size", () => {
    const j = jeffreysInterval(454, 1485, 0.8);
    expect((j.hi - j.lo) / 2).toBeGreaterThan(0.014);
    expect((j.hi - j.lo) / 2).toBeLessThan(0.016);
    expect(jeffreysInterval(0, 10).lo).toBe(0);
    expect(jeffreysInterval(10, 10).hi).toBe(1);
  });

  it("Wilson bounds reproduce the plan's audit arithmetic", () => {
    // Plan 7.4.4: 29 of 30 has a Wilson lower bound of 83%.
    expect(wilsonInterval(29, 30, 0.95).lo).toBeCloseTo(0.833, 3);
    // Study: at n = 30 and p = 0.3 the Wilson 95% half-width is ±0.156.
    expect(wilsonHalfWidth(0.3, 30)).toBeCloseTo(0.156, 3);
    expect(wilsonLowerBound(40, 50, 0.9)).toBeLessThan(0.8);
    expect(wilsonLowerBound(0, 0)).toBe(0);
  });
});

describe("linear algebra", () => {
  it("solves and inverts symmetric positive-definite systems", () => {
    const a = [
      [4, 2, 0.6],
      [2, 5, 1],
      [0.6, 1, 3],
    ];
    const l = cholesky(a)!;
    const x = choleskySolve(l, [1, 2, 3]);
    const back = a.map((row) => row.reduce((s, v, j) => s + v * x[j]!, 0));
    back.forEach((v, i) => expect(v).toBeCloseTo([1, 2, 3][i]!, 12));
    const inv = spdInverse(a)!;
    expect(quadraticForm([1, 0, 0], inv)).toBeCloseTo(inv[0]![0]!, 14);
    expect(cholesky([[1, 2], [2, 1]])).toBeNull();
  });
});

describe("seeded randomness", () => {
  it("is reproducible and roughly uniform", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 1000 }, () => a());
    expect(xs).toEqual(Array.from({ length: 1000 }, () => b()));
    const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it("draws Beta and normal variates with the right moments", () => {
    const rng = createRng(7);
    const betas = Array.from({ length: 20000 }, () => rng.beta(5, 15));
    const mean = betas.reduce((s, v) => s + v, 0) / betas.length;
    expect(mean).toBeCloseTo(0.25, 2);
    const normals = Array.from({ length: 20000 }, () => rng.normal());
    const v = normals.reduce((s, x) => s + x * x, 0) / normals.length;
    expect(v).toBeGreaterThan(0.95);
    expect(v).toBeLessThan(1.05);
  });
});
