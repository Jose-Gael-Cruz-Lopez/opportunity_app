import { PRODUCT } from "../config/product";
import type { DeadlineBasis, DeadlinePrecision, TzMode } from "../taxonomy";
import { parseIsoDate, parseIsoMonth, lastDayOfMonth, toIsoInstant } from "./iso";
import { endOfLocalDay, localDateIn, localDateTimeToInstant, localTimeIn, isValidTimeZone } from "./zones";

/**
 * Deadline instants. A Deadline keeps what the official page said (date, time, zone or
 * "your time zone") plus any instant derivable from it. This module is the only place that turns
 * those fields into instants; nothing else parses a published date.
 */

/** The fields of a Deadline that determine its instants (structural, so DB rows and API objects both fit). */
export interface DeadlineTimeFields {
  readonly basis: DeadlineBasis;
  readonly precision: DeadlinePrecision;
  readonly tzMode: TzMode;
  /** `YYYY-MM-DD`, or `YYYY-MM` for month-only rows; p50 (display only) for predicted windows. */
  readonly localDate: string | null;
  /** `HH:MM`, only for exact rows. */
  readonly localTime: string | null;
  readonly windowStart?: string | null;
  readonly windowEnd?: string | null;
  /** IANA zone for fixed rows (stated, else the Organization's default). */
  readonly timeZone: string | null;
}

export const LATEST_US_TIME_ZONE = PRODUCT.latestUsTimeZone;

function isDated(precision: DeadlinePrecision): boolean {
  return precision === "exact" || precision === "date_only";
}

/** Local instant for an exact or date-only value in `zone` (date-only means 23:59:59.999 local). */
function instantInZone(d: DeadlineTimeFields, zone: string): number | null {
  if (!d.localDate || !parseIsoDate(d.localDate)) return null;
  if (d.precision === "exact") {
    return d.localTime ? localDateTimeToInstant(d.localDate, d.localTime, zone) : null;
  }
  return endOfLocalDay(d.localDate, zone);
}

/**
 * `due_at`: only fixed rows with an exact or date-only value have one. Applicant-local rows
 * ("11:59 pm, your time zone") have none, because the instant depends on the student.
 */
export function computeDueAt(d: DeadlineTimeFields): number | null {
  if (d.tzMode !== "fixed" || !isDated(d.precision) || !d.timeZone) return null;
  return instantInZone(d, d.timeZone);
}

/**
 * `sort_at` orders lists and drives closing: `due_at`; else the applicant-local value in the
 * latest US zone (so nobody's deadline sorts before it has passed for them); else the end of
 * p10 for predicted windows; else the end of the month for month-only rows. Rolling and TBD rows
 * have no sort instant.
 */
export function computeSortAt(d: DeadlineTimeFields): number | null {
  const due = computeDueAt(d);
  if (due !== null) return due;
  const fallbackZone = d.timeZone && isValidTimeZone(d.timeZone) ? d.timeZone : LATEST_US_TIME_ZONE;
  if (d.tzMode === "applicant_local" && isDated(d.precision)) {
    return instantInZone(d, LATEST_US_TIME_ZONE);
  }
  if (d.precision === "window") {
    return d.windowStart && parseIsoDate(d.windowStart) ? endOfLocalDay(d.windowStart, fallbackZone) : null;
  }
  if (d.precision === "month_only" && d.localDate) {
    const month = parseIsoMonth(d.localDate.slice(0, 7));
    return month ? endOfLocalDay(lastDayOfMonth(month.year, month.month), fallbackZone) : null;
  }
  return null;
}

export interface ViewerDeadline {
  /** The instant the deadline falls for this viewer, or null when it has no single instant. */
  readonly instant: number | null;
  readonly instantIso: string | null;
  /** The deadline's date and time on the viewer's own clock. */
  readonly viewerLocalDate: string | null;
  readonly viewerLocalTime: string | null;
  readonly viewerTimeZone: string;
  /** The zone the official page states, or null for "your time zone" rows. */
  readonly sourceTimeZone: string | null;
  readonly applicantLocal: boolean;
  /** False for date-only rows: the page gave no time, so plan to submit a day early. */
  readonly timeStated: boolean;
  /** True for month-only and predicted-window rows, which have no exact day. */
  readonly approximate: boolean;
  readonly predicted: boolean;
}

/**
 * Converts a Deadline from its source zone to the viewer's local time. Applicant-local rows are
 * evaluated in the viewer's zone, as the official page instructs.
 */
export function resolveDeadlineForViewer(
  d: DeadlineTimeFields,
  viewerTimeZone: string | null | undefined,
): ViewerDeadline {
  const zone = viewerTimeZone && isValidTimeZone(viewerTimeZone) ? viewerTimeZone : PRODUCT.fallbackTimeZone;
  const applicantLocal = d.tzMode === "applicant_local";
  const instant = applicantLocal
    ? isDated(d.precision)
      ? instantInZone(d, zone)
      : null
    : computeDueAt(d);
  return {
    instant,
    instantIso: instant === null ? null : toIsoInstant(instant),
    viewerLocalDate: instant === null ? (d.precision === "window" ? d.windowStart ?? null : d.localDate) : localDateIn(instant, zone),
    viewerLocalTime: instant === null || d.precision !== "exact" ? null : localTimeIn(instant, zone),
    viewerTimeZone: zone,
    sourceTimeZone: applicantLocal ? null : d.timeZone,
    applicantLocal,
    timeStated: d.precision === "exact",
    approximate: d.precision === "month_only" || d.precision === "window",
    predicted: d.basis === "predicted",
  };
}

/** Fields whose change bumps a Deadline's `revision` (the ICS SEQUENCE). */
export interface DeadlineRevisionFields extends DeadlineTimeFields {
  readonly kind: string;
  readonly scope: string;
  readonly withdrawnAt?: number | string | null;
}

export function revisionChanged(prev: DeadlineRevisionFields, next: DeadlineRevisionFields): boolean {
  const keys = [
    "kind",
    "scope",
    "basis",
    "precision",
    "tzMode",
    "localDate",
    "localTime",
    "windowStart",
    "windowEnd",
    "timeZone",
  ] as const;
  if (keys.some((k) => (prev[k] ?? null) !== (next[k] ?? null))) return true;
  return (prev.withdrawnAt ?? null) === null && (next.withdrawnAt ?? null) !== null;
}

/** True when the deadline has passed for this viewer at `now`. Rows without an instant never pass. */
export function hasPassed(d: DeadlineTimeFields, now: number, viewerTimeZone?: string | null): boolean {
  const { instant } = resolveDeadlineForViewer(d, viewerTimeZone);
  return instant !== null && instant < now;
}
