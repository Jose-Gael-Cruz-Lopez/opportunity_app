import { describe, expect, it } from "vitest";
import { coxSnellR2, maxCoxSnellR2, rileyMeanRiskN, rileyMinimumN, vanHouwelingenShrinkage } from "./samplesize";

describe("sample-size gates for band models", () => {
  it("van Houwelingen shrinkage: LR χ² = 30 gives 0.9 for three parameters", () => {
    expect(vanHouwelingenShrinkage(30, 3)).toBeCloseTo(0.9, 12);
    expect(vanHouwelingenShrinkage(0, 3)).toBe(-Infinity);
  });

  it("Riley et al. 2020 criterion 1 for P = 3: about 240, 525 and 1,335 outcomes", () => {
    expect(rileyMinimumN(3, 0.106)).toBe(240);
    expect(rileyMinimumN(3, 0.05)).toBe(525);
    expect(rileyMinimumN(3, 0.02)).toBe(1335);
    expect(rileyMinimumN(3, 0)).toBe(Infinity);
  });

  it("Riley criterion 3 (mean risk within ±0.05) is met by official counts, not by reports", () => {
    expect(rileyMeanRiskN(0.3)).toBe(323);
    expect(rileyMeanRiskN(0.07)).toBe(101);
  });

  it("Cox-Snell R² and its ceiling", () => {
    expect(coxSnellR2(30, 300)).toBeCloseTo(1 - Math.exp(-0.1), 12);
    expect(coxSnellR2(10, 0)).toBe(0);
    expect(maxCoxSnellR2(0.3)).toBeCloseTo(1 - Math.exp(2 * (0.3 * Math.log(0.3) + 0.7 * Math.log(0.7))), 12);
  });
});
