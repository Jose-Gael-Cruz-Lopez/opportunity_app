/**
 * Display helpers for the Program, Readiness and Tracker screens. Pure functions only, so the
 * copy and the date arithmetic are unit-tested without a browser. Every date goes through
 * shared/time: published dates are never parsed with `new Date()`.
 *
 * Nothing here produces a number about a student. Counts and natural frequencies describe a
 * program's official selection stages (k of n), never a student's chances.
 */
import type { StageOdds } from "@shared/contracts/registry";
import type {
  CompetitivenessBand,
  CompetitivenessStatus,
  RequirementState,
  StartSeverity,
} from "@shared/contracts/readiness";
import type { EligibilityStatus, EligibilityVerdict } from "@shared/contracts/eligibility";
import type { CountStage, CycleStatus, DeadlineKind, TrackerStatus } from "@shared/taxonomy";
import {
  daysBetween,
  isIsoDate,
  isIsoMonth,
  isoWeekday,
  lastDayOfMonth,
  localDateIn,
  parseIsoDate,
  parseIsoMonth,
  resolveDeadlineForViewer,
  zoneAbbreviation,
  type DeadlineTimeFields,
} from "@shared/time";
import { PRODUCT } from "@shared/config/product";

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

// ---------------------------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------------------------

/** The viewer's zone: the profile's, else the browser's, else the product fallback. */
export function viewerTimeZone(profileZone: string | null | undefined, browserZone?: string | null): string {
  return profileZone || browserZone || PRODUCT.fallbackTimeZone;
}

/** Today's calendar date for the viewer. */
export function todayIn(now: number, timeZone: string): string {
  return localDateIn(now, timeZone);
}

/** "Thu 28 Jan", "Thu 28 Jan 2027" or, for a month-only value, "Jan 2027". */
export function formatShortDate(value: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const { weekday = true, year = false } = opts;
  if (isIsoMonth(value)) {
    const m = parseIsoMonth(value);
    return m ? `${MONTHS[m.month - 1]} ${m.year}` : value;
  }
  const d = parseIsoDate(value);
  if (!d) return value;
  const parts = [`${d.day} ${MONTHS[d.month - 1]}`];
  if (weekday) parts.unshift(WEEKDAYS[isoWeekday(value) - 1] as string);
  if (year) parts.push(String(d.year));
  return parts.join(" ");
}

