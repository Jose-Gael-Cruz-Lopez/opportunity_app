import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { sql } from "drizzle-orm";
import { ProblemDetailsSchema } from "@shared/contracts";
import type { Role } from "@shared/taxonomy";
import { SECOND_FACTOR_PROBLEM_TYPE, type RoleGrant } from "@server/auth";
import { uuidv7 } from "@server/db/columns";
import * as ev from "@server/db/events-schema";
import { grantRole } from "@server/db/repos/students";
import * as s from "@server/db/schema";
import { createUser, freshEventsDb, seededDb, type TestDb } from "@server/db/testing/fixtures";
import type { EventsDb } from "@server/db/client";
import type { AppEnv, SessionUser } from "@server/env";
import { adultFrom } from "@server/api/v1/remind/service";
import { engagementWeeks, onboardingRecordCounts, trackerSnapshot } from "./queries";
import { createAdminMetricsRoutes } from "./routes";
import { AdminMetricsViewSchema, type AdminMetricsView } from "./schemas";
import { DAY_MS, weekIndex, weekStartMs } from "./weeks";

// Fixtures only: every program is the labelled sample seed (four are relabelled non-sample inside
// this in-memory database to exercise the "real" freshness slice); every account, device and
// event below is synthetic.
const NOW = Date.parse("2026-11-11T15:00:00Z");
const W = weekIndex(NOW);
const BASE = "http://localhost/api/v1/admin/metrics";

interface Harness {
  t: TestDb;
  edb: EventsDb | null;
  app: Hono<AppEnv>;
  users: Map<string, SessionUser>;
  env: { name: string };
}

function sessionFor(id: string, roles: Role[], opts: { totp?: boolean; surface?: "app" | "console" } = {}): SessionUser {
  const grants: RoleGrant[] = roles.map((role): RoleGrant => ({ role, scope: { kind: "global" } }));
  return {
    id,
    publicId: `u${id.replace(/-/g, "").slice(-20)}`,
    email: `${id}@example.org`,
    displayName: null,
    roles: [...new Set<Role>(["student", ...roles])],
    onboarded: true,
    grants,
    sessionId: `sess-${id}`,
    sessionExpiresAt: NOW + 3_600_000,
    surface: opts.surface ?? "console",
    secondFactor: { enrolled: true, verified: opts.totp ?? true },
  };
}

async function signIn(h: Harness, roles: Role[], opts: { totp?: boolean; surface?: "app" | "console" } = {}): Promise<string> {
  const id = await createUser(h.t.db);
  for (const role of roles) await grantRole(h.t.db, id, role, NOW);
  const token = `tok-${id}`;
  h.users.set(token, sessionFor(id, roles, opts));
  return token;
}

async function setup(withEvents = true): Promise<Harness> {
  const t = await seededDb();
  const edb = withEvents ? (await freshEventsDb()).edb : null;
  const users = new Map<string, SessionUser>();
  const env = { name: "local" };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const user = users.get(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (user) c.set("user", user);
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/api/v1",
    createAdminMetricsRoutes({ db: () => t.db, eventsDb: () => edb, user: (c) => c.get("user"), now: () => NOW, environment: () => env.name }),
  );
  return { t, edb, app, users, env };
}

