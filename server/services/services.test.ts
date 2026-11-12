import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { audit, notifications, runBatch, students } from "@server/db/repos";
import * as s from "@server/db/schema";
import { uuidv7 } from "@server/db/columns";
import { createUser, freshDb, freshEventsDb, seededDb } from "@server/db/testing/fixtures";
import { Budget } from "@server/jobs/budget";
import { silentLogger, type WorkerBindings } from "@server/jobs/types";
import { changeAlertDedupeKey, deadlineChangePriority, draftAlert, fanOutChangeEvents, wantsOwnEmail, type CycleFacts } from "./alerts";
import { actorForJob, assertFieldNames, buildDigest, GENESIS_HASH, registryChanges, runAuditDigest, subjectKeyFor, verifyDigest, DIGEST_HEAD_KEY } from "./audit";
import {
  classifySendError,
  createDryRunProvider,
  dispatchNotifications,
  emailLinkRoutes,
  isQuietTime,
  isUrgent,
  listUnsubscribeHeaders,
  notificationExpiry,
  quotaAllows,
  renderAlertEmail,
  signUnsubscribeToken,
  unsubscribeUrl,
  verifyUnsubscribeToken,
  type EmailProvider,
} from "./email";
import { nextDeadlineMs } from "./email/store";

// Test-only root secret: synthetic.
const SECRET = "test-only-root-secret-0123456789abcdef0123";
const NOW = Date.UTC(2026, 10, 11, 15, 0, 0); // 10:00 in America/New_York, outside quiet hours
const HOUR = 3_600_000;

const budget = () => new Budget({ ms: 25_000, calls: 900 }, () => NOW);

function fakeR2() {
  const objects = new Map<string, string>();
  return {
    objects,
    async get(key: string) {
      const v = objects.get(key);
      return v === undefined ? null : { json: async () => JSON.parse(v) };
    },
    async put(key: string, value: string) {
      objects.set(key, value);
      return { key };
    },
  };
}

// =============================================================================================
// Alerts
// =============================================================================================

const facts: CycleFacts = {
  cycleId: "c1",
  programName: "Sample Research Program",
  programSlug: "sample-research-program",
  termLabel: "Summer 2027",
  sensitiveAudience: false,
  identityAudience: [],
  isSample: true,
};

