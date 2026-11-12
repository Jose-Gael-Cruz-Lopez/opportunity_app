import type { BandFeatureSpec, BandLevels } from "./bands";
import { createRng, type Rng } from "./math/random";
import { expit } from "./math/special";

/**
 * SYNTHETIC DATA ONLY. A seeded generator of applicant pools, outcomes and selective reporting
 * for testing and auditing the band pipeline. No value here describes a real program; the base
 * rates are round numbers chosen to span the range of nomination-stage rates.
 *
 * Each applicant has three allowlisted features, a true probability from a known logistic model
 * whose pool average equals the program's official rate τ, an outcome, and a report decision
 * P(report | x, y) = min(1, rate · g(x) · h(y)) with h(1)/h(0) = admitRatio, the selective
 * reporting that the King-Zeng correction must undo.
 */

export const SYNTHETIC_LABEL = "synthetic" as const;

export const SYNTHETIC_SPECS: BandFeatureSpec[] = [
  { key: "gpa_band", levels: ["3_0_to_3_24", "3_25_to_3_49", "3_5_to_3_74", "3_75_plus"], coding: "ordinal", monotone: "increasing" },
  { key: "class_standing", levels: ["first_year", "second_year"], coding: "nominal", monotone: "none" },
  { key: "prior_program", levels: ["no", "yes"], coding: "nominal", monotone: "none" },
];

const GPA_MIX = [0.2, 0.3, 0.3, 0.2];
const GPA_MEAN = GPA_MIX.reduce((s, w, i) => s + w * i, 0);
const SECOND_YEAR_SHARE = 0.5;
const PRIOR_SHARE = 0.4;

export interface SyntheticEffects {
  /** Log-odds per GPA band step. */
  readonly gpaStep: number;
  /** Second-year versus first-year. */
  readonly secondYear: number;
  /** An earlier program versus none. */
  readonly priorProgram: number;
}

export interface SyntheticReporting {
  readonly rate: number;
  /** h(1)/h(0): admits report this many times as often. */
  readonly admitRatio: number;
  /** Reporting also tilts toward higher GPA bands (g(x)); cancels in the slope, not in the mix. */
  readonly gpaTilt?: number;
}

export interface SyntheticWorldSpec {
  readonly seed: number;
  readonly programs: number;
  readonly cycles: number;
  readonly applicantsPerCycle: number;
  readonly baseRates: readonly number[];
  readonly effects: SyntheticEffects;
  readonly reporting: SyntheticReporting;
  readonly tiers?: readonly { readonly weight: number; readonly share: number }[];
}

export interface SyntheticApplicant {
  readonly programId: string;
  readonly cycle: number;
  readonly levels: BandLevels;
  readonly trueProbability: number;
  readonly passed: boolean;
  readonly reported: boolean;
  /** Tier weight when reported, else 0. */
  readonly weight: number;
}

export interface SyntheticWorld {
  readonly label: typeof SYNTHETIC_LABEL;
  readonly specs: readonly BandFeatureSpec[];
  readonly programs: readonly { readonly id: string; readonly tau: number; readonly alpha: number }[];
  readonly applicants: readonly SyntheticApplicant[];
  readonly officialCounts: readonly { readonly programId: string; readonly cycle: number; readonly k: number; readonly n: number }[];
}

const DEFAULT_TIERS = [
  { weight: 0.6, share: 0.5 },
  { weight: 0.8, share: 0.3 },
  { weight: 1.0, share: 0.2 },
];

