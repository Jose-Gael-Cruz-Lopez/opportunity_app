import type { StoredGateFlags } from "./rows";

/**
 * TEST ONLY. A small hand-built band model with invented ids, so tests across shared/ and
 * server/ can store, read and gate one without fitting anything. Parse it with
 * shared/readiness BandModelSchema to get a typed BandModel. No real program appears here.
 *
 * Coefficients: only the GPA column carries signal (β = 1.5 on 1[gpa ≥ 3.75], tight variance),
 * so a "3_75_plus" student reads above typical, a "3_0_to_3_24" student below typical, and a
 * GPA band outside the two coded levels has no band (profile incomplete).
 */

export const FIXTURE_PROGRAM_ID = "00000000-0000-4000-8000-00000000b001";
export const FIXTURE_OTHER_PROGRAM_ID = "00000000-0000-4000-8000-00000000b002";
export const FIXTURE_TYPE = "research_program";
export const FIXTURE_FITTED_ON = "2026-11-01";

const GPA = ["3_0_to_3_24", "3_75_plus"] as const;
const STANDING = ["first_year", "second_year"] as const;
const PRIOR = ["no", "yes"] as const;

export interface FixtureOptions {
  readonly programIds?: readonly string[];
  readonly opportunityType?: string;
  readonly fromStage?: string;
  readonly toStage?: string;
  readonly gates?: Partial<StoredGateFlags>;
  readonly modelVersion?: string;
  readonly eligible?: boolean;
  /** Reports per feature cell (the disclosure rule shows "typical" below 10). */
  readonly cellReports?: number;
}

function diagonal(n: number, v: number): number[][] {
  return Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? v : 0)));
}

/** A plain object in BandModel's shape (validate it with BandModelSchema in the test). */
export function fixtureBandModel(opts: FixtureOptions = {}) {
  const cells: Record<string, number> = {};
  for (const g of GPA) for (const c of STANDING) for (const p of PRIOR) cells[`gpa_band=${g}|class_standing=${c}|prior_program=${p}`] = opts.cellReports ?? 12;
  return {
    modelVersion: opts.modelVersion ?? "bands-fit-v1.2026-11",
    opportunityType: opts.opportunityType ?? FIXTURE_TYPE,
    fromStage: opts.fromStage ?? "applicants",
    toStage: opts.toStage ?? "awards",
    cycles: [2024, 2025],
    specs: [
      { key: "gpa_band" as const, levels: [...GPA], coding: "ordinal" as const, monotone: "increasing" as const },
      { key: "class_standing" as const, levels: [...STANDING], coding: "nominal" as const, monotone: "none" as const },
      { key: "prior_program" as const, levels: [...PRIOR], coding: "nominal" as const, monotone: "none" as const },
    ],
    beta: [1.5, 0, 0],
    covSandwich: diagonal(3, 0.01),
    covPosterior: diagonal(3, 0.01),
    programs: (opts.programIds ?? [FIXTURE_PROGRAM_ID, FIXTURE_OTHER_PROGRAM_ID]).map((programId) => ({
      programId,
      center: [0.5, 0.5, 0.5],
      nEff: 61.4,
      passReports: 20,
      failReports: 44,
      kingZengLogitGap: 0.02,
      eligible: opts.eligible ?? true,
    })),
    cellReports: cells,
    nEffPooled: 300,
    gates: { pooled: true, heldOut: "pass" as StoredGateFlags["heldOut"], representativeness: true, fairness: true, usefulness: true, approved: true, ...opts.gates },
    methodologyUrl: null,
  };
}
