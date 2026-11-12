import type { AlertType } from "@shared/contracts/events";
import { PRODUCT } from "@shared/config/product";
import { isValidTimeZone, localDateIn, localTimeIn } from "@shared/time/zones";
import type { Db, EventsDb } from "@server/db/client";
import { events, notifications } from "@server/db/repos";
import type { NotificationInsert } from "@server/db/repos/notifications";
import type { Budget } from "@server/jobs/budget";
import type { HandlerResult, Logger } from "@server/jobs/types";
import { wantsOwnEmail, type AlertPriority } from "@server/services/alerts/copy";
import { isQuietTime, isUrgent, notificationExpiry, quotaAllows, sendClassFor, utcDayStart, DEFAULT_DAILY_QUOTA } from "./policy";
import type { EmailProvider } from "./provider";
import { dueTransactionalEmail, nextDeadlineMs, profileTimeZone, readDailyQuota, type DueEmailRow } from "./store";
import { renderAlertEmail } from "./templates";
import { emailLookupHmac, listUnsubscribeHeaders, signUnsubscribeToken, unsubscribeUrl, type UnsubscribeList } from "./tokens";

/**
 * `notify.dispatch` (architecture 2.3.11, plan 6.7.2), run first on every tick:
 *   1. expire Notifications past `expires_at` (never send late);
 *   2. queue one email Notification per due Alert (idempotency key `notif:{alertId}:email`):
 *      transactional when the Alert gets its own email, digest when it waits for the weekly email;
 *   3. send queued transactional email in priority order, applying preferences, exam pause, quiet
 *      hours, the daily quota reserve and suppression at send time.
 * Holds (quiet hours, quota, provider outage) leave the row queued without spending an attempt.
 */

export interface DispatchDeps {
  readonly db: Db;
  readonly edb: EventsDb | null;
  readonly provider: EmailProvider;
  readonly appOrigin: string;
  /** BETTER_AUTH_SECRET; without it no unsubscribe link or suppression lookup can be built. */
  readonly secret: string | null;
  readonly now: () => number;
  readonly budget: Budget;
  readonly log: Logger;
  readonly queueLimit?: number;
  readonly sendLimit?: number;
}

/** Consecutive retryable provider failures that open the breaker for the rest of the run. */
export const BREAKER_THRESHOLD = 3;

export async function queueEmailNotifications(deps: DispatchDeps): Promise<number> {
  const { db, budget } = deps;
  if (!budget.allows(2)) return 0;
  const now = deps.now();
  const rows = await notifications.alertsAwaitingNotification(db, now, "email", deps.queueLimit ?? 200);
  budget.spend();
  if (rows.length === 0) return 0;
  const deadlineCache = new Map<string, number | null>();
  const items: NotificationInsert[] = [];
  for (const { alert } of rows) {
    const own = wantsOwnEmail(alert.type as AlertType, alert.priority as AlertPriority);
    let deadline: number | null = null;
    if (alert.programCycleId) {
      if (!deadlineCache.has(alert.programCycleId)) {
        if (!budget.allows(2)) break;
        deadlineCache.set(alert.programCycleId, await nextDeadlineMs(db, alert.programCycleId, now));
        budget.spend();
      }
      deadline = deadlineCache.get(alert.programCycleId) ?? null;
    }
    items.push({
      alertId: alert.id,
      channel: "email",
      stream: own ? "transactional" : "digest",
      expiresAt: notificationExpiry({ type: alert.type as AlertType, createdAt: alert.createdAt, nextDeadlineMs: deadline, digest: !own }),
    });
  }
  await notifications.queueNotifications(db, items, now);
  budget.spend(Math.ceil(items.length / 9));
  return items.length;
}

/** Which unsubscribe list a message belongs to (RFC 8058: the URI names recipient and list). */
export function unsubscribeListFor(type: AlertType): UnsubscribeList {
  if (type === "deadline.reminder" || type === "cycle.predicted_soon") return "cycle_reminders";
  return "alerts";
}

type SendDecision =
  | { kind: "send" }
  | { kind: "hold"; reason: "quiet_hours" | "quota" | "exam_pause" }
  | { kind: "suppress"; reason: "no_address" | "prefs_off" | "suppressed" };

interface SendState {
  sentToday: number;
  quota: number;
  consecutiveFailures: number;
}

