import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { OutcomeReportSchema } from "@shared/contracts/advisor";
import { ProblemDetailsSchema } from "@shared/contracts/common";
import { OutcomeSummarySchema } from "@shared/readiness/outcomes";
import type { AppEnv, SessionUser } from "@server/env";
import { uuidv7 } from "@server/db/columns";
import * as s from "@server/db/schema";
import { sampleIds } from "@server/db/seed/build";
import { createUser, seededDb, type TestDb } from "@server/db/testing/fixtures";
import { requireSignedIn } from "@server/api/v1/student/routes";
import { createD1OutcomesStore, OVER_COUNT_REASON } from "./d1";
import { ageFromBirthMonth, createOutcomesRoutes, seasonStartMs } from "./routes";

/** Seed "today" is 2026-11-11; the application deadline is 80 days later (2027-01-30). */
const NOW = Date.parse("2027-05-01T15:00:00Z");
const SLUG = "sample-summer-research-fellowship";
const CYCLE = sampleIds.cycle(SLUG);
const SENSITIVE_CYCLE = sampleIds.cycle("sample-phd-pathway-program");
const IDENTITY_CYCLE = sampleIds.cycle("sample-women-in-computing-cohort");

function user(id: string): SessionUser {
  return {
    id,
    publicId: "PubTestUser0000000000",
    email: "student@example.org",
    displayName: null,
    roles: ["student"],
    onboarded: true,
    grants: [{ role: "student", scope: { kind: "global" } }],
    sessionId: `sess-${id}`,
    sessionExpiresAt: NOW + 86_400_000,
    surface: "app",
    secondFactor: { enrolled: false, verified: false },
  };
}

let t: TestDb;
let audited: { userId: string }[];
let app: Hono<AppEnv>;

function makeApp(now = NOW) {
  const a = new Hono<AppEnv>();
  a.use("*", async (c, next) => {
    const token = c.req.header("authorization")?.replace("Bearer ", "");
    if (token) c.set("user", user(token));
    c.set("requestId", "req-test");
    await next();
  });
  a.route(
    "/api/v1",
    createOutcomesRoutes({
      store: () => createD1OutcomesStore(t.db, { subjectKey: async (u) => (audited.push({ userId: u }), "s1:test") }),
      requireStudent: requireSignedIn,
      userId: (c) => c.get("user")?.id ?? null,
      now: () => now,
    }),
  );
  return a;
}

async function call(method: string, path: string, opts: { user?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (opts.user) headers.authorization = `Bearer ${opts.user}`;
  const res = await app.request(path, { method, headers, body: opts.body === undefined ? undefined : JSON.stringify(opts.body) });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : null, text, headers: res.headers };
}

async function track(userId: string, programCycleId = CYCLE) {
  await t.db.insert(s.trackerItems).values({ id: uuidv7(), userId, programCycleId, status: "decided" });
}

const REPORT = {
  programCycleId: CYCLE,
  stages: [
    { stage: "submitted", on: "2027-01-20" },
    { stage: "interview_invited", on: "2027-03-01" },
  ],
  decision: "accepted",
  decidedOn: "2027-04-10",
};

beforeEach(async () => {
  t = await seededDb("2026-11-11");
  audited = [];
  app = makeApp();
});

