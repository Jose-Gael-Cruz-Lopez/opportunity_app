import { describe, expect, it } from "vitest";
import { aggregateBandCells, fitBandModel, heldOutScoredItems, observedRateByBand } from "./bands";
import { brierScore, brierSkill, heldOutGates, maxReliabilityGap, reliabilityBins, type Scored } from "./calibration";
import { generateSyntheticWorld, SYNTHETIC_SPECS, syntheticOfficialRates, syntheticReports, type SyntheticEffects } from "./synthetic";

/*
 * End-to-end calibration of the band model on SYNTHETIC worlds (study item 4): fit on two earlier
 * cycles, score the completed third cycle, as the bands job will once per cycle. A calibrated
 * world must pass the held-out gates; a world whose true effects are half what the model learned
 * (true calibration slope 0.5) must fail them. Brier, reliability and the observed rate per band
 * are the model card's numbers.
 */

const EFFECTS: SyntheticEffects = { gpaStep: 0.5, secondYear: 0.3, priorProgram: 0.6 };
const HALF: SyntheticEffects = { gpaStep: 0.25, secondYear: 0.15, priorProgram: 0.3 };
const WORLD = {
  programs: 12,
  cycles: 3,
  applicantsPerCycle: 400,
  baseRates: [0.3, 0.2, 0.1, 0.25, 0.15, 0.35],
  reporting: { rate: 0.35, admitRatio: 2 },
} as const;

function heldOut(seed: number, testEffects: SyntheticEffects) {
  const train = generateSyntheticWorld({ ...WORLD, seed, effects: EFFECTS });
  const test = generateSyntheticWorld({ ...WORLD, seed: seed + 7777, effects: testEffects });
  const trainRates = syntheticOfficialRates(train, [1, 2]);
  const fit = fitBandModel({ cells: aggregateBandCells(syntheticReports(train, [1, 2]), SYNTHETIC_SPECS), specs: SYNTHETIC_SPECS, officialRates: trainRates });
  const testRates = syntheticOfficialRates(test, [3]);
  const testCells = aggregateBandCells(syntheticReports(test, [3]), SYNTHETIC_SPECS);
  const items = heldOutScoredItems(fit, testCells, testRates);
  // "Same for everyone": each program's official rate from the cycles the model was fitted on.
  const reference = (s: Scored) => trainRates[s.cluster!]!;
  return { fit, items, reference, testCells, testRates };
}

const SEEDS = 20;

describe("held-out calibration of the band model (forward-chained, synthetic)", () => {
  it("a calibrated world passes the held-out gates on at least 85% of seeds", () => {
    let passed = 0;
    for (let s = 0; s < SEEDS; s++) {
      const { items, reference } = heldOut(100 + s, EFFECTS);
      if (heldOutGates(items, reference, { resamples: 500, seed: s }).outcome === "pass") passed++;
    }
    expect(passed / SEEDS).toBeGreaterThanOrEqual(0.85);
  }, 120_000);

  it("an overconfident model (true slope 0.5) fails them on at least 80% of seeds", () => {
    let failed = 0;
    for (let s = 0; s < SEEDS; s++) {
      const { items, reference } = heldOut(500 + s, HALF);
      if (heldOutGates(items, reference, { resamples: 500, seed: s }).outcome !== "pass") failed++;
    }
    expect(failed / SEEDS).toBeGreaterThanOrEqual(0.8);
  }, 120_000);

  it("Brier beats the official-rate baseline and the 5-bin reliability diagram stays near the diagonal", () => {
    let skillPositive = 0;
    let reliable = 0;
    for (let s = 0; s < SEEDS; s++) {
      const { items, reference } = heldOut(900 + s, EFFECTS);
      const bs = brierScore(items);
      expect(Number.isFinite(bs)).toBe(true);
      if (brierSkill(items, reference) > 0) skillPositive++;
      if (maxReliabilityGap(reliabilityBins(items, { bins: 5 })) < 0.08) reliable++;
    }
    expect(skillPositive / SEEDS).toBeGreaterThanOrEqual(0.95);
    expect(reliable / SEEDS).toBeGreaterThanOrEqual(0.85);
  }, 120_000);

  it("observed rates per band are ordered and match what the model predicted", () => {
    const totals = new Map<string, { w: number; obs: number; pred: number }>();
    for (let s = 0; s < 10; s++) {
      const { fit, testCells, testRates } = heldOut(1300 + s, EFFECTS);
      for (const row of observedRateByBand(fit, testCells, testRates)) {
        const t = totals.get(row.band) ?? { w: 0, obs: 0, pred: 0 };
        t.w += row.weight;
        t.obs += row.weight * row.observedRate;
        t.pred += row.weight * row.meanPredicted;
        totals.set(row.band, t);
      }
    }
    const rate = (band: string) => totals.get(band)!.obs / totals.get(band)!.w;
    expect(rate("below_typical")).toBeLessThan(rate("typical"));
    expect(rate("typical")).toBeLessThan(rate("above_typical"));
    for (const [, t] of totals) expect(Math.abs(t.obs / t.w - t.pred / t.w)).toBeLessThan(0.03);
  }, 120_000);
});
