import { BANDS_STORE_CONFIG } from "./config";
import { bandModelKey, type BandModelShape, type ProgramBandRow, type StoredGateFlags } from "./rows";

/**
 * Gates checked at read time, every time readiness asks for a band. A stored model is used only
 * when ALL of these hold; otherwise readiness gets no model and shows the official base rate:
 *
 *   the program is not status-defined                      sensitive_program
 *   the student's official transition is known             no_transition
 *   a stored row covers this program and that transition   no_model
 *   the row and its model agree (key, type, stages, id)    malformed_model
 *   the model's type is still one of the program's types   type_mismatch
 *   the fit is at most 62 days old and not in the future   stale_model, fitted_in_future
 *   a founder's approval is live now (not only at fit)     not_approved
 *   no live hold freezes any cycle of the program          cycle_held
 *   the program's own n_eff and outcome counts passed      program_ineligible
 *   every fitted gate passed, in the columns AND the JSON  pooled_sample_size, held_out_*,
 *                                                          representativeness, fairness, usefulness
 *
 * A failed skill or usefulness gate would let shared/readiness show "same for everyone at this
 * stage"; read time is stricter and shows the official base rate until every gate passes.
 * Pure: the day is an input.
 */

export const BAND_READ_FAILURES = [
  "sensitive_program",
  "no_transition",
  "no_model",
  "malformed_model",
  "type_mismatch",
  "stale_model",
  "fitted_in_future",
  "not_approved",
  "cycle_held",
  "program_ineligible",
  "pooled_sample_size",
  "held_out_fail_skill",
  "held_out_fail_calibration",
  "held_out_not_evaluated",
  "representativeness",
  "fairness",
  "usefulness",
] as const;
export type BandReadFailure = (typeof BAND_READ_FAILURES)[number];

export interface BandTransition {
  readonly fromStage: string;
  readonly toStage: string;
}

export interface BandReadContext {
  readonly programId: string;
  /** The program's current opportunity types (any of them may carry the model). */
  readonly opportunityTypes: readonly string[];
  readonly sensitiveAudience: boolean;
  /** The official transition shown to the student (shared/readiness transitionForStudent), or null. */
  readonly transition: BandTransition | null;
  /** The reader's UTC day, YYYY-MM-DD. */
  readonly today: string;
  /** Model keys with a live founder approval (band_model_approval approved or applied) now. */
  readonly approvedModelKeys: readonly string[];
  /** Cycles of this program under a live hold (outcome_cycle_holds or a live over-count task). */
  readonly heldCycleIds: readonly string[];
  readonly maxModelAgeDays?: number;
}

export type BandReadDecision<M> =
  | { readonly live: true; readonly modelKey: string; readonly model: M }
  | { readonly live: false; readonly failures: readonly BandReadFailure[] };

/** Fitted-gate failures (approval is a read-time check of its own). */
export function fittedGateFailures(gates: StoredGateFlags): BandReadFailure[] {
  const out: BandReadFailure[] = [];
  if (!gates.pooled) out.push("pooled_sample_size");
  if (gates.heldOut !== "pass") out.push(`held_out_${gates.heldOut}`);
  if (!gates.representativeness) out.push("representativeness");
  if (!gates.fairness) out.push("fairness");
  if (!gates.usefulness) out.push("usefulness");
  return out;
}

/** True only when every fitted gate passes and approval holds: the same rule as allBandGatesPass. */
export function everyGatePasses(gates: StoredGateFlags | null | undefined): boolean {
  return Boolean(gates && gates.approved && fittedGateFailures(gates).length === 0);
}

const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Whole days from `from` to `to` (both YYYY-MM-DD), or null when either is not a date. */
export function daysBetween(from: string, to: string): number | null {
  const a = ISO_DAY.exec(from);
  const b = ISO_DAY.exec(to);
  if (!a || !b) return null;
  const ms = (m: RegExpExecArray): number | null => {
    const [year, month, dom] = [Number(m[1]), Number(m[2]), Number(m[3])];
    if (month < 1 || month > 12 || dom < 1) return null;
    const monthDays = (Date.UTC(year, month, 1) - Date.UTC(year, month - 1, 1)) / 86_400_000;
    return dom > monthDays ? null : Date.UTC(year, month - 1, dom);
  };
  const [x, y] = [ms(a), ms(b)];
  if (x === null || y === null) return null;
  return Math.round((y - x) / 86_400_000);
}

function sortFailures(list: readonly BandReadFailure[]): BandReadFailure[] {
  return [...new Set(list)].sort((a, b) => BAND_READ_FAILURES.indexOf(a) - BAND_READ_FAILURES.indexOf(b));
}

/** Every reason one stored row cannot be used for this read; empty means it can. */
export function rowFailures<M extends BandModelShape>(row: ProgramBandRow<M | null>, ctx: BandReadContext): BandReadFailure[] {
  const out: BandReadFailure[] = [];
  const model = row.model;
  const consistent =
    model !== null &&
    row.programId === ctx.programId &&
    row.modelKey === bandModelKey(row.opportunityType, row.fromStage, row.toStage) &&
    model.opportunityType === row.opportunityType &&
    model.fromStage === row.fromStage &&
    model.toStage === row.toStage &&
    model.modelVersion === row.modelVersion &&
    model.programs.length === 1 &&
    model.programs[0]!.programId === ctx.programId;
  if (!consistent) out.push("malformed_model");
  if (!ctx.opportunityTypes.includes(row.opportunityType)) out.push("type_mismatch");

  const age = daysBetween(row.fittedOn, ctx.today);
  if (age === null) out.push("malformed_model");
  else if (age < 0) out.push("fitted_in_future");
  else if (age > (ctx.maxModelAgeDays ?? BANDS_STORE_CONFIG.maxModelAgeDays)) out.push("stale_model");

  if (!ctx.approvedModelKeys.includes(row.modelKey)) out.push("not_approved");
  if (ctx.heldCycleIds.length > 0) out.push("cycle_held");
  if (!row.programEligible || (model !== null && model.programs.some((p) => !p.eligible))) out.push("program_ineligible");

  // Fail closed: the indexed columns and the stored JSON must both pass.
  out.push(...fittedGateFailures(row.gates));
  if (model) out.push(...fittedGateFailures(model.gates));
  return sortFailures(out);
}

/**
 * The model readiness may use for this program and transition, with `gates.approved` set from
 * the read-time approval, or every reason there is none. Rows are tried in model-key order; the
 * first that passes wins, so the answer does not depend on storage order.
 */
export function decideProgramBand<M extends BandModelShape>(rows: readonly ProgramBandRow<M | null>[], ctx: BandReadContext): BandReadDecision<M> {
  if (ctx.sensitiveAudience) return { live: false, failures: ["sensitive_program"] };
  const transition = ctx.transition;
  if (!transition) return { live: false, failures: ["no_transition"] };
  const candidates = rows
    .filter((r) => r.programId === ctx.programId && r.fromStage === transition.fromStage && r.toStage === transition.toStage)
    .slice()
    .sort((a, b) => (a.modelKey < b.modelKey ? -1 : a.modelKey > b.modelKey ? 1 : 0));
  if (candidates.length === 0) return { live: false, failures: ["no_model"] };

  const failures: BandReadFailure[] = [];
  for (const row of candidates) {
    const found = rowFailures(row, ctx);
    if (found.length === 0 && row.model) {
      const model = { ...row.model, gates: { ...row.model.gates, approved: true } };
      return { live: true, modelKey: row.modelKey, model };
    }
    failures.push(...found);
  }
  return { live: false, failures: sortFailures(failures) };
}