describe("POST /api/v1/me/outcomes", () => {
  it("requires a session", async () => {
    expect((await call("POST", "/api/v1/me/outcomes", { body: REPORT })).status).toBe(401);
    expect((await call("GET", "/api/v1/me/outcomes")).status).toBe(401);
  });

  it("needs the program on the student's Tracker", async () => {
    const u = await createUser(t.db);
    const res = await call("POST", "/api/v1/me/outcomes", { user: u, body: REPORT });
    expect(res.status).toBe(409);
    expect(ProblemDetailsSchema.parse(res.body).code).toBe("conflict");
  });

  it("records one report per cycle with the server-side tier and no internal ids", async () => {
    const u = await createUser(t.db);
    await track(u);
    const res = await call("POST", "/api/v1/me/outcomes", { user: u, body: REPORT });
    expect(res.status).toBe(201);
    const report = OutcomeReportSchema.parse(res.body);
    expect(report).toMatchObject({ tier: "self_reported", decision: "accepted", qualityState: "ok", programCycleId: CYCLE });
    expect(report.stages.map((st) => st.stage)).toEqual(["submitted", "interview_invited"]);
    expect(res.text).not.toContain(u);
    expect(res.headers.get("cache-control")).toBe("no-store");

    const again = await call("POST", "/api/v1/me/outcomes", { user: u, body: REPORT });
    expect(again.status).toBe(409);
    const list = await call("GET", "/api/v1/me/outcomes", { user: u });
    expect((list.body as { items: unknown[] }).items).toHaveLength(1);
    // Another student sees nothing of it.
    const other = await createUser(t.db);
    expect((await call("GET", "/api/v1/me/outcomes", { user: other })).body).toEqual({ items: [] });
  });

  it("refuses status or identity keys before validation", async () => {
    const u = await createUser(t.db);
    await track(u);
    const res = await call("POST", "/api/v1/me/outcomes", { user: u, body: { ...REPORT, firstGen: "yes" } });
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(res.body).code).toBe("sensitive_field_rejected");
    expect(await t.db.select().from(s.outcomes)).toHaveLength(0);
  });

  it("answers 404 for status-defined programs and asks for consent on identity-defined ones", async () => {
    const u = await createUser(t.db);
    const sensitive = await call("POST", "/api/v1/me/outcomes", { user: u, body: { ...REPORT, programCycleId: SENSITIVE_CYCLE } });
    expect(sensitive.status).toBe(404);
    const unknown = await call("POST", "/api/v1/me/outcomes", { user: u, body: { ...REPORT, programCycleId: uuidv7() } });
    expect(unknown.status).toBe(404);
    // Same body shape for both: nothing tells an observer that the cycle exists.
    expect(ProblemDetailsSchema.parse(sensitive.body).code).toBe(ProblemDetailsSchema.parse(unknown.body).code);
    const identity = await call("POST", "/api/v1/me/outcomes", { user: u, body: { ...REPORT, programCycleId: IDENTITY_CYCLE } });
    expect(identity.status).toBe(409);
    expect(ProblemDetailsSchema.parse(identity.body).code).toBe("consent_required");
  });

  it("refuses reports that cannot be true, with field paths and fixed messages", async () => {
    const u = await createUser(t.db);
    await track(u);
    const res = await call("POST", "/api/v1/me/outcomes", {
      user: u,
      body: { ...REPORT, stages: [{ stage: "submitted", on: "2027-03-02" }, { stage: "interview_invited", on: "2027-03-01" }], decidedOn: "2027-06-01" },
    });
    expect(res.status).toBe(400);
    const problem = ProblemDetailsSchema.parse(res.body);
    expect(problem.code).toBe("validation_failed");
    expect(problem.errors?.map((e) => e.path).sort()).toEqual(["decidedOn", "stages.1.on"]);
    expect(res.text).not.toContain("2027-06-01");
    expect(await t.db.select().from(s.outcomes)).toHaveLength(0);
  });

  it("stores reports that need a look as flagged", async () => {
    const u = await createUser(t.db);
    await track(u);
    // A decision before the application round closed.
    const res = await call("POST", "/api/v1/me/outcomes", { user: u, body: { ...REPORT, stages: [{ stage: "submitted", on: "2027-01-02" }], decidedOn: "2027-01-10" } });
    expect(res.status).toBe(201);
    expect(OutcomeReportSchema.parse(res.body).qualityState).toBe("flagged");
    const [row] = await t.db.select({ flags: s.outcomes.flagCodes }).from(s.outcomes);
    expect(row?.flags).toEqual(["decision_before_round_close"]);
  });

  it("refuses accounts linked to the program's Organization", async () => {
    const u = await createUser(t.db);
    await track(u);
    const [program] = await t.db.select({ org: s.programs.organizationId }).from(s.programs).where(eq(s.programs.slug, SLUG));
    await t.db.insert(s.userRoles).values({ id: uuidv7(), userId: u, role: "sponsor_admin", organizationId: program!.org });
    const res = await call("POST", "/api/v1/me/outcomes", { user: u, body: REPORT });
    expect(res.status).toBe(403);
  });

  it("asks students under 18 to turn on outcome sharing first", async () => {
    const u = await createUser(t.db);
    await track(u);
    await t.db.insert(s.studentProfiles).values({ userId: u, birthYearMonth: "2010-05" });
    const res = await call("POST", "/api/v1/me/outcomes", { user: u, body: REPORT });
    expect(res.status).toBe(409);
    expect(ProblemDetailsSchema.parse(res.body).code).toBe("consent_required");
    expect(ageFromBirthMonth("2010-05", "2027-05-01")).toBe(16);
    expect(ageFromBirthMonth("2009-06", "2027-05-01")).toBe(17);
    expect(ageFromBirthMonth("2009-05", "2027-05-30")).toBe(17);
    expect(ageFromBirthMonth("2009-05", "2027-05-31")).toBe(18);
    expect(ageFromBirthMonth(null, "2027-05-01")).toBeNull();
  });
});

