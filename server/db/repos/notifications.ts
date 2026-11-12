import { and, asc, desc, eq, inArray, isNull, lt, sql } from "drizzle-orm";
import type { AlertType, InboxItem, NotificationPrefs } from "../../../shared/contracts/events";
import { PRODUCT } from "../../../shared/config/product";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { chunked, iso, isoOrNull, rowsPerInsert } from "../util";
import { classifyWriteError, ok, runBatch, type RepoResult, type Stmt } from "./common";

/**
 * ChangeEvents -> Alerts -> Notifications, plus inbox, preferences, contacts, Remind-me
 * subscriptions and calendar feeds. Alert and Notification inserts are idempotent on their
 * dedupe keys, so a retried tick never sends twice.
 */

// =============================================================================================
// ChangeEvents (the outbox written by publish batches)
// =============================================================================================

export async function listPendingChangeEvents(db: Db, limit: number) {
  return db.select().from(s.changeEvents).where(isNull(s.changeEvents.fannedOutAt)).orderBy(asc(s.changeEvents.createdAt)).limit(limit);
}

export async function markChangeEventFannedOut(db: Db, changeEventId: string, now: number): Promise<void> {
  await db.update(s.changeEvents).set({ fannedOutAt: now }).where(eq(s.changeEvents.id, changeEventId));
}

/**
 * Who follows a cycle: live tracker items not marked not_applying, and live Remind-me
 * subscriptions (a contact's only once confirmed; a row with `delete_after` set is not live).
 * Each recipient carries the Institution on their profile (null for contacts), so campus-scoped
 * changes reach only that campus's students.
 */
export async function recipientsForCycle(db: Db, cycleId: string) {
  const [trackers, subs] = await db.batch([
    db
      .select({ userId: s.trackerItems.userId, nameInMessages: s.trackerItems.nameInMessages, status: s.trackerItems.status, institutionId: s.studentProfiles.institutionId })
      .from(s.trackerItems)
      .innerJoin(s.users, eq(s.users.id, s.trackerItems.userId))
      .leftJoin(s.studentProfiles, eq(s.studentProfiles.userId, s.trackerItems.userId))
      .where(and(eq(s.trackerItems.programCycleId, cycleId), isNull(s.trackerItems.deletedAt), isNull(s.users.deletedAt), sql`${s.trackerItems.status} <> 'not_applying'`)),
    db
      .select({ userId: s.subscriptions.userId, contactId: s.subscriptions.contactId, nameInMessages: s.subscriptions.nameInMessages, institutionId: s.studentProfiles.institutionId })
      .from(s.subscriptions)
      .leftJoin(s.contacts, eq(s.contacts.id, s.subscriptions.contactId))
      .leftJoin(s.studentProfiles, eq(s.studentProfiles.userId, s.subscriptions.userId))
      .where(
        and(
          eq(s.subscriptions.programCycleId, cycleId),
          sql`${s.subscriptions.kind} IN ('remind_me', 'tracked_cycle')`,
          // Same audience as reminders.schedule (services/reminders/store.ts): pending rows get nothing.
          isNull(s.subscriptions.deleteAfter),
          // Email-only contacts must have confirmed before they get anything but the confirmation.
          sql`(${s.subscriptions.contactId} IS NULL OR ${s.contacts.confirmedAt} IS NOT NULL)`,
        ),
      ),
  ]);
  const seen = new Set<string>();
  const out: { recipientKey: string; userId: string | null; contactId: string | null; nameInMessages: boolean; institutionId: string | null }[] = [];
  for (const t of trackers) {
    const key = `u:${t.userId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ recipientKey: key, userId: t.userId, contactId: null, nameInMessages: t.nameInMessages, institutionId: t.institutionId ?? null });
  }
  for (const sub of subs) {
    const key = sub.userId ? `u:${sub.userId}` : `c:${sub.contactId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ recipientKey: key, userId: sub.userId, contactId: sub.contactId, nameInMessages: sub.nameInMessages, institutionId: sub.userId ? (sub.institutionId ?? null) : null });
  }
  return out;
}