/** "11:59 PM" from "23:59". */
export function formatTime12(hhmm: string): string {
  const [h = 0, m = 0] = hhmm.split(":").map(Number);
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/** Whole days from today to `date` (negative once it has passed). Month-only values count to the month's end. */
export function daysUntil(today: string, date: string): number | null {
  if (isIsoDate(date)) return daysBetween(today, date);
  const m = parseIsoMonth(date);
  return m ? daysBetween(today, lastDayOfMonth(m.year, m.month)) : null;
}

/** "79 days left", "1 day left", "Due today" or "Closed". */
export function countdownText(daysLeft: number | null): string {
  if (daysLeft === null) return "Date not set";
  if (daysLeft < 0) return "Closed";
  if (daysLeft === 0) return "Due today";
  return daysLeft === 1 ? "1 day left" : `${daysLeft} days left`;
}

/** Deadlines under two weeks away are highlighted (the same window as "soon" start-by dates). */
export function isHot(daysLeft: number | null): boolean {
  return daysLeft !== null && daysLeft >= 0 && daysLeft <= PRODUCT.readiness.soonWithinDays;
}

// ---------------------------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------------------------

export interface DeadlineLike extends DeadlineTimeFields {
  readonly kind: DeadlineKind;
  readonly scope: "national" | "campus";
  readonly roundLabel: string;
  readonly sortAt: string | null;
  readonly withdrawnAt?: string | null;
}

export interface DeadlineSummary {
  /** "Closes", "Priority round closes", "Nomination due"... */
  readonly verb: string;
  /** "Thu 28 Jan 2027, 11:59 PM ET", "Jan 2027", "Rolling". */
  readonly officialText: string;
  /** "(8:59 PM your time)" when the viewer's clock differs; null otherwise. */
  readonly viewerText: string | null;
  /** Date the countdown counts to, on the viewer's calendar. */
  readonly date: string | null;
  readonly daysLeft: number | null;
  readonly passed: boolean;
  readonly approximate: boolean;
  readonly predicted: boolean;
  /** False for date-only rows: "Time not stated: plan to submit a day early". */
  readonly timeStated: boolean;
}

const VERBS: Partial<Record<DeadlineKind, string>> = {
  application: "Closes",
  priority_round: "Priority round closes",
  nomination: "Nomination due",
  campus_internal: "Campus deadline",
  recommendation: "Letters due",
  supplemental: "Supplement due",
  interest_form: "Interest form due",
  decision_expected: "Decisions expected",
  program_start: "Program starts",
};

/** Turns a Deadline into the words the Program page and Tracker show, for one viewer. */
export function describeDeadline(d: DeadlineLike, now: number, tz: string): DeadlineSummary {
  const viewer = resolveDeadlineForViewer(d, tz);
  const today = todayIn(now, tz);
  const round = d.roundLabel ? `${d.roundLabel}: ` : "";
  const verb = round + (VERBS[d.kind] ?? "Due");
  const base = { verb, approximate: viewer.approximate, predicted: viewer.predicted, timeStated: viewer.timeStated };

  if (d.precision === "rolling") {
    return { ...base, officialText: "Rolling: apply any time", viewerText: null, date: null, daysLeft: null, passed: false };
  }
  if (d.precision === "tbd" || (!d.localDate && !d.windowStart)) {
    return { ...base, officialText: "Date not announced yet", viewerText: null, date: null, daysLeft: null, passed: false };
  }
  if (d.precision === "window") {
    const start = d.windowStart ?? "";
    const end = d.windowEnd ?? start;
    const text = `Expected ${formatShortDate(start, { weekday: false })} to ${formatShortDate(end, { weekday: false, year: true })}`;
    return { ...base, officialText: text, viewerText: null, date: start, daysLeft: daysUntil(today, start), passed: false };
  }
  if (d.precision === "month_only" && d.localDate) {
    const left = daysUntil(today, d.localDate);
    return { ...base, officialText: `Sometime in ${formatShortDate(d.localDate)}`, viewerText: null, date: d.localDate, daysLeft: left, passed: left !== null && left < 0 };
  }

  const localDate = d.localDate as string;
  const dateText = formatShortDate(localDate, { year: true });
  let officialText = dateText;
  let viewerText: string | null = null;
  if (viewer.applicantLocal) {
    officialText = d.localTime ? `${dateText}, ${formatTime12(d.localTime)} your time` : `${dateText}, your time`;
  } else if (d.localTime && d.timeZone && viewer.instant !== null) {
    officialText = `${dateText}, ${formatTime12(d.localTime)} ${zoneAbbreviation(viewer.instant, d.timeZone)}`;
    const sameClock = viewer.viewerLocalDate === localDate && viewer.viewerLocalTime === d.localTime;
    if (!sameClock && viewer.viewerLocalTime) {
      const dayNote = viewer.viewerLocalDate && viewer.viewerLocalDate !== localDate ? ` on ${formatShortDate(viewer.viewerLocalDate)}` : "";
      viewerText = `(${formatTime12(viewer.viewerLocalTime)} your time${dayNote})`;
    }
  }
  const date = viewer.viewerLocalDate ?? localDate;
  const daysLeft = daysUntil(today, date);
  const passed = viewer.instant !== null ? viewer.instant < now : daysLeft !== null && daysLeft < 0;
  return { ...base, officialText, viewerText, date, daysLeft, passed };
}

const PRIMARY_KINDS: readonly DeadlineKind[] = ["application", "priority_round", "nomination", "campus_internal"];

/**
 * The deadline a countdown shows: the next live national application-type deadline; failing
 * that, the latest one that has passed (so a closed program still says when it closed).
 */
export function pickPrimaryDeadline<D extends DeadlineLike>(deadlines: readonly D[], now: number, tz: string): D | null {
  const live = deadlines.filter((d) => !d.withdrawnAt && PRIMARY_KINDS.includes(d.kind) && d.scope === "national");
  if (live.length === 0) return null;
  const withSummary = live.map((d) => ({ d, s: describeDeadline(d, now, tz) }));
  const key = (x: { s: DeadlineSummary }) => x.s.date ?? "9999-12-31";
  const upcoming = withSummary.filter((x) => !x.s.passed).sort((a, b) => key(a).localeCompare(key(b)));
  if (upcoming[0]) return upcoming[0].d;
  const past = withSummary.sort((a, b) => key(b).localeCompare(key(a)));
  return past[0]?.d ?? null;
}

export interface RulerPosition {
  /** 0..1 along the window. */
  readonly fraction: number;
  readonly day: number;
  readonly totalDays: number;
  readonly label: string;
}

/** Where today sits between the opening date and the deadline, for the countdown ruler. */
export function rulerPosition(opensOn: string | null, dueOn: string | null, today: string): RulerPosition | null {
  if (!opensOn || !dueOn || !isIsoDate(opensOn) || !isIsoDate(dueOn)) return null;
  const totalDays = daysBetween(opensOn, dueOn);
  if (totalDays <= 0) return null;
  const day = Math.min(Math.max(daysBetween(opensOn, today), 0), totalDays);
  return { fraction: day / totalDays, day, totalDays, label: `Day ${day} of a ${totalDays}-day application window` };
}

// ---------------------------------------------------------------------------------------------
// Official odds (program-level, never about a student)
// ---------------------------------------------------------------------------------------------

const FREQUENCY_DENOMINATORS = [2, 3, 4, 5, 10, 20, 50, 100, 1000] as const;
/** "About" is only honest when the phrase is this close to the true rate. */
const ABOUT_TOLERANCE = 0.05;

/**
 * A natural frequency for a program's stage rate: 454 of 1,485 reads "about 3 in 10". Picks the
 * smallest denominator within 5% of the true rate. Lower-bound pools (the true pool is larger)
 * read "at most", rounding the numerator up so the phrase stays a true upper bound.
 *
 * Rates no listed denominator can reach within 5% never get "about": below 1 in 1000 they read
 * "fewer than 1 in 1000", and between whole counts per 1000 they read "between k and k+1 in
 * 1000". Rounding 1 in 5,000 up to "about 1 in 1000" would overstate the odds five times.
 */
export function naturalFrequency(numerator: number, denominator: number, kind: "exact" | "lower_bound" | "approx"): string {
  if (denominator <= 0) return "";
  const rate = numerator / denominator;
  if (rate === 0) return kind === "lower_bound" ? "none so far" : "none";
  if (rate >= 1) return "everyone";
  for (const d of FREQUENCY_DENOMINATORS) {
    const k = kind === "lower_bound" ? Math.ceil(rate * d - 1e-9) : Math.round(rate * d);
    if (k < 1) continue;
    if (Math.abs(k / d - rate) / rate <= ABOUT_TOLERANCE) {
      const exact = k * denominator === numerator * d;
      const prefix = kind === "lower_bound" ? "at most " : exact && kind === "exact" ? "" : "about ";
      return `${prefix}${k} in ${d}`;
    }
  }
  return roughPerThousand(rate, kind);
}

/** The fallback when no denominator is within 5%: a bound or a bracket, never "about". */
function roughPerThousand(rate: number, kind: "exact" | "lower_bound" | "approx"): string {
  const perThousand = rate * 1000;
  // A lower-bound pool only makes the true rate smaller, so "fewer than" stays true for it too.
  if (perThousand < 1) return "fewer than 1 in 1000";
  const low = Math.floor(perThousand);
  if (kind === "lower_bound") return `at most ${Math.ceil(perThousand - 1e-9)} in 1000`;
  return `between ${low} and ${low + 1} in 1000`;
}

export const STAGE_LABELS: Record<CountStage, string> = {
  campus_applicants: "campus applicants",
  applicants: "applicants",
  nominees: "nominees",
  finalists: "finalists",
  awards: "awards",
  alternates: "alternates",
};

export interface StageOddsView {
  readonly key: string;
  readonly headline: string;
  readonly natural: string;
  readonly year: number;
  readonly sourceUrl: string;
  readonly verified: string;
  readonly current: boolean;
}

/** "454 awards from 1,485 nominees (2026)" with "about 3 in 10 nominees". */
export function describeStageOdds(o: StageOdds, currentStage: CountStage | null): StageOddsView {
  const fmt = (n: number) => n.toLocaleString("en-US");
  const pool = o.denominatorKind === "lower_bound" ? `over ${fmt(o.denominator)}` : o.denominatorKind === "approx" ? `about ${fmt(o.denominator)}` : fmt(o.denominator);
  return {
    key: `${o.fromStage}-${o.toStage}-${o.cycleYear}`,
    headline: `${fmt(o.numerator)} ${STAGE_LABELS[o.toStage]} from ${pool} ${STAGE_LABELS[o.fromStage]}`,
    natural: `${naturalFrequency(o.numerator, o.denominator, o.denominatorKind)} ${STAGE_LABELS[o.fromStage]}`,
    year: o.cycleYear,
    sourceUrl: o.sourceUrl,
    verified: `Checked ${formatShortDate(o.verifiedAt, { weekday: false, year: true })} by ${o.verifiedBy}`,
    current: currentStage === o.fromStage,
  };
}

// ---------------------------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------------------------

export const BAND_LABELS: Record<CompetitivenessBand, string> = {
  below_typical: "Below typical",
  typical: "Typical",
  above_typical: "Above typical",
  same_for_everyone: "Same for everyone",
};

export const BAND_EXPLAINERS: Record<CompetitivenessBand, string> = {
  below_typical: "Applicants with a profile like yours were selected less often than the program's usual rate. It is still worth applying, alongside other programs.",
  typical: "Applicants with a profile like yours were selected at about the program's usual rate.",
  above_typical: "Applicants with a profile like yours were selected more often than the program's usual rate.",
  same_for_everyone: "Selection does not depend on the profile signals Novus can see.",
};

export const COMPETITIVENESS_HEADLINES: Record<CompetitivenessStatus, string> = {
  available: "Competitiveness band",
  official_odds_only: "Official selection numbers",
  insufficient_data: "Not enough outcomes yet",
  not_applicable: "No competitive selection",
};

export const INSUFFICIENT_REASON_COPY: Record<string, string> = {
  no_official_counts: "The program has not published how many people apply or are selected.",
  new_program: "This program is new, so there is no history to learn from yet.",
  too_few_reports: "Too few verified outcomes have been reported to show a band.",
  sensitive_program: "For this program Novus shows official numbers only.",
  profile_incomplete: "Add your class year and major to your profile to see more.",
};

export const REQUIREMENT_STATE_LABELS: Record<RequirementState, string> = {
  met: "Ready",
  in_progress: "In progress",
  gap: "To do",
  unknown: "Check",
  not_applicable: "Not needed",
};

export const SEVERITY_LABELS: Record<StartSeverity, string> = {
  late: "Start now",
  soon: "Start soon",
  planned: "Planned",
};

export const ELIGIBILITY_STATUS_LABELS: Record<EligibilityStatus, string> = {
  eligible: "You can apply",
  conditional: "Eligible if...",
  unknown: "Not checked yet",
  not_eligible: "Not eligible this cycle",
};

export const VERDICT_MARKS: Record<EligibilityVerdict, { symbol: string; label: string }> = {
  met: { symbol: "check", label: "Met" },
  not_met: { symbol: "x", label: "Not met" },
  unknown: { symbol: "?", label: "Not answered" },
};

export const TRACKER_STATUS_LABELS: Record<TrackerStatus, string> = {
  interested: "Interested",
  applying: "Applying",
  submitted: "Submitted",
  decided: "Decided",
  not_applying: "Not applying",
};

export const CYCLE_STATUS_LABELS: Record<CycleStatus, string> = {
  expected: "Expected",
  open: "Open",
  closed: "Closed",
  paused: "Paused",
  ended: "Ended",
  relaunched: "Relaunched",
};

/** Tag tone for a cycle status: live, soon or off. */
export function cycleTone(status: CycleStatus): "live" | "soon" | "off" {
  if (status === "open" || status === "relaunched") return "live";
  if (status === "expected") return "soon";
  return "off";
}

/** "$7,500" from cents. */
export function formatMoney(cents: number): string {
  const dollars = cents / 100;
  return dollars.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: dollars % 1 === 0 ? 0 : 2 });
}

/** "fall-2026" or "summer-2027" -> "Fall 2026"; "ay-2026-27" -> "2026-27". */
export function formatCycleKey(key: string): string {
  const ay = /^ay-(\d{4})-(\d{2})$/.exec(key);
  if (ay) return `${ay[1]}-${ay[2]}`;
  const m = /^([a-z]+)-(\d{4})$/.exec(key);
  if (!m) return key;
  const word = m[1] as string;
  return `${word.charAt(0).toUpperCase()}${word.slice(1)} ${m[2]}`;
}

/** "sample-scholars-program" -> "Sample Scholars Program" (used only until the card loads). */
export function humanizeSlug(slug: string): string {
  return slug
    .split("-")
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

/** The host name of a URL for source lists ("noaa.gov"), or the URL itself if unparsable. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
