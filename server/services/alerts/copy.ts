import type { AlertType, ChangeEventType } from "@shared/contracts/events";

/**
 * Pure rules that turn one ChangeEvent into Alert copy for one recipient (plan 6.7.1's table).
 * Deterministic code decides priority and wording; nothing here sees student answers.
 */

export type AlertPriority = "p0" | "p1" | "p2";

export interface CycleFacts {
  readonly cycleId: string;
  readonly programName: string;
  readonly programSlug: string;
  readonly termLabel: string;
  /** Status-defined program (non-citizen status, Pell, health): always neutral copy. */
  readonly sensitiveAudience: boolean;
  /** Identity-audience program: neutral copy unless the recipient chose to see names. */
  readonly identityAudience: readonly string[];
  readonly isSample: boolean;
}

export interface ChangeEventInput {
  readonly id: string;
  readonly type: ChangeEventType;
  readonly programCycleId: string;
  readonly payload: Record<string, unknown>;
}

export interface AlertDraft {
  readonly type: AlertType;
  readonly priority: AlertPriority;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly neutral: boolean;
}

const HOUR = 3_600_000;

function str(v: unknown): string | null {
  return typeof v === "string" && v.length > 0 ? v : null;
}

/** Earliest instant a `YYYY-MM-DD` (or `YYYY-MM`) date could fall due, for the 72-hour rule. */
function dateStartMs(date: string | null): number | null {
  if (!date) return null;
  const m = /^(\d{4})-(\d{2})(?:-(\d{2}))?$/.exec(date);
  if (!m) return null;
  return Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3] ?? "1"));
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** Kinds that are dates the student acts by; the others (decisions, program start) only inform. */
const ACTION_KINDS: ReadonlySet<string> = new Set(["application", "campus_internal", "nomination", "priority_round", "recommendation", "supplemental", "interest_form"]);

/** True for informational dates (decision expected, program start) and false for unknown kinds. */
export function informationalKind(kind: unknown): boolean {
  return typeof kind === "string" && !ACTION_KINDS.has(kind);
}

/**
 * A deadline change is P0 when it moves earlier, is withdrawn, or is an extension of a deadline
 * that was within 72 hours (or had passed); other later moves go to the weekly email (P1).
 * "Earlier" compares instants when the payload carries both (`dueAt`, `previousDueAt`), so a
 * 23:59 deadline moved to 12:00, or from Pacific to Eastern time, on the same date is P0. Rows
 * with no instant (date-only applicant-local, month-only) compare dates, then stated clock
 * times (a stated time is earlier than none), and treat a zone change on the same date and time
 * as P0. A missing previous value (a new row, or an older payload) is P0, so a student never
 * misses an earlier date. Informational dates (decisions, program start) are never P0.
 */
export function deadlineChangePriority(payload: Record<string, unknown>, nowMs: number): AlertPriority {
  if (informationalKind(payload.kind)) return "p1";
  if (payload.withdrawn === true) return "p0";
  const nextAt = num(payload.dueAt);
  const prevAt = num(payload.previousDueAt);
  if (nextAt !== null && prevAt !== null) {
    if (nextAt < prevAt) return "p0";
    if (nextAt === prevAt) return "p1";
    return prevAt - nowMs <= 72 * HOUR ? "p0" : "p1";
  }
  const next = dateStartMs(str(payload.localDate));
  const prev = dateStartMs(str(payload.previousLocalDate));
  if (next === null || prev === null) return "p0";
  if (next < prev) return "p0";
  if (next === prev) {
    const nextTime = str(payload.localTime) ?? "24:00";
    const prevTime = str(payload.previousLocalTime) ?? "24:00";
    if (nextTime < prevTime) return "p0";
    const zoneChanged = "previousTimeZone" in payload && str(payload.timeZone) !== str(payload.previousTimeZone);
    if (nextTime === prevTime && zoneChanged) return "p0";
    return "p1";
  }
  return prev - nowMs <= 72 * HOUR ? "p0" : "p1";
}

/**
 * Whether a change reaches this recipient at all. A campus-scoped deadline belongs to one
 * Institution: only students whose profile names that Institution hear about it (email-only
 * contacts have none, so they never do). Everything else reaches every follower.
 */
export function reachesRecipient(event: Pick<ChangeEventInput, "type" | "payload">, recipient: { institutionId?: string | null }): boolean {
  if (event.type !== "deadline.changed" || event.payload.scope !== "campus") return true;
  const institutionId = str(event.payload.institutionId);
  return institutionId !== null && recipient.institutionId === institutionId;
}

const KIND_LABEL: Readonly<Record<string, string>> = {
  application: "The deadline",
  campus_internal: "Your campus deadline",
  nomination: "Your campus nomination deadline",
  priority_round: "The priority deadline",
  recommendation: "The recommendation deadline",
  supplemental: "The supplemental materials deadline",
  interest_form: "The interest form deadline",
};