// =============================================================================================
// Alerts
// =============================================================================================

export interface AlertInsert {
  type: AlertType;
  userId?: string | null;
  contactId?: string | null;
  programCycleId?: string | null;
  changeEventId?: string | null;
  dedupeKey: string;
  priority?: "p0" | "p1" | "p2";
  title: string;
  body: string;
  href?: string | null;
  scheduledFor: number;
}

export function recipientKey(a: { userId?: string | null; contactId?: string | null }): string {
  if (a.userId) return `u:${a.userId}`;
  if (a.contactId) return `c:${a.contactId}`;
  throw new Error("an alert needs exactly one recipient");
}

const ALERT_COLUMNS = 15;

/** Inserts alerts in chunks; duplicates (same recipient and dedupe key) are skipped. */
export async function insertAlerts(db: Db, alerts: readonly AlertInsert[], now: number): Promise<RepoResult<number>> {
  if (alerts.length === 0) return ok(0);
  const rows = alerts.map((a) => ({
    id: uuidv7(now),
    type: a.type,
    userId: a.userId ?? null,
    contactId: a.contactId ?? null,
    recipientKey: recipientKey(a),
    programCycleId: a.programCycleId ?? null,
    changeEventId: a.changeEventId ?? null,
    dedupeKey: a.dedupeKey,
    priority: a.priority ?? "p1",
    title: a.title,
    body: a.body,
    href: a.href ?? null,
    scheduledFor: a.scheduledFor,
    createdAt: now,
  }));
  const stmts: Stmt[] = chunked(rows, rowsPerInsert(ALERT_COLUMNS)).map((chunk) => db.insert(s.alerts).values(chunk).onConflictDoNothing());
  try {
    await runBatch(db, stmts);
    return ok(rows.length);
  } catch (err) {
    return classifyWriteError(err);
  }
}

export function toInboxItem(row: typeof s.alerts.$inferSelect): InboxItem {
  return {
    id: row.id,
    type: row.type as InboxItem["type"],
    priority: row.priority as InboxItem["priority"],
    title: row.title,
    body: row.body,
    href: row.href,
    readAt: isoOrNull(row.readAt),
    createdAt: iso(row.createdAt),
  };
}

/** In-app inbox, newest first, keyset-paginated by (created_at, id). */
export async function listInbox(db: Db, userId: string, now: number, opts: { limit: number; before?: { createdAt: number; id: string } | null }) {
  const before = opts.before
    ? sql`(${s.alerts.createdAt} < ${opts.before.createdAt} OR (${s.alerts.createdAt} = ${opts.before.createdAt} AND ${s.alerts.id} < ${opts.before.id}))`
    : sql`1 = 1`;
  const rows = await db
    .select()
    .from(s.alerts)
    .where(and(eq(s.alerts.userId, userId), sql`${s.alerts.scheduledFor} <= ${now}`, before))
    .orderBy(desc(s.alerts.createdAt), desc(s.alerts.id))
    .limit(opts.limit);
  return rows.map(toInboxItem);
}

export async function markAlertRead(db: Db, userId: string, alertId: string, now: number): Promise<boolean> {
  const rows = await db
    .update(s.alerts)
    .set({ readAt: now })
    .where(and(eq(s.alerts.id, alertId), eq(s.alerts.userId, userId), isNull(s.alerts.readAt)))
    .returning({ id: s.alerts.id });
  return rows.length > 0;
}

export async function unreadCount(db: Db, userId: string, now: number): Promise<number> {
  const rows = await db
    .select({ n: sql<number>`count(*)` })
    .from(s.alerts)
    .where(and(eq(s.alerts.userId, userId), isNull(s.alerts.readAt), sql`${s.alerts.scheduledFor} <= ${now}`));
  return Number(rows[0]?.n ?? 0);
}

