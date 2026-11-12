import { PRODUCT } from "../config/product";
import type { DeadlineView } from "../contracts/registry";
import { resolveDeadlineForViewer, type ViewerDeadline } from "../time/deadline";
import { addDays, lastDayOfMonth, parseIsoDate, parseIsoMonth } from "../time/iso";
import { daysFrom, formatShortDate, laterDate } from "./dates";
import { type PrepSummary, SUBMIT_BUFFER_DAYS, summarizeRequirements, type PrepModel, DEFAULT_PREP_MODEL } from "./schedule";
import { plural } from "./text";
import type { Feasibility, OnboardingProgram } from "./types";

/**
 * Feasibility: can the student still finish this application, and by when must they start?
 * Dates are calendar days in the student's zone. The rules follow plans 06 (6.4.5, 6.6.1) and
 * 07 (7.4.2): start-by = effective deadline - prepDays, so onboarding agrees with Explore's
 * order and the Tracker's latestStart. shared/eligibility will own `effectiveDeadline`; this is
 * the onboarding fallback for the national rows a release card carries.
 */

/** Plan 06 defaults while fewer than five campus deadlines are known: E1 = national - 70 days, E2 = national - 42 days. */
export const CAMPUS_LEAD_L80_DAYS = 70;
export const CAMPUS_LEAD_L50_DAYS = 42;

/** "Opening soon" uses the in-season window (shared/config): opening within 30 days. */
export const OPENING_SOON_DAYS: number = PRODUCT.inSeason.openOrP10WithinDays;

/**
 * Whether a cycle can be offered now: open, or expected (or relaunching) and opening within the
 * in-season window by its stated or predicted (p10) date. An expected cycle with no date at all
 * is not offered, because nothing tells the student when to come back. findMatches and the
 * quiz's adaptive pairs share this rule, so the pairs split what matching can actually show.
 */
export function onOffer(
  card: { readonly status?: string; readonly opensOn?: string | null; readonly prediction?: { readonly p10: string } | null },
  today: string,
): boolean {
  if (card.status === undefined || card.status === "open") return true;
  if (card.status === "expected" || card.status === "relaunched") {
    const opens = card.opensOn ?? card.prediction?.p10 ?? null;
    return opens !== null && daysFrom(today, opens) <= OPENING_SOON_DAYS;
  }
  return false;
}

/** Programs whose start-by passed more than 30 days ago cannot be done well and are dropped. */
export const TOO_LATE_DAYS = 30;

/**
 * Rolling and unannounced deadlines have no date, so onboarding suggests applying within four
 * weeks (judgment: rolling programs fill as applications arrive). It is labelled as a
 * suggestion, never as an official date.
 */
export const ROLLING_TARGET_DAYS = 28;

const APPLY_KINDS: ReadonlySet<string> = new Set(["application", "priority_round"]);
const NOMINATION_KINDS: ReadonlySet<string> = new Set(["application", "priority_round", "nomination"]);

export type DeadlineBasis = Feasibility["basis"];

/**
 * Viewer-zone resolution of a deadline row, memoized per row object and zone: the Intl work is
 * the costliest step when a whole catalogue is scanned, and a row's instant never depends on now.
 */
const VIEWER_CACHE = new WeakMap<object, Map<string, ViewerDeadline>>();

function resolveCached(d: DeadlineView, timeZone: string): ViewerDeadline {
  let byZone = VIEWER_CACHE.get(d);
  if (!byZone) {
    byZone = new Map();
    VIEWER_CACHE.set(d, byZone);
  }
  let v = byZone.get(timeZone);
  if (!v) {
    v = resolveDeadlineForViewer(d, timeZone);
    byZone.set(timeZone, v);
  }
  return v;
}

export interface EffectiveDeadline {
  readonly date: string | null;
  readonly basis: DeadlineBasis;
  readonly campusStep: "e1" | "e2" | "national" | null;
}

interface DatedCandidate {
  readonly date: string;
  readonly exact: boolean;
}

/**
 * The deadline the student works to, or "passed" when every application deadline is over.
 * Order: the next unexpired priority round or application deadline; for nomination-gated
 * programs, the estimated campus deadline E1, then E2, then the national date.
 */
