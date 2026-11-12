import { describe, expect, it } from "vitest";
import {
  aggregateBandCells,
  assertAllowedSpecs,
  bandCellKey,
  bandColumns,
  bandForStudent,
  bandLevelsFromProfile,
  BandModelSchema,
  codeLevels,
  decideBand,
  fitBandModel,
  modelCardCoefficients,
  nonTypicalShare,
  studentContrast,
  toBandModel,
  type BandCell,
  type BandFeatureSpec,
  type BandModelFit,
} from "./bands";
import { expit, logit, Z80 } from "./math/special";
import {
  generateSyntheticWorld,
  interceptForRate,
  SYNTHETIC_LABEL,
  SYNTHETIC_SPECS,
  syntheticOfficialRates,
  syntheticReports,
  syntheticReportSample,
  type SyntheticEffects,
} from "./synthetic";

/*
 * The band pipeline against SYNTHETIC worlds with known truth (study test plan items 1-3 and
 * 6-10). Selective reporting: admits report twice as often (h(1)/h(0) = 2), tiers weigh 0.6,
 * 0.8 and 1.0. Base rates are round numbers, not any real program's.
 */

const NULL: SyntheticEffects = { gpaStep: 0, secondYear: 0, priorProgram: 0 };
const SIGNAL: SyntheticEffects = { gpaStep: 0.7, secondYear: 0.3, priorProgram: 0.5 };
const RATES = [0.3, 0.2, 0.1, 0.25, 0.15];
const REPORTING = { rate: 0.3, admitRatio: 2 };
const GPA_LEVELS = SYNTHETIC_SPECS[0]!.levels;

function fitSample(seed: number, total: number, effects: SyntheticEffects, programs = 5) {
  const sample = syntheticReportSample({ seed, programs, total, baseRates: RATES, effects, reporting: REPORTING });
  const cells = aggregateBandCells(sample.reports, SYNTHETIC_SPECS);
  return { fit: fitBandModel({ cells, specs: SYNTHETIC_SPECS, officialRates: sample.officialRates }), cells, rates: sample.officialRates };
}

/** The true contrast of a cell against the synthetic pool mix (GPA mean 1.5, 50% second-year, 40% prior). */
function trueContrast(effects: SyntheticEffects, cell: Pick<BandCell, "levels">): number {
  const gpa = GPA_LEVELS.indexOf(cell.levels.gpa_band!);
  return (
    effects.gpaStep * (gpa - 1.5) +
    effects.secondYear * ((cell.levels.class_standing === "second_year" ? 1 : 0) - 0.5) +
    effects.priorProgram * ((cell.levels.prior_program === "yes" ? 1 : 0) - 0.4)
  );
}

/** Report-weighted shares of non-typical and wrong-direction labels over a fit's own cells. */
function labelRates(fit: BandModelFit, cells: readonly BandCell[], effects: SyntheticEffects): { nonTypical: number; wrong: number; reports: number } {
  let total = 0;
  let nonTypical = 0;
  let wrong = 0;
  for (const cell of cells) {
    const program = fit.programs.find((p) => p.programId === cell.programId);
    if (!program) continue;
    const contrast = studentContrast(fit, program.center, cell.levels)!;
    const band = decideBand(contrast.delta, contrast.sd);
    const n = cell.passReports + cell.failReports;
    total += n;
    if (band === "typical") continue;
    nonTypical += n;
    const truth = trueContrast(effects, cell);
    if ((band === "above_typical" && truth <= 0) || (band === "below_typical" && truth >= 0)) wrong += n;
  }
  return { nonTypical: nonTypical / total, wrong: wrong / total, reports: total };
}

function simulate(total: number, effects: SyntheticEffects, replicates: number, seed0: number): { nonTypical: number; wrong: number } {
  let reports = 0;
  let nonTypical = 0;
  let wrong = 0;
  for (let r = 0; r < replicates; r++) {
    const { fit, cells } = fitSample(seed0 + r, total, effects);
    const rates = labelRates(fit, cells, effects);
    reports += rates.reports;
    nonTypical += rates.nonTypical * rates.reports;
    wrong += rates.wrong * rates.reports;
  }
  return { nonTypical: nonTypical / reports, wrong: wrong / reports };
}