// =============================================================================================
// Notifications (one per Alert and channel)
// =============================================================================================

export interface NotificationInsert {
  alertId: string;
  channel: "email" | "in_app" | "push";
  stream?: "transactional" | "digest";
  expiresAt: number;
}

export function notificationKey(alertId: string, channel: string): string {
  return `notif:${alertId}:${channel}`;
}

export async function queueNotifications(db: Db, items: readonly NotificationInsert[], now: number): Promise<void> {
  const rows = items.map((n) => ({
    id: uuidv7(now),
    alertId: n.alertId,
    channel: n.channel,
    stream: n.stream ?? "transactional",
    idempotencyKey: notificationKey(n.alertId, n.channel),
    expiresAt: n.expiresAt,
    createdAt: now,
    updatedAt: now,
  }));
  await runBatch(
    db,
    chunked(rows, rowsPerInsert(11)).map((chunk) => db.insert(s.notifications).values(chunk).onConflictDoNothing()),
  );
}

/** Alerts due now that have no notification on a channel yet (for notify.dispatch). */
export async function alertsAwaitingNotification(db: Db, now: number, channel: "email" | "in_app" | "push", limit: number) {
  return db
    .select({ alert: s.alerts })
    .from(s.alerts)
    .where(
      and(
        sql`${s.alerts.scheduledFor} <= ${now}`,
        // Qualified raw name: an interpolated column may render unqualified and rebind to n.id.
        sql`NOT EXISTS (SELECT 1 FROM notifications n WHERE n.alert_id = alerts.id AND n.channel = ${channel})`,
      ),
    )
    .orderBy(asc(s.alerts.priority), asc(s.alerts.scheduledFor))
    .limit(limit);
}

/** Queued notifications that are still deliverable, with their alert and recipient address. */
export async function dueNotifications(db: Db, now: number, limit: number) {
  return db
    .select({
      notification: s.notifications,
      alert: s.alerts,
      userEmail: s.users.email,
      contactEmail: s.contacts.email,
    })
    .from(s.notifications)
    .innerJoin(s.alerts, eq(s.alerts.id, s.notifications.alertId))
    .leftJoin(s.users, eq(s.users.id, s.alerts.userId))
    .leftJoin(s.contacts, eq(s.contacts.id, s.alerts.contactId))
    .where(and(eq(s.notifications.state, "queued"), sql`${s.notifications.expiresAt} > ${now}`, sql`${s.users.deletedAt} IS NULL`))
    .orderBy(asc(s.alerts.priority), asc(s.notifications.createdAt))
    .limit(limit);
}

export async function markNotification(
  db: Db,
  id: string,
  state: "sent" | "failed" | "suppressed" | "expired",
  now: number,
  errorClass?: string,
): Promise<void> {
  await db
    .update(s.notifications)
    .set({
      state,
      sentAt: state === "sent" ? now : null,
      attempts: sql`${s.notifications.attempts} + 1`,
      lastError: errorClass ? errorClass.slice(0, 200) : null,
      updatedAt: now,
    })
    .where(eq(s.notifications.id, id));
}

/** A transient send failure keeps the notification queued until it expires. */
export async function recordNotificationAttempt(db: Db, id: string, errorClass: string, now: number): Promise<void> {
  await db
    .update(s.notifications)
    .set({ attempts: sql`${s.notifications.attempts} + 1`, lastError: errorClass.slice(0, 200), updatedAt: now })
    .where(eq(s.notifications.id, id));
}

export async function expireNotifications(db: Db, now: number): Promise<void> {
  await db
    .update(s.notifications)
    .set({ state: "expired", updatedAt: now })
    .where(and(eq(s.notifications.state, "queued"), lt(s.notifications.expiresAt, now)));
}

// =============================================================================================
// Preferences
// =============================================================================================

