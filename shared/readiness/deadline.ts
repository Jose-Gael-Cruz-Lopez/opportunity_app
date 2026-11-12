import { READINESS_CONFIG } from "./config";
import { epochDayOf, isoFromEpochDay, minDate, type IsoDate } from "./calendar";
import { NATIONAL_SUBMISSION_KINDS, type DeadlineKind, type DeadlineScope } from "../taxonomy";
import { lastDayOfMonth, parseIsoDate, parseIsoMonth } from "../time/iso";
import { resolveDeadlineForViewer, type DeadlineTimeFields } from "../time/deadline";
import { endOfLocalDay, isValidTimeZone, localDateIn } from "../time/zones";

/**
 * The deadline that readiness counts back from, following s06 6.4.5 step by step:
 *   1. known campus dates (the student's private date, an official campus row for their
 *      Institution, an attested row), earliest still upcoming;
 *   2. E1 = national − L80 for nomination-gated cycles with no known campus date;
 *   3. E2 = national − L50 once E1 has passed;
 *   4. the national date once E2 or every known campus date has passed, labelled so the student
 *      asks their fellowship office;
 *   5. otherwise the next unexpired priority round, then the final application deadline.
 * Callers that already have s06's effectiveDeadline pass it in instead (assessReadiness accepts
 * an override), so this is the same rule, not a second policy.
 *
 * Planning dates are local calendar dates. A fixed-zone deadline uses the earlier of its date in
 * its own zone and in the student's zone, so a student west of the program never plans past it;
 * applicant-local deadlines resolve in the student's zone (plan 7.4.2).
 */

export interface DeadlineLike extends DeadlineTimeFields {
  readonly id: string;
  readonly kind: DeadlineKind;
  readonly scope: DeadlineScope;
  readonly institutionId: string | null;
  readonly roundLabel?: string;
  readonly withdrawnAt?: string | null;
}

export interface PlannedDeadline {
  readonly deadlineId: string | null;
  readonly kind: DeadlineKind | null;
  readonly date: IsoDate;
  /** The submission instant for this student, when the row has one. */
  readonly instant: number | null;
  readonly timeZone: string | null;
  readonly localTime: string | null;
  /** Month-only rows, predicted windows and estimates have no exact day. */
  readonly approximate: boolean;
  /**
   * For month-only rows and windows, the latest plausible day (last of the month, window end).
   * `date` is the earliest plausible day, which is what a plan counts back from while it lies ahead.
   */
  readonly latestDate?: IsoDate | null;
  readonly predicted: boolean;
  readonly passed: boolean;
}

export type EffectiveDeadlineStep =
  | "known_campus"
  | "campus_estimate_e1"
  | "campus_estimate_e2"
  | "national_after_campus"
  | "priority_round"
  | "final";

export type EffectiveDeadlineBasis = "official" | "attested" | "estimated" | "student_entered" | "predicted";

export interface EffectiveDeadline extends PlannedDeadline {
  readonly basis: EffectiveDeadlineBasis;
  readonly scope: DeadlineScope;
  readonly step: EffectiveDeadlineStep;
  readonly label: string;
  /** The final national deadline that bounds every date in the plan. */
  readonly final: PlannedDeadline | null;
  /** True once the final national deadline has passed for this student. */
  readonly closed: boolean;
  readonly campusEstimate: { readonly e1: IsoDate; readonly e2: IsoDate } | null;
  /** The latest known campus date that has passed ("Your campus deadline was ..."). */
  readonly campusDatePassed: IsoDate | null;
  /**
   * Set when an approximate deadline's earliest plausible day has passed but the deadline itself
   * may not have: `date` then holds the latest plausible day and this keeps the passed bound.
   */
  readonly earliestLikelyPassed?: IsoDate | null;
}

export interface CampusLead {
  /** 80th percentile of known national-minus-campus lead days (default 70 until five are known). */
  readonly l80Days: number;
  /** Median known lead (default 42). */
  readonly l50Days: number;
}

export interface EffectiveDeadlineInput {
  readonly deadlines: readonly DeadlineLike[];
  readonly now: number;
  readonly studentTimeZone: string;
  readonly studentInstitutionId: string | null;
  /** The student's private campus date from their TrackerItem. */
  readonly ownCampusDeadline: IsoDate | null;
  readonly nominationGated: boolean;
  readonly campusLead?: CampusLead | null;
}