describe("band features: allowlist, coding, cells", () => {
  it("rejects anything outside the three allowlisted features", () => {
    const bad = [{ key: "institution_type", levels: ["two_year", "four_year"], coding: "nominal", monotone: "none" }] as unknown as BandFeatureSpec[];
    expect(() => assertAllowedSpecs(bad)).toThrow(/allowlist/);
    expect(() => assertAllowedSpecs([])).toThrow();
    expect(() => assertAllowedSpecs([...SYNTHETIC_SPECS, SYNTHETIC_SPECS[0]!])).toThrow();
    expect(() => assertAllowedSpecs([SYNTHETIC_SPECS[0]!, SYNTHETIC_SPECS[0]!])).toThrow(/duplicate/);
  });

  it("codes ordinal levels cumulatively with sign-constrained columns", () => {
    const columns = bandColumns(SYNTHETIC_SPECS);
    expect(columns.map((c) => c.name)).toEqual([
      "gpa_band>=3_25_to_3_49",
      "gpa_band>=3_5_to_3_74",
      "gpa_band>=3_75_plus",
      "class_standing=second_year",
      "prior_program=yes",
    ]);
    expect(columns.slice(0, 3).every((c) => c.lower === 0)).toBe(true);
    expect(codeLevels(SYNTHETIC_SPECS, { gpa_band: "3_5_to_3_74", class_standing: "first_year", prior_program: "yes" })).toEqual([1, 1, 0, 0, 1]);
    expect(codeLevels(SYNTHETIC_SPECS, { gpa_band: "3_5_to_3_74" })).toBeNull();
    expect(bandCellKey(SYNTHETIC_SPECS, { gpa_band: "3_75_plus", class_standing: "first_year", prior_program: "no" })).toBe(
      "gpa_band=3_75_plus|class_standing=first_year|prior_program=no",
    );
  });

  it("reads only class year, GPA band and the generic prior-program answer from a profile", () => {
    const profile = { classYear: "second_year", gpaBand: "3_5_to_3_74", priorExperience: ["research"] };
    const withEverything = {
      ...profile,
      institutionId: "00000000-0000-4000-8000-000000000999",
      institutionLevel: "two_year",
      residenceState: "RI",
      citizenship: "us_citizen",
      firstGeneration: "yes",
      pell: "yes",
    };
    expect(bandLevelsFromProfile(withEverything)).toEqual(bandLevelsFromProfile(profile));
    expect(bandLevelsFromProfile(profile)).toEqual({ class_standing: "second_year", gpa_band: "3_5_to_3_74", prior_program: "yes" });
    // "Prefer not to say" and "no GPA yet" are not levels; an unanswered question is not "no".
    expect(bandLevelsFromProfile({ gpaBand: "prefer_not", priorExperience: null })).toEqual({});
    expect(bandLevelsFromProfile({ priorExperience: [] })).toEqual({ prior_program: "no" });
  });

  it("aggregates reports into cells with weights, squared weights and counts", () => {
    const levels = { gpa_band: "3_75_plus", class_standing: "first_year", prior_program: "no" };
    const cells = aggregateBandCells(
      [
        { programId: "p", levels, passed: true, weight: 1 },
        { programId: "p", levels, passed: false, weight: 0.6 },
        { programId: "p", levels, passed: false, weight: 0.8 },
        { programId: "p", levels, passed: true, weight: 0 },
        { programId: "p", levels: { gpa_band: "unknown" }, passed: true, weight: 1 },
      ],
      SYNTHETIC_SPECS,
    );
    expect(cells).toHaveLength(1);
    expect(cells[0]).toMatchObject({ passWeight: 1, failWeight: 1.4, passReports: 1, failReports: 2 });
    expect(cells[0]!.failWeightSq).toBeCloseTo(0.36 + 0.64, 12);
  });
});

describe("the contrast rule", () => {
  it("labels only when the 80% interval clears ln 1.5 on the odds scale", () => {
    const t = Math.log(1.5);
    expect(decideBand(t + Z80 * 0.1 + 0.01, 0.1)).toBe("above_typical");
    expect(decideBand(t + Z80 * 0.1 - 0.01, 0.1)).toBe("typical");
    expect(decideBand(-t - Z80 * 0.1 - 0.01, 0.1)).toBe("below_typical");
    expect(decideBand(5, 10)).toBe("typical");
    expect(decideBand(0, 0)).toBe("typical");
  });
});