describe("alert copy", () => {
  const opened = { id: "e1", type: "cycle.status_changed" as const, programCycleId: "c1", payload: { to: "open" } };

  it("names the program for ordinary recipients and tags sample listings", () => {
    const d = draftAlert(opened, facts, { nameInMessages: true }, NOW);
    expect(d).toMatchObject({ priority: "p0", neutral: false, href: "/programs/sample-research-program" });
    expect(d?.title).toContain("Sample Research Program");
    expect(d?.title).toContain("[sample listing]");
  });

  it("uses neutral copy for status-defined programs and for recipients who opted out of names", () => {
    const sensitive = draftAlert(opened, { ...facts, sensitiveAudience: true }, { nameInMessages: true }, NOW);
    const optedOut = draftAlert(opened, facts, { nameInMessages: false }, NOW);
    for (const d of [sensitive, optedOut]) {
      expect(d?.neutral).toBe(true);
      expect(`${d?.title} ${d?.body}`).not.toContain("Sample Research Program");
      expect(d?.href).toBe("/app/tracker");
    }
  });

  it("never alerts students about verification or re-checks", () => {
    expect(draftAlert({ ...opened, type: "program_cycle.verified" }, facts, { nameInMessages: true }, NOW)).toBeNull();
    expect(draftAlert({ ...opened, type: "cycle.urgent_recheck" }, facts, { nameInMessages: true }, NOW)).toBeNull();
  });

  it("ranks deadline changes: earlier or withdrawn is P0, a far later move is P1", () => {
    expect(deadlineChangePriority({ localDate: "2026-12-01", previousLocalDate: "2026-12-10" }, NOW)).toBe("p0");
    expect(deadlineChangePriority({ withdrawn: true }, NOW)).toBe("p0");
    expect(deadlineChangePriority({ localDate: "2027-01-20", previousLocalDate: "2027-01-10" }, NOW)).toBe("p1");
    // An extension of a deadline within 72 hours is urgent news.
    expect(deadlineChangePriority({ localDate: "2026-11-20", previousLocalDate: "2026-11-12" }, NOW)).toBe("p0");
    // Unknown previous date: treat as P0 so nobody misses an earlier date.
    expect(deadlineChangePriority({ localDate: "2026-11-20" }, NOW)).toBe("p0");
  });

  it("ranks an earlier time or zone on the same date as P0, by instant when known", () => {
    const base = { kind: "application", localDate: "2027-01-15", previousLocalDate: "2027-01-15" };
    const at = (h: number, m = 0) => Date.UTC(2027, 0, 15, h, m);
    // 23:59 -> 12:00 Pacific, same date.
    expect(deadlineChangePriority({ ...base, dueAt: at(20), previousDueAt: at(31, 59) }, NOW)).toBe("p0");
    // Pacific -> Eastern at the same clock time: three hours earlier.
    expect(deadlineChangePriority({ ...base, dueAt: at(28, 59), previousDueAt: at(31, 59) }, NOW)).toBe("p0");
    expect(deadlineChangePriority({ ...base, dueAt: at(31, 59), previousDueAt: at(31, 59) }, NOW)).toBe("p1");
    // No instants (applicant-local): stated times compare; a time where none was stated is earlier.
    expect(deadlineChangePriority({ ...base, localTime: "12:00", previousLocalTime: "23:59" }, NOW)).toBe("p0");
    expect(deadlineChangePriority({ ...base, localTime: "17:00", previousLocalTime: null }, NOW)).toBe("p0");
    expect(deadlineChangePriority({ ...base, localTime: "23:59", previousLocalTime: "12:00" }, NOW)).toBe("p1");
    expect(deadlineChangePriority({ ...base, localTime: "17:00", previousLocalTime: "17:00", timeZone: "America/New_York", previousTimeZone: "America/Los_Angeles" }, NOW)).toBe("p0");
    // Decision and start dates inform; they never page anyone.
    expect(deadlineChangePriority({ kind: "decision_expected", localDate: "2026-12-01", previousLocalDate: "2026-12-10" }, NOW)).toBe("p1");
  });

  it("sends a campus deadline only to that campus's students, with kind-specific copy", () => {
    const campus = { id: "e9", type: "deadline.changed" as const, programCycleId: facts.cycleId, payload: { kind: "campus_internal", scope: "campus", institutionId: "inst-a", localDate: "2026-12-01", previousLocalDate: null } };
    expect(draftAlert(campus, facts, { nameInMessages: true, institutionId: "inst-b" }, NOW)).toBeNull();
    expect(draftAlert(campus, facts, { nameInMessages: true, institutionId: null }, NOW)).toBeNull();
    const mine = draftAlert(campus, facts, { nameInMessages: true, institutionId: "inst-a" }, NOW);
    expect(mine?.title).toMatch(/^New deadline: /);
    expect(mine?.body).toContain("Your campus deadline is now 2026-12-01");
    const national = { ...campus, payload: { kind: "application", scope: "national", institutionId: null, localDate: "2026-12-01", previousLocalDate: "2026-12-10" } };
    expect(draftAlert(national, facts, { nameInMessages: true, institutionId: "inst-b" }, NOW)?.body).toContain("The deadline is now 2026-12-01");
    const decision = { ...campus, payload: { kind: "decision_expected", scope: "national", localDate: "2027-03-01", previousLocalDate: "2027-03-15" } };
    const d = draftAlert(decision, facts, { nameInMessages: true }, NOW);
    expect(d).toMatchObject({ priority: "p1" });
    expect(d?.title).toMatch(/^Decision date changed/);
    expect(d?.body).not.toContain("deadline is now");
  });

  it("sends P0 and reminders on their own; the rest waits for the weekly email", () => {
    expect(wantsOwnEmail("cycle.status_changed", "p0")).toBe(true);
    expect(wantsOwnEmail("deadline.reminder", "p2")).toBe(true);
    expect(wantsOwnEmail("eligibility.changed", "p1")).toBe(false);
    expect(changeAlertDedupeKey("e1", "deadline.changed")).toBe("change:e1:deadline.changed");
  });
});

