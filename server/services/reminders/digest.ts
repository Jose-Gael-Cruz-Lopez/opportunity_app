import type { Db, EventsDb } from "@server/db/client";
import { events, notifications } from "@server/db/repos";
import { deriveSubkey, hmacSha256Hex } from "@server/internal/crypto";
import type { Budget } from "@server/jobs/budget";
import type { HandlerResult, Logger } from "@server/jobs/types";
import { BREAKER_THRESHOLD } from "@server/services/email/dispatch";
import { DEFAULT_DAILY_QUOTA, quotaAllows, utcDayStart } from "@server/services/email/policy";
import type { EmailProvider } from "@server/services/email/provider";
import { readDailyQuota } from "@server/services/email/store";
import { emailLookupHmac, listUnsubscribeHeaders, signUnsubscribeToken, unsubscribeUrl } from "@server/services/email/tokens";
import { recipientContext } from "./context";
import { planCycleReminders, type RecipientContext, type ReminderDraft } from "./plan";
import { examPaused, isoWeekKey, recipientToday, weeklyWindowOpen } from "./policy";
import {
  ensureWeeklyRecord,
  existingDedupeKeys,
  loadAudience,
  loadCycleInfos,
  loadProgress,
  loadUserSettings,
  queuedDigestChanges,
  recordCarriedReminders,
  weeklyStates,
  type AudienceRow,
} from "./store";
import { collectWeekly, isEmptyWeekly, renderWeekly } from "./weekly";

/**
 * `digest.send` (hourly; plan 6.7.2-6.7.3, s02 2.3.7 and 2.3.11): the weekly email. Each hour it
 * finds recipients whose weekly day it is (`hash(id) mod 7`, or the day they picked) and whose
 * local send time has come (18:00, or 09:00 when a T−2 reminder rides along) before quiet hours,
 * composes the email from current registry data, and sends it through the EmailProvider on the
 * digest stream with RFC 8058 one-click unsubscribe for the weekly list only.
 *
 * Idempotent per recipient and ISO week: the record is an Alert keyed `weekly:{isoWeek}` (shown
 * in the notification center) with one digest-stream Notification, and the provider receives
 * `digest:{hmac(recipient)}:{isoWeek}`. Send-time rules: weekly switch and email channel, exam
 * pause, the 50% quota hold (bypassed only when a T−2 rides along), suppression, and quiet hours.
 * Change alerts that waited for this email are marked sent with it.
 */

export interface DigestDeps {
  readonly db: Db;
  readonly edb: EventsDb | null;
  readonly provider: EmailProvider;
  readonly appOrigin: string;
  /** BETTER_AUTH_SECRET; without it no unsubscribe link exists, so nothing is sent. */
  readonly secret: string | null;
  readonly now: () => number;
  readonly budget: Budget;
  readonly log: Logger;
  /** Recipients composed per run at most (the rest wait for the next hour of their window). */
  readonly sendLimit?: number;
}

/** Weekly emails older than 48 hours are discarded (plan 6.7.2). */
export const WEEKLY_EXPIRY_MS = 48 * 3_600_000;

/** The provider idempotency key; the recipient part is an HMAC, never an id (s02 2.3.7). */
export async function digestIdempotencyKey(secret: string, recipientKey: string, weekKey: string): Promise<string> {
  const key = await deriveSubkey(secret, "digest-key-v1");
  return `digest:${(await hmacSha256Hex(key, recipientKey)).slice(0, 32)}:${weekKey}`;
}

interface Candidate {
  readonly row: AudienceRow;
  readonly ctx: RecipientContext;
  readonly weekKey: string;
  readonly dueSoon: ReminderDraft[];
}