describe("simulation: no real effect, few labels and none in a wrong direction (study item 1)", () => {
  it.each([30, 60, 150, 300])("at %i counted reports: non-typical ≤ 1%%, wrong direction ≤ 0.5%%", (total) => {
    const replicates = total <= 60 ? 600 : 300;
    const r = simulate(total, NULL, replicates, 10_000 + total);
    expect(r.nonTypical).toBeLessThanOrEqual(0.01);
    expect(r.wrong).toBeLessThanOrEqual(0.005);
  }, 60_000);
});

describe("simulation: a real effect is found more often with more reports, never backwards (study item 2)", () => {
  it("non-typical share grows with N; wrong-direction share stays ≤ 0.5%", () => {
    const sizes = [30, 150, 300, 600];
    const results = sizes.map((total) => simulate(total, SIGNAL, 120, 20_000 + total));
    for (const r of results) expect(r.wrong).toBeLessThanOrEqual(0.005);
    for (let i = 1; i < results.length; i++) expect(results[i]!.nonTypical).toBeGreaterThanOrEqual(results[i - 1]!.nonTypical);
    expect(results[results.length - 1]!.nonTypical).toBeGreaterThan(0.1);
  }, 60_000);
});

describe("King-Zeng prior correction (study item 3)", () => {
  it("pins each program to its official rate within 0.1 logit although admits report twice as often", () => {
    const world = generateSyntheticWorld({ seed: 3, programs: 6, cycles: 2, applicantsPerCycle: 1500, baseRates: RATES, effects: SIGNAL, reporting: REPORTING });
    expect(world.label).toBe(SYNTHETIC_LABEL);
    const rates = syntheticOfficialRates(world, [1, 2]);
    const fit = fitBandModel({ cells: aggregateBandCells(syntheticReports(world, [1, 2]), SYNTHETIC_SPECS), specs: SYNTHETIC_SPECS, officialRates: rates });
    for (const program of fit.programs) {
      const pool = world.applicants.filter((a) => a.programId === program.programId);
      const poolAverage = (alpha: number) =>
        pool.reduce((s, a) => {
          let eta = alpha;
          codeLevels(SYNTHETIC_SPECS, a.levels)!.forEach((v, k) => (eta += fit.beta[k]! * (v - program.center[k]!)));
          return s + expit(eta);
        }, 0) / pool.length;
      const tau = rates[program.programId]!;
      const corrected = Math.abs(logit(poolAverage(program.alphaStar)) - logit(tau));
      const uncorrected = Math.abs(logit(poolAverage(program.alphaHat)) - logit(tau));
      expect(corrected).toBeLessThan(0.1);
      expect(uncorrected).toBeGreaterThan(0.4); // about ln 2: what selective reporting would add
      expect(Math.abs(program.kingZengLogitGap)).toBeLessThanOrEqual(0.1);
    }
  });

  it("the synthetic intercept makes the pool average equal the base rate", () => {
    const alpha = interceptForRate(0.2, SIGNAL);
    expect(alpha).toBeLessThan(logit(0.2)); // a spread of effects lowers the intercept below logit(τ)
  });
});

describe("gates and sample sizes", () => {
  it("per-program floor (n_eff ≥ 30, 8 of each outcome) and pooled gate (n_eff ≥ 250, shrinkage ≥ 0.9, Riley)", () => {
    const small = fitSample(1, 100, SIGNAL).fit;
    expect(small.pooled.passes).toBe(false);
    expect(small.programs.every((p) => !p.eligible)).toBe(true); // 20 reports each
    const large = fitSample(2, 3000, SIGNAL).fit;
    expect(large.pooled.passes).toBe(true);
    expect(large.pooled.shrinkage).toBeGreaterThanOrEqual(0.9);
    expect(large.pooled.nEff).toBeGreaterThanOrEqual(250);
    expect(large.pooled.nEff).toBeGreaterThanOrEqual(large.pooled.rileyMinN);
    expect(large.programs.every((p) => p.eligible)).toBe(true);
    // With no signal the shrinkage gate fails however many reports there are.
    expect(fitSample(3, 3000, NULL).fit.pooled.passes).toBe(false);
  });

  it("usefulness: under 5% non-typical in the null world, which ships 'same for everyone'", () => {
    const { fit, cells } = fitSample(4, 600, NULL);
    expect(nonTypicalShare(fit, cells)).toBeLessThan(0.05);
    const strong = fitSample(5, 3000, { gpaStep: 1, secondYear: 0.5, priorProgram: 0.7 });
    expect(nonTypicalShare(strong.fit, strong.cells)).toBeGreaterThan(0.05);
  });
});

