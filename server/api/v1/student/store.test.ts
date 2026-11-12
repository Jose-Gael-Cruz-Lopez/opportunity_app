import { beforeAll, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { AskResponseSchema, ReadinessResponseSchema, RoadmapSchema, TrackerItemSchema } from "@shared/contracts";
import { createAi } from "@server/ai";
import * as s from "@server/db/schema";
import * as onboarding from "@server/db/repos/onboarding";
import { sampleIds } from "@server/db/seed/build";
import { createUser, seededDb, type TestDb } from "@server/db/testing/fixtures";
import type { AppEnv, SessionUser } from "@server/env";
import { createStudentRoutes } from "./routes";
import { createD1StudentStore } from "./store";

/**
 * The D1 store end to end: the real repositories, migrations, triggers and the SAMPLE seed (every
 * program is invented and labelled "Sample"), behind the same routes the Worker mounts.
 */

const NOW = Date.parse("2026-11-11T16:00:00Z");
const NOMINATED = "sample-national-stem-scholarship";
const OPEN = "sample-reu-site-ecology";
/** Sample status-defined program. */
const RESTRICTED = "sample-phd-pathway-program";

let t: TestDb;
let app: Hono<AppEnv>;
const users = new Map<string, SessionUser>();

async function signIn(): Promise<string> {
  const id = await createUser(t.db);
  users.set(id, {
    id,
    publicId: `Pub${id.replace(/-/g, "")}`.slice(0, 32),
    email: `${id}@example.org`,
    displayName: null,
    roles: ["student"],
    onboarded: true,
    grants: [{ role: "student", scope: { kind: "global" } }],
    sessionId: `sess-${id}`,
    sessionExpiresAt: NOW + 86_400_000,
    surface: "app",
    secondFactor: { enrolled: false, verified: false },
  });
  return id;
}

function call(method: string, path: string, who: string, body?: unknown) {
  return app.request(`/api/v1${path}`, {
    method,
    headers: { authorization: `Bearer ${who}`, ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

beforeAll(async () => {
  t = await seededDb("2026-11-11");
  app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const u = users.get(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (u) c.set("user", u);
    c.set("requestId", "req-test");
    await next();
  });
  const ai = createAi({}, { clock: { now: () => NOW }, log: () => {} });
  app.route(
    "/api/v1",
    createStudentRoutes({ store: () => createD1StudentStore(t.db), ai: () => ai, now: () => NOW, origin: () => "https://novus.example.org" }),
  );
});

describe("D1 student store", () => {
  it("computes readiness for a seeded sample cycle with status rules left to the device", async () => {
    const who = await signIn();
    await call("PATCH", "/me/profile", who, {
      classYear: "second_year",
      enrollmentIntensity: "full_time",
      institutionId: sampleIds.institution("sample-state-university"),
      timeZone: "America/Chicago",
    });
    const res = await call("GET", `/me/readiness/${sampleIds.cycle(NOMINATED)}`, who);
    expect(res.status).toBe(200);
    const { report } = ReadinessResponseSchema.parse(await res.json());
    expect(report.programSlug).toBe(NOMINATED);
    const citizenship = report.eligibility.rules.find((r) => r.dimension === "citizenship");
    expect(citizenship).toMatchObject({ sensitive: true, verdict: "unknown", reasonCode: "SENSITIVE_ON_DEVICE" });
    expect(report.requirements.items.length).toBeGreaterThan(0);
    expect(report.nextActions.length).toBeGreaterThan(0);
  });

  it("answers 404 for a status-defined sample program and refuses to track it without consent", async () => {
    const who = await signIn();
    expect((await call("GET", `/me/readiness/${sampleIds.cycle(RESTRICTED)}`, who)).status).toBe(404);
    const refused = await call("POST", "/me/tracker", who, { programCycleId: sampleIds.cycle(RESTRICTED) });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("consent_required");
  });

  it("tracks a cycle and plans it on the roadmap", async () => {
    const who = await signIn();
    const created = await call("POST", "/me/tracker", who, { programCycleId: sampleIds.cycle(OPEN), status: "applying" });
    expect(created.status).toBe(201);
    expect(TrackerItemSchema.parse(await created.json()).programSlug).toBe(OPEN);
    const roadmap = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", who)).json());
    const apply = roadmap.terms.flatMap((term) => term.apply);
    expect(apply.map((i) => i.programSlug)).toEqual([OPEN]);
    expect(apply[0]?.reasonCodes).toContain("sample_record");
    // The visit is stored, so a second read reports no changes.
    const again = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", who)).json());
    expect(again.changedSinceLastVisit).toEqual([]);
  });

  it("shows the first-door plan's steps as Prepare items that survive a reload, with stored state", async () => {
    const who = await signIn();
    const created = TrackerItemSchema.parse(await (await call("POST", "/me/tracker", who, { programCycleId: sampleIds.cycle(OPEN), status: "applying" })).json());
    const program = (await t.db.query.programs.findFirst({ where: eq(s.programs.slug, OPEN) }))!;
    const steps = [
      { id: "s1", title: "Ask a professor for a letter", kind: "letter", minutes: 15, due: "2026-11-20" },
      { id: "s2", title: "Draft your personal statement", kind: "essay", minutes: 90, due: "2026-11-25" },
      { id: "submit", title: "Submit the application", kind: "submit", minutes: 30, due: "2026-12-01" },
    ];
    await onboarding.saveOnboardingRecord(
      t.db,
      who,
      { preferences: null, signals: null, step: "done", completedAt: NOW, firstDoor: { programId: program.id, programCycleId: sampleIds.cycle(OPEN), trackerItemId: created.id, steps } },
      NOW,
    );
    const s1Key = `prep:${program.id}:${created.cycleKey}:s1`;
    await onboarding.upsertRoadmapRows(t.db, who, [{ itemKey: s1Key, programId: program.id, pinned: false, state: "done" }], NOW);
    for (let i = 0; i < 2; i++) {
      const roadmap = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", who)).json());
      const prepare = roadmap.terms.flatMap((term) => term.prepare);
      expect(prepare.map((p) => p.title)).toEqual(["Ask a professor for a letter", "Draft your personal statement"]);
      expect(prepare[0]).toMatchObject({ itemKey: s1Key, kind: "prepare", state: "done", dueOn: "2026-11-20", programSlug: OPEN, reasonCodes: expect.arrayContaining(["FIRST_DOOR"]) });
      expect(prepare[1]).toMatchObject({ state: "open", dueOn: "2026-11-25", dateConfidence: "estimated" });
    }
    // Untracking the cycle (not applying) removes its plan from the roadmap.
    await call("PATCH", `/me/tracker/${created.id}`, who, { status: "not_applying", version: created.version });
    const after = RoadmapSchema.parse(await (await call("GET", "/me/roadmap", who)).json());
    expect(after.terms.flatMap((term) => term.prepare)).toEqual([]);
  });

  it("stores only non-sensitive profile fields and refuses a status key", async () => {
    const who = await signIn();
    const res = await call("PATCH", "/me/profile", who, { classYear: "first_year", veteranStatus: "yes" });
    expect(res.status).toBe(400);
    const row = await t.db.query.studentProfiles.findFirst({ where: eq(s.studentProfiles.userId, who) });
    expect(row).toBeUndefined();
  });

  it("rotates the calendar feed and keeps only the token hash", async () => {
    const who = await signIn();
    const res = await call("POST", "/me/calendar-feed/rotate", who);
    const { url } = (await res.json()) as { url: string };
    const token = /\/cal\/u\/([A-Za-z0-9_-]+)\.ics$/.exec(url)?.[1] ?? "";
    expect(token.length).toBeGreaterThanOrEqual(16);
    const feeds = await t.db.select().from(s.calendarFeeds).where(eq(s.calendarFeeds.userId, who));
    expect(feeds).toHaveLength(1);
    expect(JSON.stringify(feeds)).not.toContain(token);
  });

  it("retrieves registry records for Ask Novus by slug and by search", async () => {
    const who = await signIn();
    const named = AskResponseSchema.parse(await (await call("POST", "/me/ask", who, { question: "What do I need?", programSlug: NOMINATED })).json());
    expect(named.programRefs[0]?.slug).toBe(NOMINATED);
    expect(named.meta.status).toBe("unavailable");
    const open = await call("POST", "/me/ask", who, { question: "ecology research site" });
    expect(open.status).toBe(200);
    expect(AskResponseSchema.parse(await open.json()).programRefs.map((r) => r.slug)).toContain(OPEN);
  });
});
