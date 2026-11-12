import type { DeadlineBasis, DeadlineKind, DeadlinePrecision, DeadlineScope, IdentityCategory, TzMode, VerificationStored } from "@shared/taxonomy";
import { isIsoDate } from "@shared/time";
import type { IcsAlarm, IcsEvent, IcsStart, IcsStatus } from "./ics";
import { eventUid, UID_NAMES } from "./uid";

/**
 * Turns registry deadlines and a student's private campus date into calendar events
 * (plan 6.7.5). Pure: the caller loads rows; nothing here reads a clock or the network.
 *
 * Text rules:
 * - Named events say what is due, "Verified on [date] by [Curator]" (or that it is not yet
 *   verified), and link the official page and the Novus page. They never mention eligibility.
 * - Neutral events (status- and identity-defined programs, or a feed set to neutral titles) say
 *   only "Saved deadline" with a [Campus] or [National] prefix, link to the signed-in Tracker, and
 *   carry no program name, slug, Organization, official link or category, so the calendar
 *   service and anyone the calendar is shared with cannot tell which program it is.
 */

/** The deadline fields an event needs (structural: DB rows and API objects both fit). */
export interface DeadlineEventSource {
  readonly id: string;
  readonly kind: DeadlineKind;
  readonly scope: DeadlineScope;
  readonly roundLabel: string;
  readonly basis: DeadlineBasis;
  readonly precision: DeadlinePrecision;
  readonly tzMode: TzMode;
  readonly localDate: string | null;
  readonly localTime: string | null;
  readonly windowStart: string | null;
  readonly windowEnd: string | null;
  readonly timeZone: string | null;
  /** Epoch ms; present exactly for fixed exact and date-only rows. */
  readonly dueAt: number | null;
  readonly revision: number;
  readonly verificationState: VerificationStored;
  readonly withdrawnAt: number | null;
  readonly updatedAt: number;
}

/** What a named event says about its program. */
export interface ProgramEventContext {
  readonly slug: string;
  readonly name: string;
  readonly organizationName: string;
  readonly officialUrl: string;
  /** `YYYY-MM-DD` of the cycle's last Curator verification, or null. */
  readonly verifiedOn: string | null;
  /** Curator handle (never a person's name), or null. */
  readonly verifiedBy: string | null;
  readonly isSample: boolean;
}

export interface EventTextOptions {
  /** Public origin, e.g. https://novus.example.org (no trailing slash needed). */
  readonly origin: string;
  readonly neutral: boolean;
}

/** Alarms before submission-type deadlines (plan 6.7.5: seven days and one day). */
export const ALARM_DAYS = [7, 1] as const;

/** Kinds that are informational dates rather than something the student submits. */
const INFORMATIONAL_KINDS: ReadonlySet<DeadlineKind> = new Set(["decision_expected", "program_start"]);

const KIND_LABELS: Readonly<Record<DeadlineKind, string>> = {
  application: "application deadline",
  campus_internal: "campus deadline",
  nomination: "nomination deadline",
  priority_round: "priority deadline",
  recommendation: "recommendation letters due",
  supplemental: "supplemental materials due",
  interest_form: "interest form due",
  decision_expected: "decisions expected",
  program_start: "program starts",
};

/** Withdrawn rows stay in feeds this long as CANCELLED, so subscribed copies are removed. */
export const WITHDRAWN_RETENTION_DAYS = 180;

function trimOrigin(origin: string): string {
  return origin.replace(/\/+$/, "");
}

/**
 * Whether an event must use neutral text: always for `sensitive_audience` programs, for
 * `identity_audience` programs unless the student opted in to naming that program, and for every
 * program when the feed itself is set to neutral titles.
 */
export function isNeutral(input: {
  readonly sensitiveAudience: boolean;
  readonly identityAudience: readonly IdentityCategory[] | readonly string[];
  readonly nameInMessages: boolean;
  readonly feedNeutral: boolean;
}): boolean {
  if (input.feedNeutral || input.sensitiveAudience) return true;
  return input.identityAudience.length > 0 && !input.nameInMessages;
}

