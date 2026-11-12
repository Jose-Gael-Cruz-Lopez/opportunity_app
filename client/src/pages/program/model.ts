/**
 * The Program page's view model, built from ProgramDetail for one viewer at one instant. Pure,
 * so the countdown, ruler, tags and money lines are unit-tested.
 */
import type { ProgramDetail } from "@shared/contracts/registry";
import { ROUTES, buildPath } from "@shared/contracts/routes";
import { getOpportunityType } from "@shared/taxonomy";
import {
  CYCLE_STATUS_LABELS,
  cycleTone,
  describeDeadline,
  formatCycleKey,
  formatMoney,
  formatShortDate,
  pickPrimaryDeadline,
  rulerPosition,
  todayIn,
  type DeadlineSummary,
  type RulerPosition,
} from "@/components/readiness/format";

export interface HeroTag {
  readonly label: string;
  readonly tone?: "live" | "soon" | "off";
  readonly ghost?: boolean;
  readonly sample?: boolean;
}

export interface Countdown {
  /** Doto digits, e.g. "79". */
  readonly value: string;
  /** "days left", "day left" or "due today". */
  readonly unit: string;
  readonly spoken: string;
}

export interface ProgramView {
  readonly title: string;
  readonly organization: string;
  readonly summary: string | null;
  readonly tags: readonly HeroTag[];
  readonly deadline: DeadlineSummary | null;
  readonly countdown: Countdown | null;
  readonly ruler: { position: RulerPosition; startLabel: string; endLabel: string } | null;
  readonly verifiedLine: string | null;
  readonly openingLine: string | null;
  readonly applyHref: string;
  readonly calendarHref: string;
  readonly publicHref: string;
  readonly officialUrl: string;
  readonly gives: readonly string[];
  readonly costs: readonly string[];
  readonly when: readonly string[];
  readonly sample: boolean;
}

export function countdownFor(daysLeft: number | null): Countdown | null {
  if (daysLeft === null || daysLeft < 0) return null;
  if (daysLeft === 0) return { value: "0", unit: "due today", spoken: "Due today" };
  const unit = daysLeft === 1 ? "day left" : "days left";
  return { value: String(daysLeft), unit, spoken: `${daysLeft} ${unit}` };
}

const PERIOD_WORDS: Record<string, string> = {
  one_time: "one time",
  hour: "an hour",
  week: "a week",
  month: "a month",
  term: "a term",
  year: "a year",
  total: "in total",
};

/** "$7,500 stipend in total", "Tuition support", "Paid: amount varies". */
export function compensationLine(c: ProgramDetail["cycle"]["compensation"]): string | null {
  if (!c || c.kind === "none") return null;
  const kindWord: Record<string, string> = {
    stipend: "stipend",
    salary_hourly: "pay",
    award: "award",
    tuition: "tuition support",
    travel: "travel support",
    varies: "paid (amount varies)",
  };
  const word = kindWord[c.kind] ?? c.kind;
  if (c.amountCents === null) return word.charAt(0).toUpperCase() + word.slice(1);
  const period = c.period ? ` ${PERIOD_WORDS[c.period] ?? c.period}` : "";
  return `${formatMoney(c.amountCents)} ${word}${period}`;
}

export function costLines(cycle: ProgramDetail["cycle"]): string[] {
  const lines: string[] = [];
  if (cycle.applicationFeeCents === 0) lines.push("No application fee");
  else if (cycle.applicationFeeCents !== null) lines.push(`Application fee ${formatMoney(cycle.applicationFeeCents)}`);
  if (cycle.participantCostCents === 0) lines.push("No cost to take part");
  else if (cycle.participantCostCents !== null) lines.push(`Costs ${formatMoney(cycle.participantCostCents)} to take part`);
  if (cycle.pellDisplacement === "yes" || cycle.pellDisplacement === "possible") lines.push("The award may reduce other financial aid; ask your aid office");
  return lines;
}

function verifiedLine(detail: ProgramDetail): string | null {
  const { cycle } = detail;
  if (cycle.verificationState === "verified" && cycle.lastVerifiedAt) {
    const on = formatShortDate(cycle.lastVerifiedAt.slice(0, 10), { weekday: false, year: true });
    return `Verified ${on} by ${cycle.verifiedBy ?? "a Novus curator"}`;
  }
  if (cycle.verificationState === "reverifying") return "Being re-checked by a Novus curator";
  return "Not yet verified by Novus: check the official page";
}

export function buildProgramView(detail: ProgramDetail, now: number, tz: string, sample: boolean): ProgramView {
  const { program, organization, cycle } = detail;
  const today = todayIn(now, tz);
  const primary = pickPrimaryDeadline(detail.deadlines, now, tz);
  const deadline = primary ? describeDeadline(primary, now, tz) : null;
  const countdown = cycle.status === "open" || cycle.status === "relaunched" ? countdownFor(deadline?.daysLeft ?? null) : null;

  const position = deadline?.date ? rulerPosition(cycle.opensOn, deadline.date, today) : null;
  const ruler =
    position && cycle.opensOn && deadline?.date
      ? { position, startLabel: `Opened ${formatShortDate(cycle.opensOn, { weekday: false })}`, endLabel: `Due ${formatShortDate(deadline.date, { weekday: false })}` }
      : null;

  const typeTags: HeroTag[] = program.opportunityTypes.slice(0, 2).map((t) => ({ label: getOpportunityType(t)?.label ?? t, ghost: true }));
  const tags: HeroTag[] = [
    { label: CYCLE_STATUS_LABELS[cycle.status], tone: cycleTone(cycle.status) },
    ...typeTags,
    { label: cycle.termLabel || formatCycleKey(cycle.cycleKey), ghost: true },
    ...(sample || program.isSample ? [{ label: "Sample data", sample: true }] : []),
  ];

  const openingLine =
    cycle.status === "expected"
      ? cycle.opensOn
        ? `Opens ${formatShortDate(cycle.opensOn, { year: true })}`
        : detail.prediction
          ? `Expected to open around ${formatShortDate(detail.prediction.p50, { weekday: false, year: true })} (${detail.prediction.label} confidence)`
          : "Opening date not announced yet"
      : null;

  const when: string[] = [];
  if (cycle.eventStart && cycle.eventEnd) {
    when.push(`Runs ${formatShortDate(cycle.eventStart, { weekday: false })} to ${formatShortDate(cycle.eventEnd, { weekday: false, year: true })}`);
  }
  if (cycle.decisionWindowStart && cycle.decisionWindowEnd) {
    when.push(`Decisions expected ${formatShortDate(cycle.decisionWindowStart, { weekday: false })} to ${formatShortDate(cycle.decisionWindowEnd, { weekday: false, year: true })}`);
  }

  const gives = [compensationLine(cycle.compensation)].filter((x): x is string => Boolean(x));
  const isSample = sample || program.isSample;

  return {
    title: program.name,
    organization: organization.name,
    summary: program.summary,
    tags,
    deadline,
    countdown,
    ruler,
    verifiedLine: verifiedLine(detail),
    openingLine,
    // The /out route records the apply click and redirects; sample records have no such route.
    applyHref: isSample ? cycle.applicationUrl ?? program.officialUrl : buildPath(ROUTES.applyOut, { programCycleId: cycle.id }),
    calendarHref: buildPath(ROUTES.programCalendar, { file: `${program.slug}.ics` }),
    publicHref: buildPath(ROUTES.programPage, { slug: program.slug }),
    officialUrl: program.officialUrl,
    gives,
    costs: costLines(cycle),
    when,
    sample: isSample,
  };
}