export const DEFAULT_NOTIFICATION_PREFS: NotificationPrefs = {
  weeklyEmail: true,
  weeklyDay: null,
  quietHoursStart: PRODUCT.email.quietHours[0],
  quietHoursEnd: PRODUCT.email.quietHours[1],
  examPauseUntil: null,
  channels: { email: true, inApp: true, push: false },
};

export async function getNotificationPrefs(db: Db, userId: string): Promise<NotificationPrefs> {
  const row = await db.query.notificationPrefs.findFirst({ where: eq(s.notificationPrefs.userId, userId) });
  if (!row) return DEFAULT_NOTIFICATION_PREFS;
  return {
    weeklyEmail: row.weeklyEmail,
    weeklyDay: row.weeklyDay,
    quietHoursStart: row.quietHoursStart,
    quietHoursEnd: row.quietHoursEnd,
    examPauseUntil: row.examPauseUntil,
    channels: { email: row.channelEmail, inApp: row.channelInApp, push: row.channelPush },
  };
}

export async function saveNotificationPrefs(db: Db, userId: string, prefs: NotificationPrefs, now: number): Promise<void> {
  const values = {
    weeklyEmail: prefs.weeklyEmail,
    weeklyDay: prefs.weeklyDay,
    quietHoursStart: prefs.quietHoursStart,
    quietHoursEnd: prefs.quietHoursEnd,
    examPauseUntil: prefs.examPauseUntil,
    channelEmail: prefs.channels.email,
    channelInApp: prefs.channels.inApp,
    channelPush: prefs.channels.push,
    updatedAt: now,
  };
  await db.insert(s.notificationPrefs).values({ userId, ...values }).onConflictDoUpdate({ target: s.notificationPrefs.userId, set: values });
}

// =============================================================================================
// Contacts and Remind-me
// =============================================================================================

export interface ContactInput {
  email: string;
  emailHmac: string;
  hmacKeyId: string;
  /** Unconfirmed contacts are deleted after 7 days (retention class remind_me). */
  deleteAfter: number;
}

export async function upsertContact(db: Db, input: ContactInput, now: number): Promise<string> {
  const existing = await db.query.contacts.findFirst({ where: and(eq(s.contacts.emailHmac, input.emailHmac), eq(s.contacts.hmacKeyId, input.hmacKeyId)) });
  if (existing) return existing.id;
  const id = uuidv7(now);
  await db
    .insert(s.contacts)
    .values({ id, email: input.email, emailHmac: input.emailHmac, hmacKeyId: input.hmacKeyId, deleteAfter: input.deleteAfter, createdAt: now })
    .onConflictDoNothing();
  const row = await db.query.contacts.findFirst({ where: and(eq(s.contacts.emailHmac, input.emailHmac), eq(s.contacts.hmacKeyId, input.hmacKeyId)) });
  return row?.id ?? id;
}

export async function confirmContact(db: Db, contactId: string, now: number, deleteAfter: number | null): Promise<void> {
  await db.update(s.contacts).set({ confirmedAt: now, deleteAfter }).where(eq(s.contacts.id, contactId));
}

export async function isSuppressed(db: Db, emailHmacs: readonly { hmac: string; keyId: string }[]): Promise<boolean> {
  for (const h of emailHmacs) {
    const row = await db.query.emailSuppressions.findFirst({ where: and(eq(s.emailSuppressions.emailHmac, h.hmac), eq(s.emailSuppressions.keyId, h.keyId)) });
    if (row) return true;
  }
  return false;
}

export async function suppressEmail(db: Db, hmac: string, keyId: string, reason: "unsubscribe" | "bounce" | "complaint" | "manual", now: number): Promise<void> {
  await db.insert(s.emailSuppressions).values({ emailHmac: hmac, keyId, reason, createdAt: now }).onConflictDoNothing();
}

/**
 * A Remind-me subscription for a user or a contact. The audience trigger refuses a status- or
 * identity-defined program without consent (`consent_required`); the route then offers the
 * official link instead.
 */
