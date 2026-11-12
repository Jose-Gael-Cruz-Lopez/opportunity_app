import { and, eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { isoWeekday } from "@shared/time/iso";
import { notifications, onboarding, students } from "@server/db/repos";
import { DEFAULT_NOTIFICATION_PREFS } from "@server/db/repos/notifications";
import * as s from "@server/db/schema";
import { createUser, freshEventsDb, seededDb } from "@server/db/testing/fixtures";
import { Budget } from "@server/jobs/budget";
import { silentLogger } from "@server/jobs/types";
import { createDryRunProvider, dispatchNotifications, verifyUnsubscribeToken } from "@server/services/email";
import { runDigestSend } from "./digest";
import { spreadWeekday } from "./policy";
import { runRemindersSchedule } from "./schedule";

// Integration tests on real SQLite with the committed migrations and the sample seed. Every
// program is sample data; the address domains are reserved example domains.

const SECRET = "test-only-root-secret-0123456789abcdef0123";
const ORIGIN = "https://novus.example.org";
const HOUR = 3_600_000;
// Sample Job Shadow Week: national application deadline 23 Nov 2026, date only, America/Chicago.
const JOB_SHADOW = "Sample Job Shadow Week";
// Sat 21 Nov 2026, 09:00 CST: the T−2 send time.
const T2_AT = Date.UTC(2026, 10, 21, 15, 0);

const budget = (now: number) => new Budget({ ms: 60_000, calls: 2_000 }, () => now);

async function setup(opts: { weeklyDay?: number | null; weeklyEmail?: boolean; status?: "interested" | "applying" | "submitted"; program?: string } = {}) {
  const t = await seededDb();
  // The cycle that carries the program's dated deadline (programs also have past cycles).
  const [cycle] = await t.db
    .select({ id: s.programCycles.id })
    .from(s.programCycles)
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .innerJoin(s.deadlines, eq(s.deadlines.programCycleId, s.programCycles.id))
    .where(eq(s.programs.name, opts.program ?? JOB_SHADOW))
    .limit(1);
  if (!cycle) throw new Error("seed is missing the sample program");
  const userId = await createUser(t.db, "student@example.org");
  await t.db.insert(s.studentProfiles).values({ userId, timeZone: "America/Chicago", createdAt: 1, updatedAt: 1 });
  await notifications.saveNotificationPrefs(t.db, userId, { ...DEFAULT_NOTIFICATION_PREFS, weeklyEmail: opts.weeklyEmail ?? true, weeklyDay: opts.weeklyDay ?? 1 }, 1);
  const added = await students.addTrackerItem(t.db, userId, { programCycleId: cycle.id, status: opts.status ?? "interested", nameInMessages: true }, Date.UTC(2026, 10, 11));
  if (!added.ok) throw new Error(`tracker insert failed: ${added.error}`);
  return { ...t, userId, cycleId: cycle.id, trackerItemId: added.value.id };
}

async function reminderAlerts(t: Awaited<ReturnType<typeof setup>>) {
  return t.db.select().from(s.alerts).where(and(eq(s.alerts.userId, t.userId), eq(s.alerts.type, "deadline.reminder")));
}

describe("reminders.schedule", () => {
  it("writes one T−2 reminder at 09:00 local, idempotently, and notify.dispatch sends it", async () => {
    const t = await setup();
    const early = await runRemindersSchedule({ db: t.db, now: () => T2_AT - 3 * HOUR, budget: budget(T2_AT), log: silentLogger });
    expect(early.processed).toBe(0);

    const now = T2_AT - 30 * 60_000;
    const first = await runRemindersSchedule({ db: t.db, now: () => now, budget: budget(now), log: silentLogger });
    expect(first.outcome).toBe("ok");
    expect(first.processed).toBe(1);
    const again = await runRemindersSchedule({ db: t.db, now: () => now + HOUR, budget: budget(now), log: silentLogger });
    expect(again.processed).toBe(0);

    const alerts = await reminderAlerts(t);
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ scheduledFor: T2_AT, priority: "p1", programCycleId: t.cycleId });
    expect(alerts[0]!.dedupeKey).toMatch(/^t2:.+:2026-11-23$/);
    expect(alerts[0]!.title).toContain(JOB_SHADOW);
    expect(alerts[0]!.body).toContain("time not stated: plan to submit by 22 Nov 2026");

    // Not before its time: dispatch at 08:30 queues nothing; at 09:00 it sends with unsubscribe.
    const provider = createDryRunProvider();
    const { edb } = await freshEventsDb();
    const deps = { db: t.db, edb, provider, appOrigin: ORIGIN, secret: SECRET, budget: budget(now), log: silentLogger };
    await dispatchNotifications({ ...deps, now: () => now });
    expect(provider.sent).toHaveLength(0);
    await dispatchNotifications({ ...deps, now: () => T2_AT + 60_000 });
    expect(provider.sent).toHaveLength(1);
    const mail = provider.sent[0]!;
    expect(mail.to).toBe("student@example.org");
    expect(mail.subject).toContain("Due in 2 days");
    expect(mail.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
  });

  it("stops reminders once the application is submitted", async () => {
    const t = await setup({ status: "submitted" });
    const res = await runRemindersSchedule({ db: t.db, now: () => T2_AT, budget: budget(T2_AT), log: silentLogger });
    expect(res.processed).toBe(0);
    expect(await reminderAlerts(t)).toHaveLength(0);
  });

  it("leaves a T−2 on the weekly day to the weekly email", async () => {
    const t = await setup({ weeklyDay: isoWeekday("2026-11-21") });
    const res = await runRemindersSchedule({ db: t.db, now: () => T2_AT, budget: budget(T2_AT), log: silentLogger });
    expect(res.detail).toMatchObject({ merged: 1 });
    expect(await reminderAlerts(t)).toHaveLength(0);
  });

  it("sends first-door plan steps with their title and cancels them after submission", async () => {
    const t = await setup();
    await onboarding.saveOnboardingRecord(
      t.db,
      t.userId,
      { preferences: null, signals: null, step: "done", completedAt: 1, firstDoor: { programCycleId: t.cycleId, steps: [{ id: "s1", title: "Draft your short answer", kind: "essay", minutes: 30, due: "2026-11-21" }] } },
      1,
    );
    const write = { trackerItemId: t.trackerItemId, kind: "step_due" as const, sendOn: "2026-11-20", at: "18:00", timeZone: "America/Chicago", neutral: false };
    await onboarding.scheduleReminders(t.db, t.userId, [{ ...write, key: "fd:s1", stepId: "s1" }, { ...write, key: "fd:s2", stepId: "s2", sendOn: "2026-11-25" }], 1);
    const now = Date.UTC(2026, 10, 21, 0, 0); // 20 Nov 18:00 CST
    await runRemindersSchedule({ db: t.db, now: () => now, budget: budget(now), log: silentLogger });
    const rows = await t.db.select().from(s.reminders).where(eq(s.reminders.userId, t.userId));
    expect(rows.find((r) => r.reminderKey === "fd:s1")).toMatchObject({ state: "sent", sentAt: now });
    expect(rows.find((r) => r.reminderKey === "fd:s2")).toMatchObject({ state: "scheduled" });
    const alert = (await reminderAlerts(t)).find((a) => a.dedupeKey === "step:fd:s1");
    expect(alert?.title).toBe("Due tomorrow: Draft your short answer");

    await students.updateTrackerItem(t.db, t.userId, t.trackerItemId, { status: "submitted", version: 1 }, now);
    const later = Date.UTC(2026, 10, 26, 0, 0);
    await runRemindersSchedule({ db: t.db, now: () => later, budget: budget(later), log: silentLogger });
    const after = await t.db.select().from(s.reminders).where(eq(s.reminders.reminderKey, "fd:s2"));
    expect(after[0]?.state).toBe("cancelled");
  });

  it("reminds confirmed Remind-me contacts at 22:30 UTC and never unconfirmed ones", async () => {
    const t = await setup({ status: "submitted" });
    const confirmed = await notifications.upsertContact(t.db, { email: "visitor@example.net", emailHmac: "h1", hmacKeyId: "lookup-v1", deleteAfter: 1 }, 1);
    await notifications.confirmContact(t.db, confirmed, 2, null);
    const pending = await notifications.upsertContact(t.db, { email: "pending@example.net", emailHmac: "h2", hmacKeyId: "lookup-v1", deleteAfter: T2_AT + 99 * HOUR }, 1);
    await notifications.subscribe(t.db, { contactId: confirmed, kind: "remind_me", programCycleId: t.cycleId }, 3);
    await notifications.subscribe(t.db, { contactId: pending, kind: "remind_me", programCycleId: t.cycleId, deleteAfter: T2_AT + 99 * HOUR }, 3);
    const at = Date.UTC(2026, 10, 21, 22, 30);
    const res = await runRemindersSchedule({ db: t.db, now: () => at - 10 * 60_000, budget: budget(at), log: silentLogger });
    const alerts = await t.db.select().from(s.alerts).where(eq(s.alerts.type, "deadline.reminder"));
    // Contacts get the weekly email on their spread day; a T−2 on that day rides in it.
    if (spreadWeekday(confirmed) === isoWeekday("2026-11-21")) {
      expect(res.detail).toMatchObject({ merged: 1 });
      expect(alerts).toHaveLength(0);
    } else {
      expect(alerts.map((a) => a.recipientKey)).toEqual([`c:${confirmed}`]);
      expect(alerts[0]?.scheduledFor).toBe(at);
    }
  });
});