async function seededWithFollower() {
  const t = await seededDb();
  const program = t.seed.programs.find((p) => !p.sensitiveAudience && (p.identityAudience ?? []).length === 0);
  const cycle = t.seed.programCycles.find((c) => c.programId === program?.id);
  if (!program || !cycle?.id) throw new Error("seed has no ordinary program cycle");
  const userId = await createUser(t.db, "student@example.org");
  const added = await students.addTrackerItem(t.db, userId, { programCycleId: cycle.id, status: "interested", nameInMessages: true }, NOW - HOUR);
  if (!added.ok) throw new Error(`tracker insert failed: ${added.error}`);
  const eventId = uuidv7(NOW - 60_000);
  await t.db.insert(s.changeEvents).values({
    id: eventId,
    type: "cycle.status_changed",
    programCycleId: cycle.id,
    payload: { to: "open" },
    idempotencyKey: `test:cycle.status_changed:${cycle.id}`,
    createdAt: NOW - 60_000,
  });
  return { ...t, userId, cycleId: cycle.id, eventId, programName: program.name };
}

describe("alerts.match fan-out", () => {
  it("writes one Alert per recipient and event, and a re-run adds nothing", async () => {
    const t = await seededWithFollower();
    const first = await fanOutChangeEvents({ db: t.db, now: () => NOW, budget: budget(), log: silentLogger });
    expect(first.outcome).toBe("ok");
    const alerts = await t.db.select().from(s.alerts);
    const ours = alerts.filter((a) => a.changeEventId === t.eventId);
    expect(ours).toHaveLength(1);
    expect(ours[0]).toMatchObject({ userId: t.userId, priority: "p0", dedupeKey: changeAlertDedupeKey(t.eventId, "cycle.status_changed") });
    const event = await t.db.query.changeEvents.findFirst({ where: (e, { eq }) => eq(e.id, t.eventId) });
    expect(event?.fannedOutAt).toBe(NOW);

    // Simulate an interrupted run: the event is pending again, but the Alert already exists.
    await t.db.update(s.changeEvents).set({ fannedOutAt: null });
    await fanOutChangeEvents({ db: t.db, now: () => NOW + 1000, budget: budget(), log: silentLogger });
    expect((await t.db.select().from(s.alerts)).filter((a) => a.changeEventId === t.eventId)).toHaveLength(1);
  });

  it("stops at the budget and leaves the event pending", async () => {
    const t = await seededWithFollower();
    const tiny = new Budget({ ms: 25_000, calls: 3 }, () => NOW);
    const res = await fanOutChangeEvents({ db: t.db, now: () => NOW, budget: tiny, log: silentLogger });
    expect(res.outcome).toBe("partial");
    const pending = await notifications.listPendingChangeEvents(t.db, 100);
    expect(pending.some((e) => e.id === t.eventId)).toBe(true);
  });
});

// =============================================================================================
// Email
// =============================================================================================