function deadlineCopy(p: Record<string, unknown>, name: string, priority: AlertPriority): { priority: AlertPriority; title: string; body: string } {
  const kind = str(p.kind);
  const date = str(p.localDate);
  const time = str(p.localTime);
  const when = date ? `${date}${time ? ` at ${time}${str(p.timeZone) ? ` (${str(p.timeZone)})` : ""}` : ""}` : null;
  if (kind === "decision_expected") {
    if (p.withdrawn === true) return { priority, title: `Decision date removed: ${name}`, body: "The expected decision date was withdrawn. Check the official page." };
    return { priority, title: `Decision date changed: ${name}`, body: when ? `Decisions are now expected around ${when}. Confirm on the official page.` : "The expected decision date changed. Confirm on the official page." };
  }
  if (kind === "program_start") {
    if (p.withdrawn === true) return { priority, title: `Start date removed: ${name}`, body: "The program's start date was withdrawn. Check the official page." };
    return { priority, title: `Start date changed: ${name}`, body: when ? `The program now starts ${when}. Confirm on the official page.` : "The program's start date changed. Confirm on the official page." };
  }
  const label = (kind && KIND_LABEL[kind]) ?? "A deadline";
  if (p.withdrawn === true) return { priority, title: `A deadline was removed: ${name}`, body: `${label} was withdrawn. Check the official page before you plan around it.` };
  const added = p.previousLocalDate === null && "previousLocalDate" in p;
  return {
    priority,
    title: `${added ? "New deadline" : "Deadline changed"}: ${name}`,
    body: when ? `${label} is now ${when}. Confirm on the official page.` : "A deadline changed. Confirm on the official page.",
  };
}

/** Which change events reach students at all; verification and re-checks never do (6.7.1). */
export function alertableEvent(type: ChangeEventType): boolean {
  return type !== "program_cycle.verified" && type !== "cycle.urgent_recheck";
}

function namedCopy(event: ChangeEventInput, facts: CycleFacts, nowMs: number): { priority: AlertPriority; title: string; body: string } | null {
  const name = `${facts.programName} (${facts.termLabel})`;
  const p = event.payload;
  switch (event.type) {
    case "cycle.status_changed": {
      const to = str(p.to);
      if (to === "open") return { priority: "p0", title: `Applications are open: ${name}`, body: "The application window has opened. Check the official page for the deadline and requirements." };
      if (to === "paused" || to === "ended") return { priority: "p1", title: `${name} is ${to === "paused" ? "paused" : "no longer running"}`, body: "The program changed its status. Open Novus to see similar programs." };
      if (to === "closed") return { priority: "p1", title: `Applications closed: ${name}`, body: "This cycle is no longer accepting applications." };
      return { priority: "p1", title: `Status update: ${name}`, body: "The status of this application cycle changed." };
    }
    case "deadline.changed":
      return deadlineCopy(p, name, deadlineChangePriority(p, nowMs));
    case "eligibility.changed":
      // The server cannot evaluate sensitive clauses, so the copy never claims the student qualifies.
      return { priority: "p1", title: `Eligibility rules changed: ${name}`, body: "Open Novus to re-check whether you qualify." };
    case "cycle.prediction_changed":
      return { priority: "p2", title: `Expected dates moved: ${name}`, body: "Our estimate of when this program opens has changed." };
    case "cycle.decisions_released":
      return { priority: "p2", title: `Decisions released: ${name}`, body: "The program has announced that decisions are out." };
    case "posting.opened":
      return { priority: "p1", title: `New posting: ${name}`, body: "A new posting for this program is open." };
    case "posting.closed":
      return { priority: "p2", title: `Posting closed: ${name}`, body: "A posting for this program has closed." };
    default:
      return null;
  }
}

/**
 * Copy for one recipient. Neutral copy names no program, so a shared screen or inbox preview
 * cannot reveal that a student follows a status- or identity-defined program.
 */
export function draftAlert(event: ChangeEventInput, facts: CycleFacts, recipient: { nameInMessages: boolean; institutionId?: string | null }, nowMs: number): AlertDraft | null {
  if (!alertableEvent(event.type)) return null;
  if (!reachesRecipient(event, recipient)) return null;
  const named = namedCopy(event, facts, nowMs);
  if (!named) return null;
  // Identity-audience trackers default nameInMessages to false at tracking time (the student's
  // choice), so the recipient flag covers them; status-defined programs are neutral regardless.
  const neutral = facts.sensitiveAudience || !recipient.nameInMessages;
  const sampleTag = facts.isSample ? " [sample listing]" : "";
  if (neutral) {
    return {
      type: event.type,
      priority: named.priority,
      title: `An update to a program you saved${sampleTag}`,
      body: "Open Novus to see what changed.",
      href: "/app/tracker",
      neutral: true,
    };
  }
  return {
    type: event.type,
    priority: named.priority,
    title: `${named.title}${sampleTag}`.slice(0, 200),
    body: named.body.slice(0, 1000),
    href: `/programs/${encodeURIComponent(facts.programSlug)}`,
    neutral: false,
  };
}

/** One Alert per recipient, ChangeEvent and type; the table's unique (recipient, dedupe) index enforces it. */
export function changeAlertDedupeKey(changeEventId: string, type: string): string {
  return `change:${changeEventId}:${type}`;
}

/**
 * Whether an Alert gets its own email now. P0 alerts, single reminders and account mail do;
 * everything else waits for the weekly email (plan 6.7.1), so its email Notification is closed
 * as `suppressed` with reason `weekly_digest`.
 */
export function wantsOwnEmail(type: AlertType, priority: AlertPriority): boolean {
  if (type === "contact.confirmation" || type === "account.notice" || type === "deadline.reminder") return true;
  return priority === "p0";
}
