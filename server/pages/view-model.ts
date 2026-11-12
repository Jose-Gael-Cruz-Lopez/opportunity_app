import type {
  Compensation,
  DeadlineView,
  EligibilityRule,
  EligibilityRuleSet,
  EvidenceQuote,
  ProgramCard,
  ProgramDetail,
} from "@shared/contracts";
import {
  CLASS_YEAR_LABELS,
  getOpportunityType,
  OPPORTUNITY_GROUP_LABELS,
  type ClassYear,
  type CycleStatus,
  type DeadlineKind,
  type Freshness,
  type OpportunityGroup,
  type RequirementKind,
  type VerificationDisplay,
} from "@shared/taxonomy";
import { PRODUCT } from "@shared/config/product";
import { localDateTimeToInstant, MS_PER_HOUR, parseIsoInstant, resolveDeadlineForViewer } from "@shared/time";
import {
  clampWords,
  dayBefore,
  daysUntil,
  formatDate,
  formatMoney,
  formatMonth,
  formatMonthShort,
  formatTime12,
  isoDateIn,
  joinList,
  plural,
  relativeAge,
  zoneLabel,
} from "./format";

/**
 * Pure view models for public pages: they turn registry read models (ProgramCard, ProgramDetail)
 * into the words and numbers a page shows. Nothing here reads a request, a cookie or a student.
 */

/** Words shown for each cycle status. */
export const STATUS_LABELS: Readonly<Record<CycleStatus, string>> = {
  open: "Open",
  expected: "Expected",
  closed: "Closed",
  paused: "Paused",
  ended: "Ended",
  relaunched: "Relaunched",
};

/** Tone of a status chip: drives colour, always paired with a word and an icon. */
export type Tone = "good" | "warn" | "late" | "neutral";

export const DEADLINE_KIND_LABELS: Readonly<Record<DeadlineKind, string>> = {
  application: "Application",
  campus_internal: "Campus deadline",
  nomination: "Nomination",
  priority_round: "Priority round",
  recommendation: "Letters due",
  supplemental: "Supplemental materials",
  interest_form: "Interest form",
  decision_expected: "Decisions expected",
  program_start: "Program starts",
};

export const REQUIREMENT_KIND_LABELS: Readonly<Record<RequirementKind, string>> = {
  recommendation: "Letters",
  essay: "Essay",
  campus_nomination: "Campus nomination",
  test_score: "Test score",
  portfolio: "Portfolio",
  resume: "Resume",
  transcript: "Transcript",
  interview: "Interview",
  fee: "Fee",
  coursework: "Coursework",
  gpa_floor: "GPA minimum",
  other: "Other",
};

/** Deadline kinds a student submits by; decisions and start dates are informative only. */
const SUBMISSION_KINDS: ReadonlySet<DeadlineKind> = new Set<DeadlineKind>([
  "application",
  "campus_internal",
  "nomination",
  "priority_round",
  "recommendation",
  "supplemental",
  "interest_form",
]);

export function isSubmissionDeadline(d: Pick<DeadlineView, "kind">): boolean {
  return SUBMISSION_KINDS.has(d.kind);
}

// ---------------------------------------------------------------------------------------------
// Deadlines
// ---------------------------------------------------------------------------------------------

export interface DeadlineDisplay {
  readonly id: string;
  readonly kind: DeadlineKind;
  readonly kindLabel: string;
  readonly scope: "national" | "campus";
  /** "Fri 15 Jan 2027, 11:59 PM ET", "… your time zone", "Sometime in December 2026", "Rolling". */
  readonly primary: string;
  /** Extra advice, such as "Time not stated: plan to submit by Thu 14 Jan 2027". */
  readonly advice: string | null;
  /** Basis note for non-official rows ("Estimate from past cycles"). */
  readonly basisNote: string | null;
  /** ISO instant for the "your time" island; null unless the row has an exact time in a fixed zone. */
  readonly instantIso: string | null;
  /** Applicant-local rows: the island computes the instant on the viewer's own clock. */
  readonly applicantLocal: { readonly date: string; readonly time: string | null } | null;
  /** Instant the countdown runs to (00:00 local for date-only rows), or null. */
  readonly countdownAt: number | null;
  readonly daysLeft: number | null;
  readonly passed: boolean;
  /** Passed less than 72 hours ago: "Deadline passed: checking for extensions". */
  readonly recentlyPassed: boolean;
  readonly approximate: boolean;
  readonly predicted: boolean;
  /** Calendar date shown in lists (`YYYY-MM-DD`), or null for rolling and TBD rows. */
  readonly listDate: string | null;
  /** ISO date for JSON-LD `applicationDeadline` (exact or date-only official rows only). */
  readonly jsonLdDate: string | null;
}