describe("send-time policy", () => {
  it("handles quiet windows that wrap midnight", () => {
    expect(isQuietTime("23:30", "22:00", "08:00")).toBe(true);
    expect(isQuietTime("07:59", "22:00", "08:00")).toBe(true);
    expect(isQuietTime("08:00", "22:00", "08:00")).toBe(false);
    expect(isQuietTime("13:00", "12:00", "14:00")).toBe(true);
    expect(isQuietTime("13:00", "09:00", "09:00")).toBe(false);
  });

  it("keeps a quota reserve for essential and urgent mail", () => {
    expect(quotaAllows("digest", 50, 100, false)).toBe(false);
    expect(quotaAllows("alert", 84, 100, false)).toBe(true);
    expect(quotaAllows("alert", 85, 100, false)).toBe(false);
    expect(quotaAllows("alert", 99, 100, true)).toBe(true);
    expect(quotaAllows("essential", 1000, 100, false)).toBe(true);
  });

  it("never lets a change alert outlive its deadline", () => {
    const deadline = NOW + 10 * HOUR;
    expect(notificationExpiry({ type: "deadline.changed", createdAt: NOW, nextDeadlineMs: deadline, digest: false })).toBe(deadline);
    expect(notificationExpiry({ type: "deadline.changed", createdAt: NOW, nextDeadlineMs: null, digest: false })).toBe(NOW + 72 * HOUR);
    expect(notificationExpiry({ type: "eligibility.changed", createdAt: NOW, nextDeadlineMs: null, digest: true })).toBe(NOW + 7 * 24 * HOUR);
  });

  it("classifies provider errors without keeping the message", () => {
    const e = Object.assign(new Error("rejected recipient student@example.org"), { code: "E_RECIPIENT" });
    const out = classifySendError(e);
    expect(out.retryable).toBe(false);
    expect(out.errorClass).not.toContain("@");
    expect(classifySendError(new Error("timeout")).retryable).toBe(true);
  });
});

describe("rendering", () => {
  it("escapes HTML, strips header injection and keeps links on the app origin", () => {
    const r = renderAlertEmail({ title: "Deadline <b>moved</b>\r\nBcc: x@example.org", body: "a & b", href: "//evil.example.com", appOrigin: "https://novus.example.org", unsubscribeUrl: null });
    expect(r.subject).not.toMatch(/[\r\n]/);
    expect(r.html).toContain("&lt;b&gt;");
    expect(r.html).toContain('href="https://novus.example.org/"');
    expect(r.text).toContain("a & b");
  });
});

describe("unsubscribe tokens", () => {
  const recipientKey = "u:01890000-0000-7000-8000-000000000001";

  it("round-trips and refuses tampering, other secrets and expiry", async () => {
    const token = await signUnsubscribeToken(SECRET, { recipientKey, list: "alerts", nowMs: NOW });
    expect(await verifyUnsubscribeToken(SECRET, token, NOW)).toMatchObject({ r: recipientKey, l: "alerts" });
    expect(await verifyUnsubscribeToken(`${SECRET}x`, token, NOW)).toBeNull();
    const [payload, mac] = token.split(".");
    expect(await verifyUnsubscribeToken(SECRET, `${payload}A.${mac}`, NOW)).toBeNull();
    expect(await verifyUnsubscribeToken(SECRET, token, NOW + 366 * 24 * HOUR)).toBeNull();
  });

  it("emits RFC 8058 headers", () => {
    const url = unsubscribeUrl("https://novus.example.org/", "tok");
    expect(url).toBe("https://novus.example.org/e/u/tok");
    expect(listUnsubscribeHeaders(url)).toEqual({ "List-Unsubscribe": "<https://novus.example.org/e/u/tok>", "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" });
  });
});

describe("one-click unsubscribe routes", () => {
  async function setup() {
    const t = await seededDb();
    const userId = await createUser(t.db);
    const env: WorkerBindings = { DB: t.raw.d1 as unknown as D1Database, BETTER_AUTH_SECRET: SECRET };
    const app = new Hono().route("/", emailLinkRoutes);
    const token = await signUnsubscribeToken(SECRET, { recipientKey: `u:${userId}`, list: "alerts", nowMs: Date.now() });
    return { ...t, userId, env, app, token };
  }

  it("GET shows a confirmation and changes nothing", async () => {
    const t = await setup();
    const res = await t.app.request(`/e/u/${t.token}`, {}, t.env);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="List-Unsubscribe" value="One-Click"');
    expect((await notifications.getNotificationPrefs(t.db, t.userId)).channels.email).toBe(true);
  });

  it("POST List-Unsubscribe=One-Click unsubscribes, idempotently, with 200 and no redirect", async () => {
    const t = await setup();
    const post = () =>
      t.app.request(`/e/u/${t.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }, t.env);
    const first = await post();
    expect(first.status).toBe(200);
    expect((await notifications.getNotificationPrefs(t.db, t.userId)).channels.email).toBe(false);
    expect((await post()).status).toBe(200);
  });

  it("refuses a forged token and a POST without the one-click body", async () => {
    const t = await setup();
    expect((await t.app.request(`/e/u/${t.token}x`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "List-Unsubscribe=One-Click" }, t.env)).status).toBe(404);
    expect((await t.app.request(`/e/u/${t.token}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: "x=1" }, t.env)).status).toBe(400);
  });
});