function get(h: Harness, token: string | null, query = "") {
  return h.app.request(`${BASE}${query}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
}

async function view(h: Harness, token: string, query = ""): Promise<AdminMetricsView> {
  const res = await get(h, token, query);
  expect(res.status).toBe(200);
  return AdminMetricsViewSchema.parse(await res.json());
}

// ---------------------------------------------------------------------------------------------
// Fixture writers
// ---------------------------------------------------------------------------------------------

type EventName = (typeof ev.analyticsEvents.$inferInsert)["name"];

async function event(edb: EventsDb, name: EventName, at: number, actor: { device?: string; user?: string }, props: Record<string, string | number | boolean> = {}) {
  await edb.insert(ev.analyticsEvents).values({ id: uuidv7(at), name, at, deviceId: actor.device ?? null, userHmac: actor.user ?? null, path: "/app/start", props });
}

/** 12 devices start inside the 28-day window, 4 before it, and 1 never starts. */
async function seedFunnel(edb: EventsDb) {
  const start = NOW - 10 * DAY_MS;
  for (let i = 0; i < 12; i++) {
    const d = { device: `device-in-window-${String(i).padStart(4, "0")}` };
    const at = start + i * 60_000;
    await event(edb, "onboarding_step", at, d, { step: "started" });
    if (i < 11) await event(edb, "onboarding_step", at + 1000, d, { step: "quiz_completed", asked: 13, skipped: 1 });
    if (i < 6) await event(edb, "onboarding_step", at + 2000, d, { step: "resume_parsed", source: "pdf", ok: true });
    if (i === 6) await event(edb, "onboarding_step", at + 2000, d, { step: "resume_parsed", source: "none", ok: true });
    if (i === 7) await event(edb, "onboarding_step", at + 2000, d, { step: "resume_parsed", source: "docx", ok: false });
    if (i < 10) await event(edb, "onboarding_step", at + 3000, d, { step: "matches_shown", strong: 2, good: 3, stretch: 1, explore: 0, relaxed: false });
    if (i < 7) await event(edb, "onboarding_step", at + 4000, d, { step: "first_door_chosen", tier: "strong" });
    if (i < 3) await event(edb, "onboarding_step", at + 5000, d, { step: "first_step_done", kind: "draft" });
    if (i < 6) await event(edb, "onboarding_step", at + 6000, d, { step: "tracker_created", deviceOnly: false });
  }
  for (let i = 0; i < 4; i++) {
    const d = { device: `device-before-window-${i}` };
    const at = NOW - 40 * DAY_MS;
    for (const step of ["started", "quiz_completed", "matches_shown", "first_door_chosen", "first_step_done", "tracker_created"]) await event(edb, "onboarding_step", at, d, { step });
  }
  await event(edb, "onboarding_step", NOW - DAY_MS, { device: "device-no-start" }, { step: "quiz_completed", asked: 13, skipped: 0 });
}

/**
 * Cohort of week W-3: 8 students; 6 come back in W-2, 3 in W-1, 5 in the current week.
 * Cohort of week W-1: 3 students (too small to show). Older students and page views don't count.
 */
async function seedRetention(edb: EventsDb) {
  const at = (week: number, i: number) => weekStartMs(week) + DAY_MS + i * 60_000;
  for (let i = 0; i < 8; i++) {
    const u = { user: `hmac-cohort-a-${i}`, device: `dev-a-${i}` };
    await event(edb, "program_view", at(W - 3, i), u);
    if (i < 6) await event(edb, "tracker_add", at(W - 2, i), u);
    if (i < 3) await event(edb, "readiness_open", at(W - 1, i), u);
    if (i < 5) await event(edb, "apply_click", at(W, 0) - DAY_MS + i, u);
  }
  for (let i = 0; i < 3; i++) await event(edb, "program_view", at(W - 1, i), { user: `hmac-cohort-b-${i}` });
  for (let i = 0; i < 6; i++) {
    await event(edb, "program_view", at(W - 10, i), { user: `hmac-old-${i}` });
    await event(edb, "program_view", at(W - 1, i), { user: `hmac-old-${i}` });
  }
  // Browsing only: never a cohort.
  for (let i = 0; i < 7; i++) await event(edb, "page_view", at(W - 2, i), { user: `hmac-browser-${i}` });
}

async function trackableCycle(t: TestDb): Promise<string> {
  const rows = await t.db.all<{ id: string }>(sql`
    SELECT c.id AS id FROM program_cycles c JOIN programs p ON p.id = c.program_id
    WHERE p.sensitive_audience = 0 AND p.identity_audience = '[]' ORDER BY c.id LIMIT 1`);
  return rows[0]!.id;
}

/**
 * 20 counted students with one Tracker item each: 12 applying, 8 interested; 14 added in W-1 and
 * 6 this week. 7 items got a sent reminder in W-1 (6 applying, 1 interested); 5 students have an
 * upcoming reminder; 2 reminders were cancelled this week. Excluded accounts track too.
 */
async function seedTracker(t: TestDb) {
  const cycle = await trackableCycle(t);
  const created = (i: number) => (i < 14 ? weekStartMs(W - 1) + DAY_MS + i * 1000 : weekStartMs(W) + i * 1000);
  const reminder = async (userId: string, itemId: string, key: string, state: "scheduled" | "sent" | "cancelled", createdAt: number, extra: Partial<typeof s.reminders.$inferInsert> = {}) =>
    t.db.insert(s.reminders).values({
      id: uuidv7(createdAt),
      userId,
      reminderKey: key,
      trackerItemId: itemId,
      kind: "step_due",
      stepId: "draft",
      sendOn: "2026-11-20",
      sendAt: "09:00",
      timeZone: "America/Chicago",
      state,
      createdAt,
      updatedAt: createdAt,
      ...extra,
    });
  for (let i = 0; i < 20; i++) {
    const userId = await createUser(t.db);
    const itemId = uuidv7(created(i));
    const status = i < 12 ? "applying" : "interested";
    await t.db.insert(s.trackerItems).values({ id: itemId, userId, programCycleId: cycle, status, createdAt: created(i), updatedAt: created(i) });
    if (i < 6 || i === 12) {
      const at = weekStartMs(W - 1) + 2 * DAY_MS;
      await reminder(userId, itemId, `fd:${itemId}:sent`, "sent", at, { sendOn: "2026-11-04", sentAt: at + 3_600_000 });
    }
    if (i >= 14 && i < 19) await reminder(userId, itemId, `fd:${itemId}:next`, "scheduled", weekStartMs(W) + DAY_MS);
    if (i >= 19) {
      await reminder(userId, itemId, `fd:${itemId}:x1`, "cancelled", weekStartMs(W) + DAY_MS);
      await reminder(userId, itemId, `fd:${itemId}:x2`, "cancelled", weekStartMs(W) + DAY_MS + 1);
    }
  }
  // Not counted: analytics off, a staff account, a deleted account.
  const off = await createUser(t.db);
  await t.db.update(s.users).set({ analyticsOffAt: NOW - DAY_MS }).where(sql`id = ${off}`);
  const staff = await createUser(t.db);
  await grantRole(t.db, staff, "curator", NOW);
  const gone = await createUser(t.db);
  await t.db.update(s.users).set({ deletedAt: NOW - DAY_MS }).where(sql`id = ${gone}`);
  // Minor mode: 17 today (born 2009-06, adult from 2027-07-01), no analytics consent exists.
  const minor = await createUser(t.db);
  await t.db.insert(s.studentProfiles).values({ userId: minor, birthYearMonth: "2009-06" });
  for (const userId of [off, staff, gone, minor]) {
    const itemId = uuidv7(NOW - DAY_MS);
    await t.db.insert(s.trackerItems).values({ id: itemId, userId, programCycleId: cycle, status: "submitted", createdAt: NOW - DAY_MS, updatedAt: NOW - DAY_MS });
    await reminder(userId, itemId, `fd:${itemId}:sent`, "sent", NOW - DAY_MS, { sentAt: NOW - DAY_MS });
  }
  return { off, staff, gone, minor };
}

/** 6 counted onboarding records in the window (all quiz, 5 first doors, 2 completed). */
async function seedOnboarding(t: TestDb, excluded: string) {
  const write = async (userId: string, createdAt: number, door: boolean, done: boolean) =>
    t.db.insert(s.onboardingRecords).values({
      userId,
      preferences: { categories: ["internships"] },
      step: "matches",
      completedAt: done ? createdAt : null,
      firstDoor: door ? { programId: "p", programCycleId: "c", trackerItemId: "t" } : null,
      createdAt,
      updatedAt: createdAt,
    });
  for (let i = 0; i < 6; i++) await write(await createUser(t.db), NOW - 3 * DAY_MS, i < 5, i < 2);
  await write(await createUser(t.db), NOW - 60 * DAY_MS, true, true);
  await write(excluded, NOW - 3 * DAY_MS, true, true);
}

/** All cycles unverified; four programs relabelled non-sample, verified 2, 20 and 45 days ago or never. */
async function seedFreshness(t: TestDb) {
  await t.db.run(sql`UPDATE program_cycles SET verification_state = 'unverified', last_verified_at = NULL, verified_by = NULL`);
  const programs = await t.db.all<{ id: string }>(sql`SELECT id FROM programs WHERE is_published = 1 AND lifecycle = 'active' ORDER BY id LIMIT 4`);
  const ages = [2, 20, 45, null];
  for (const [i, p] of programs.entries()) {
    await t.db.run(sql`UPDATE programs SET is_sample = 0 WHERE id = ${p.id}`);
    const age = ages[i];
    if (age !== null && age !== undefined) {
      await t.db.run(sql`
        UPDATE program_cycles SET verification_state = 'verified', last_verified_at = ${NOW - age * DAY_MS},
          verified_by = (SELECT id FROM curators LIMIT 1)
        WHERE program_id = ${p.id}`);
    }
  }
  const rest = await t.db.all<{ n: number }>(sql`SELECT count(*) AS n FROM programs WHERE is_published = 1 AND lifecycle = 'active' AND is_sample = 1`);
  return { samplePublished: Number(rest[0]!.n) };
}

let h: Harness;
beforeEach(async () => {
  h = await setup();
});

describe("GET /api/v1/admin/metrics: access", () => {
  it("answers 401 signed out, 403 for students and Curators, step-up before TOTP", async () => {
    expect((await get(h, null)).status).toBe(401);
    expect((await get(h, await signIn(h, []))).status).toBe(403);
    expect((await get(h, await signIn(h, ["curator"]))).status).toBe(403);
    const res = await get(h, await signIn(h, ["admin"], { totp: false }));
    expect(res.status).toBe(403);
    expect(ProblemDetailsSchema.parse(await res.json()).type).toBe(SECOND_FACTOR_PROBLEM_TYPE);
  });

  it("serves admins with no-store, and only on the console surface in staging and production", async () => {
    const appSession = await signIn(h, ["admin"], { surface: "app" });
    const ok = await get(h, appSession);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toContain("no-store");
    h.env.name = "production";
    expect((await get(h, appSession)).status).toBe(403);
    expect((await get(h, await signIn(h, ["admin"], { surface: "console" }))).status).toBe(200);
  });

  it("validates the query", async () => {
    const admin = await signIn(h, ["admin"]);
    expect((await get(h, admin, "?days=10")).status).toBe(400);
    expect((await get(h, admin, "?weeks=2")).status).toBe(400);
    expect((await get(h, admin, "?weeks=27")).status).toBe(400);
    expect((await get(h, admin, "?userId=x")).status).toBe(400);
    const v = await view(h, admin, "?days=90&weeks=12");
    expect(v.window).toMatchObject({ days: 90, weeks: 12, to: "2026-11-11", from: "2026-08-13" });
  });
});

describe("GET /api/v1/admin/metrics: numbers", () => {
  it("builds the funnel from onboarding events of devices that started in the window", async () => {
    await seedFunnel(h.edb!);
    const v = await view(h, await signIn(h, ["admin"]));
    const by = Object.fromEntries(v.funnel.steps.map((st) => [st.step, st]));
    expect(by.started!.actors).toEqual({ n: 12, hidden: false });
    expect(by.quiz_completed!).toMatchObject({ actors: { n: 11 }, fromPrevious: 0.917, fromStart: 0.917 });
    // Only a real on-device parse counts (not "none", not a failed parse).
    expect(by.resume_parsed!).toMatchObject({ actors: { n: 6 }, optional: true, fromPrevious: 0.545 });
    // Matches compare with the quiz, the last required step.
    expect(by.matches_shown!).toMatchObject({ actors: { n: 10 }, fromPrevious: 0.909 });
    expect(by.first_door_chosen!).toMatchObject({ actors: { n: 7 }, fromPrevious: 0.7 });
    expect(by.first_step_done!).toEqual({ step: "first_step_done", actors: { n: null, hidden: true }, optional: false, fromPrevious: null, fromStart: null });
    expect(by.tracker_created!).toMatchObject({ actors: { n: 6 }, fromPrevious: null, fromStart: 0.5 });
    expect(v.ingest.eventsDb).toBe("ok");
    expect(v.ingest.onboardingEventRows).toBe(v.ingest.eventRows);
    expect(v.ingest.lastEventAt).toBe(new Date(NOW - DAY_MS).toISOString());
  });

  it("builds weekly retention cohorts of signed-in students and hides small cohorts whole", async () => {
    await seedRetention(h.edb!);
    const v = await view(h, await signIn(h, ["admin"]), "?weeks=4");
    expect(v.retention.cohorts.map((c) => c.weekStart)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(v.retention.measured).toBe(true);
    const a = v.retention.cohorts[0]!;
    expect(a.size).toEqual({ n: 8, hidden: false });
    expect(a.weeks.map((w) => w.actors.n)).toEqual([8, 6, null, 5]);
    expect(a.weeks.map((w) => w.rate)).toEqual([1, 0.75, null, 0.625]);
    expect(a.weeks.map((w) => w.partial)).toEqual([false, false, false, true]);
    const b = v.retention.cohorts[2]!;
    expect(b.size.hidden).toBe(true);
    expect(b.weeks.every((w) => w.actors.hidden && w.rate === null)).toBe(true);
    // Week W-2 had 7 page-view-only students and no new active ones.
    expect(v.retention.cohorts[1]!.size).toEqual({ n: 0, hidden: false });
  });

  it("counts Tracker and reminder engagement for counted students only", async () => {
    const { off } = await seedTracker(h.t);
    await seedOnboarding(h.t, off);
    const v = await view(h, await signIn(h, ["admin"]), "?weeks=4");
    const e = v.engagement;
    expect(e.weeks.map((w) => w.weekStart)).toEqual(["2026-10-19", "2026-10-26", "2026-11-02", "2026-11-09"]);
    expect(e.weeks.map((w) => w.trackerItemsAdded.n)).toEqual([0, 0, 14, 6]);
    expect(e.weeks.map((w) => w.studentsAdding.n)).toEqual([0, 0, 14, 6]);
    expect(e.weeks.map((w) => w.remindersScheduled.n)).toEqual([0, 0, 7, 7]);
    expect(e.weeks.map((w) => w.remindersSent.n)).toEqual([0, 0, 7, 0]);
    expect(e.weeks[3]!.remindersCancelled).toEqual({ n: null, hidden: true });
    expect(e.weeks[3]!.partial).toBe(true);
    expect(e.studentsTracking).toEqual({ n: 20, hidden: false });
    expect(e.studentsWithUpcomingReminder).toEqual({ n: 5, hidden: false });
    expect(e.trackerStatus.total).toEqual({ n: 20, hidden: false });
    expect(Object.fromEntries(e.trackerStatus.cells.map((c) => [c.key, c.count.n]))).toEqual({ interested: 8, applying: 12, submitted: 0, decided: 0, not_applying: 0 });
    expect(e.remindedItems).toEqual({ items: { n: 7, hidden: false }, progressed: { n: 6, hidden: false }, rate: 0.857 });
    expect(e.unremindedItems).toEqual({ items: { n: 13, hidden: false }, progressed: { n: 6, hidden: false }, rate: 0.462 });
    // Onboarding cross-check: 6 counted records in the window; "completed" (2) is hidden.
    expect(v.funnel.serverRecorded).toEqual({ records: { n: 6, hidden: false }, quizSaved: { n: 6, hidden: false }, firstDoorChosen: { n: 5, hidden: false }, completed: { n: null, hidden: true } });
  });

  it("never counts a student in minor mode, using the same adult boundary as adultFrom()", async () => {
    const cycle = await trackableCycle(h.t);
    const seriesFrom = weekStartMs(W - 3);
    const snapshot = async () => ({
      tracker: await trackerSnapshot(h.t.db, NOW),
      weeks: [...(await engagementWeeks(h.t.db, seriesFrom, NOW)).values()],
      onboarding: await onboardingRecordCounts(h.t.db, NOW - 28 * DAY_MS, NOW, NOW),
    });
    const student = async (birthYearMonth: string | null) => {
      const userId = await createUser(h.t.db);
      if (birthYearMonth !== null) await h.t.db.insert(s.studentProfiles).values({ userId, birthYearMonth });
      await h.t.db.insert(s.trackerItems).values({ id: uuidv7(NOW - DAY_MS), userId, programCycleId: cycle, status: "applying", createdAt: NOW - DAY_MS, updatedAt: NOW - DAY_MS });
      await h.t.db.insert(s.onboardingRecords).values({ userId, preferences: { categories: ["internships"] }, step: "matches", createdAt: NOW - DAY_MS, updatedAt: NOW - DAY_MS });
      return userId;
    };
    const before = await snapshot();
    // 17 (born 2009-06) and 17 until next month (born 2008-11, adult from 2026-12-01): no change.
    expect(NOW).toBeLessThan(adultFrom("2008-11"));
    await student("2009-06");
    await student("2008-11");
    expect(await snapshot()).toEqual(before);
    // Adult since 2026-11-01 (born 2008-10), and a profile with no birth month: both count.
    expect(NOW).toBeGreaterThanOrEqual(adultFrom("2008-10"));
    await student("2008-10");
    await student(null);
    const after = await snapshot();
    expect(after.tracker.studentsTracking).toBe(before.tracker.studentsTracking + 2);
    expect(after.tracker.byStatus.get("applying")).toBe((before.tracker.byStatus.get("applying") ?? 0) + 2);
    expect(after.onboarding.records).toBe(before.onboarding.records + 2);
    expect(after.weeks.reduce((n, w) => n + w.trackerItemsAdded, 0)).toBe(before.weeks.reduce((n, w) => n + w.trackerItemsAdded, 0) + 2);
  });

  it("reports registry freshness for real and sample programs separately", async () => {
    const { samplePublished } = await seedFreshness(h.t);
    const v = await view(h, await signIn(h, ["admin"]));
    expect(v.freshness.real).toEqual({
      published: 4,
      verifiedWithinWindow: 2,
      share: 0.5,
      neverVerified: 1,
      medianDaysSinceVerification: 20,
      ageBuckets: [
        { key: "0-7", n: 1 },
        { key: "8-14", n: 0 },
        { key: "15-30", n: 1 },
        { key: "31-90", n: 1 },
        { key: "90+", n: 0 },
        { key: "never", n: 1 },
      ],
    });
    expect(v.freshness.sample).toMatchObject({ published: samplePublished, verifiedWithinWindow: 0, neverVerified: samplePublished, medianDaysSinceVerification: null });
  });

  it("never returns an identifier, a small shown count, or a key outside the schema", async () => {
    await seedFunnel(h.edb!);
    await seedRetention(h.edb!);
    const { off } = await seedTracker(h.t);
    await seedOnboarding(h.t, off);
    const res = await get(h, await signIn(h, ["admin"]));
    const text = await res.text();
    expect(text).not.toMatch(/device-|hmac-|@example\.org|tok-/);
    const v = AdminMetricsViewSchema.parse(JSON.parse(text));
    const cells: { n: number | null }[] = [];
    const walk = (x: unknown) => {
      if (x && typeof x === "object") {
        if ("hidden" in x && "n" in x) cells.push(x as { n: number | null });
        for (const value of Object.values(x)) walk(value);
      }
    };
    walk(v.funnel);
    walk(v.retention);
    walk(v.engagement);
    expect(cells.length).toBeGreaterThan(40);
    for (const c of cells) expect(c.n === null || c.n === 0 || c.n >= 5).toBe(true);
  });

  it("reads empty, not broken, without the events database", async () => {
    const bare = await setup(false);
    const v = await view(bare, await signIn(bare, ["admin"]));
    expect(v.ingest).toEqual({ eventsDb: "unbound", eventRows: 0, onboardingEventRows: 0, lastEventAt: null });
    expect(v.funnel.steps.every((st) => st.actors.n === 0)).toBe(true);
    expect(v.retention).toEqual({ measured: false, cohorts: [] });
  });

  it("marks retention not measured when events exist but none carries a keyed actor (today's ingest)", async () => {
    await seedFunnel(h.edb!);
    const v = await view(h, await signIn(h, ["admin"]));
    expect(v.ingest.eventRows).toBeGreaterThan(0);
    expect(v.retention).toEqual({ measured: false, cohorts: [] });
  });
});