describe("invariants (study items 6-10)", () => {
  const { fit } = fitSample(6, 3000, SIGNAL);
  const model = toBandModel(fit, {
    modelVersion: "bands-synthetic-1",
    opportunityType: "fellowship",
    fromStage: "nominees",
    toStage: "awards",
    cycles: [2026],
    gates: { heldOut: "pass", representativeness: true, fairness: true, usefulness: true, approved: true },
    methodologyUrl: null,
  });
  const programId = fit.programs[0]!.programId;

  it("monotone: raising the GPA band never lowers the band, even when the data point the other way", () => {
    const order = ["below_typical", "typical", "above_typical"];
    for (const [seed, effects] of [
      [7, SIGNAL],
      [8, { gpaStep: -0.6, secondYear: 0.2, priorProgram: 0 }],
      [9, NULL],
    ] as const) {
      const f = fitSample(seed, 1500, effects).fit;
      for (const beta of f.beta.slice(0, 3)) expect(beta).toBeGreaterThanOrEqual(0);
      const program = f.programs[0]!;
      for (const cls of ["first_year", "second_year"]) {
        for (const prior of ["no", "yes"]) {
          const bands = GPA_LEVELS.map((g) => {
            const c = studentContrast(f, program.center, { gpa_band: g, class_standing: cls, prior_program: prior })!;
            return order.indexOf(decideBand(c.delta, c.sd));
          });
          for (let i = 1; i < bands.length; i++) expect(bands[i]!).toBeGreaterThanOrEqual(bands[i - 1]!);
        }
      }
    }
  });

  it("deterministic: same reports in any order give a byte-identical model", () => {
    const sample = syntheticReportSample({ seed: 12, programs: 5, total: 600, baseRates: RATES, effects: SIGNAL, reporting: REPORTING });
    const a = fitBandModel({ cells: aggregateBandCells(sample.reports, SYNTHETIC_SPECS), specs: SYNTHETIC_SPECS, officialRates: sample.officialRates });
    const b = fitBandModel({ cells: aggregateBandCells([...sample.reports].reverse(), SYNTHETIC_SPECS), specs: SYNTHETIC_SPECS, officialRates: sample.officialRates });
    expect(JSON.stringify(b)).toBe(JSON.stringify(a));
  });

  it("the stored model validates, and a student's outcome is a word plus direction-only factors", () => {
    expect(BandModelSchema.safeParse(model).success).toBe(true);
    const outcome = bandForStudent(model, programId, { gpa_band: "3_75_plus", class_standing: "second_year", prior_program: "yes" });
    expect(outcome.kind).toBe("band");
    if (outcome.kind === "band") {
      expect(outcome.band).toBe("above_typical");
      for (const f of outcome.factors) expect(["helps", "hurts", "neutral"]).toContain(f.direction);
    }
  });

  it("disclosure: a feature cell with fewer than 10 counted reports reads 'typical'", () => {
    const levels = { gpa_band: "3_75_plus", class_standing: "second_year", prior_program: "yes" };
    const cell = bandCellKey(model.specs, levels)!;
    const sparse = { ...model, cellReports: { ...model.cellReports, [cell]: 9 } };
    const outcome = bandForStudent(sparse, programId, levels);
    expect(outcome).toMatchObject({ kind: "band", band: "typical", smallCell: true, factors: [] });
  });

  it("model-card coefficients are rounded to 0.05", () => {
    for (const c of modelCardCoefficients(model)) expect(Math.abs(c.coefficient / 0.05 - Math.round(c.coefficient / 0.05))).toBeLessThan(1e-9);
  });
});
