import type { CycleStatus } from "@shared/taxonomy";
import type { DeadlineEdit, Edits } from "./schemas";
import { hostOf } from "./text";

/**
 * High-impact changes (plan 04 4.10, runbook 14.4) need a second Curator before they publish:
 * status `paused` or `ended`, a deadline moved more than 3 days earlier, a new application-URL
 * host, or any attested change (a URL or fee backed by a note instead of a Snapshot, or an
 * attested campus date). New eligibility restrictions are
 * high impact too; console v0 does not edit rule sets, so none can arrive through this path.
 */

export const HIGH_IMPACT_REASONS = ["status_paused_or_ended", "deadline_moved_earlier", "new_application_host", "attested_change"] as const;
export type HighImpactReason = (typeof HIGH_IMPACT_REASONS)[number];

export const EARLIER_THRESHOLD_DAYS = 3;

export interface CurrentCycle {
  status: CycleStatus;
  applicationUrl: string | null;
  applicationFeeCents: number | null;
  opensOn: string | null;
}

export interface CurrentDeadline {
  id: string;
  kind: string;
  scope: string;
  institutionId: string | null;
  roundLabel: string;
  localDate: string | null;
}

/** Day number of `YYYY-MM-DD` or `YYYY-MM` (first of the month), or null. */
export function dayNumber(date: string | null): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(date);
  if (!m) return null;
  return Math.floor(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? "1")) / 86_400_000);
}

export function slotKey(d: { kind: string; scope: string; institutionId: string | null; roundLabel: string }): string {
  return `${d.kind}|${d.scope}|${d.institutionId ?? ""}|${d.roundLabel}`;
}

export function findSlot(current: readonly CurrentDeadline[], edit: DeadlineEdit): CurrentDeadline | undefined {
  const key = slotKey(edit);
  return current.find((d) => slotKey(d) === key);
}

/** Why this set of edits needs a second Curator; empty when one approval is enough. */
export function highImpactReasons(cycle: CurrentCycle | null, deadlines: readonly CurrentDeadline[], edits: Edits): HighImpactReason[] {
  const out = new Set<HighImpactReason>();
  const c = edits.cycle;
  if (c.status !== undefined && (c.status === "paused" || c.status === "ended") && c.status !== cycle?.status) out.add("status_paused_or_ended");
  if (c.applicationUrl !== undefined && c.applicationUrl !== (cycle?.applicationUrl ?? null)) {
    const before = hostOf(cycle?.applicationUrl);
    const after = hostOf(c.applicationUrl);
    if (before !== null && after !== null && before !== after) out.add("new_application_host");
    if (edits.cycleEvidence.applicationUrl && edits.cycleEvidence.applicationUrl.basis !== "snapshot") out.add("attested_change");
  }
  if (c.applicationFeeCents !== undefined && c.applicationFeeCents !== (cycle?.applicationFeeCents ?? null)) {
    if (edits.cycleEvidence.applicationFeeCents && edits.cycleEvidence.applicationFeeCents.basis !== "snapshot") out.add("attested_change");
  }
  for (const op of edits.deadlines) {
    if (op.op !== "upsert") continue;
    // A campus date attested by an office rather than read from an official page.
    if (op.deadline.basis === "attested") out.add("attested_change");
    const slot = findSlot(deadlines, op.deadline);
    const before = dayNumber(slot?.localDate ?? null);
    const after = dayNumber(op.deadline.localDate);
    if (before !== null && after !== null && before - after > EARLIER_THRESHOLD_DAYS) out.add("deadline_moved_earlier");
  }
  return HIGH_IMPACT_REASONS.filter((r) => out.has(r));
}

/**
 * Whether the edits change a deadline, the status or the application URL. Those need per-field
 * approval with the live official page opened during the claim, and the console logs the click.
 */
export function needsOfficialLink(cycle: CurrentCycle | null, edits: Edits): boolean {
  if (edits.deadlines.length > 0) return true;
  const c = edits.cycle;
  if (c.status !== undefined && c.status !== cycle?.status) return true;
  if (c.applicationUrl !== undefined && c.applicationUrl !== (cycle?.applicationUrl ?? null)) return true;
  return false;
}

/** Cycle fields whose value actually changes. */
export function changedCycleFields(cycle: CurrentCycle | null, edits: Edits): (keyof CurrentCycle)[] {
  const out: (keyof CurrentCycle)[] = [];
  const c = edits.cycle;
  for (const f of ["status", "applicationUrl", "applicationFeeCents", "opensOn"] as const) {
    if (c[f] === undefined) continue;
    if ((c[f] ?? null) !== (cycle?.[f] ?? null)) out.push(f);
  }
  return out;
}
