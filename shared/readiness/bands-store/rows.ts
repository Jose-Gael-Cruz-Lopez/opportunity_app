/**
 * The per-program shape of a stored band model (`band_models` rows). `bands.fit` fits one model
 * per opportunity type and stage transition; each program the model covers gets its own row
 * holding the same coefficients with only that program's entry in `programs`, so readiness reads
 * one row for one program and never sees another program's counts.
 *
 * Shapes are restated structurally: this folder imports only its own files and zod (the
 * shared/readiness purity rule). `bands-store.test.ts` checks they accept `BandModel` from
 * `../bands` and that the gate rule matches `allBandGatesPass` in `../outcomes`.
 */

export const HELD_OUT_OUTCOMES = ["pass", "fail_skill", "fail_calibration", "not_evaluated"] as const;
export type HeldOutOutcome = (typeof HELD_OUT_OUTCOMES)[number];

/** The gates a stored model carries (same fields as BandModel["gates"] and BandGateFlags). */
export interface StoredGateFlags {
  readonly pooled: boolean;
  readonly heldOut: HeldOutOutcome;
  readonly representativeness: boolean;
  readonly fairness: boolean;
  readonly usefulness: boolean;
  /** Founder approval as recorded when the model was fitted. Read time re-checks it. */
  readonly approved: boolean;
}

export interface ProgramEntryShape {
  readonly programId: string;
  readonly eligible: boolean;
  readonly nEff: number;
  readonly passReports: number;
  readonly failReports: number;
}

/** The fields of a BandModel that storage and the read-time gates use. */
export interface BandModelShape {
  readonly modelVersion: string;
  readonly opportunityType: string;
  readonly fromStage: string;
  readonly toStage: string;
  readonly programs: readonly ProgramEntryShape[];
  readonly gates: StoredGateFlags;
}

/** One stored row: indexed columns plus the model sliced to this program. */
export interface ProgramBandRow<M> {
  readonly modelKey: string;
  readonly programId: string;
  readonly opportunityType: string;
  readonly fromStage: string;
  readonly toStage: string;
  readonly modelVersion: string;
  readonly algo: string;
  /** UTC day of the fit (YYYY-MM-DD). */
  readonly fittedOn: string;
  /** Gate columns; read time requires these and the model's own gates to pass. */
  readonly gates: StoredGateFlags;
  readonly programEligible: boolean;
  readonly nEff: number;
  readonly passReports: number;
  readonly failReports: number;
  /** The sliced model, or null when the stored JSON no longer parses. */
  readonly model: M;
}

/** `{type}.{from}-{to}`: the same key bands.fit uses for R2 objects and approval tasks. */
export function bandModelKey(opportunityType: string, fromStage: string, toStage: string): string {
  return `${opportunityType}.${fromStage}-${toStage}`;
}

/** The model with only one program's entry; null when the model does not cover the program. */
export function sliceModelForProgram<M extends BandModelShape>(model: M, programId: string): M | null {
  const entry = model.programs.find((p) => p.programId === programId);
  if (!entry) return null;
  return { ...model, programs: [{ ...entry }] };
}

/** One row per program the model covers, sorted by program id. */
export function splitModelByProgram<M extends BandModelShape>(model: M, meta: { readonly fittedOn: string; readonly algo: string }): ProgramBandRow<M>[] {
  const key = bandModelKey(model.opportunityType, model.fromStage, model.toStage);
  const ids = [...new Set(model.programs.map((p) => p.programId))].sort();
  return ids.map((programId) => {
    const sliced = sliceModelForProgram(model, programId)!;
    const entry = sliced.programs[0]!;
    return {
      modelKey: key,
      programId,
      opportunityType: model.opportunityType,
      fromStage: model.fromStage,
      toStage: model.toStage,
      modelVersion: model.modelVersion,
      algo: meta.algo,
      fittedOn: meta.fittedOn,
      gates: { ...model.gates },
      programEligible: entry.eligible,
      nEff: entry.nEff,
      passReports: entry.passReports,
      failReports: entry.failReports,
      model: sliced,
    };
  });
}