export async function subscribe(
  db: Db,
  input: { userId?: string | null; contactId?: string | null; kind: "remind_me" | "tracked_cycle"; programCycleId: string; nameInMessages?: boolean; deleteAfter?: number | null },
  now: number,
): Promise<RepoResult<string>> {
  const id = uuidv7(now);
  try {
    await db
      .insert(s.subscriptions)
      .values({
        id,
        userId: input.userId ?? null,
        contactId: input.contactId ?? null,
        kind: input.kind,
        programCycleId: input.programCycleId,
        nameInMessages: input.nameInMessages ?? true,
        deleteAfter: input.deleteAfter ?? null,
        createdAt: now,
      })
      .onConflictDoNothing();
    return ok(id);
  } catch (err) {
    return classifyWriteError(err);
  }
}

export async function unsubscribe(db: Db, subscriptionId: string): Promise<void> {
  await db.delete(s.subscriptions).where(eq(s.subscriptions.id, subscriptionId));
}

/** Remind-me rows are kept until their cycle closes plus this long (plan 09 retention table). */
export const REMIND_ME_RETENTION_MS = 30 * 86_400_000;

/**
 * Contacts that are gone: past `delete_after` (unconfirmed for 7 days), or confirmed with no
 * subscription left ("an address goes with its last Subscription", plan 09). Never a contact
 * linked to an account. A confirmed contact asking again gets a fresh `delete_after`, so it is
 * not removed while its new link is live.
 */
function goneContacts(db: Db, now: number) {
  return db
    .select({ id: s.contacts.id })
    .from(s.contacts)
    .where(
      and(
        isNull(s.contacts.userId),
        sql`(${s.contacts.deleteAfter} <= ${now} OR (${s.contacts.deleteAfter} IS NULL AND NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.contact_id = contacts.id)))`,
      ),
    );
}

/** Deletes the given contacts with their alerts, notifications, subscriptions and consents. */
function contactPurgeStatements(db: Db, contacts: ReturnType<typeof goneContacts>): Stmt[] {
  const contactAlerts = db.select({ id: s.alerts.id }).from(s.alerts).where(inArray(s.alerts.contactId, contacts));
  return [
    db.delete(s.notifications).where(inArray(s.notifications.alertId, contactAlerts)),
    db.delete(s.alerts).where(inArray(s.alerts.contactId, contacts)),
    db.delete(s.subscriptions).where(inArray(s.subscriptions.contactId, contacts)),
    db.delete(s.consents).where(inArray(s.consents.contactId, contacts)),
    db.delete(s.contacts).where(inArray(s.contacts.id, contacts)),
  ];
}

/**
 * Retention sweep (plan 09: `remind_me` unconfirmed 7 days, else cycle close + 30 days; an
 * address goes with its last Subscription):
 *   1. rows past their own `delete_after`;
 *   2. contacts' Remind-me subscriptions whose cycle closed (or ended) 30 days ago, or whose last
 *      live deadline passed 30 days ago. Computed at sweep time, so an extension keeps them;
 *   3. contacts left with nothing, with their alerts, notifications and consents.
 * One batch: statement 3's set is read after 1 and 2 ran.
 */
export async function sweepExpiredContacts(db: Db, now: number): Promise<void> {
  const cutoff = now - REMIND_ME_RETENTION_MS;
  const cutoffDay = new Date(cutoff).toISOString().slice(0, 10);
  await runBatch(db, [
    db.delete(s.subscriptions).where(sql`${s.subscriptions.deleteAfter} <= ${now}`),
    db.delete(s.subscriptions).where(
      and(
        sql`${s.subscriptions.contactId} IS NOT NULL`,
        eq(s.subscriptions.kind, "remind_me"),
        sql`EXISTS (SELECT 1 FROM program_cycles c WHERE c.id = subscriptions.program_cycle_id AND (
          (c.status IN ('closed', 'ended') AND c.status_changed_at <= ${cutoff})
          OR (EXISTS (SELECT 1 FROM deadlines d WHERE d.program_cycle_id = c.id AND d.withdrawn_at IS NULL AND d.local_date IS NOT NULL)
              AND NOT EXISTS (SELECT 1 FROM deadlines d WHERE d.program_cycle_id = c.id AND d.withdrawn_at IS NULL
                AND (d.local_date IS NULL OR substr(d.local_date || '-31', 1, 10) >= ${cutoffDay} OR d.due_at > ${cutoff})))
        ))`,
      ),
    ),
    ...contactPurgeStatements(db, goneContacts(db, now)),
  ]);
}

