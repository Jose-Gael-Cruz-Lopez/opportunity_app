import type { TrackerStatus } from "@shared/taxonomy";
import { DISCLOSURE } from "@shared/disclosure";
import { releaseTable, type ReleasedTable } from "@shared/disclosure/table";

/**
 * Aggregate-only progress for an advisor workspace (plan 10.4.2 and 9.6).
 *
 * Inputs are pre-aggregated counts (program, tracker status, n), never tracker rows, and outputs
 * go through shared/disclosure's advisor thresholds: a table under 5 people is withheld, cells
 * under 5 read "fewer than 5", and complementary suppression hides one more cell whenever a small
 * cell could be recovered from the total. Two one-way tables (by program, by stage) are released
 * instead of one program x stage table, because two-way releases are not enabled (rule R4).
 */

export const PROGRESS_STAGES = ["saved", "started", "submitted"] as const;
export type ProgressStage = (typeof PROGRESS_STAGES)[number];

/**
 * Tracker statuses collapse into three coarse stages. "decided" merges into submitted so the
 * view never hints at an outcome, and "not_applying" is left out: it is a private choice.
 */
const STAGE_FOR_STATUS: Record<TrackerStatus, ProgressStage | null> = {
  interested: "saved",
  applying: "started",
  submitted: "submitted",
  decided: "submitted",
  not_applying: null,
};

export const STAGE_LABELS: Record<ProgressStage, string> = {
  saved: "Saved",
  started: "Started an application",
  submitted: "Submitted",
};

export interface StatusCount {
  readonly programSlug: string;
  readonly status: TrackerStatus;
  readonly n: number;
}

export interface ListedProgram {
  readonly slug: string;
  readonly name: string;
  /** Status- or identity-defined programs never appear in an advisor count. */
  readonly restricted: boolean;
}

export interface ProgressView {
  readonly period: string;
  /** Whose activity is counted; Phase 2 has no cohort membership, so it is every Novus student. */
  readonly population: "all_novus_students";
  readonly minGroupSize: number;
  readonly programs: readonly { slug: string; name: string }[];
  /** Restricted programs on the lists, named so the advisor knows why they are missing. */
  readonly excluded: readonly { slug: string; name: string }[];
  readonly byProgram: ReleasedTable;
  readonly byStage: ReleasedTable;
}

export function stageFor(status: TrackerStatus): ProgressStage | null {
  return STAGE_FOR_STATUS[status];
}

/** Releases the two one-way tables. Counts for unknown or restricted programs are dropped first. */
export function buildProgressView(period: string, listed: readonly ListedProgram[], counts: readonly StatusCount[]): ProgressView {
  const shown = listed.filter((p) => !p.restricted);
  const allowed = new Set(shown.map((p) => p.slug));
  const byProgram = new Map<string, number>(shown.map((p) => [p.slug, 0]));
  const byStage = new Map<ProgressStage, number>(PROGRESS_STAGES.map((s) => [s, 0]));

  for (const row of counts) {
    const stage = stageFor(row.status);
    if (!allowed.has(row.programSlug) || stage === null || !Number.isInteger(row.n) || row.n <= 0) continue;
    byProgram.set(row.programSlug, (byProgram.get(row.programSlug) ?? 0) + row.n);
    byStage.set(stage, (byStage.get(stage) ?? 0) + row.n);
  }

  return {
    period,
    population: "all_novus_students",
    minGroupSize: DISCLOSURE.audiences.advisor.minTotal,
    programs: shown.map((p) => ({ slug: p.slug, name: p.name })),
    excluded: listed.filter((p) => p.restricted).map((p) => ({ slug: p.slug, name: p.name })),
    byProgram: releaseTable(period, [...byProgram].map(([key, n]) => ({ key, n })), "advisor", false),
    byStage: releaseTable(period, [...byStage].map(([key, n]) => ({ key, n })), "advisor", false),
  };
}