/** A deadline row as a planning date for this student, or null for rolling, TBD and withdrawn rows. */
export function planDeadline(d: DeadlineLike, studentTimeZone: string, now: number): PlannedDeadline | null {
  if (d.withdrawnAt) return null;
  const today = localDateIn(now, studentTimeZone);
  const base = {
    deadlineId: d.id,
    kind: d.kind,
    timeZone: d.tzMode === "fixed" ? d.timeZone : null,
    localTime: d.precision === "exact" ? d.localTime : null,
    predicted: d.basis === "predicted",
  };
  if (d.precision === "exact" || d.precision === "date_only") {
    // A fixed row needs a real zone; the contract refuses others, but one bad row must not take
    // the whole report down.
    if (d.tzMode === "fixed" && !(d.timeZone && isValidTimeZone(d.timeZone))) return null;
    const view = resolveDeadlineForViewer(d, studentTimeZone);
    if (view.instant === null) return null;
    const studentDate = localDateIn(view.instant, studentTimeZone);
    const ownZone = d.tzMode === "fixed" && d.timeZone && isValidTimeZone(d.timeZone) ? d.timeZone : null;
    const date = ownZone ? minDate(localDateIn(view.instant, ownZone), studentDate) : studentDate;
    return { ...base, date, instant: view.instant, approximate: false, passed: view.instant < now };
  }
  if (d.precision === "month_only" && d.localDate) {
    const month = parseIsoMonth(d.localDate.slice(0, 7));
    if (!month) return null;
    // Plan to the first of the month: the day is unknown, and planning late is the costly error.
    const first = `${d.localDate.slice(0, 7)}-01`;
    const last = lastDayOfMonth(month.year, month.month);
    return { ...base, date: first, latestDate: last, instant: null, approximate: true, passed: last < today };
  }
  if (d.precision === "window" && d.windowStart && parseIsoDate(d.windowStart)) {
    // Predicted windows plan to p10, the earliest plausible date.
    const end = d.windowEnd && parseIsoDate(d.windowEnd) ? d.windowEnd : d.windowStart;
    return { ...base, date: d.windowStart, latestDate: end, instant: null, approximate: true, passed: end < today };
  }
  return null;
}

/**
 * The date to plan against for a deadline that may still be open. While the planning date lies
 * ahead it is used as is. Once it is behind today:
 * - an approximate row (month-only, window) moves to its latest plausible day, because its real
 *   day may still be weeks away and planning to today would mark every item late;
 * - an exact row that has not passed is due today in the student's zone (its date can trail the
 *   student's calendar when the program's zone is west of the student).
 */
export function openPlanningDate(planned: Pick<PlannedDeadline, "date" | "passed" | "approximate" | "latestDate">, today: IsoDate): IsoDate {
  if (planned.passed || planned.date >= today) return planned.date;
  if (planned.approximate && planned.latestDate && planned.latestDate >= today) return planned.latestDate;
  return today;
}

function byDateThenId(a: PlannedDeadline, b: PlannedDeadline): number {
  if (a.date !== b.date) return a.date < b.date ? -1 : 1;
  return (a.deadlineId ?? "") < (b.deadlineId ?? "") ? -1 : 1;
}

/** The final national submission deadline: the latest national application or nomination row. */
export function finalNationalDeadline(deadlines: readonly DeadlineLike[], studentTimeZone: string, now: number): PlannedDeadline | null {
  const planned = deadlines
    .filter((d) => d.scope === "national" && NATIONAL_SUBMISSION_KINDS.has(d.kind))
    .map((d) => planDeadline(d, studentTimeZone, now))
    .filter((p): p is PlannedDeadline => p !== null)
    .sort(byDateThenId);
  return planned.length > 0 ? planned[planned.length - 1]! : null;
}

function finalLabel(final: PlannedDeadline): string {
  const noun = final.kind === "nomination" ? "Nomination deadline" : "Application deadline";
  return final.predicted ? `${noun} (expected, from past cycles)` : final.approximate ? `${noun} (month only)` : noun;
}

function basisOf(p: PlannedDeadline): EffectiveDeadlineBasis {
  return p.predicted ? "predicted" : "official";
}

