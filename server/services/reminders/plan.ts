import type { Deadline, Requirement } from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { resolveEffectiveDeadline, type CampusLead, type EffectiveDeadline } from "@shared/readiness";
import { addDays, parseIsoDate } from "@shared/time/iso";
import { endOfLocalDay, zoneAbbreviation } from "@shared/time/zones";
import { mergesIntoWeekly, planningZone, recipientToday, reminderDue, scheduledInstant, type WeeklySettings } from "./policy";

/**
 * Turns followed program cycles into dated reminder drafts (plan 6.7.1-6.7.2, 6.4.5):
 * - T−2: 09:00 local two days before the effective deadline (campus date, E1, E2 or national),
 *   keyed on (deadline, date) so a revision that keeps the date never re-sends;
 * - "Confirm your campus deadline now": once, on the day after E1 passes with no known campus
 *   date;
 * - first-door plan steps stored in `reminders` by onboarding.
 * Deterministic and pure: the clock, the recipient's settings and the registry facts are inputs.
 * Copy never names a status- or identity-defined program unless the recipient chose names.
 */

export interface RecipientContext {
  /** `u:{userId}` or `c:{contactId}`. */
  readonly recipientKey: string;
  readonly userId: string | null;
  readonly contactId: string | null;
  /** Sending zone (profile, else Institution); null means the 22:30 UTC rule. */
  readonly zone: string | null;
  readonly institutionId: string | null;
  readonly quiet: readonly [string, string];
  readonly weekly: WeeklySettings;
}

export interface CycleInfo {
  readonly cycleId: string;
  readonly programName: string;
  readonly programSlug: string;
  readonly termLabel: string;
  readonly officialUrl: string | null;
  readonly sensitiveAudience: boolean;
  readonly identityAudience: readonly string[];
  readonly isSample: boolean;
  readonly deadlines: readonly Deadline[];
  readonly requirements: readonly Requirement[];
  readonly campusLead: CampusLead | null;
}

/** One recipient following one cycle (a live tracker item, or a confirmed Remind-me). */
export interface FollowedCycle {
  readonly cycleId: string;
  readonly trackerItemId: string | null;
  readonly ownCampusDeadline: string | null;
  readonly nameInMessages: boolean;
  /** When the recipient started following; reminders planned before then are not sent. */
  readonly followedAt: number;
}

export type ReminderKind = "t2" | "campus_confirm" | "step";