describe("notify.dispatch", () => {
  async function ready() {
    const t = await seededWithFollower();
    await fanOutChangeEvents({ db: t.db, now: () => NOW, budget: budget(), log: silentLogger });
    const events = await freshEventsDb();
    return { ...t, edb: events.edb };
  }

  it("sends one email per Alert with an unsubscribe link, and never twice", async () => {
    const t = await ready();
    const provider = createDryRunProvider();
    const deps = { db: t.db, edb: t.edb, provider, appOrigin: "https://novus.example.org", secret: SECRET, now: () => NOW, budget: budget(), log: silentLogger };
    const first = await dispatchNotifications(deps);
    expect(first.processed).toBe(1);
    expect(provider.sent).toHaveLength(1);
    const msg = provider.sent[0]!;
    expect(msg.to).toBe("student@example.org");
    expect(msg.headers["List-Unsubscribe-Post"]).toBe("List-Unsubscribe=One-Click");
    expect(msg.idempotencyKey).toMatch(/^notif:.+:email$/);
    expect(msg.subject).toContain(t.programName);

    await dispatchNotifications({ ...deps, now: () => NOW + 60_000, budget: budget() });
    expect(provider.sent).toHaveLength(1);
    const notifs = await t.db.select().from(s.notifications);
    expect(notifs).toHaveLength(1);
    expect(notifs[0]?.state).toBe("sent");
  });

  it("holds non-urgent mail in quiet hours without spending an attempt", async () => {
    const t = await ready();
    const provider = createDryRunProvider();
    const night = Date.UTC(2026, 10, 12, 4, 0, 0); // 23:00 in New York
    await dispatchNotifications({ db: t.db, edb: t.edb, provider, appOrigin: "https://novus.example.org", secret: SECRET, now: () => night, budget: budget(), log: silentLogger });
    const notifs = await t.db.select().from(s.notifications);
    // Within 72 hours of the cycle's deadline, alerts ignore quiet hours; otherwise they wait.
    const urgent = isUrgent(await nextDeadlineMs(t.db, t.cycleId, night), night);
    expect(provider.sent).toHaveLength(urgent ? 1 : 0);
    expect(notifs[0]?.state).toBe(urgent ? "sent" : "queued");
    expect(notifs[0]?.attempts ?? 0).toBe(0);
  });

  it("suppresses mail when the student turned email off", async () => {
    const t = await ready();
    const prefs = await notifications.getNotificationPrefs(t.db, t.userId);
    await notifications.saveNotificationPrefs(t.db, t.userId, { ...prefs, channels: { ...prefs.channels, email: false } }, NOW);
    const provider = createDryRunProvider();
    await dispatchNotifications({ db: t.db, edb: t.edb, provider, appOrigin: "https://novus.example.org", secret: SECRET, now: () => NOW, budget: budget(), log: silentLogger });
    expect(provider.sent).toHaveLength(0);
    expect((await t.db.select().from(s.notifications))[0]?.state).toBe("suppressed");
  });

  it("opens the breaker after repeated retryable failures and keeps rows queued", async () => {
    const t = await ready();
    let calls = 0;
    const failing: EmailProvider = {
      name: "failing",
      async send() {
        calls++;
        return { ok: false, retryable: true, errorClass: "Unavailable" };
      },
    };
    const res = await dispatchNotifications({ db: t.db, edb: t.edb, provider: failing, appOrigin: "https://novus.example.org", secret: SECRET, now: () => NOW, budget: budget(), log: silentLogger });
    expect(calls).toBe(1);
    expect(res.outcome).toBe("ok");
    expect((await t.db.select().from(s.notifications))[0]?.state).toBe("queued");
  });
});