const FALLBACK_ZONE = PRODUCT.fallbackTimeZone;

/** Builds the display for one deadline at `now`. Server-side, the viewer's zone is unknown. */
export function describeDeadline(d: DeadlineView, now: number): DeadlineDisplay {
  const base = {
    id: d.id,
    kind: d.kind,
    kindLabel: d.roundLabel ? `${DEADLINE_KIND_LABELS[d.kind]} (${d.roundLabel})` : DEADLINE_KIND_LABELS[d.kind],
    scope: d.scope,
    predicted: d.basis === "predicted",
    basisNote: d.basis === "predicted" ? "Estimate from past cycles" : d.basis === "attested" ? "Confirmed by a campus office" : null,
  };
  const none = {
    advice: null,
    instantIso: null,
    applicantLocal: null,
    countdownAt: null,
    daysLeft: null,
    passed: false,
    recentlyPassed: false,
    approximate: false,
    listDate: null,
    jsonLdDate: null,
  };

  if (d.precision === "rolling") return { ...base, ...none, primary: "Rolling: apply early" };
  if (d.precision === "tbd" || !d.localDate) return { ...base, ...none, primary: "Date not announced yet" };

  if (d.precision === "window") {
    const start = d.windowStart ?? d.localDate;
    const end = d.windowEnd ?? d.localDate;
    const sortAt = d.sortAt ? parseIsoInstant(d.sortAt) : null;
    const span = formatMonthShort(start) === formatMonthShort(end) ? formatMonth(start) : `${formatMonthShort(start)} to ${formatMonthShort(end)}`;
    return {
      ...base,
      ...none,
      primary: `Expected around ${span}`,
      approximate: true,
      listDate: start,
      daysLeft: sortAt !== null ? daysUntil(sortAt, now) : null,
    };
  }

  if (d.precision === "month_only") {
    const sortAt = d.sortAt ? parseIsoInstant(d.sortAt) : null;
    const passed = sortAt !== null && sortAt < now;
    return {
      ...base,
      ...none,
      primary: `Sometime in ${formatMonth(d.localDate)}, day not stated`,
      advice: "The official page gives only the month: plan for the first week.",
      approximate: true,
      passed,
      listDate: `${d.localDate.slice(0, 7)}-01`,
    };
  }

  // exact or date_only
  const resolved = resolveDeadlineForViewer(d, FALLBACK_ZONE);
  const applicantLocal = d.tzMode === "applicant_local";
  const zone = applicantLocal ? FALLBACK_ZONE : d.timeZone ?? FALLBACK_ZONE;
  const end = resolved.instant;
  const dateText = formatDate(d.localDate);
  let primary: string;
  let advice: string | null = null;
  let countdownAt = end;
  if (d.precision === "exact" && d.localTime) {
    const tz = applicantLocal ? "your time zone" : zoneLabel(zone, end ?? now);
    primary = `${dateText}, ${formatTime12(d.localTime)} ${tz}`;
  } else {
    // A date with no time has no single instant to convert, so no "your time" is offered; the
    // zone is named only when it is not the default one.
    const zoneNote = !applicantLocal && zone !== FALLBACK_ZONE ? ` (${zoneLabel(zone, end ?? now)})` : "";
    primary = applicantLocal ? `${dateText}, your time zone, time not stated` : `${dateText}${zoneNote}, time not stated`;
    advice = `Time not stated: plan to submit by ${formatDate(dayBefore(d.localDate))}.`;
    // Many portals and offices close before midnight, so the countdown runs to the start of the day.
    countdownAt = localDateTimeToInstant(d.localDate, "00:00", zone);
  }
  const passed = end !== null && end < now;
  const recentlyPassed = passed && end !== null && now - end <= PRODUCT.extensionCheckHours * MS_PER_HOUR;
  return {
    ...base,
    primary,
    advice,
    instantIso: applicantLocal || d.precision !== "exact" ? null : resolved.instantIso,
    applicantLocal: applicantLocal ? { date: d.localDate, time: d.localTime } : null,
    countdownAt,
    daysLeft: countdownAt !== null && !passed ? daysUntil(countdownAt, now) : null,
    passed,
    recentlyPassed,
    approximate: false,
    listDate: d.localDate,
    jsonLdDate: d.basis === "official" ? d.localDate : null,
  };
}

