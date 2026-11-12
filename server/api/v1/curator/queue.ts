import type { ReviewTaskKind } from "@shared/taxonomy";
import type { QueueView } from "./schemas";

/**
 * Queue order and visibility (plan 04 4.10, runbook 14.4). Pure: the store reads candidate rows,
 * these functions decide which a Curator sees and in what order.
 *
 * Order through Phase 2: `dueAt` (an SLA's due time already encodes deadline proximity), then
 * severity (error report 1.0 down to hint 0.3), then the wedge flag, then priority and age.
 * Commerce never enters (REQ-043/045): nothing here reads a commerce table or field.
 */

/** Severity by kind; judgment values, plan 4.10 names the end points (error report 1.0, hint 0.3). */
export const KIND_SEVERITY: Readonly<Record<ReviewTaskKind, number>> = {
  error_report: 1.0,
  scam_flag: 0.95,
  cycle_update: 0.85,
  overdue_opening: 0.8,
  source_broken: 0.7,
  reconfirm: 0.65,
  campus_deadline: 0.6,
  new_program: 0.55,
  possible_duplicate: 0.5,
  rollover: 0.5,
  extraction_failed: 0.45,
  counts_table: 0.45,
  outcome_anomaly: 0.45,
  owner_update: 0.4,
  sponsor_claim: 0.4,
  posting_match: 0.4,
  promotion_copy: 0.35,
  resource_link: 0.35,
  relation_proposal: 0.35,
  band_model_approval: 0.35,
  community_hint: 0.3,
};

export function severityOf(kind: string): number {
  return KIND_SEVERITY[kind as ReviewTaskKind] ?? 0.4;
}

/** The fields queue logic reads from a task row. */
export interface QueueRow {
  id: string;
  kind: string;
  state: string;
  priority: number;
  dueAt: number | null;
  createdAt: number;
  claimedBy: string | null;
  claimExpiresAt: number | null;
  payload: Record<string, unknown>;
}

export interface QueueFacts {
  /** The subject's program is a wedge program (s01's season focus). */
  wedge: boolean;
}

/** `payload.snoozedUntil` as epoch ms, or null. */
export function snoozedUntil(row: Pick<QueueRow, "payload">): number | null {
  const v = row.payload.snoozedUntil;
  if (typeof v !== "string") return null;
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** The Curator who gave the first approval of a high-impact change, if any. */
export function firstApproverOf(row: Pick<QueueRow, "payload">): string | null {
  const first = row.payload.firstApproval;
  if (first && typeof first === "object" && typeof (first as { by?: unknown }).by === "string") return (first as { by: string }).by;
  return null;
}

function claimLive(row: QueueRow, now: number): boolean {
  return row.state === "claimed" && row.claimExpiresAt !== null && row.claimExpiresAt > now;
}

/**
 * Whether `curatorId` may claim the task now. Open tasks, expired claims and woken snoozes are
 * claimable; a live claim only by its holder; second review only by someone other than the
 * first approver; escalated tasks only by an admin.
 */
export function claimable(row: QueueRow, curatorId: string, now: number, isAdmin: boolean): { ok: true } | { ok: false; reason: string } {
  switch (row.state) {
    case "open":
      return { ok: true };
    case "claimed":
      if (row.claimedBy === curatorId) return { ok: true };
      if (claimLive(row, now)) return { ok: false, reason: "Another Curator holds this task." };
      // An expired second-review claim returns to the pool, but never to the first approver.
      if (firstApproverOf(row) === curatorId) return { ok: false, reason: "A second Curator must confirm this change." };
      return { ok: true };
    case "second_review":
      if (firstApproverOf(row) === curatorId) return { ok: false, reason: "A second Curator must confirm this change." };
      return { ok: true };
    case "snoozed": {
      const until = snoozedUntil(row);
      return until === null || until <= now ? { ok: true } : { ok: false, reason: "This task is snoozed." };
    }
    case "escalated":
      return isAdmin ? { ok: true } : { ok: false, reason: "Escalated tasks go to an admin." };
    default:
      return { ok: false, reason: "This task is closed." };
  }
}

/** Which rows a view shows (before ordering). */
export function inView(row: QueueRow, view: QueueView, curatorId: string, now: number): boolean {
  switch (view) {
    case "queue":
      // The shared queue: open, expired claims, second reviews someone else can give, woken snoozes.
      if (row.state === "open") return true;
      if (row.state === "claimed") return !claimLive(row, now) && firstApproverOf(row) !== curatorId;
      if (row.state === "second_review") return firstApproverOf(row) !== curatorId;
      if (row.state === "snoozed") return (snoozedUntil(row) ?? 0) <= now;
      return false;
    case "mine":
      return claimLive(row, now) && row.claimedBy === curatorId;
    case "second_review":
      return row.state === "second_review";
    case "escalated":
      return row.state === "escalated";
    case "snoozed":
      return row.state === "snoozed" && (snoozedUntil(row) ?? 0) > now;
  }
}

/** Queue comparator: due time (none last), severity, wedge, priority (lower first), age. */
export function compareQueue(a: QueueRow & QueueFacts, b: QueueRow & QueueFacts): number {
  const da = a.dueAt ?? Number.POSITIVE_INFINITY;
  const db = b.dueAt ?? Number.POSITIVE_INFINITY;
  if (da !== db) return da < db ? -1 : 1;
  const sa = severityOf(a.kind);
  const sb = severityOf(b.kind);
  if (sa !== sb) return sb - sa;
  if (a.wedge !== b.wedge) return a.wedge ? -1 : 1;
  if (a.priority !== b.priority) return a.priority - b.priority;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function orderQueue<T extends QueueRow & QueueFacts>(rows: readonly T[]): T[] {
  return [...rows].sort(compareQueue);
}

/** Offset cursors (`o:{n}`): the queue reorders as SLAs pass, so keyset cursors buy nothing here. */
export function decodeCursor(cursor: string | undefined): number {
  if (!cursor) return 0;
  const m = /^o:(\d{1,5})$/.exec(cursor);
  return m ? Number(m[1]) : 0;
}

export function encodeCursor(offset: number, total: number): string | null {
  return offset < total ? `o:${offset}` : null;
}

/** The claim lease (plan 4.10: 15 minutes). */
export const CLAIM_LEASE_MS = 15 * 60_000;