export function effectiveDeadline(
  card: { readonly deadlines: readonly DeadlineView[]; readonly flags: { readonly nominationRequired: boolean } },
  nowMs: number,
  timeZone: string,
  today: string,
): EffectiveDeadline | "passed" {
  const kinds = card.flags.nominationRequired ? NOMINATION_KINDS : APPLY_KINDS;
  const dated: DatedCandidate[] = [];
  let rolling = false;
  let tbd = false;
  let sawAny = false;
  for (const d of card.deadlines as readonly (DeadlineView & { readonly withdrawnAt?: unknown })[]) {
    // Detail rows (Deadline) can be withdrawn; card rows (DeadlineView) never carry withdrawn ones.
    if (!kinds.has(d.kind) || d.scope !== "national" || (d.withdrawnAt !== undefined && d.withdrawnAt !== null)) continue;
    sawAny = true;
    switch (d.precision) {
      case "exact":
      case "date_only": {
        const v = resolveCached(d, timeZone);
        if (v.instant === null || v.viewerLocalDate === null) {
          tbd = true;
        } else if (v.instant >= nowMs) {
          dated.push({ date: v.viewerLocalDate, exact: d.basis === "official" });
        }
        break;
      }
      case "month_only": {
        const m = d.localDate ? parseIsoMonth(d.localDate.slice(0, 7)) : null;
        if (!m) {
          tbd = true;
          break;
        }
        const first = `${d.localDate!.slice(0, 7)}-01`;
        const last = lastDayOfMonth(m.year, m.month);
        // Planning counts from the first of the month (the earliest the deadline can be).
        if (last >= today) dated.push({ date: laterDate(first, today), exact: false });
        break;
      }
      case "window": {
        if (!d.windowStart || !d.windowEnd || !parseIsoDate(d.windowStart)) {
          tbd = true;
          break;
        }
        if (d.windowEnd >= today) dated.push({ date: laterDate(d.windowStart, today), exact: false });
        break;
      }
      case "rolling":
        rolling = true;
        break;
      case "tbd":
        tbd = true;
        break;
    }
  }
  if (dated.length > 0) {
    dated.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : Number(b.exact) - Number(a.exact)));
    const first = dated[0] as DatedCandidate;
    const basis: DeadlineBasis = first.exact ? "official" : "estimated";
    if (card.flags.nominationRequired) {
      const e1 = addDays(first.date, -CAMPUS_LEAD_L80_DAYS);
      if (e1 >= today) return { date: e1, basis: "campus_estimate", campusStep: "e1" };
      const e2 = addDays(first.date, -CAMPUS_LEAD_L50_DAYS);
      if (e2 >= today) return { date: e2, basis: "campus_estimate", campusStep: "e2" };
      return { date: first.date, basis, campusStep: "national" };
    }
    return { date: first.date, basis, campusStep: null };
  }
  if (rolling) return { date: null, basis: "rolling", campusStep: null };
  if (tbd || !sawAny) return { date: null, basis: "not_announced", campusStep: null };
  return "passed";
}

export interface FeasibilityInput {
  readonly program: OnboardingProgram;
  readonly nowMs: number;
  readonly timeZone: string;
  readonly today: string;
  /** The student's own hours a week for applications (quiz answer). */
  readonly weeklyHours: number;
  readonly prepModel?: PrepModel;
}

export interface FeasibilityResult extends Feasibility {
  readonly campusStep: EffectiveDeadline["campusStep"];
  readonly prep: PrepSummary | null;
  readonly checked: boolean;
}

/**
 * Computes the card's feasibility, or null when the program cannot be done: every deadline has
 * passed, or the start-by date passed more than 30 days ago. enoughTime needs both:
 * - calendar room: today is on or before start-by (when preparation is unknown, at least the
 *   two-day submit buffer remains), and
 * - the student's own hours: the listed work fits in their weekly hours before the deadline.
 */