/**
 * The event start for a deadline, or null when it has no single day (month-only, rolling, TBD)
 * or its fields are inconsistent. Predicted windows start on their earliest day, so a student
 * is never told about a deadline later than it may fall.
 */
export function deadlineStart(d: DeadlineEventSource): IcsStart | null {
  switch (d.precision) {
    case "exact":
      if (d.tzMode === "applicant_local") {
        return d.localDate && isIsoDate(d.localDate) && d.localTime ? { kind: "floating", date: d.localDate, time: d.localTime } : null;
      }
      return d.dueAt !== null ? { kind: "utc", instantMs: d.dueAt } : null;
    case "date_only":
      return d.localDate && isIsoDate(d.localDate) ? { kind: "date", date: d.localDate } : null;
    case "window":
      return d.windowStart && isIsoDate(d.windowStart) ? { kind: "date", date: d.windowStart } : null;
    case "month_only":
    case "rolling":
    case "tbd":
      return null;
  }
}

/** [Campus], [Priority round] or [National]; neutral text never says "priority round". */
function prefix(d: Pick<DeadlineEventSource, "scope" | "kind">, neutral: boolean): string {
  if (d.scope === "campus") return "[Campus]";
  if (!neutral && d.kind === "priority_round") return "[Priority round]";
  return "[National]";
}

function statusFor(d: DeadlineEventSource): IcsStatus {
  if (d.withdrawnAt !== null) return "CANCELLED";
  if (d.basis === "predicted") return "TENTATIVE";
  return d.verificationState === "verified" ? "CONFIRMED" : "TENTATIVE";
}

/** How the official page stated the time, in words (never parsed through Date). */
function dueText(d: DeadlineEventSource): string {
  if (d.precision === "window") return `Predicted to fall between ${d.windowStart} and ${d.windowEnd}, based on past cycles`;
  if (d.tzMode === "applicant_local") {
    return d.localTime ? `Due ${d.localDate} at ${d.localTime}, in your own time zone` : `Due ${d.localDate}, in your own time zone`;
  }
  const zone = d.timeZone ? ` (${d.timeZone})` : "";
  return d.localTime ? `Due ${d.localDate} at ${d.localTime}${zone}` : `Due by the end of ${d.localDate}${zone}`;
}

function verificationText(program: ProgramEventContext, d: DeadlineEventSource): string {
  if (d.basis === "predicted") return "This date is a prediction, not an announced deadline.";
  if (d.verificationState === "verified" && program.verifiedOn && program.verifiedBy) {
    return `Verified on ${program.verifiedOn} by ${program.verifiedBy}.`;
  }
  return "Not yet verified by a Novus Curator.";
}

function programUrl(origin: string, slug: string): string {
  return `${trimOrigin(origin)}/programs/${encodeURIComponent(slug)}`;
}

function trackerUrl(origin: string): string {
  return `${trimOrigin(origin)}/app/tracker`;
}

const NEUTRAL_DESCRIPTION = "Details in Novus (sign in)";
const NEUTRAL_ALARM = "Saved deadline coming up";

function alarmsFor(kind: DeadlineKind, text: (days: number) => string): IcsAlarm[] {
  if (INFORMATIONAL_KINDS.has(kind)) return [];
  return ALARM_DAYS.map((days) => ({ daysBefore: days, description: text(days) }));
}

function inDays(days: number): string {
  return days === 1 ? "in 1 day" : `in ${days} days`;
}

