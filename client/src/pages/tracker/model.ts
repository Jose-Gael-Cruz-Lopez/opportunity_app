/**
 * Tracker board view model: tracked cycles joined to their program cards, grouped into status
 * columns and ordered by what is due first. Pure, so grouping and copy are unit-tested.
 */
import type { ProgramCard } from "@shared/contracts/registry";
import type { TrackerItem } from "@shared/contracts/student";
import { TRACKER_STATUSES, getOpportunityType, type TrackerStatus } from "@shared/taxonomy";
import { addDays, daysBetween } from "@shared/time";
import {
  TRACKER_STATUS_LABELS,
  countdownText,
  describeDeadline,
  formatShortDate,
  humanizeSlug,
  isHot,
  pickPrimaryDeadline,
  todayIn,
} from "@/components/readiness/format";

export interface TrackerCardView {
  readonly id: string;
  readonly version: number;
  readonly status: TrackerStatus;
  readonly programCycleId: string;
  readonly slug: string;
  readonly name: string;
  readonly organization: string | null;
  readonly typeLabel: string | null;
  readonly monogram: string;
  /** The one line under the title: the deadline, the campus date or the submission. */
  readonly line: string;
  readonly hot: boolean;
  /** "Start by Mon 5 Jan" from the card's prep days, while there is still something to start. */
  readonly startByLine: string | null;
  readonly startByLate: boolean;
  readonly ownCampusDeadline: string | null;
  /** The date this card sorts by (campus date first, else the national deadline). */
  readonly sortDate: string | null;
  readonly daysLeft: number | null;
  readonly isSample: boolean;
}

export interface TrackerColumn {
  readonly status: TrackerStatus;
  readonly label: string;
  readonly cards: readonly TrackerCardView[];
}

/** Two letters for the card badge: "Sample Coastal Research" -> "SC". */
export function monogramFor(name: string): string {
  const words = name.replace(/[^A-Za-z0-9 ]/g, " ").split(/\s+/).filter(Boolean);
  const letters = words.slice(0, 2).map((w) => w.charAt(0).toUpperCase());
  return letters.join("") || "?";
}

const ACTIVE: readonly TrackerStatus[] = ["interested", "applying"];

export function buildTrackerCard(item: TrackerItem, card: ProgramCard | undefined, now: number, tz: string): TrackerCardView {
  const today = todayIn(now, tz);
  const name = card?.name ?? humanizeSlug(item.programSlug);
  const primary = card ? pickPrimaryDeadline(card.deadlines, now, tz) : null;
  const deadline = primary ? describeDeadline(primary, now, tz) : null;

  // The student's own campus date wins: it is earlier and it is the one they must meet.
  const campusLeft = item.ownCampusDeadline ? daysBetween(today, item.ownCampusDeadline) : null;
  const daysLeft = campusLeft ?? deadline?.daysLeft ?? null;
  const sortDate = item.ownCampusDeadline ?? deadline?.date ?? null;

  let line: string;
  if (item.status === "submitted") line = item.submittedOn ? `Submitted ${formatShortDate(item.submittedOn)}` : "Submitted";
  else if (item.status === "decided") line = "Decision recorded";
  else if (item.status === "not_applying") line = "Not applying this cycle";
  else if (item.ownCampusDeadline) line = `Your campus deadline ${formatShortDate(item.ownCampusDeadline)} · ${countdownText(campusLeft)}`;
  else if (deadline?.date && deadline.daysLeft !== null) line = `${deadline.verb} ${formatShortDate(deadline.date)} · ${countdownText(deadline.daysLeft)}`;
  else if (deadline) line = deadline.officialText;
  else if (card?.status === "expected") line = "Expected to open; dates not announced";
  else line = "No deadline listed";

  let startByLine: string | null = null;
  let startByLate = false;
  if (ACTIVE.includes(item.status) && sortDate && card?.prepDays) {
    // A month-only deadline counts from the month's first day: starting early is the safe error.
    const startBy = addDays(sortDate.length === 7 ? `${sortDate}-01` : sortDate, -card.prepDays);
    const slack = daysBetween(today, startBy);
    if (daysLeft === null || daysLeft >= 0) {
      startByLate = slack < 0;
      startByLine = startByLate ? `Start now: materials take about ${card.prepDays} days` : `Start by ${formatShortDate(startBy)}`;
    }
  }

  const type = card?.opportunityTypes[0];
  return {
    id: item.id,
    version: item.version,
    status: item.status,
    programCycleId: item.programCycleId,
    slug: item.programSlug,
    name,
    organization: card?.organizationName ?? null,
    typeLabel: type ? getOpportunityType(type)?.label ?? null : null,
    monogram: monogramFor(name),
    line,
    hot: ACTIVE.includes(item.status) && isHot(daysLeft),
    startByLine,
    startByLate,
    ownCampusDeadline: item.ownCampusDeadline,
    sortDate,
    daysLeft,
    isSample: card?.isSample ?? false,
  };
}

/** Earliest date first; undated cards last, then by name. */
export function compareCards(a: TrackerCardView, b: TrackerCardView): number {
  if (a.sortDate && b.sortDate && a.sortDate !== b.sortDate) return a.sortDate.localeCompare(b.sortDate);
  if (a.sortDate && !b.sortDate) return -1;
  if (!a.sortDate && b.sortDate) return 1;
  return a.name.localeCompare(b.name);
}

export function groupTracker(items: readonly TrackerItem[], cards: ReadonlyMap<string, ProgramCard>, now: number, tz: string): TrackerColumn[] {
  const views = items.map((i) => buildTrackerCard(i, cards.get(i.programSlug), now, tz));
  return TRACKER_STATUSES.map((status) => ({
    status,
    label: TRACKER_STATUS_LABELS[status],
    cards: views.filter((v) => v.status === status).sort(compareCards),
  }));
}

/** Header counts: programs tracked, live deadlines in the next 30 days, applications submitted. */
export function trackerSummary(columns: readonly TrackerColumn[]): { tracked: number; dueSoon: number; submitted: number } {
  const all = columns.flatMap((c) => c.cards);
  return {
    tracked: all.length,
    dueSoon: all.filter((c) => ACTIVE.includes(c.status) && c.daysLeft !== null && c.daysLeft >= 0 && c.daysLeft <= 30).length,
    submitted: all.filter((c) => c.status === "submitted").length,
  };
}

/** The PATCH body for a move; moving to Submitted records today as the submission date. */
export function movePatch(card: TrackerCardView, to: TrackerStatus, today: string): { status: TrackerStatus; version: number; submittedOn?: string | null } {
  const patch: { status: TrackerStatus; version: number; submittedOn?: string | null } = { status: to, version: card.version };
  if (to === "submitted" && card.status !== "submitted") patch.submittedOn = today;
  if (to !== "submitted" && to !== "decided" && card.status === "submitted") patch.submittedOn = null;
  return patch;
}