export function computeFeasibility(input: FeasibilityInput): FeasibilityResult | null {
  const { program, nowMs, timeZone, today, weeklyHours } = input;
  const ed = effectiveDeadline(program, nowMs, timeZone, today);
  if (ed === "passed") return null;
  // An empty requirements list means "not checked yet", exactly like a missing one (see
  // planFirstApplication). Treating [] as "checked, zero prep" would put start-by on the
  // deadline and call a program due tomorrow comfortable.
  const reqs = program.extras?.requirements;
  const listed = reqs !== undefined && reqs.length > 0 ? reqs : undefined;
  const prep = listed ? summarizeRequirements(listed, input.prepModel ?? DEFAULT_PREP_MODEL) : null;
  const checked = listed !== undefined || program.prepDays !== null;
  const prepDays = prep ? prep.prepDays ?? 0 : program.prepDays;
  const hours = prep ? prep.hours : null;

  if (ed.date === null) {
    // Rolling or not announced: suggest an apply-by date from the opening (or today).
    const opens = program.opensOn && program.opensOn > today ? program.opensOn : today;
    const applyBy = addDays(opens, ROLLING_TARGET_DAYS);
    const startBy = prepDays === null ? today : laterDate(today, addDays(applyBy, -prepDays));
    const label =
      ed.basis === "rolling"
        ? `Rolling admission: aim to apply by ${formatShortDate(applyBy, today)}`
        : `Deadline not announced yet${opens > today ? ` · opens ${formatShortDate(opens, today)}` : ""}: start early`;
    return {
      startBy,
      daysLeft: daysFrom(today, applyBy),
      enoughTime: true,
      deadline: null,
      basis: ed.basis,
      prepDays,
      prepHours: hours,
      tight: false,
      label,
      campusStep: null,
      prep,
      checked,
    };
  }

  const deadline = ed.date;
  const daysLeft = daysFrom(today, deadline);
  const startBy = prepDays === null ? deadline : addDays(deadline, -prepDays);
  if (daysFrom(startBy, today) > TOO_LATE_DAYS) return null;
  const calendarOk = prepDays === null ? daysLeft >= SUBMIT_BUFFER_DAYS : startBy >= today;
  const availableHours = (weeklyHours * Math.max(daysLeft, 0)) / 7;
  const capacityOk = hours === null || hours <= availableHours + 1e-9;
  const enoughTime = calendarOk && capacityOk;
  const label = feasibilityLabel({ ed, deadline, startBy, daysLeft, prepDays, hours, prep, enoughTime, calendarOk, weeklyHours, today });
  return {
    startBy,
    daysLeft,
    enoughTime,
    deadline,
    basis: ed.basis,
    prepDays,
    prepHours: hours,
    tight: !enoughTime,
    label,
    campusStep: ed.campusStep,
    prep,
    checked,
  };
}

function feasibilityLabel(a: {
  ed: EffectiveDeadline;
  deadline: string;
  startBy: string;
  daysLeft: number;
  prepDays: number | null;
  hours: number | null;
  prep: PrepSummary | null;
  enoughTime: boolean;
  calendarOk: boolean;
  weeklyHours: number;
  today: string;
}): string {
  const due = formatShortDate(a.deadline, a.today);
  const campus = a.ed.basis === "campus_estimate" ? ` · campus deadline about ${due} (estimate)` : "";
  if (!a.enoughTime) {
    if (!a.calendarOk) {
      if (a.prepDays === null) return a.daysLeft <= 0 ? "Due today" : `Due in ${plural(a.daysLeft, "day", "days")}`;
      if (a.prep && a.prep.letters > 0) return `Tight timeline: needs ${plural(a.prep.letters, "letter", "letters")} · due ${due}`;
      return `Tight timeline: about ${plural(a.prepDays, "day", "days")} of prep · due ${due}`;
    }
    return `Tight for ${a.weeklyHours} h a week: about ${formatHours(a.hours ?? 0)} of prep · due ${due}`;
  }
  if (a.prepDays === null) return `Due ${due} · prep time not checked yet`;
  const start = `Start by ${formatShortDate(a.startBy, a.today)}`;
  if (a.ed.basis === "campus_estimate") return `${start}${campus}`;
  if (a.hours !== null) return `${start} · about ${formatHours(a.hours)} of prep`;
  return `${start} · due ${due}`;
}

export function formatHours(hours: number): string {
  if (hours < 1) return `${Math.max(15, Math.round(hours * 60 / 15) * 15)} min`;
  return `${Math.round(hours)} h`;
}
