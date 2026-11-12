import { and, asc, eq, isNull, sql } from "drizzle-orm";
import type { Db } from "@server/db/client";
import { notifications, registry } from "@server/db/repos";
import { runBatch } from "@server/db/repos/common";
import * as s from "@server/db/schema";

/**
 * Reads and writes the email path needs that server/db/repos does not offer yet. Each is a
 * candidate to move into repos/notifications.ts; they stay small and typed against the schema.
 */

/**
 * Queued transactional email Notifications that are still deliverable, highest priority first.
 * Unlike `dueNotifications`, digest-stream rows (the weekly email's queue) are excluded, so a
 * backlog of weekly items can never crowd out a reminder or a P0 alert.
 */
export async function dueTransactionalEmail(db: Db, now: number, limit: number) {
  return db
    .select({
      notification: s.notifications,
      alert: s.alerts,
      userEmail: s.users.email,
      contactEmail: s.contacts.email,
      contactHmac: s.contacts.emailHmac,
      contactHmacKeyId: s.contacts.hmacKeyId,
    })
    .from(s.notifications)
    .innerJoin(s.alerts, eq(s.alerts.id, s.notifications.alertId))
    .leftJoin(s.users, eq(s.users.id, s.alerts.userId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.alerts.contactId))
    .where(
      and(
        eq(s.notifications.state, "queued"),
        eq(s.notifications.channel, "email"),
        eq(s.notifications.stream, "transactional"),
        sql`${s.notifications.expiresAt} > ${now}`,
        isNull(s.users.deletedAt),
      ),
    )
    .orderBy(asc(s.alerts.priority), asc(s.notifications.createdAt))
    .limit(limit);
}

export type DueEmailRow = Awaited<ReturnType<typeof dueTransactionalEmail>>[number];

/** The account's recorded daily send quota (config key `email.daily_quota`), if any. */
export async function readDailyQuota(db: Db): Promise<number | null> {
  const row = await db.query.config.findFirst({ where: eq(s.config.key, "email.daily_quota") });
  const value = row?.value;
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

/** The earliest live, future deadline instant of a cycle (epoch ms), for urgency and expiry. */
export async function nextDeadlineMs(db: Db, cycleId: string, now: number): Promise<number | null> {
  const deadlines = await registry.listLiveDeadlines(db, [cycleId]);
  let best: number | null = null;
  for (const d of deadlines) {
    if (!d.dueAt) continue;
    const t = Date.parse(d.dueAt);
    if (Number.isFinite(t) && t > now && (best === null || t < best)) best = t;
  }
  return best;
}

/** The student's stored time zone, if any (sending uses profile, else the fallback zone). */
export async function profileTimeZone(db: Db, userId: string): Promise<string | null> {
  const row = await db.query.studentProfiles.findFirst({ where: eq(s.studentProfiles.userId, userId), columns: { timeZone: true } });
  return row?.timeZone ?? null;
}

/**
 * Removes Remind-me / tracked-cycle subscriptions for a recipient, optionally for one cycle. For
 * an email-only contact, when that was its last subscription the contact goes in the same batch
 * with its alerts, notifications and consents (plan 09: an address goes with its last
 * Subscription), so no plaintext address or status-program consent outlives the unsubscribe.
 */
export async function deleteSubscriptions(db: Db, who: { userId?: string; contactId?: string }, cycleId?: string | null): Promise<void> {
  const owner = who.userId ? eq(s.subscriptions.userId, who.userId) : who.contactId ? eq(s.subscriptions.contactId, who.contactId) : null;
  if (!owner) return;
  const where = cycleId ? and(owner, eq(s.subscriptions.programCycleId, cycleId)) : owner;
  await runBatch(db, [
    db.delete(s.subscriptions).where(and(where, sql`${s.subscriptions.kind} IN ('remind_me', 'tracked_cycle')`)),
    ...(!who.userId && who.contactId ? notifications.purgeContactIfEmptyStatements(db, who.contactId) : []),
  ]);
}