/**
 * Removes one contact entirely when it has no subscription left (after an unsubscribe), in one
 * batch with everything that names it. A contact still holding a subscription, or linked to an
 * account, is left alone.
 */
export function purgeContactIfEmptyStatements(db: Db, contactId: string): Stmt[] {
  const target = db
    .select({ id: s.contacts.id })
    .from(s.contacts)
    .where(and(eq(s.contacts.id, contactId), isNull(s.contacts.userId), sql`NOT EXISTS (SELECT 1 FROM subscriptions x WHERE x.contact_id = contacts.id)`));
  return contactPurgeStatements(db, target);
}

// =============================================================================================
// Calendar feeds (hashed, rotatable, revocable tokens)
// =============================================================================================

export async function createCalendarFeed(db: Db, userId: string, tokenHash: string, neutralTitles: boolean, now: number): Promise<string> {
  const id = uuidv7(now);
  await db.insert(s.calendarFeeds).values({ id, userId, tokenHash, neutralTitles, createdAt: now });
  return id;
}

/** Revokes the user's live feeds and creates a new one in one batch. */
export async function rotateCalendarFeed(db: Db, userId: string, tokenHash: string, neutralTitles: boolean, now: number): Promise<string> {
  const id = uuidv7(now);
  await runBatch(db, [
    db.update(s.calendarFeeds).set({ revokedAt: now }).where(and(eq(s.calendarFeeds.userId, userId), isNull(s.calendarFeeds.revokedAt))),
    db.insert(s.calendarFeeds).values({ id, userId, tokenHash, neutralTitles, createdAt: now }),
  ]);
  return id;
}

export async function findCalendarFeed(db: Db, tokenHash: string) {
  const rows = await db
    .select({ feed: s.calendarFeeds })
    .from(s.calendarFeeds)
    .innerJoin(s.users, eq(s.users.id, s.calendarFeeds.userId))
    .where(and(eq(s.calendarFeeds.tokenHash, tokenHash), isNull(s.calendarFeeds.revokedAt), isNull(s.users.deletedAt)))
    .limit(1);
  return rows[0]?.feed ?? null;
}

export async function revokeCalendarFeeds(db: Db, userId: string, now: number): Promise<void> {
  await db.update(s.calendarFeeds).set({ revokedAt: now }).where(and(eq(s.calendarFeeds.userId, userId), isNull(s.calendarFeeds.revokedAt)));
}

// =============================================================================================
// Email action tokens (single use)
// =============================================================================================

export async function createEmailActionToken(
  db: Db,
  input: { tokenHash: string; userId: string; trackerItemId: string; action: "mark_submitted" | "not_applying" | "snooze"; expiresAt: number },
  now: number,
): Promise<void> {
  await db.insert(s.emailActionTokens).values({ ...input, createdAt: now });
}

/** Consumes a token exactly once; null when unknown, used or expired. */
export async function consumeEmailActionToken(db: Db, tokenHash: string, now: number) {
  const rows = await db
    .update(s.emailActionTokens)
    .set({ usedAt: now })
    .where(and(eq(s.emailActionTokens.tokenHash, tokenHash), isNull(s.emailActionTokens.usedAt), sql`${s.emailActionTokens.expiresAt} > ${now}`))
    .returning();
  return rows[0] ?? null;
}