export async function runDigestSend(deps: DigestDeps): Promise<HandlerResult> {
  const { db, edb, budget, log, provider } = deps;
  if (!deps.secret) {
    // No unsubscribe link can be built: the weekly email waits rather than going out without one.
    log("warn", "digest.no_secret", {});
    return { processed: 0, outcome: "deferred" };
  }
  if (!budget.allows(8)) return { processed: 0, outcome: "partial" };
  const start = deps.now();

  const audience = await loadAudience(db);
  budget.spend();
  const userIds = audience.flatMap((a) => (a.userId ? [a.userId] : []));
  const settings = await loadUserSettings(db, userIds);
  budget.spend();

  // Recipients whose window might be open, before loading anything heavier.
  const early: { row: AudienceRow; ctx: RecipientContext }[] = [];
  for (const row of audience) {
    if (!row.email) continue;
    const ctx = recipientContext(row, row.userId ? settings.get(row.userId) : undefined);
    if (!ctx.weekly.weeklyEmail) continue;
    if (examPaused(ctx.weekly.examPauseUntil, recipientToday(start, ctx.zone))) continue;
    // 09:00 is the earliest the window can open; the exact check needs the cycle facts.
    if (!weeklyWindowOpen(ctx.weekly, start, true)) continue;
    early.push({ row, ctx });
  }
  if (early.length === 0) return { processed: 0, outcome: "ok", detail: { candidates: 0 } };

  const cycleIds = [...new Set(early.flatMap((e) => e.row.followed.map((f) => f.cycleId)))];
  const infos = await loadCycleInfos(db, cycleIds);
  // T−2 reminders that already exist as Alerts (sent on their own, or carried by an earlier
  // weekly email) are not carried again.
  const existingT2 = await existingDedupeKeys(db, early.map((e) => e.row.recipientKey), ["t2:"], start - 14 * 86_400_000);
  budget.spend(4);

  const candidates: Candidate[] = [];
  for (const { row, ctx } of early) {
    const today = recipientToday(start, ctx.zone);
    const dueSoon: ReminderDraft[] = [];
    for (const followed of row.followed) {
      const info = infos.get(followed.cycleId);
      if (!info) continue;
      for (const d of planCycleReminders(ctx, followed, info, start)) {
        if (d.kind === "t2" && d.merged && d.localDate === today && !existingT2.has(`${row.recipientKey}|${d.dedupeKey}`)) dueSoon.push(d);
      }
    }
    if (!weeklyWindowOpen(ctx.weekly, start, dueSoon.length > 0)) continue;
    candidates.push({ row, ctx, weekKey: isoWeekKey(today), dueSoon });
  }
  if (candidates.length === 0) return { processed: 0, outcome: "ok", detail: { candidates: 0 } };

  const keys = candidates.map((c) => c.row.recipientKey);
  const states = await weeklyStates(db, keys, [...new Set(candidates.map((c) => c.weekKey))]);
  const pending = candidates.filter((c) => {
    const state = states.get(`${c.row.recipientKey}|${c.weekKey}`);
    return state === undefined || state === "queued";
  });
  const pendingUsers = pending.flatMap((c) => (c.row.userId ? [c.row.userId] : []));
  const [changes, progress] = await Promise.all([queuedDigestChanges(db, pending.map((c) => c.row.recipientKey), start), loadProgress(db, pendingUsers)]);
  const quota = (await readDailyQuota(db)) ?? DEFAULT_DAILY_QUOTA;
  let sentToday = edb ? await events.emailsSentSince(edb, utcDayStart(start)) : 0;
  budget.spend(5);

  const counts = { sent: 0, held: 0, suppressed: 0, failed: 0, empty: 0 };
  let consecutiveFailures = 0;
  let partial = false;
  const limit = deps.sendLimit ?? 200;
  for (const c of pending.slice(0, limit)) {
    if (!budget.allows(10)) {
      partial = true;
      break;
    }
    const now = deps.now();
    const content = collectWeekly({
      recipient: c.ctx,
      cycles: c.row.followed.flatMap((followed) => {
        const info = infos.get(followed.cycleId);
        return info ? [{ followed, info }] : [];
      }),
      progress: c.row.userId ? (progress.get(c.row.userId) ?? []) : [],
      changes: (changes.get(c.row.recipientKey) ?? []).map((ch) => ({ title: ch.title, body: ch.body, href: ch.href })),
      dueSoon: c.dueSoon,
      now,
    });
    if (isEmptyWeekly(content)) {
      counts.empty++;
      continue;
    }
    const urgent = c.dueSoon.length > 0;
    if (!quotaAllows("digest", sentToday, quota, urgent)) {
      counts.held++;
      continue;
    }

    const unsubscribe = unsubscribeUrl(deps.appOrigin, await signUnsubscribeToken(deps.secret, { recipientKey: c.row.recipientKey, list: "weekly", nowMs: now }));
    const rendered = renderWeekly(content, { appOrigin: deps.appOrigin, unsubscribeUrl: unsubscribe });
    const record = await ensureWeeklyRecord(
      db,
      {
        userId: c.row.userId,
        contactId: c.row.userId ? null : c.row.contactId,
        recipientKey: c.row.recipientKey,
        weekKey: c.weekKey,
        title: `Your week ahead: ${rendered.summary}`,
        body: content.entries
          .slice(0, 5)
          .map((e) => `${e.date} · ${e.program} · ${e.text}`)
          .join("\n"),
        expiresAt: now + WEEKLY_EXPIRY_MS,
      },
      now,
    );
    budget.spend(2);
    if (!record || record.state !== "queued") continue;

    const hmacs: { hmac: string; keyId: string }[] = [];
    if (c.row.contactHmac) hmacs.push(c.row.contactHmac);
    hmacs.push(await emailLookupHmac(deps.secret, c.row.email as string));
    if (await notifications.isSuppressed(db, hmacs)) {
      await notifications.markNotification(db, record.notificationId, "suppressed", now, "suppressed");
      if (edb) await events.appendEmailLedger(edb, { notificationId: record.notificationId, stream: "digest", outcome: "suppressed" }, now);
      budget.spend(hmacs.length + 2);
      counts.suppressed++;
      continue;
    }

    const outcome = await provider.send({
      to: c.row.email as string,
      subject: rendered.subject,
      text: rendered.text,
      html: rendered.html,
      headers: listUnsubscribeHeaders(unsubscribe),
      stream: "digest",
      idempotencyKey: await digestIdempotencyKey(deps.secret, c.row.recipientKey, c.weekKey),
    });
    if (outcome.ok) {
      consecutiveFailures = 0;
      sentToday++;
      counts.sent++;
      await notifications.markNotification(db, record.notificationId, "sent", now);
      for (const ch of changes.get(c.row.recipientKey) ?? []) await notifications.markNotification(db, ch.notificationId, "sent", now);
      // The record of which T−2 reminders this email carried: reminders.schedule skips exactly
      // these and sends any other merged T−2 on its own.
      await recordCarriedReminders(db, { userId: c.row.userId, contactId: c.row.userId ? null : c.row.contactId }, c.dueSoon, now);
      if (edb) await events.appendEmailLedger(edb, { notificationId: record.notificationId, stream: "digest", outcome: "sent", providerMessageId: outcome.messageId, dryRun: outcome.dryRun }, now);
      budget.spend(2 + (changes.get(c.row.recipientKey)?.length ?? 0));
      continue;
    }
    counts.failed++;
    if (!outcome.retryable) {
      await notifications.markNotification(db, record.notificationId, "failed", now, outcome.errorClass);
      if (edb) await events.appendEmailLedger(edb, { notificationId: record.notificationId, stream: "digest", outcome: "failed" }, now);
      budget.spend(2);
      continue;
    }
    await notifications.recordNotificationAttempt(db, record.notificationId, outcome.errorClass, now);
    budget.spend();
    consecutiveFailures++;
    if (consecutiveFailures >= BREAKER_THRESHOLD) {
      log("alert", "digest.breaker_open", { provider: provider.name, errorClass: outcome.errorClass });
      return { processed: counts.sent, outcome: "deferred", detail: counts };
    }
  }
  if (pending.length > limit) partial = true;
  if (counts.sent + counts.failed + counts.suppressed > 0) log("info", "digest.send", counts);
  return { processed: counts.sent, outcome: partial ? "partial" : "ok", detail: counts };
}