/** One calendar event for a stored Deadline, or null when it has no day to show. */
export function deadlineEvent(d: DeadlineEventSource, program: ProgramEventContext, opts: EventTextOptions): IcsEvent | null {
  const start = deadlineStart(d);
  if (!start) return null;
  const base = {
    uid: eventUid(UID_NAMES.deadline(d.id)),
    sequence: d.revision,
    start,
    status: statusFor(d),
    stampMs: d.updatedAt,
  };
  const label = prefix(d, opts.neutral);

  if (opts.neutral) {
    return {
      ...base,
      summary: `${label} Saved deadline`,
      description: NEUTRAL_DESCRIPTION,
      url: trackerUrl(opts.origin),
      alarms: alarmsFor(d.kind, () => NEUTRAL_ALARM),
    };
  }

  const round = d.roundLabel ? ` (${d.roundLabel})` : "";
  const predicted = d.basis === "predicted" ? " (predicted)" : "";
  const cancelled = d.withdrawnAt !== null ? "Withdrawn: this date is no longer listed on the official page. " : "";
  const description = [
    program.isSample ? "Sample data, not a real program." : null,
    `${cancelled}${program.name} (${program.organizationName})`,
    dueText(d),
    verificationText(program, d),
    `Official page: ${program.officialUrl}`,
    `On Novus: ${programUrl(opts.origin, program.slug)}`,
    "Always confirm dates on the official page.",
  ]
    .filter((line): line is string => line !== null)
    .join("\n");

  return {
    ...base,
    summary: `${label} ${program.name}: ${KIND_LABELS[d.kind]}${round}${predicted}`,
    description,
    url: programUrl(opts.origin, program.slug),
    categories: ["Novus"],
    alarms: alarmsFor(d.kind, (days) => `${program.name}: ${KIND_LABELS[d.kind]} ${inDays(days)}`),
  };
}

/** The student's own campus date for a tracked cycle (private to them; SEQUENCE is the item version). */
export interface OwnCampusSource {
  readonly trackerItemId: string;
  readonly date: string;
  readonly version: number;
  readonly updatedAt: number;
}

export function ownCampusEvent(item: OwnCampusSource, program: ProgramEventContext, opts: EventTextOptions): IcsEvent | null {
  if (!isIsoDate(item.date)) return null;
  const base = {
    uid: eventUid(UID_NAMES.ownCampus(item.trackerItemId)),
    sequence: item.version,
    start: { kind: "date", date: item.date } as const,
    // The student entered this date themselves; Novus has not checked it.
    status: "TENTATIVE" as const,
    stampMs: item.updatedAt,
  };
  if (opts.neutral) {
    return {
      ...base,
      summary: "[Campus] Saved deadline",
      description: NEUTRAL_DESCRIPTION,
      url: trackerUrl(opts.origin),
      alarms: ALARM_DAYS.map((days) => ({ daysBefore: days, description: NEUTRAL_ALARM })),
    };
  }
  return {
    ...base,
    summary: `[Campus] ${program.name}: your campus deadline`,
    description: [
      program.isSample ? "Sample data, not a real program." : null,
      `${program.name} (${program.organizationName})`,
      `Your campus deadline, as you entered it: ${item.date}. Novus has not checked this date.`,
      `On Novus: ${programUrl(opts.origin, program.slug)}`,
    ]
      .filter((line): line is string => line !== null)
      .join("\n"),
    url: programUrl(opts.origin, program.slug),
    categories: ["Novus"],
    alarms: ALARM_DAYS.map((days) => ({ daysBefore: days, description: `${program.name}: your campus deadline ${inDays(days)}` })),
  };
}

/** Whether a withdrawn row is still recent enough to send as CANCELLED. */
export function keepWithdrawn(withdrawnAt: number | null, now: number): boolean {
  return withdrawnAt === null || now - withdrawnAt <= WITHDRAWN_RETENTION_DAYS * 86_400_000;
}

/** Stable event order: by start, then UID, so the same data always renders the same bytes. */
export function sortEvents(events: readonly IcsEvent[]): IcsEvent[] {
  const key = (e: IcsEvent): string => {
    switch (e.start.kind) {
      case "utc":
        return new Date(e.start.instantMs).toISOString().slice(0, 16);
      case "floating":
        return `${e.start.date}T${e.start.time}`;
      case "date":
        return `${e.start.date}T00:00`;
    }
  };
  return [...events].sort((a, b) => key(a).localeCompare(key(b)) || a.uid.localeCompare(b.uid));
}