/** Resolves the effective deadline, or null when the cycle has no dated national deadline. */
export function resolveEffectiveDeadline(input: EffectiveDeadlineInput): EffectiveDeadline | null {
  const zone = input.studentTimeZone;
  const today = localDateIn(input.now, zone);
  const final = finalNationalDeadline(input.deadlines, zone, input.now);
  const closed = final?.passed ?? false;
  const common = { final, closed };

  // Step 1: known campus dates.
  const known: { planned: PlannedDeadline; basis: EffectiveDeadlineBasis; label: string }[] = [];
  if (input.ownCampusDeadline && parseIsoDate(input.ownCampusDeadline)) {
    const instant = endOfLocalDay(input.ownCampusDeadline, zone);
    known.push({
      planned: {
        deadlineId: null,
        kind: "campus_internal",
        date: input.ownCampusDeadline,
        instant,
        timeZone: null,
        localTime: null,
        approximate: false,
        predicted: false,
        passed: instant < input.now,
      },
      basis: "student_entered",
      label: "Your campus deadline (you entered it)",
    });
  }
  if (input.studentInstitutionId) {
    for (const d of input.deadlines) {
      if (d.scope !== "campus" || d.institutionId !== input.studentInstitutionId) continue;
      if (d.basis !== "official" && d.basis !== "attested") continue;
      const planned = planDeadline(d, zone, input.now);
      if (!planned) continue;
      known.push({
        planned,
        basis: d.basis,
        label: d.basis === "attested" ? "Confirmed by your campus" : "Your campus deadline",
      });
    }
  }
  // A campus date after the national deadline is a typo or a stale row: the national date bounds
  // every date in the plan, so such a date is ignored rather than planned against.
  const upcoming = known
    .filter((k) => !k.planned.passed && (!final || k.planned.date <= final.date))
    .sort((a, b) => byDateThenId(a.planned, b.planned));
  const passedKnown = known.filter((k) => k.planned.passed).map((k) => k.planned.date).sort();
  const campusDatePassed = passedKnown.length > 0 ? passedKnown[passedKnown.length - 1]! : null;
  if (upcoming.length > 0) {
    const first = upcoming[0]!;
    return { ...first.planned, ...common, basis: first.basis, scope: "campus", step: "known_campus", label: first.label, campusEstimate: null, campusDatePassed };
  }

  // Steps 2-4: nomination-gated cycles without a known upcoming campus date.
  if (input.nominationGated && final) {
    const lead = input.campusLead ?? { l80Days: READINESS_CONFIG.campus.l80Days, l50Days: READINESS_CONFIG.campus.l50Days };
    const finalDay = epochDayOf(final.date);
    const e1 = isoFromEpochDay(finalDay - Math.max(0, Math.round(lead.l80Days)));
    const e2 = isoFromEpochDay(finalDay - Math.max(0, Math.round(lead.l50Days)));
    const campusEstimate = { e1, e2 };
    const estimate = (date: IsoDate, step: EffectiveDeadlineStep, label: string): EffectiveDeadline => ({
      deadlineId: null,
      kind: "campus_internal",
      date,
      instant: endOfLocalDay(date, zone),
      timeZone: null,
      localTime: null,
      approximate: true,
      predicted: false,
      passed: date < today,
      ...common,
      basis: "estimated",
      scope: "campus",
      step,
      label,
      campusEstimate,
      campusDatePassed,
    });
    if (campusDatePassed === null && today <= e1) {
      return estimate(e1, "campus_estimate_e1", "Estimated: confirm with your campus representative");
    }
    if (campusDatePassed === null && today <= e2) {
      return estimate(e2, "campus_estimate_e2", "Your campus deadline may be soon or may have passed: confirm with your campus representative");
    }
    return {
      ...final,
      ...common,
      basis: basisOf(final),
      scope: "national",
      step: "national_after_campus",
      label: "Your campus deadline may have passed: ask your fellowship office whether you can still be considered",
      campusEstimate,
      campusDatePassed,
    };
  }

  // A known campus date passed on a cycle that is not nomination-gated: fall back to national.
  // Step 5: the next unexpired priority round, then the final deadline.
  const rounds = input.deadlines
    .filter((d) => d.scope === "national" && d.kind === "priority_round")
    .map((d) => ({ d, planned: planDeadline(d, zone, input.now) }))
    .filter((r): r is { d: DeadlineLike; planned: PlannedDeadline } => r.planned !== null && !r.planned.passed)
    .sort((a, b) => byDateThenId(a.planned, b.planned));
  if (rounds.length > 0 && (!final || rounds[0]!.planned.date <= final.date)) {
    const round = rounds[0]!;
    const label = round.d.roundLabel ? `Priority round: ${round.d.roundLabel}` : "Priority round";
    return { ...round.planned, ...common, basis: basisOf(round.planned), scope: "national", step: "priority_round", label, campusEstimate: null, campusDatePassed };
  }
  if (!final) return null;
  return { ...final, ...common, basis: basisOf(final), scope: "national", step: "final", label: finalLabel(final), campusEstimate: null, campusDatePassed };
}