/** Synthetic, clearly fake program ids in UUID form so they pass the contract's id checks. */
export function syntheticProgramId(index: number): string {
  return `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

function linearPart(effects: SyntheticEffects, gpa: number, second: boolean, prior: boolean): number {
  return effects.gpaStep * (gpa - GPA_MEAN) + effects.secondYear * ((second ? 1 : 0) - SECOND_YEAR_SHARE) + effects.priorProgram * ((prior ? 1 : 0) - PRIOR_SHARE);
}

/** The intercept that makes the pool average probability equal τ (Newton over the 16 cells). */
export function interceptForRate(tau: number, effects: SyntheticEffects): number {
  let alpha = Math.log(tau / (1 - tau));
  for (let iter = 0; iter < 100; iter++) {
    let mean = 0;
    let slope = 0;
    GPA_MIX.forEach((gw, gpa) => {
      for (const second of [false, true]) {
        for (const prior of [false, true]) {
          const w = gw * (second ? SECOND_YEAR_SHARE : 1 - SECOND_YEAR_SHARE) * (prior ? PRIOR_SHARE : 1 - PRIOR_SHARE);
          const p = expit(alpha + linearPart(effects, gpa, second, prior));
          mean += w * p;
          slope += w * p * (1 - p);
        }
      }
    });
    const step = (tau - mean) / slope;
    alpha += step;
    if (Math.abs(step) < 1e-13) break;
  }
  return alpha;
}

function drawApplicant(rng: Rng, programId: string, cycle: number, alpha: number, spec: Pick<SyntheticWorldSpec, "effects" | "reporting" | "tiers">): SyntheticApplicant {
  const gpa = rng.categorical(GPA_MIX);
  const second = rng.bernoulli(SECOND_YEAR_SHARE);
  const prior = rng.bernoulli(PRIOR_SHARE);
  const p = expit(alpha + linearPart(spec.effects, gpa, second, prior));
  const passed = rng.bernoulli(p);
  const tilt = Math.exp((spec.reporting.gpaTilt ?? 0) * (gpa - GPA_MEAN));
  const reportP = Math.min(1, spec.reporting.rate * tilt * (passed ? spec.reporting.admitRatio : 1));
  const reported = rng.bernoulli(reportP);
  const tiers = spec.tiers ?? DEFAULT_TIERS;
  const weight = reported ? tiers[rng.categorical(tiers.map((t) => t.share))]!.weight : 0;
  return {
    programId,
    cycle,
    levels: {
      gpa_band: SYNTHETIC_SPECS[0]!.levels[gpa]!,
      class_standing: second ? "second_year" : "first_year",
      prior_program: prior ? "yes" : "no",
    },
    trueProbability: p,
    passed,
    reported,
    weight,
  };
}

export function generateSyntheticWorld(spec: SyntheticWorldSpec): SyntheticWorld {
  const rng = createRng(spec.seed);
  const programs = Array.from({ length: spec.programs }, (_, i) => {
    const tau = spec.baseRates[i % spec.baseRates.length]!;
    return { id: syntheticProgramId(i), tau, alpha: interceptForRate(tau, spec.effects) };
  });
  const applicants: SyntheticApplicant[] = [];
  const officialCounts: { programId: string; cycle: number; k: number; n: number }[] = [];
  for (const program of programs) {
    for (let cycle = 1; cycle <= spec.cycles; cycle++) {
      let k = 0;
      for (let i = 0; i < spec.applicantsPerCycle; i++) {
        const a = drawApplicant(rng, program.id, cycle, program.alpha, spec);
        if (a.passed) k++;
        applicants.push(a);
      }
      officialCounts.push({ programId: program.id, cycle, k, n: spec.applicantsPerCycle });
    }
  }
  return { label: SYNTHETIC_LABEL, specs: SYNTHETIC_SPECS, programs, applicants, officialCounts };
}

/** Official rate per program over the chosen cycles (Σk / Σn), the intercept anchor. */
export function syntheticOfficialRates(world: SyntheticWorld, cycles: readonly number[]): Record<string, number> {
  const rates: Record<string, number> = {};
  for (const program of world.programs) {
    const rows = world.officialCounts.filter((c) => c.programId === program.id && cycles.includes(c.cycle));
    const k = rows.reduce((s, r) => s + r.k, 0);
    const n = rows.reduce((s, r) => s + r.n, 0);
    if (n > 0) rates[program.id] = k / n;
  }
  return rates;
}

/** Reported applicants of the chosen cycles, in the shape aggregateBandCells takes. */
export function syntheticReports(world: SyntheticWorld, cycles: readonly number[]): { programId: string; levels: BandLevels; passed: boolean; weight: number }[] {
  return world.applicants
    .filter((a) => a.reported && cycles.includes(a.cycle))
    .map((a) => ({ programId: a.programId, levels: a.levels, passed: a.passed, weight: a.weight }));
}

/**
 * Exactly `total` counted reports spread over `programs` programs (for false-label studies at a
 * fixed sample size), with each program's true pool rate as its official rate.
 */
export function syntheticReportSample(opts: {
  readonly seed: number;
  readonly programs: number;
  readonly total: number;
  readonly baseRates: readonly number[];
  readonly effects: SyntheticEffects;
  readonly reporting: SyntheticReporting;
}): { reports: { programId: string; levels: BandLevels; passed: boolean; weight: number }[]; officialRates: Record<string, number> } {
  const rng = createRng(opts.seed);
  const programs = Array.from({ length: opts.programs }, (_, i) => {
    const tau = opts.baseRates[i % opts.baseRates.length]!;
    return { id: syntheticProgramId(i), tau, alpha: interceptForRate(tau, opts.effects) };
  });
  const reports: { programId: string; levels: BandLevels; passed: boolean; weight: number }[] = [];
  let guard = 0;
  while (reports.length < opts.total && guard < opts.total * 1000) {
    const program = programs[reports.length % programs.length]!;
    const a = drawApplicant(rng, program.id, 1, program.alpha, opts);
    guard++;
    if (a.reported) reports.push({ programId: a.programId, levels: a.levels, passed: a.passed, weight: a.weight });
  }
  return { reports, officialRates: Object.fromEntries(programs.map((p) => [p.id, p.tau])) };
}