describe("PATCH /api/v1/me/outcomes/:publicId", () => {
  it("edits the student's own report and audits field names only", async () => {
    const u = await createUser(t.db);
    await track(u);
    const created = OutcomeReportSchema.parse((await call("POST", "/api/v1/me/outcomes", { user: u, body: { ...REPORT, decision: null, decidedOn: null } })).body);
    const res = await call("PATCH", `/api/v1/me/outcomes/${created.publicId}`, { user: u, body: { decision: "rejected", decidedOn: "2027-04-12" } });
    expect(res.status).toBe(200);
    expect(OutcomeReportSchema.parse(res.body)).toMatchObject({ decision: "rejected", decidedOn: "2027-04-12" });
    const audit = await t.db.select().from(s.accessAudit);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ action: "update", purpose: "outcome_edit", fields: ["outcome.decidedOn", "outcome.decision"], subjectKey: "s1:test" });
    expect(JSON.stringify(audit)).not.toContain("rejected");

    const other = await createUser(t.db);
    expect((await call("PATCH", `/api/v1/me/outcomes/${created.publicId}`, { user: other, body: { decision: "accepted" } })).status).toBe(404);
  });

  it("closes edits 60 days after the decision", async () => {
    const u = await createUser(t.db);
    await track(u);
    const created = OutcomeReportSchema.parse((await call("POST", "/api/v1/me/outcomes", { user: u, body: REPORT })).body);
    app = makeApp(Date.parse("2027-06-10T12:00:00Z"));
    expect((await call("PATCH", `/api/v1/me/outcomes/${created.publicId}`, { user: u, body: { decision: "declined_offer" } })).status).toBe(409);
  });
});

/** Inserts counted reports directly (edu verification, the only way to reach a counted tier, is not built). */
async function countedReports(n: number, opts: { createdAt?: number; tier?: string } = {}) {
  for (let i = 0; i < n; i++) {
    const userId = await createUser(t.db);
    const id = uuidv7();
    await t.db.insert(s.outcomes).values({
      id,
      userId,
      programCycleId: CYCLE,
      tier: opts.tier ?? "institution_email",
      decision: i % 3 === 0 ? "accepted" : "rejected",
      decidedOn: "2027-04-10",
      createdAt: opts.createdAt ?? NOW - 3 * 86_400_000,
      updatedAt: NOW,
    });
    await t.db.insert(s.outcomeStages).values({ outcomeId: id, stage: "submitted", onDate: "2027-01-20", createdAt: NOW });
  }
}

describe("GET /api/v1/programs/:slug/outcomes/summary", () => {
  it("releases nothing below five counted reports", async () => {
    await countedReports(4);
    await countedReports(10, { tier: "self_reported" });
    const res = await call("GET", `/api/v1/programs/${SLUG}/outcomes/summary`);
    expect(res.status).toBe(200);
    const summary = OutcomeSummarySchema.parse(res.body);
    const cycle = summary.cycles.find((c) => c.cycleKey)!;
    expect(cycle.reports).toMatchObject({ suppressed: true, reason: "below_min_total" });
    expect(cycle.decisions.suppressed).toBe(true);
    expect(summary.bands.status).toBe("official_base_rate_only");
    expect(summary.isSample).toBe(true);
  });

  it("bands counts through shared/disclosure and never carries a row", async () => {
    await countedReports(23);
    const res = await call("GET", `/api/v1/programs/${SLUG}/outcomes/summary`);
    const summary = OutcomeSummarySchema.parse(res.body);
    const cycle = summary.cycles[0]!;
    expect(cycle.reports).toMatchObject({ suppressed: false, total: "25" });
    const decisions = cycle.decisions.suppressed ? {} : Object.fromEntries(cycle.decisions.cells.map((c) => [c.key, c.label]));
    expect(decisions.accepted).toBe("fewer than 10");
    expect(res.text).not.toMatch(/"(id|userId|publicId|decidedOn)"/);
    expect(res.text).not.toContain("2027-04-10");
    expect(res.headers.get("cache-control")).toContain("public");
  });

  it("uses fixed daily windows: today's reports wait for tomorrow", async () => {
    await countedReports(4);
    await countedReports(3, { createdAt: NOW - 60_000 });
    const summary = OutcomeSummarySchema.parse((await call("GET", `/api/v1/programs/${SLUG}/outcomes/summary`)).body);
    expect(summary.cycles[0]!.reports.suppressed).toBe(true);
  });

  it("releases nothing for a held cycle", async () => {
    await countedReports(23);
    await t.db.insert(s.reviewTasks).values({
      id: uuidv7(),
      kind: "outcome_anomaly",
      subjectType: "program_cycle",
      subjectId: CYCLE,
      dedupeKey: `outcome_anomaly:program_cycle:${CYCLE}`,
      reasonCodes: [OVER_COUNT_REASON],
    });
    const summary = OutcomeSummarySchema.parse((await call("GET", `/api/v1/programs/${SLUG}/outcomes/summary`)).body);
    expect(summary.cycles[0]).toMatchObject({ held: true, reports: { suppressed: true, reason: "held" } });
  });

  it("answers 404 for status-defined and unknown programs", async () => {
    expect((await call("GET", "/api/v1/programs/sample-phd-pathway-program/outcomes/summary")).status).toBe(404);
    expect((await call("GET", "/api/v1/programs/no-such-program/outcomes/summary")).status).toBe(404);
  });
});

describe("helpers", () => {
  it("starts the season on 1 July", () => {
    expect(new Date(seasonStartMs("2027-05-01")).toISOString().slice(0, 10)).toBe("2026-07-01");
    expect(new Date(seasonStartMs("2027-07-01")).toISOString().slice(0, 10)).toBe("2027-07-01");
  });
});