function sortKey(d: DeadlineView): string {
  return d.sortAt ?? d.windowStart ?? d.localDate ?? "9999";
}

/** Live deadlines in date order, rolling and TBD rows last. */
export function sortDeadlines<T extends DeadlineView>(deadlines: readonly T[]): T[] {
  return [...deadlines].sort((a, b) => sortKey(a).localeCompare(sortKey(b)));
}

/**
 * The deadline a card leads with: the next national submission deadline that has not passed;
 * else a rolling one; else the most recent passed one (so a closed cycle still shows its date).
 */
export function nextDeadline(card: Pick<ProgramCard, "deadlines">, now: number): DeadlineDisplay | null {
  const national = sortDeadlines(card.deadlines.filter((d) => d.scope === "national" && isSubmissionDeadline(d)));
  const shown = national.map((d) => describeDeadline(d, now));
  return (
    shown.find((d) => d.listDate !== null && !d.passed) ??
    shown.find((d) => d.listDate === null) ??
    [...shown].reverse().find((d) => d.passed) ??
    null
  );
}

// ---------------------------------------------------------------------------------------------
// Status and verification
// ---------------------------------------------------------------------------------------------

export interface StatusDisplay {
  readonly label: string;
  readonly tone: Tone;
}

export function describeStatus(status: CycleStatus, next: DeadlineDisplay | null): StatusDisplay {
  if (status === "open" && next?.recentlyPassed) return { label: "Deadline passed: checking for extensions", tone: "late" };
  if (status === "open" && next?.daysLeft !== null && next?.daysLeft !== undefined && next.daysLeft <= 14) {
    return { label: "Open · closes soon", tone: "warn" };
  }
  const tone: Tone = status === "open" || status === "relaunched" ? "good" : status === "expected" ? "neutral" : "late";
  return { label: STATUS_LABELS[status], tone };
}

export interface VerificationDisplayLine {
  readonly state: VerificationDisplay;
  readonly label: string;
  readonly detail: string | null;
  readonly tone: Tone;
}

/** The verification line: who checked a record and when, with freshness labels from plan s09 9.9. */
export function describeVerification(
  v: { state: VerificationDisplay; verifiedOn: string | null; verifiedBy: string | null; freshness: Freshness },
  todayIso: string,
): VerificationDisplayLine {
  const by = v.verifiedBy ? ` · ${v.verifiedBy}` : "";
  const on = v.verifiedOn ? formatDate(v.verifiedOn, { weekday: false }) : null;
  switch (v.state) {
    case "verified":
      if (v.freshness === "aging" && v.verifiedOn) {
        return { state: v.state, label: "Verified, aging", detail: `last checked ${relativeAge(v.verifiedOn, todayIso)}${by}`, tone: "warn" };
      }
      return { state: v.state, label: on ? `Verified ${on}` : "Verified", detail: v.verifiedBy, tone: "good" };
    case "reverifying":
      return { state: v.state, label: "Being re-checked", detail: on ? `last verified ${on}${by}` : null, tone: "warn" };
    case "stale":
      return { state: v.state, label: "Needs re-check: confirm on the official site", detail: on ? `last verified ${on}` : null, tone: "late" };
    case "draft":
    case "unverified":
      return { state: v.state, label: "Not yet verified by a person", detail: "Check the official page before you rely on it.", tone: "neutral" };
  }
}

// ---------------------------------------------------------------------------------------------
// Types, class years, pay
// ---------------------------------------------------------------------------------------------

export function typeLabels(slugs: readonly string[]): string[] {
  return slugs.map((s) => getOpportunityType(s)?.label ?? s.replace(/_/g, " "));
}

export function groupOf(slug: string): OpportunityGroup {
  return getOpportunityType(slug)?.group ?? "other";
}

/** The short family label for a card's first type ("Research", "Scholarships"). */
export function primaryGroupLabel(slugs: readonly string[]): string {
  const first = slugs[0];
  return first ? OPPORTUNITY_GROUP_LABELS[groupOf(first)] : "Program";
}

/** "First- and second-years", "Open to all class years", or a list. */
export function classYearText(years: readonly ClassYear[]): string {
  if (years.length === 0) return "Class years not restricted";
  const undergrad: ClassYear[] = ["first_year", "second_year", "third_year", "fourth_year"];
  if (undergrad.every((y) => years.includes(y))) return "All undergraduate years";
  if (years.length === 2 && years.includes("first_year") && years.includes("second_year")) return "First- and second-years";
  return joinList(years.map((y) => CLASS_YEAR_LABELS[y]));
}