// =============================================================================================
// Audit
// =============================================================================================

describe("audit writer", () => {
  it("accepts field names and refuses values or sensitive keys", () => {
    expect(() => assertFieldNames(["profile.classYear", "trackerItems.status"])).not.toThrow();
    expect(() => assertFieldNames(["student@example.org"])).toThrow();
    expect(() => assertFieldNames(["citizenship"])).toThrow();
    expect(() => assertFieldNames(["profile.firstGeneration"])).toThrow();
  });

  it("derives a stable pseudonymous subject key", async () => {
    const a = await subjectKeyFor(SECRET, "user-1");
    expect(a).toBe(await subjectKeyFor(SECRET, "user-1"));
    expect(a).not.toBe(await subjectKeyFor(SECRET, "user-2"));
    expect(a).not.toContain("user-1");
  });

  it("lists changed registry fields as before/after pairs", () => {
    expect(registryChanges({ a: 1, b: "x" }, { a: 1, b: "y" }, ["a", "b"])).toEqual([{ field: "b", before: "x", after: "y" }]);
    expect(registryChanges(null, { a: 1 }, ["a"])).toEqual([{ field: "a", before: null, after: 1 }]);
  });

  it("chains digests and detects an altered row", async () => {
    const rows = [
      { rowid: 2, row: { field: "status", after: "open" } },
      { rowid: 1, row: { field: "status", after: "expected" } },
    ];
    const d1 = await buildDigest(rows, GENESIS_HASH, "2026-11-11T08:00:00.000Z");
    expect(d1).toMatchObject({ fromRowId: 1, toRowId: 2, count: 2, prevHash: GENESIS_HASH });
    expect(await verifyDigest(d1, rows)).toBe(true);
    expect(await verifyDigest(d1, [{ ...rows[0]!, row: { field: "status", after: "closed" } }, rows[1]!])).toBe(false);
    const d2 = await buildDigest([{ rowid: 3, row: {} }], d1.hash, "2026-11-12T08:00:00.000Z");
    expect(d2.prevHash).toBe(d1.hash);
  });

  it("audit.digest writes a ledger object and moves the head; a re-run with no new rows writes nothing", async () => {
    const t = await freshDb();
    const store = fakeR2();
    const entityId = "01890000-0000-7000-8000-0000000000c1";
    await runBatch(
      t.db,
      ["expected", "open"].map((after, i) =>
        audit.registryAuditInsert(t.db, { at: NOW - 1000 + i, actor: actorForJob("test"), entityType: "program_cycle", entityId, field: "status", before: null, after }),
      ),
    );
    const deps = { db: t.db, store: store as unknown as R2Bucket, now: () => NOW, budget: budget() };
    const first = await runAuditDigest(deps);
    expect(first).toMatchObject({ processed: 2, outcome: "ok" });
    const head = JSON.parse(store.objects.get(DIGEST_HEAD_KEY) ?? "null") as { lastRowId: number; hash: string };
    expect(head.lastRowId).toBe(2);
    const ledger = [...store.objects.keys()].filter((k) => k !== DIGEST_HEAD_KEY);
    expect(ledger).toEqual(["ledger/audit/2026-11-11-2.json"]);
    expect(JSON.parse(store.objects.get(ledger[0]!)!).hash).toBe(head.hash);

    const second = await runAuditDigest({ ...deps, budget: budget() });
    expect(second.processed).toBe(0);
    expect(store.objects.size).toBe(2);
  });

  it("defers the digest when R2 is not bound", async () => {
    const t = await seededDb();
    expect((await runAuditDigest({ db: t.db, store: null, now: () => NOW, budget: budget() })).outcome).toBe("deferred");
  });
});