describe("digest.send", () => {
  // Sun 15 Nov 2026 (ISO weekday 7), 18:30 CST.
  const SUNDAY_EVENING = Date.UTC(2026, 10, 16, 0, 30);

  async function run(t: Awaited<ReturnType<typeof setup>>, now: number, edb?: Awaited<ReturnType<typeof freshEventsDb>>["edb"]) {
    const provider = createDryRunProvider();
    const res = await runDigestSend({ db: t.db, edb: edb ?? null, provider, appOrigin: ORIGIN, secret: SECRET, now: () => now, budget: budget(now), log: silentLogger });
    return { res, provider };
  }

  it("sends one weekly email at 18:00 local on the weekly day with one-click unsubscribe for the weekly list", async () => {
    const t = await setup({ weeklyDay: 7 });
    const { edb } = await freshEventsDb();
    const before = await run(t, SUNDAY_EVENING - HOUR, edb);
    expect(before.provider.sent).toHaveLength(0);

    const { res, provider } = await run(t, SUNDAY_EVENING, edb);
    expect(res.processed).toBe(1);
    const mail = provider.sent[0]!;
    expect(mail.stream).toBe("digest");
    expect(mail.idempotencyKey).toMatch(/^digest:[0-9a-f]{32}:2026-W46$/);
    expect(mail.idempotencyKey).not.toContain(t.userId);
    expect(mail.text).toContain(JOB_SHADOW);
    expect(mail.text).toContain("23 Nov 2026");
    expect(mail.subject).not.toContain(JOB_SHADOW);
    const url = /<(.+)>/.exec(mail.headers["List-Unsubscribe"] ?? "")?.[1] ?? "";
    const claims = await verifyUnsubscribeToken(SECRET, url.split("/e/u/")[1] ?? "", SUNDAY_EVENING);
    expect(claims).toMatchObject({ r: `u:${t.userId}`, l: "weekly" });

    // The record shows in the notification center, and the same week never sends twice.
    const inbox = await notifications.listInbox(t.db, t.userId, SUNDAY_EVENING, { limit: 10 });
    expect(inbox[0]?.title).toMatch(/^Your week ahead/);
    const again = await run(t, SUNDAY_EVENING + HOUR, edb);
    expect(again.provider.sent).toHaveLength(0);
    // notify.dispatch never sends the weekly record as its own email.
    const dispatchProvider = createDryRunProvider();
    await dispatchNotifications({ db: t.db, edb, provider: dispatchProvider, appOrigin: ORIGIN, secret: SECRET, now: () => SUNDAY_EVENING + HOUR, budget: budget(SUNDAY_EVENING), log: silentLogger });
    expect(dispatchProvider.sent).toHaveLength(0);
  });

  it("carries the week's changes and marks them sent", async () => {
    const t = await setup({ weeklyDay: 7 });
    await notifications.insertAlerts(
      t.db,
      [{ type: "eligibility.changed", userId: t.userId, programCycleId: t.cycleId, dedupeKey: "change:e1:eligibility.changed", priority: "p1", title: "Eligibility rules changed: Sample", body: "Open Novus to re-check.", href: "/programs/x", scheduledFor: SUNDAY_EVENING - 48 * HOUR }],
      SUNDAY_EVENING - 48 * HOUR,
    );
    const [alert] = await t.db.select().from(s.alerts).where(eq(s.alerts.dedupeKey, "change:e1:eligibility.changed"));
    await notifications.queueNotifications(t.db, [{ alertId: alert!.id, channel: "email", stream: "digest", expiresAt: SUNDAY_EVENING + 100 * HOUR }], SUNDAY_EVENING - 48 * HOUR);
    const { provider } = await run(t, SUNDAY_EVENING);
    expect(provider.sent[0]?.text).toContain("Eligibility rules changed: Sample");
    const [n] = await t.db.select().from(s.notifications).where(eq(s.notifications.alertId, alert!.id));
    expect(n?.state).toBe("sent");
  });

  it("merges a T−2 on the weekly day and sends at 09:00 local", async () => {
    const t = await setup({ weeklyDay: isoWeekday("2026-11-21") });
    const { provider } = await run(t, T2_AT + 5 * 60_000);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.subject).toBe("Due in 2 days, plus your next two weeks");
    expect(provider.sent[0]!.text).toContain("Due in 2 days");
  });

  it("records the T−2 it carried, so reminders.schedule never sends it again", async () => {
    const t = await setup({ weeklyDay: isoWeekday("2026-11-21") });
    const { provider } = await run(t, T2_AT + 5 * 60_000);
    expect(provider.sent).toHaveLength(1);
    const carried = await reminderAlerts(t);
    const t2 = carried.find((a) => a.dedupeKey.startsWith("t2:"));
    expect(t2).toBeDefined();
    const [n] = await t.db.select().from(s.notifications).where(eq(s.notifications.alertId, t2!.id));
    expect(n).toMatchObject({ state: "sent", stream: "digest" });
    const later = T2_AT + 3 * HOUR;
    const res = await runRemindersSchedule({ db: t.db, now: () => later, budget: budget(later), log: silentLogger });
    expect(res.processed).toBe(0);
    // notify.dispatch does not send the carried reminder on its own either.
    const dispatchProvider = createDryRunProvider();
    await dispatchNotifications({ db: t.db, edb: null, provider: dispatchProvider, appOrigin: ORIGIN, secret: SECRET, now: () => later, budget: budget(later), log: silentLogger });
    expect(dispatchProvider.sent).toHaveLength(0);
  });

  it("sends a merged T−2 on its own when the weekly email went without it (quiet hours moved it to the evening before)", async () => {
    // Quiet 21:00-10:00 moves the 09:00 Sat T−2 to Fri 20:30 CST; Friday is the weekly day.
    const t = await setup({ weeklyDay: isoWeekday("2026-11-20") });
    await notifications.saveNotificationPrefs(t.db, t.userId, { ...DEFAULT_NOTIFICATION_PREFS, weeklyEmail: true, weeklyDay: isoWeekday("2026-11-20"), quietHoursStart: "21:00", quietHoursEnd: "10:00" }, 2);
    const fridayWeekly = Date.UTC(2026, 10, 21, 0, 5); // Fri 18:05 CST: weekly window, T−2 not due yet
    const { provider } = await run(t, fridayWeekly);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.text).not.toContain("Due in 2 days");
    const now = Date.UTC(2026, 10, 21, 1, 40); // Fri 19:40 CST: the 20:30 T−2 is within the lookahead
    const res = await runRemindersSchedule({ db: t.db, now: () => now, budget: budget(now), log: silentLogger });
    expect(res.processed).toBe(1);
    const [t2] = (await reminderAlerts(t)).filter((a) => a.dedupeKey.startsWith("t2:"));
    expect(t2?.scheduledFor).toBe(Date.UTC(2026, 10, 21, 2, 30));
  });

  it("sends a merged T−2 on its own once the weekly email is overdue", async () => {
    const t = await setup({ weeklyDay: isoWeekday("2026-11-21") });
    const waiting = await runRemindersSchedule({ db: t.db, now: () => T2_AT + HOUR, budget: budget(T2_AT), log: silentLogger });
    expect(waiting.detail).toMatchObject({ merged: 1, written: 0 });
    const late = T2_AT + 2 * HOUR + 60_000;
    const res = await runRemindersSchedule({ db: t.db, now: () => late, budget: budget(late), log: silentLogger });
    expect(res.processed).toBe(1);
  });

  it("holds during quiet hours, skips when weekly email is off, and honours suppression", async () => {
    const quiet = await setup({ weeklyDay: 7 });
    expect((await run(quiet, Date.UTC(2026, 10, 16, 4, 30))).provider.sent).toHaveLength(0); // 22:30 CST

    const off = await setup({ weeklyDay: 7, weeklyEmail: false });
    expect((await run(off, SUNDAY_EVENING)).provider.sent).toHaveLength(0);

    const suppressed = await setup({ weeklyDay: 7 });
    const { emailLookupHmac } = await import("@server/services/email");
    const h = await emailLookupHmac(SECRET, "student@example.org");
    await notifications.suppressEmail(suppressed.db, h.hmac, h.keyId, "bounce", 1);
    const r = await run(suppressed, SUNDAY_EVENING);
    expect(r.provider.sent).toHaveLength(0);
    expect(r.res.detail).toMatchObject({ suppressed: 1 });
  });

  it("is skipped when nothing is due in the next two weeks", async () => {
    const t = await setup({ weeklyDay: 7, program: "Sample Engineering Co-op" }); // rolling: no dated deadline
    const { res, provider } = await run(t, SUNDAY_EVENING);
    expect(provider.sent).toHaveLength(0);
    expect(res.detail).toMatchObject({ empty: 1 });
  });

  it("defers without a secret, so no weekly email goes out without an unsubscribe link", async () => {
    const t = await setup({ weeklyDay: 7 });
    const provider = createDryRunProvider();
    const res = await runDigestSend({ db: t.db, edb: null, provider, appOrigin: ORIGIN, secret: null, now: () => SUNDAY_EVENING, budget: budget(SUNDAY_EVENING), log: silentLogger });
    expect(res.outcome).toBe("deferred");
    expect(provider.sent).toHaveLength(0);
  });

  it("sends contacts their weekly email at 22:30 UTC on their spread day", async () => {
    const t = await setup({ status: "submitted" });
    const contactId = await notifications.upsertContact(t.db, { email: "visitor@example.net", emailHmac: "h1", hmacKeyId: "lookup-v1", deleteAfter: 1 }, 1);
    await notifications.confirmContact(t.db, contactId, 2, null);
    await notifications.subscribe(t.db, { contactId, kind: "remind_me", programCycleId: t.cycleId }, 3);
    // The contact's spread day in the week of 16-22 Nov 2026 (Monday 16 Nov is weekday 1).
    const day = 15 + spreadWeekday(contactId);
    const at = Date.UTC(2026, 10, day, 22, 45);
    // Before 22:30 UTC nothing goes; after it, one email (the 23 Nov deadline is in the window).
    expect((await run(t, Date.UTC(2026, 10, day, 21, 45))).provider.sent).toHaveLength(0);
    const { provider } = await run(t, at);
    expect(provider.sent).toHaveLength(1);
    expect(provider.sent[0]!.to).toBe("visitor@example.net");
    expect(provider.sent[0]!.text).toContain("Sample Job Shadow Week");
  });
});
