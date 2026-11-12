import { z } from "zod";

/**
 * Response shape of GET /api/v1/programs/:slug/outcomes/summary (route id `outcomeSummary`).
 * Every number in it is a label produced by shared/disclosure's `release()`: banded below 20,
 * rounded to 5 above, "fewer than 10" for small cells, "not shown" for complements, or a whole
 * table suppressed with its reason. No Outcome row, id, date to the day or raw count appears.
 *
 * Bands: personal competitiveness bands stay off until every gate passes, so `bands.status` is
 * `official_base_rate_only` until a model is approved and passes all gates.
 */

const LabelSchema = z.string().min(1).max(40);

export const ReleasedTableSchema = z.union([
  z.object({ period: z.string().max(40), suppressed: z.literal(true), reason: z.string().max(40) }).strict(),
  z
    .object({
      period: z.string().max(40),
      suppressed: z.literal(false),
      total: LabelSchema,
      cells: z.array(z.object({ key: z.string().max(80), label: LabelSchema }).strict()).max(40),
    })
    .strict(),
]);
export type ReleasedTableView = z.infer<typeof ReleasedTableSchema>;

export const OUTCOME_SUMMARY_BAND_STATUSES = ["official_base_rate_only", "live"] as const;
export type OutcomeSummaryBandStatus = (typeof OUTCOME_SUMMARY_BAND_STATUSES)[number];

export const OutcomeSummaryCycleSchema = z
  .object({
    cycleKey: z.string().min(1).max(40),
    /** True while an over-count hold freezes this cycle's aggregates (nothing released). */
    held: z.boolean(),
    reports: ReleasedTableSchema,
    decisions: ReleasedTableSchema,
    furthestStage: ReleasedTableSchema,
    /** Decisions per calendar month; each month is its own banded total. */
    timeline: z.array(ReleasedTableSchema).max(24),
  })
  .strict();
export type OutcomeSummaryCycle = z.infer<typeof OutcomeSummaryCycleSchema>;

export const OutcomeSummarySchema = z
  .object({
    programSlug: z.string().min(1).max(120),
    audience: z.literal("public"),
    /** Data as of this UTC day: reports filed today wait for tomorrow (fixed windows). */
    asOf: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    /** Only these verification tiers are counted in any number shown. */
    countedTiers: z.array(z.string().max(40)).max(10),
    cycles: z.array(OutcomeSummaryCycleSchema).max(10),
    bands: z.object({ status: z.enum(OUTCOME_SUMMARY_BAND_STATUSES), note: z.string().max(300) }).strict(),
    isSample: z.boolean(),
  })
  .strict();
export type OutcomeSummary = z.infer<typeof OutcomeSummarySchema>;

export const OFFICIAL_BASE_RATE_ONLY_NOTE =
  "Official base rate only. Personal bands stay off until enough verified outcomes pass every accuracy and fairness check.";
export const BANDS_LIVE_NOTE = "Bands compare with the official rate at each stage. They are never a prediction or a chance about you.";

/** The gates a stored band model carries (shared/readiness/bands BandModel["gates"]). */
export interface BandGateFlags {
  readonly pooled: boolean;
  readonly heldOut: "pass" | "fail_skill" | "fail_calibration" | "not_evaluated";
  readonly representativeness: boolean;
  readonly fairness: boolean;
  readonly usefulness: boolean;
  readonly approved: boolean;
}

/** Every gate passes, including the founder's approval; anything less is "official base rate only". */
export function allBandGatesPass(gates: BandGateFlags | null | undefined): boolean {
  return Boolean(gates && gates.approved && gates.pooled && gates.representativeness && gates.fairness && gates.usefulness && gates.heldOut === "pass");
}

export function bandDisplayStatus(gates: BandGateFlags | null | undefined): OutcomeSummaryBandStatus {
  return allBandGatesPass(gates) ? "live" : "official_base_rate_only";
}