const PERIOD_TEXT: Readonly<Record<string, string>> = {
  one_time: "",
  hour: " per hour",
  week: " per week",
  month: " per month",
  term: " per term",
  year: " per year",
  total: " in total",
};

const COMP_KIND_TEXT: Readonly<Record<Compensation["kind"], string>> = {
  stipend: "Stipend",
  salary_hourly: "Paid",
  award: "Award",
  tuition: "Tuition covered",
  travel: "Travel covered",
  none: "Unpaid",
  varies: "Pay varies",
};

/** "Award $7,500 per year", "Paid $18 per hour", "Unpaid", or null when unknown. */
export function compensationText(c: Compensation | null): string | null {
  if (!c) return null;
  const kind = COMP_KIND_TEXT[c.kind];
  if (c.amountCents === null || c.kind === "none" || c.kind === "varies") return c.note ? `${kind}: ${c.note}` : kind;
  return `${kind} ${formatMoney(c.amountCents)}${c.period ? PERIOD_TEXT[c.period] ?? "" : ""}`;
}

/** "No cost to apply", "Application fee $25", "Participant cost $500". */
export function costText(cycle: { applicationFeeCents: number | null; participantCostCents: number | null }): string {
  const parts: string[] = [];
  if (cycle.applicationFeeCents) parts.push(`Application fee ${formatMoney(cycle.applicationFeeCents)}`);
  if (cycle.participantCostCents) parts.push(`Participant cost ${formatMoney(cycle.participantCostCents)}`);
  return parts.length ? parts.join(" · ") : "No cost to apply";
}

/**
 * The summary shown when a Curator wrote none: a deterministic sentence from verified fields, so
 * no unreviewed prose reaches a public page.
 */
export function templateSummary(card: Pick<ProgramCard, "name" | "organizationName" | "opportunityTypes" | "classYears">, next: DeadlineDisplay | null): string {
  const type = typeLabels(card.opportunityTypes)[0]?.toLowerCase() ?? "programs";
  const who = card.classYears.length ? ` for ${classYearText(card.classYears).toLowerCase()}` : "";
  const when = next?.listDate && !next.approximate ? ` The next deadline is ${formatDate(next.listDate, { weekday: false })}.` : "";
  return `${card.name} is listed under ${type} from ${card.organizationName}${who}.${when}`;
}

// ---------------------------------------------------------------------------------------------
// Eligibility summary (public: the rules only; answers are checked in the browser)
// ---------------------------------------------------------------------------------------------

export interface RuleLine {
  readonly id: string;
  readonly text: string;
  /** Sensitive rules are answered privately on the device; the server never sees the answer. */
  readonly sensitive: boolean;
  readonly evidence: EvidenceQuote | null;
}

export interface RuleGroup {
  /** "all" rules must all hold; an anyOf group needs one. */
  readonly kind: "all" | "any";
  readonly label: string | null;
  readonly rules: readonly RuleLine[];
}

export interface EligibilitySummary {
  readonly groups: readonly RuleGroup[];
  readonly hasSensitive: boolean;
  readonly attestations: readonly string[];
  readonly nomination: string | null;
  /** Dimensions a Curator has not reviewed yet ("Not fully checked"). */
  readonly notReviewed: readonly string[];
  /** Rules copied from an earlier cycle ("may change"). */
  readonly fromCycleKey: string | null;
  readonly verifiedBy: string | null;
}

const DIMENSION_LABELS: Readonly<Record<string, string>> = {
  standing: "class standing",
  enrollment: "enrollment",
  transfer: "transfer status",
  gpa: "GPA",
  citizenship: "citizenship",
  pell: "financial need",
  institution: "your school",
  field: "field of study",
  identity: "community served",
  age: "age",
  residency: "residency",
  first_gen: "first-generation status",
  prior_award: "earlier awards",
};

function ruleLine(rule: EligibilityRule, evidence: EligibilityRuleSet["evidence"]): RuleLine {
  const quote = rule.evidenceKey ? evidence[rule.evidenceKey] ?? null : null;
  return {
    id: rule.id,
    text: rule.officialText,
    sensitive: rule.sensitive,
    evidence: quote ? { ...quote, quote: quote.quote ? clampWords(quote.quote, 25) : null } : null,
  };
}