async function decide(deps: DispatchDeps, row: DueEmailRow, state: SendState, now: number, cache: Map<string, number | null>): Promise<SendDecision> {
  const { db, budget } = deps;
  const { alert } = row;
  const type = alert.type as AlertType;
  const cls = sendClassFor(type, row.notification.stream as "transactional" | "digest");
  const address = row.userEmail ?? row.contactEmail;
  if (!address) return { kind: "suppress", reason: "no_address" };

  let timeZone: string = PRODUCT.fallbackTimeZone;
  let quiet: [string, string] = [PRODUCT.email.quietHours[0], PRODUCT.email.quietHours[1]];
  if (alert.userId) {
    const prefs = await notifications.getNotificationPrefs(db, alert.userId);
    const tz = await profileTimeZone(db, alert.userId);
    budget.spend(2);
    if (!prefs.channels.email && cls !== "essential") return { kind: "suppress", reason: "prefs_off" };
    if (tz && isValidTimeZone(tz)) timeZone = tz;
    quiet = [prefs.quietHoursStart, prefs.quietHoursEnd];
    // Exam pause holds everything but P0 alerts and reminders (plan 6.7.2: T-2 is exempt).
    if (prefs.examPauseUntil && localDateIn(now, timeZone) <= prefs.examPauseUntil && alert.priority !== "p0" && type !== "deadline.reminder" && cls !== "essential") {
      return { kind: "hold", reason: "exam_pause" };
    }
  }

  let urgent = false;
  if (alert.programCycleId) {
    if (!cache.has(alert.programCycleId)) {
      cache.set(alert.programCycleId, await nextDeadlineMs(db, alert.programCycleId, now));
      budget.spend();
    }
    urgent = isUrgent(cache.get(alert.programCycleId) ?? null, now);
  }
  if (cls !== "essential" && !urgent && isQuietTime(localTimeIn(now, timeZone), quiet[0], quiet[1])) return { kind: "hold", reason: "quiet_hours" };
  if (!quotaAllows(cls, state.sentToday, state.quota, urgent)) return { kind: "hold", reason: "quota" };

  if (deps.secret || row.contactHmac) {
    const hmacs: { hmac: string; keyId: string }[] = [];
    if (row.contactHmac && row.contactHmacKeyId) hmacs.push({ hmac: row.contactHmac, keyId: row.contactHmacKeyId });
    if (deps.secret) hmacs.push(await emailLookupHmac(deps.secret, address));
    const suppressed = await notifications.isSuppressed(db, hmacs);
    budget.spend(hmacs.length);
    // Suppressions hold bounces and complaints; they never block essential mail such as codes.
    if (suppressed && cls !== "essential") return { kind: "suppress", reason: "suppressed" };
  }
  return { kind: "send" };
}

export async function sendDueEmail(deps: DispatchDeps): Promise<HandlerResult> {
  const { db, edb, budget, log, provider } = deps;
  if (!budget.allows(3)) return { processed: 0, outcome: "partial" };
  const start = deps.now();
  const quota = (await readDailyQuota(db)) ?? DEFAULT_DAILY_QUOTA;
  const sentToday = edb ? await events.emailsSentSince(edb, utcDayStart(start)) : 0;
  budget.spend(2);
  const state: SendState = { sentToday, quota, consecutiveFailures: 0 };
  const rows = await dueTransactionalEmail(db, start, deps.sendLimit ?? 50);
  budget.spend();

  const cache = new Map<string, number | null>();
  const counts = { sent: 0, held: 0, suppressed: 0, failed: 0 };
  let partial = false;
  for (const row of rows) {
    if (!budget.allows(8)) {
      partial = true;
      break;
    }
    const now = deps.now();
    const decision = await decide(deps, row, state, now, cache);
    if (decision.kind === "hold") {
      counts.held++;
      continue;
    }
    if (decision.kind === "suppress") {
      await notifications.markNotification(db, row.notification.id, "suppressed", now, decision.reason);
      if (edb) await events.appendEmailLedger(edb, { notificationId: row.notification.id, stream: "transactional", outcome: "suppressed" }, now);
      budget.spend(2);
      counts.suppressed++;
      continue;
    }

    const recipientKey = row.alert.recipientKey;
    let unsubscribe: string | null = null;
    if (deps.secret) {
      const list = unsubscribeListFor(row.alert.type as AlertType);
      const token = await signUnsubscribeToken(deps.secret, { recipientKey, list, cycleId: row.alert.programCycleId, nowMs: now });
      unsubscribe = unsubscribeUrl(deps.appOrigin, token);
    }
    const rendered = renderAlertEmail({ title: row.alert.title, body: row.alert.body, href: row.alert.href, appOrigin: deps.appOrigin, unsubscribeUrl: unsubscribe });
    const outcome = await provider.send({
      to: (row.userEmail ?? row.contactEmail) as string,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: unsubscribe ? listUnsubscribeHeaders(unsubscribe) : {},
      stream: "transactional",
      idempotencyKey: row.notification.idempotencyKey,
    });

    if (outcome.ok) {
      state.consecutiveFailures = 0;
      state.sentToday++;
      counts.sent++;
      await notifications.markNotification(db, row.notification.id, "sent", now);
      // The ledger lives in novus-events, so a novus-main restore cannot make mail look unsent.
      if (edb) await events.appendEmailLedger(edb, { notificationId: row.notification.id, stream: "transactional", outcome: "sent", providerMessageId: outcome.messageId, dryRun: outcome.dryRun }, now);
      budget.spend(2);
      continue;
    }
    counts.failed++;
    if (!outcome.retryable) {
      await notifications.markNotification(db, row.notification.id, "failed", now, outcome.errorClass);
      if (edb) await events.appendEmailLedger(edb, { notificationId: row.notification.id, stream: "transactional", outcome: "failed" }, now);
      budget.spend(2);
      continue;
    }
    await notifications.recordNotificationAttempt(db, row.notification.id, outcome.errorClass, now);
    budget.spend();
    state.consecutiveFailures++;
    if (state.consecutiveFailures >= BREAKER_THRESHOLD) {
      // Provider looks down: stop for this tick; rows stay queued until they expire.
      log("alert", "email.breaker_open", { provider: provider.name, errorClass: outcome.errorClass });
      return { processed: counts.sent, outcome: "deferred", detail: counts };
    }
  }
  if (state.sentToday >= Math.floor(state.quota * 0.7)) log("warn", "email.quota_70pct", { sentToday: state.sentToday, quota: state.quota });
  return { processed: counts.sent, outcome: partial ? "partial" : "ok", detail: counts };
}

export async function dispatchNotifications(deps: DispatchDeps): Promise<HandlerResult> {
  const now = deps.now();
  await notifications.expireNotifications(deps.db, now);
  deps.budget.spend();
  const queued = await queueEmailNotifications(deps);
  const sent = await sendDueEmail(deps);
  return { ...sent, detail: { ...(sent.detail ?? {}), queued } };
}
