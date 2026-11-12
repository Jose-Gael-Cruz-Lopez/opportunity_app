import { PRODUCT } from "../config/product";
import type { CycleStatus, Freshness, VerificationDisplay, VerificationStored } from "../taxonomy";
import { MS_PER_DAY, parseIsoDate, parseIsoInstant } from "./iso";
import { endOfLocalDay } from "./zones";

/**
 * Season and freshness. Every surface (pages, ordering, citations, badges) calls these, so a
 * record shows the same badge everywhere.
 */

export interface SeasonInput {
  readonly status: CycleStatus;
  /** Official opening date (`YYYY-MM-DD`), if known. */
  readonly opensOn?: string | null;
  /** p10 of the predicted opening, if the cycle is expected. */
  readonly predictedOpensP10?: string | null;
  /** Sort instants (epoch ms) of the cycle's live deadlines. */
  readonly deadlineSortAts?: readonly (number | null)[];
}

function dateWithin(isoDate: string | null | undefined, now: number, days: number): boolean {
  if (!isoDate || !parseIsoDate(isoDate)) return false;
  // Use the latest US zone so a date counts until it has ended everywhere a student might be.
  const at = endOfLocalDay(isoDate, PRODUCT.latestUsTimeZone);
  return at >= now && at - now <= days * MS_PER_DAY;
}

/** In season: open, opening (or its p10) within 30 days, or a deadline within 60 days. */
export function isInSeason(cycle: SeasonInput, now: number): boolean {
  if (cycle.status === "open") return true;
  const { openOrP10WithinDays, deadlineWithinDays } = PRODUCT.inSeason;
  if (dateWithin(cycle.opensOn, now, openOrP10WithinDays)) return true;
  if (dateWithin(cycle.predictedOpensP10, now, openOrP10WithinDays)) return true;
  return (cycle.deadlineSortAts ?? []).some(
    (t) => t !== null && t >= now && t - now <= deadlineWithinDays * MS_PER_DAY,
  );
}

export interface VerifiableRow {
  readonly verificationState: VerificationStored;
  /** Epoch ms or an ISO instant; null when never Curator-verified. */
  readonly lastVerifiedAt: number | string | null;
}

function toMs(value: number | string | null): number | null {
  if (value === null) return null;
  return typeof value === "number" ? value : parseIsoInstant(value);
}

/** fresh / aging / stale from days since Curator verification, with in-season and off-season windows. */
export function freshness(row: VerifiableRow, now: number, inSeason: boolean): Freshness {
  const verifiedAt = toMs(row.lastVerifiedAt);
  if (verifiedAt === null) return "stale";
  const ageDays = (now - verifiedAt) / MS_PER_DAY;
  const [freshUntil, agingUntil] = inSeason ? PRODUCT.freshness.inSeason : PRODUCT.freshness.offSeason;
  if (ageDays <= freshUntil) return "fresh";
  if (ageDays <= agingUntil) return "aging";
  return "stale";
}

/** The display state: stored states pass through, except a verified record that has gone stale. */
export function verificationState(row: VerifiableRow, now: number, inSeason: boolean): VerificationDisplay {
  if (row.verificationState !== "verified") return row.verificationState;
  return freshness(row, now, inSeason) === "stale" ? "stale" : "verified";
}
