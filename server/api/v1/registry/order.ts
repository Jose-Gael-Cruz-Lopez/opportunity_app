import type { DeadlineView, ProgramCard } from "@shared/contracts/registry";
import { MATCHING_CONFIG } from "@shared/matching";
import type { CycleStatus, DeadlineKind } from "@shared/taxonomy";
import { MS_PER_DAY, parseIsoInstant } from "@shared/time";

/**
 * The public, unpersonalized order for lists (plan S06-016): open cycles first, then cycles
 * about to open, then paused, closed and ended ones; inside each group, by the next live national
 * deadline; ties by slug. Nothing here knows who is asking, so the order is the same for everyone.
 *
 * Nomination-gated cycles are placed at their estimated campus deadline (plan 6.4.5): E1 =
 * national - L80 while E1 is ahead, then E2 = national - L50, then the national date. Placing them
 * at the national date alone would surface them after most campus windows have closed.
 * ProgramCard carries no per-program lead times yet, so L80 and L50 are the published defaults.
 */

const STATUS_RANK: Readonly<Record<CycleStatus, number>> = {
  open: 0,
  relaunched: 1,
  expected: 1,
  paused: 2,
  closed: 3,
  ended: 4,
};

/** Kinds that are a step the student submits nationally (not informational dates). */
export const SUBMISSION_KINDS: ReadonlySet<DeadlineKind> = new Set([
  "application",
  "priority_round",
  "interest_form",
  "nomination",
  "campus_internal",
  "recommendation",
  "supplemental",
]);

/** Kinds that place a card in lists: the steps a student must meet to be considered at all. */
const PLACEMENT_KINDS: ReadonlySet<DeadlineKind> = new Set(["application", "priority_round", "interest_form"]);

/** Sorts undated cards after every dated one. */
const UNDATED = Number.POSITIVE_INFINITY;

function sortAtMs(d: Pick<DeadlineView, "sortAt">): number | null {
  return d.sortAt ? parseIsoInstant(d.sortAt) : null;
}

/**
 * Where a deadline sits in public lists. For nomination-gated cycles: E1 while it is ahead, then
 * E2, then the national instant itself.
 */
export function placementAt(nationalMs: number, nominationRequired: boolean, now: number): number {
  if (!nominationRequired) return nationalMs;
  const e1 = nationalMs - MATCHING_CONFIG.timing.campusL80Days * MS_PER_DAY;
  if (e1 >= now) return e1;
  const e2 = nationalMs - MATCHING_CONFIG.timing.campusL50Days * MS_PER_DAY;
  return e2 >= now ? e2 : nationalMs;
}

/** The earliest placement among a card's upcoming national submission deadlines, or Infinity. */
export function cardPlacement(card: ProgramCard, now: number): number {
  let best = UNDATED;
  for (const d of card.deadlines) {
    if (d.scope !== "national" || !PLACEMENT_KINDS.has(d.kind)) continue;
    const at = sortAtMs(d);
    if (at === null || at < now) continue;
    best = Math.min(best, placementAt(at, card.flags.nominationRequired, now));
  }
  return best;
}

export function publicOrder(cards: readonly ProgramCard[], now: number): ProgramCard[] {
  const keyed = cards.map((card) => ({ card, status: STATUS_RANK[card.status] ?? 5, at: cardPlacement(card, now) }));
  keyed.sort((a, b) => a.status - b.status || a.at - b.at || (a.card.slug < b.card.slug ? -1 : a.card.slug > b.card.slug ? 1 : 0));
  return keyed.map((k) => k.card);
}