export function summarizeEligibility(rs: EligibilityRuleSet | null, fromCycleKey: string | null = null): EligibilitySummary | null {
  if (!rs) return null;
  const all = rs.rules.filter((r) => r.group === "all").map((r) => ruleLine(r, rs.evidence));
  const groups: RuleGroup[] = all.length ? [{ kind: "all", label: null, rules: all }] : [];
  for (const g of rs.anyOf) {
    const rules = rs.rules.filter((r) => r.group === g.id).map((r) => ruleLine(r, rs.evidence));
    if (rules.length) groups.push({ kind: "any", label: `${g.label} (at least one of these)`, rules });
  }
  const notReviewed = Object.entries(rs.coverage)
    .filter(([, state]) => state === "not_reviewed")
    .map(([dim]) => DIMENSION_LABELS[dim] ?? dim);
  return {
    groups,
    hasSensitive: rs.rules.some((r) => r.sensitive),
    attestations: rs.attestations.map((a) => a.text),
    nomination: rs.nomination ? "Your campus must nominate you before you can apply." : null,
    notReviewed,
    fromCycleKey: rs.fromCycleKey ?? fromCycleKey,
    verifiedBy: rs.verifiedBy,
  };
}

// ---------------------------------------------------------------------------------------------
// Requirements and sources
// ---------------------------------------------------------------------------------------------

export interface RequirementLine {
  readonly kindLabel: string;
  readonly text: string;
  readonly startBy: string | null;
  readonly verified: boolean;
  readonly evidenceUrl: string | null;
}

/**
 * Requirements with a "start by" date: the application deadline minus the Curator's lead time,
 * so "2 letters (ask by 25 Dec)" can be shown without any student data.
 */
export function describeRequirements(detail: Pick<ProgramDetail, "requirements" | "deadlines">, now: number): RequirementLine[] {
  const app = nextDeadline({ deadlines: detail.deadlines }, now);
  return detail.requirements.map((r) => {
    const qty = r.quantity > 1 ? `${r.quantity} × ` : "";
    const limit = r.wordLimit ? ` (up to ${r.wordLimit.toLocaleString("en-US")} words)` : "";
    const detailText = r.detail ? `: ${r.detail}` : "";
    let startBy: string | null = null;
    if (r.leadTimeDays && app?.listDate && !app.approximate && !app.passed) {
      const start = shiftDate(app.listDate, -r.leadTimeDays);
      if (start) startBy = start;
    }
    return {
      kindLabel: REQUIREMENT_KIND_LABELS[r.kind],
      text: `${qty}${r.label}${limit}${detailText}`,
      startBy,
      verified: r.verificationState === "verified",
      evidenceUrl: r.evidence?.url ?? null,
    };
  });
}

function shiftDate(isoDate: string, days: number): string | null {
  try {
    return isoDateIn(Date.UTC(Number(isoDate.slice(0, 4)), Number(isoDate.slice(5, 7)) - 1, Number(isoDate.slice(8, 10)) + days, 12), "UTC");
  } catch {
    return null;
  }
}

export interface SourceLink {
  readonly url: string;
  readonly label: string;
  readonly retrievedOn: string | null;
}

/** Every distinct URL a fact on the page was read from, official page first. */
export function collectSources(detail: Pick<ProgramDetail, "program" | "cycle" | "requirements" | "ruleSet" | "citation">): SourceLink[] {
  const out = new Map<string, SourceLink>();
  const add = (url: string | null | undefined, label: string, retrievedOn: string | null = null): void => {
    if (!url || out.has(url)) return;
    out.set(url, { url, label, retrievedOn });
  };
  add(detail.program.officialUrl, "Official program page");
  add(detail.cycle.applicationUrl, "Official application");
  add(detail.citation.evidenceUrl, "Status and dates");
  for (const q of Object.values(detail.ruleSet?.evidence ?? {})) add(q.url, "Eligibility rules", q.retrievedOn);
  for (const r of detail.requirements) add(r.evidence?.url, `Requirement: ${r.label}`, r.evidence?.retrievedOn ?? null);
  return [...out.values()];
}

/** Today's date in the fallback zone, for "last checked 3 weeks ago". */
export function todayIso(now: number): string {
  return isoDateIn(now, FALLBACK_ZONE);
}

/** Group counts for the landing page doors and Explore filters. */
export function countByGroup(cards: readonly Pick<ProgramCard, "opportunityTypes">[]): Map<OpportunityGroup, number> {
  const counts = new Map<OpportunityGroup, number>();
  for (const card of cards) {
    const groups = new Set(card.opportunityTypes.map(groupOf));
    for (const g of groups) counts.set(g, (counts.get(g) ?? 0) + 1);
  }
  return counts;
}

export { plural };