export interface ReminderDraft {
  readonly kind: ReminderKind;
  readonly dedupeKey: string;
  readonly programCycleId: string;
  readonly scheduledFor: number;
  readonly title: string;
  readonly body: string;
  readonly href: string;
  readonly neutral: boolean;
  /** T−2 that rides in the weekly email instead of its own message (plan 6.7.2). */
  readonly merged: boolean;
  /**
   * The recipient's local date of `scheduledFor`, the day the reminder goes out (the merge rule
   * and the weekly email both use it, so they never disagree about which email carries it).
   */
  readonly localDate: string;
  /** The deadline line, for the weekly email's "due in 2 days" section. */
  readonly deadlineLine: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;

/** `15 Jan 2027`, from a `YYYY-MM-DD` string (never through `new Date("YYYY-MM-DD")`). */
export function formatDay(isoDate: string): string {
  const d = parseIsoDate(isoDate);
  if (!d) return isoDate;
  return `${d.day} ${MONTHS[d.month - 1]} ${d.year}`;
}

function formatClock(hhmm: string): string {
  const [h, m] = hhmm.split(":").map(Number) as [number, number];
  const suffix = h >= 12 ? "PM" : "AM";
  const hour = h % 12 === 0 ? 12 : h % 12;
  return `${hour}:${String(m).padStart(2, "0")} ${suffix}`;
}

/**
 * The full deadline line every reminder carries, so a copy in the inbox stands alone when Novus
 * is down: "15 Jan 2027, 11:59 PM EST", "2 Feb 2027, 11:59 PM your time", or a date-only line
 * with the plan-a-day-early advice (s01 F-02).
 */
export function deadlineLine(eff: Pick<EffectiveDeadline, "date" | "localTime" | "timeZone" | "instant" | "approximate">): string {
  const day = formatDay(eff.date);
  if (eff.approximate) return `around ${day} (estimated)`;
  if (eff.localTime && eff.timeZone && eff.instant !== null) return `${day}, ${formatClock(eff.localTime)} ${zoneAbbreviation(eff.instant, eff.timeZone)}`;
  if (eff.localTime) return `${day}, ${formatClock(eff.localTime)} your time`;
  return `${day}, time not stated: plan to submit by ${formatDay(addDays(eff.date, -1))}`;
}

/** Status-defined programs are always neutral; others follow the recipient's choice. */
export function isNeutral(info: Pick<CycleInfo, "sensitiveAudience">, followed: Pick<FollowedCycle, "nameInMessages">): boolean {
  return info.sensitiveAudience || !followed.nameInMessages;
}

function programLabel(info: CycleInfo): string {
  return `${info.programName} (${info.termLabel})${info.isSample ? " [sample listing]" : ""}`;
}

function nominationGated(info: CycleInfo): boolean {
  return info.requirements.some((r) => r.kind === "campus_nomination") || info.deadlines.some((d) => d.kind === "nomination");
}

export function effectiveFor(recipient: RecipientContext, followed: FollowedCycle, info: CycleInfo, now: number): EffectiveDeadline | null {
  return resolveEffectiveDeadline({
    deadlines: info.deadlines,
    now,
    studentTimeZone: planningZone(recipient.zone),
    studentInstitutionId: recipient.institutionId,
    ownCampusDeadline: followed.ownCampusDeadline,
    nominationGated: nominationGated(info),
    campusLead: info.campusLead,
  });
}

/** T−2 only for real dates: exact or date-only rows, the student's own date, or E1/E2 estimates. */
function remindable(eff: EffectiveDeadline): boolean {
  if (eff.closed || eff.passed) return false;
  if (eff.step === "campus_estimate_e1" || eff.step === "campus_estimate_e2") return true;
  return !eff.approximate && !eff.predicted;
}

const T2_TIME = `${String(PRODUCT.t2.localHour).padStart(2, "0")}:00`;

/** Every reminder draft that is due now for one recipient and cycle. */
export function planCycleReminders(recipient: RecipientContext, followed: FollowedCycle, info: CycleInfo, now: number): ReminderDraft[] {
  const eff = effectiveFor(recipient, followed, info, now);
  if (!eff || !remindable(eff)) return [];
  const zone = planningZone(recipient.zone);
  const neutral = isNeutral(info, followed);
  const line = deadlineLine(eff);
  const deadlineAt = eff.instant ?? endOfLocalDay(eff.date, zone);
  const out: ReminderDraft[] = [];

  const t2Date = addDays(eff.date, -2);
  const t2At = scheduledInstant(t2Date, T2_TIME, recipient.zone, recipient.quiet);
  // The day the reminder actually goes out (quiet hours can move 09:00 to the evening before).
  // The merge rule and the weekly email's "due in 2 days" list both key on this one day.
  const t2SendDay = recipientToday(t2At, recipient.zone);
  // "Unless the item was tracked later" (plan 6.7.2): nothing back-dated to before the follow.
  if (followed.followedAt <= t2At && reminderDue(t2At, now, { finalBeforeDeadline: true, deadlineAt })) {
    const label = eff.label;
    out.push({
      kind: "t2",
      dedupeKey: `t2:${eff.deadlineId ?? `${eff.step}:${info.cycleId}`}:${eff.date}`,
      programCycleId: info.cycleId,
      scheduledFor: t2At,
      ...(neutral
        ? {
            title: "A deadline for a program you saved is in 2 days",
            body: `Due ${line}. Details in Novus (sign in).`,
            href: "/app/tracker",
          }
        : {
            title: `Due in 2 days: ${programLabel(info)}`.slice(0, 200),
            body: [`${label}: ${line}.`, info.officialUrl ? `Official page: ${info.officialUrl}` : null, "Novus does not submit for you; confirm the date on the official page."]
              .filter(Boolean)
              .join(" ")
              .slice(0, 1000),
            href: `/programs/${encodeURIComponent(info.programSlug)}`,
          }),
      neutral,
      merged: mergesIntoWeekly(recipient.weekly, t2SendDay),
      localDate: t2SendDay,
      deadlineLine: line,
    });
  }

  if (eff.step === "campus_estimate_e2" && eff.campusEstimate) {
    const day = addDays(eff.campusEstimate.e1, 1);
    const at = scheduledInstant(day, T2_TIME, recipient.zone, recipient.quiet);
    if (followed.followedAt <= at && reminderDue(at, now, { finalBeforeDeadline: false, deadlineAt })) {
      out.push({
        kind: "campus_confirm",
        dedupeKey: `campus:${info.cycleId}:${eff.campusEstimate.e1}`,
        programCycleId: info.cycleId,
        scheduledFor: at,
        title: neutral ? "Confirm your campus deadline now" : `Confirm your campus deadline now: ${programLabel(info)}`.slice(0, 200),
        body: neutral
          ? "The estimated campus deadline for a program you saved has passed. Ask your fellowship office for your campus date. Details in Novus (sign in)."
          : `Our estimate of your campus deadline (${formatDay(eff.campusEstimate.e1)}) has passed. Campus deadlines come weeks before the national one: ask your fellowship office today, then add the date in your Tracker.`,
        href: neutral ? "/app/tracker" : `/programs/${encodeURIComponent(info.programSlug)}`,
        neutral,
        merged: false,
        localDate: day,
        deadlineLine: line,
      });
    }
  }
  return out;
}

// =============================================================================================
// First-door plan steps (rows in `reminders`, written by onboarding)
// =============================================================================================

export interface StepReminderRow {
  readonly id: string;
  readonly reminderKey: string;
  readonly kind: "step_due" | "intention" | "submit_buffer";
  readonly stepId: string;
  readonly sendOn: string;
  readonly sendAt: string;
  readonly timeZone: string;
  readonly neutral: boolean;
}

export type StepDecision =
  | { readonly action: "wait" }
  | { readonly action: "cancel"; readonly reason: "not_preparing" | "stale" }
  | { readonly action: "send"; readonly draft: ReminderDraft };

/** Statuses that still want reminders; submitted, decided and not applying stop them. */
export const PREPARING_STATUSES: ReadonlySet<string> = new Set(["interested", "applying"]);

export function planStepReminder(
  row: StepReminderRow,
  ctx: {
    readonly recipient: RecipientContext;
    readonly trackerStatus: string | null;
    readonly stepTitle: string | null;
    readonly info: CycleInfo | null;
    readonly nameInMessages: boolean;
  },
  now: number,
): StepDecision {
  if (!ctx.trackerStatus || !PREPARING_STATUSES.has(ctx.trackerStatus)) return { action: "cancel", reason: "not_preparing" };
  // The row keeps the zone onboarding saw; a zone set on the profile since then wins.
  const zone = ctx.recipient.zone ?? row.timeZone;
  const at = scheduledInstant(row.sendOn, row.sendAt, zone, ctx.recipient.quiet);
  if (at > now + 3_600_000) return { action: "wait" };
  if (!reminderDue(at, now, { finalBeforeDeadline: false, deadlineAt: null })) return { action: "cancel", reason: "stale" };
  const neutral = row.neutral || !ctx.info || isNeutral(ctx.info, { nameInMessages: ctx.nameInMessages });
  const step = ctx.stepTitle?.trim() ? ctx.stepTitle.trim().slice(0, 120) : "the next step in your plan";
  const program = ctx.info && !neutral ? programLabel(ctx.info) : null;
  let title: string;
  let body: string;
  switch (row.kind) {
    case "intention":
      title = program ? `Your plan for ${program}` : "Your plan for a program you saved";
      body = neutral ? "You planned a step for today. Details in Novus (sign in)." : `You planned to do this today: ${step}.`;
      break;
    case "submit_buffer":
      title = program ? `Plan to submit soon: ${program}` : "Plan to submit soon for a program you saved";
      body = neutral
        ? "Leave a buffer before the deadline. Details in Novus (sign in)."
        : "Portals and offices often close early, so plan to submit a day or two before the deadline.";
      break;
    default:
      title = program ? `Due tomorrow: ${step}` : "A step in your plan is due tomorrow";
      body = neutral ? "A step for a program you saved is due tomorrow. Details in Novus (sign in)." : `For ${program ?? "your application"}: ${step}.`;
  }
  return {
    action: "send",
    draft: {
      kind: "step",
      dedupeKey: `step:${row.reminderKey}`.slice(0, 200),
      programCycleId: ctx.info?.cycleId ?? "",
      scheduledFor: at,
      title: title.slice(0, 200),
      body: body.slice(0, 1000),
      href: neutral || !ctx.info ? "/app/roadmap" : `/programs/${encodeURIComponent(ctx.info.programSlug)}`,
      neutral,
      merged: false,
      localDate: row.sendOn,
      deadlineLine: "",
    },
  };
}
