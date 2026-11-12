import { and, asc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import type { NotificationPrefs } from "@shared/contracts/events";
import type { ProgressEntry } from "@shared/readiness";
import type { Db } from "@server/db/client";
import { uuidv7 } from "@server/db/columns";
import { notifications, registry } from "@server/db/repos";
import { jsonIds, runBatch } from "@server/db/repos/common";
import { DEFAULT_NOTIFICATION_PREFS, notificationKey, type AlertInsert } from "@server/db/repos/notifications";
import * as s from "@server/db/schema";
import type { CycleInfo, FollowedCycle, StepReminderRow } from "./plan";

/**
 * D1 reads and writes for reminders.schedule and digest.send. Set-based: one query per table per
 * run, ids passed through json_each so D1's 100-parameter limit never applies. Joined selects
 * are not put in db.batch(): batched rows come back keyed by bare column name, so two joined
 * tables' `id` or `email` columns would overwrite each other. Reads public
 * registry facts and the recipient's own settings only; nothing here sees SensitiveAnswers.
 */

export interface AudienceRow {
  readonly recipientKey: string;
  readonly userId: string | null;
  readonly contactId: string | null;
  readonly email: string | null;
  readonly contactHmac: { readonly hmac: string; readonly keyId: string } | null;
  readonly followed: FollowedCycle[];
}

/**
 * Who follows what: live tracker items still being prepared (interested, applying), account
 * Remind-me subscriptions for cycles they do not track, and confirmed contacts' Remind-me
 * subscriptions. A tracked cycle's status wins over a subscription to the same cycle, so
 * "Submitted" and "Not applying" stop every reminder for it.
 */
export async function loadAudience(db: Db): Promise<AudienceRow[]> {
  const [trackers, subs] = await Promise.all([
    db
      .select({
        id: s.trackerItems.id,
        userId: s.trackerItems.userId,
        cycleId: s.trackerItems.programCycleId,
        status: s.trackerItems.status,
        ownCampusDeadline: s.trackerItems.ownCampusDeadline,
        nameInMessages: s.trackerItems.nameInMessages,
        createdAt: s.trackerItems.createdAt,
        email: s.users.email,
      })
      .from(s.trackerItems)
      .innerJoin(s.users, eq(s.users.id, s.trackerItems.userId))
      .where(and(isNull(s.trackerItems.deletedAt), isNull(s.users.deletedAt)))
      .orderBy(asc(s.trackerItems.userId)),
    db
      .select({
        userId: s.subscriptions.userId,
        contactId: s.subscriptions.contactId,
        cycleId: s.subscriptions.programCycleId,
        nameInMessages: s.subscriptions.nameInMessages,
        createdAt: s.subscriptions.createdAt,
        userEmail: s.users.email,
        userDeletedAt: s.users.deletedAt,
        contactEmail: s.contacts.email,
        contactHmac: s.contacts.emailHmac,
        contactKeyId: s.contacts.hmacKeyId,
        confirmedAt: s.contacts.confirmedAt,
      })
      .from(s.subscriptions)
      .leftJoin(s.users, eq(s.users.id, s.subscriptions.userId))
      .leftJoin(s.contacts, eq(s.contacts.id, s.subscriptions.contactId))
      .where(and(sql`${s.subscriptions.kind} IN ('remind_me', 'tracked_cycle')`, isNotNull(s.subscriptions.programCycleId), isNull(s.subscriptions.deleteAfter))),
  ]);

  const byKey = new Map<string, AudienceRow>();
  const tracked = new Set<string>();
  const row = (key: string, init: () => AudienceRow) => {
    let r = byKey.get(key);
    if (!r) {
      r = init();
      byKey.set(key, r);
    }
    return r;
  };
  for (const t of trackers) {
    tracked.add(`${t.userId}|${t.cycleId}`);
    if (t.status !== "interested" && t.status !== "applying") continue;
    row(`u:${t.userId}`, () => ({ recipientKey: `u:${t.userId}`, userId: t.userId, contactId: null, email: t.email, contactHmac: null, followed: [] })).followed.push({
      cycleId: t.cycleId,
      trackerItemId: t.id,
      ownCampusDeadline: t.ownCampusDeadline,
      nameInMessages: t.nameInMessages,
      followedAt: t.createdAt,
    });
  }
  for (const sub of subs) {
    if (!sub.cycleId) continue;
    if (sub.userId) {
      if (sub.userDeletedAt !== null || tracked.has(`${sub.userId}|${sub.cycleId}`)) continue;
      const r = row(`u:${sub.userId}`, () => ({ recipientKey: `u:${sub.userId}`, userId: sub.userId, contactId: null, email: sub.userEmail, contactHmac: null, followed: [] }));
      if (r.followed.some((f) => f.cycleId === sub.cycleId)) continue;
      r.followed.push({ cycleId: sub.cycleId, trackerItemId: null, ownCampusDeadline: null, nameInMessages: sub.nameInMessages, followedAt: sub.createdAt });
    } else if (sub.contactId && sub.confirmedAt !== null) {
      const r = row(`c:${sub.contactId}`, () => ({
        recipientKey: `c:${sub.contactId}`,
        userId: null,
        contactId: sub.contactId,
        email: sub.contactEmail,
        contactHmac: sub.contactHmac && sub.contactKeyId ? { hmac: sub.contactHmac, keyId: sub.contactKeyId } : null,
        followed: [],
      }));
      if (r.followed.some((f) => f.cycleId === sub.cycleId)) continue;
      r.followed.push({ cycleId: sub.cycleId, trackerItemId: null, ownCampusDeadline: null, nameInMessages: sub.nameInMessages, followedAt: sub.createdAt });
    }
  }
  return [...byKey.values()].sort((a, b) => (a.recipientKey < b.recipientKey ? -1 : 1));
}

export interface UserSettings {
  readonly profileZone: string | null;
  readonly institutionZone: string | null;
  readonly institutionId: string | null;
  readonly prefs: NotificationPrefs;
}

/** Profile zone, Institution and its zone, and notification preferences per account. */
export async function loadUserSettings(db: Db, userIds: readonly string[]): Promise<Map<string, UserSettings>> {
  const out = new Map<string, UserSettings>();
  if (userIds.length === 0) return out;
  const ids = jsonIds(userIds);
  const [profiles, prefs] = await Promise.all([
    db
      .select({ userId: s.studentProfiles.userId, timeZone: s.studentProfiles.timeZone, institutionId: s.studentProfiles.institutionId, institutionZone: s.institutions.timeZone })
      .from(s.studentProfiles)
      .leftJoin(s.institutions, eq(s.institutions.id, s.studentProfiles.institutionId))
      .where(sql`${s.studentProfiles.userId} IN ${ids}`),
    db.select().from(s.notificationPrefs).where(sql`${s.notificationPrefs.userId} IN ${ids}`),
  ]);
  const profileBy = new Map(profiles.map((p) => [p.userId, p]));
  const prefsBy = new Map(prefs.map((p) => [p.userId, p]));
  for (const id of userIds) {
    const p = profileBy.get(id);
    const r = prefsBy.get(id);
    out.set(id, {
      profileZone: p?.timeZone ?? null,
      institutionZone: p?.institutionZone ?? null,
      institutionId: p?.institutionId ?? null,
      prefs: r
        ? {
            weeklyEmail: r.weeklyEmail,
            weeklyDay: r.weeklyDay,
            quietHoursStart: r.quietHoursStart,
            quietHoursEnd: r.quietHoursEnd,
            examPauseUntil: r.examPauseUntil,
            channels: { email: r.channelEmail, inApp: r.channelInApp, push: r.channelPush },
          }
        : DEFAULT_NOTIFICATION_PREFS,
    });
  }
  return out;
}

/** Published cycles with their live deadlines and requirements (public registry data only). */
export async function loadCycleInfos(db: Db, cycleIds: readonly string[]): Promise<Map<string, CycleInfo>> {
  const out = new Map<string, CycleInfo>();
  if (cycleIds.length === 0) return out;
  const ids = jsonIds(cycleIds);
  const [rows, requirementRows] = await Promise.all([
    db
      .select({ cycle: s.programCycles, program: s.programs })
      .from(s.programCycles)
      .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
      .where(and(sql`${s.programCycles.id} IN ${ids}`, eq(s.programs.isPublished, true))),
    db
      .select()
      .from(s.requirements)
      .where(and(sql`${s.requirements.programCycleId} IN ${ids}`, isNull(s.requirements.withdrawnAt)))
      .orderBy(asc(s.requirements.sortOrder)),
  ]);
  const deadlines = await registry.listLiveDeadlines(db, cycleIds);
  const requirements = requirementRows.map((r) => registry.toRequirement(r, null));
  for (const { cycle, program } of rows) {
    const n = program.campusLeadN ?? 0;
    out.set(cycle.id, {
      cycleId: cycle.id,
      programName: program.name,
      programSlug: program.slug,
      termLabel: cycle.termLabel,
      officialUrl: program.officialUrl,
      sensitiveAudience: program.sensitiveAudience,
      identityAudience: program.identityAudience,
      isSample: program.isSample,
      deadlines: deadlines.filter((d) => d.programCycleId === cycle.id),
      requirements: requirements.filter((r) => r.programCycleId === cycle.id),
      // Known lead times only once five campus deadlines are known (plan 6.4.5); else defaults.
      campusLead:
        n >= 5 && program.campusLeadDays !== null && program.campusLeadMedianDays !== null
          ? { l80Days: program.campusLeadDays, l50Days: program.campusLeadMedianDays }
          : null,
    });
  }
  return out;
}

/** Requirement progress per account (`req:` and `kind:` subjects), for the weekly email. */
export async function loadProgress(db: Db, userIds: readonly string[]): Promise<Map<string, ProgressEntry[]>> {
  const out = new Map<string, ProgressEntry[]>();
  if (userIds.length === 0) return out;
  const rows = await db
    .select({ userId: s.requirementProgress.userId, subjectKey: s.requirementProgress.subjectKey, state: s.requirementProgress.state })
    .from(s.requirementProgress)
    .where(and(sql`${s.requirementProgress.userId} IN ${jsonIds(userIds)}`, isNull(s.requirementProgress.deletedAt)));
  for (const r of rows) {
    const list = out.get(r.userId) ?? [];
    list.push({ subjectKey: r.subjectKey, state: r.state as ProgressEntry["state"] });
    out.set(r.userId, list);
  }
  return out;
}

/** Existing reminder Alerts by (recipient, dedupe key), so a run only writes new ones. */
export async function existingDedupeKeys(db: Db, recipientKeys: readonly string[], prefixes: readonly string[], since: number): Promise<Set<string>> {
  const out = new Set<string>();
  if (recipientKeys.length === 0) return out;
  const like = prefixes.map((p) => sql`${s.alerts.dedupeKey} LIKE ${`${p}%`}`);
  const rows = await db
    .select({ recipientKey: s.alerts.recipientKey, dedupeKey: s.alerts.dedupeKey })
    .from(s.alerts)
    .where(and(sql`${s.alerts.recipientKey} IN ${jsonIds(recipientKeys)}`, sql`${s.alerts.createdAt} >= ${since}`, sql`(${sql.join(like, sql` OR `)})`));
  for (const r of rows) out.add(`${r.recipientKey}|${r.dedupeKey}`);
  return out;
}

/** Inserts reminder Alerts; on a refused batch (a consent revoked mid-run) retries one by one. */
export async function insertReminderAlerts(db: Db, rows: readonly AlertInsert[], now: number): Promise<number> {
  if (rows.length === 0) return 0;
  const res = await notifications.insertAlerts(db, rows, now);
  if (res.ok) return rows.length;
  let n = 0;
  for (const row of rows) {
    const one = await notifications.insertAlerts(db, [row], now);
    if (one.ok) n++;
  }
  return n;
}

// =============================================================================================
// First-door plan steps
// =============================================================================================

export interface StepReminderJoined {
  readonly row: StepReminderRow;
  readonly userId: string;
  readonly cycleId: string | null;
  readonly trackerStatus: string | null;
  readonly nameInMessages: boolean;
  readonly firstDoor: Record<string, unknown> | null;
}

/** Scheduled step reminders whose local day is on or before `untilDate`, with their tracker item. */
export async function dueStepReminders(db: Db, untilDate: string, limit: number): Promise<StepReminderJoined[]> {
  const rows = await db
    .select({
      r: s.reminders,
      status: s.trackerItems.status,
      deletedAt: s.trackerItems.deletedAt,
      cycleId: s.trackerItems.programCycleId,
      nameInMessages: s.trackerItems.nameInMessages,
      userDeletedAt: s.users.deletedAt,
      firstDoor: s.onboardingRecords.firstDoor,
    })
    .from(s.reminders)
    .innerJoin(s.users, eq(s.users.id, s.reminders.userId))
    .leftJoin(s.trackerItems, eq(s.trackerItems.id, s.reminders.trackerItemId))
    .leftJoin(s.onboardingRecords, eq(s.onboardingRecords.userId, s.reminders.userId))
    .where(and(eq(s.reminders.state, "scheduled"), sql`${s.reminders.sendOn} <= ${untilDate}`))
    .orderBy(asc(s.reminders.sendOn))
    .limit(limit);
  return rows
    .filter((x) => x.userDeletedAt === null)
    .map((x) => ({
      row: {
        id: x.r.id,
        reminderKey: x.r.reminderKey,
        kind: x.r.kind as StepReminderRow["kind"],
        stepId: x.r.stepId,
        sendOn: x.r.sendOn,
        sendAt: x.r.sendAt,
        timeZone: x.r.timeZone,
        neutral: x.r.neutral,
      },
      userId: x.r.userId,
      cycleId: x.cycleId ?? null,
      trackerStatus: x.deletedAt === null && x.status ? x.status : null,
      nameInMessages: x.nameInMessages ?? false,
      firstDoor: x.firstDoor ?? null,
    }));
}

/** The title onboarding gave a plan step, from the first-door JSON; null when absent. */
export function stepTitleFrom(firstDoor: Record<string, unknown> | null, stepId: string): string | null {
  const steps = firstDoor && Array.isArray(firstDoor.steps) ? (firstDoor.steps as unknown[]) : [];
  for (const step of steps) {
    if (step && typeof step === "object" && (step as { id?: unknown }).id === stepId) {
      const title = (step as { title?: unknown }).title;
      return typeof title === "string" ? title : null;
    }
  }
  return null;
}

export async function markStepReminders(db: Db, updates: readonly { id: string; state: "sent" | "cancelled" }[], now: number): Promise<void> {
  if (updates.length === 0) return;
  await runBatch(
    db,
    updates.map((u) => db.update(s.reminders).set({ state: u.state, sentAt: u.state === "sent" ? now : null, updatedAt: now }).where(eq(s.reminders.id, u.id))),
  );
}

// =============================================================================================
// Weekly email
// =============================================================================================

export interface DigestChangeRow {
  readonly notificationId: string;
  readonly recipientKey: string;
  readonly title: string;
  readonly body: string;
  readonly href: string | null;
}

/** Change Alerts that waited for the weekly email (digest-stream Notifications still queued). */
export async function queuedDigestChanges(db: Db, recipientKeys: readonly string[], now: number): Promise<Map<string, DigestChangeRow[]>> {
  const out = new Map<string, DigestChangeRow[]>();
  if (recipientKeys.length === 0) return out;
  const rows = await db
    .select({ notificationId: s.notifications.id, recipientKey: s.alerts.recipientKey, title: s.alerts.title, body: s.alerts.body, href: s.alerts.href })
    .from(s.notifications)
    .innerJoin(s.alerts, eq(s.alerts.id, s.notifications.alertId))
    .where(
      and(
        eq(s.notifications.channel, "email"),
        eq(s.notifications.stream, "digest"),
        eq(s.notifications.state, "queued"),
        sql`${s.notifications.expiresAt} > ${now}`,
        sql`${s.alerts.dedupeKey} NOT LIKE 'weekly:%'`,
        sql`${s.alerts.recipientKey} IN ${jsonIds(recipientKeys)}`,
      ),
    )
    .orderBy(asc(s.alerts.createdAt));
  for (const r of rows) {
    const list = out.get(r.recipientKey) ?? [];
    list.push(r);
    out.set(r.recipientKey, list);
  }
  return out;
}

export const WEEKLY_PREFIX = "weekly:";

export interface WeeklyRecord {
  readonly alertId: string;
  readonly notificationId: string;
  readonly state: string;
}

/**
 * The weekly email's record: one Alert per recipient and ISO week (it also appears in the
 * notification center) plus its digest-stream email Notification, inserted in one batch so
 * notify.dispatch never sees the Alert without its Notification (and never sends it itself).
 * Re-running for the same week returns the existing record. If another run inserted the Alert
 * first, this batch fails on the Notification's foreign key and rolls back; the re-read below
 * then finds the other run's record.
 */
export async function ensureWeeklyRecord(
  db: Db,
  input: { userId: string | null; contactId: string | null; recipientKey: string; weekKey: string; title: string; body: string; expiresAt: number },
  now: number,
): Promise<WeeklyRecord | null> {
  const dedupeKey = `${WEEKLY_PREFIX}${input.weekKey}`;
  const read = async () => {
    const rows = await db
      .select({ alertId: s.alerts.id, notificationId: s.notifications.id, state: s.notifications.state })
      .from(s.alerts)
      .innerJoin(s.notifications, eq(s.notifications.alertId, s.alerts.id))
      .where(and(eq(s.alerts.recipientKey, input.recipientKey), eq(s.alerts.dedupeKey, dedupeKey), eq(s.notifications.channel, "email")))
      .limit(1);
    return rows[0] ?? null;
  };
  const existing = await read();
  if (existing) return existing;
  const alertId = uuidv7(now);
  try {
    await runBatch(db, [
      db
        .insert(s.alerts)
        .values({
          id: alertId,
          type: "deadline.reminder",
          userId: input.userId,
          contactId: input.contactId,
          recipientKey: input.recipientKey,
          programCycleId: null,
          changeEventId: null,
          dedupeKey,
          priority: "p2",
          title: input.title.slice(0, 200),
          body: input.body.slice(0, 1000),
          href: "/app/tracker",
          scheduledFor: now,
          createdAt: now,
        })
        .onConflictDoNothing(),
      db
        .insert(s.notifications)
        .values({
          id: uuidv7(now),
          alertId,
          channel: "email",
          stream: "digest",
          idempotencyKey: notificationKey(alertId, "email"),
          state: "queued",
          expiresAt: input.expiresAt,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing(),
    ]);
  } catch {
    // Lost a race with another run (see above); its record is read back below.
  }
  return read();
}

/** State of each recipient's weekly-email Notification for the given ISO weeks, keyed `{recipientKey}|{weekKey}`. */
export async function weeklyStates(db: Db, recipientKeys: readonly string[], weekKeys: readonly string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  if (recipientKeys.length === 0 || weekKeys.length === 0) return out;
  const rows = await db
    .select({ recipientKey: s.alerts.recipientKey, dedupeKey: s.alerts.dedupeKey, state: s.notifications.state })
    .from(s.alerts)
    .innerJoin(s.notifications, eq(s.notifications.alertId, s.alerts.id))
    .where(
      and(
        sql`${s.alerts.recipientKey} IN ${jsonIds(recipientKeys)}`,
        sql`${s.alerts.dedupeKey} IN ${jsonIds(weekKeys.map((w) => `${WEEKLY_PREFIX}${w}`))}`,
        eq(s.notifications.channel, "email"),
      ),
    );
  for (const r of rows) out.set(`${r.recipientKey}|${r.dedupeKey.slice(WEEKLY_PREFIX.length)}`, r.state);
  return out;
}

/**
 * Records the T−2 reminders a sent weekly email carried, each as an Alert under the T−2's own
 * dedupe key with an email Notification already `sent` on the digest stream, so notify.dispatch
 * never sends it again and reminders.schedule sees it as done. One batch per reminder: if the
 * Alert already exists (a separate send won a race), its batch fails and nothing changes.
 */
export async function recordCarriedReminders(
  db: Db,
  recipient: { userId: string | null; contactId: string | null },
  drafts: readonly { dedupeKey: string; programCycleId: string; title: string; body: string; href: string; scheduledFor: number }[],
  now: number,
): Promise<number> {
  let n = 0;
  for (const d of drafts) {
    const alertId = uuidv7(now);
    const recipientKey = recipient.userId ? `u:${recipient.userId}` : `c:${recipient.contactId}`;
    try {
      await runBatch(db, [
        db.insert(s.alerts).values({
          id: alertId,
          type: "deadline.reminder",
          userId: recipient.userId,
          contactId: recipient.userId ? null : recipient.contactId,
          recipientKey,
          programCycleId: d.programCycleId || null,
          changeEventId: null,
          dedupeKey: d.dedupeKey,
          priority: "p1",
          title: d.title.slice(0, 200),
          body: d.body.slice(0, 1000),
          href: d.href,
          scheduledFor: d.scheduledFor,
          createdAt: now,
        }),
        db.insert(s.notifications).values({
          id: uuidv7(now),
          alertId,
          channel: "email",
          stream: "digest",
          idempotencyKey: notificationKey(alertId, "email"),
          state: "sent",
          sentAt: now,
          expiresAt: now,
          createdAt: now,
          updatedAt: now,
        }),
      ]);
      n++;
    } catch {
      // Already recorded (or refused by an audience guard after a consent was revoked): skip.
    }
  }
  return n;
}

