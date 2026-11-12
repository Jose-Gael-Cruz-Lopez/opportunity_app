import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import { ProgramListSchema, ProblemDetailsSchema, WorkspaceReportSchema } from "@shared/contracts";
import type { Role } from "@shared/taxonomy";
import type { AppEnv, SessionUser } from "@server/env";
import type { RoleGrant } from "@server/auth";
import { SECOND_FACTOR_PROBLEM_TYPE } from "@server/auth";
import type { EventsDb } from "@server/db/client";
import * as s from "@server/db/schema";
import { analyticsEvents } from "@server/db/events-schema";
import { uuidv7 } from "@server/db/columns";
import * as advisorRepo from "@server/db/repos/advisor";
import { changeConsent, grantRole } from "@server/db/repos/students";
import { sampleIds } from "@server/db/seed/build";
import { createUser, freshEventsDb, seededDb, type TestDb } from "@server/db/testing/fixtures";
import { requireAdvisorRole } from "./index";
import { createAdvisorRoutes } from "./routes";

const NOW = Date.parse("2026-11-11T15:00:00Z");
const OPEN = "sample-reu-site-ecology";
const SECOND = "sample-sprinternship";
/** Sample status-audience program: restricted, never counted. */
const RESTRICTED = "sample-phd-pathway-program";

interface Harness {
  app: Hono<AppEnv>;
  t: TestDb;
  users: Map<string, SessionUser>;
  wsA: string;
  wsB: string;
  advisorA: string;
  advisorB: string;
  student: string;
}

/** A session as server/auth's sessionMiddleware builds it; staff sessions pass TOTP unless told otherwise. */
async function signIn(h: Pick<Harness, "users" | "t">, roles: Role[], workspaceId?: string, opts: { totp?: boolean } = {}): Promise<string> {
  const id = await createUser(h.t.db);
  for (const role of roles) await grantRole(h.t.db, id, role, NOW, workspaceId ? { workspaceId } : {});
  const token = `tok-${id}`;
  const grants: RoleGrant[] = [
    { role: "student", scope: { kind: "global" } },
    ...roles
      .filter((r) => r !== "student")
      .map((role): RoleGrant => (role === "advisor" && workspaceId ? { role, scope: { kind: "workspace", workspaceId, level: "advisor" } } : { role, scope: { kind: "global" } })),
  ];
  const verified = opts.totp ?? true;
  h.users.set(token, {
    id,
    publicId: `u_${id.slice(-12)}`,
    email: `${id}@example.org`,
    displayName: null,
    roles: [...new Set<Role>(["student", ...roles])],
    onboarded: true,
    grants,
    sessionId: `sess-${id}`,
    sessionExpiresAt: NOW + 3_600_000,
    surface: "app",
    secondFactor: { enrolled: true, verified },
  });
  return token;
}

async function setup(opts: { eventsDb?: EventsDb | null } = {}): Promise<Harness> {
  const t = await seededDb();
  const users = new Map<string, SessionUser>();
  const wsA = await advisorRepo.createWorkspace(t.db, { name: "Sample Pilot A", approvedBy: "founder", institutionId: sampleIds.institution("sample-state-university") }, NOW);
  const wsB = await advisorRepo.createWorkspace(t.db, { name: "Sample Pilot B", approvedBy: "founder" }, NOW);
  const h = { t, users };
  const advisorA = await signIn(h, ["advisor"], wsA);
  const advisorB = await signIn(h, ["advisor"], wsB);
  const student = await signIn(h, ["student"]);

  const app = new Hono<AppEnv>();
  // Stand-in for server/auth's sessionMiddleware.
  app.use("*", async (c, next) => {
    const user = users.get(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (user) c.set("user", user);
    c.set("requestId", "test");
    await next();
  });
  app.route(
    "/api/v1",
    createAdvisorRoutes({
      requireAdvisor: requireAdvisorRole,
      user: (c) => c.get("user"),
      db: () => t.db,
      eventsDb: () => opts.eventsDb ?? null,
      now: () => NOW,
    }),
  );
  return { app, t, users, wsA, wsB, advisorA, advisorB, student };
}

function call(h: Harness, method: string, path: string, token?: string, body?: unknown, headers: Record<string, string> = {}) {
  return h.app.request(`/api/v1${path}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function createList(h: Harness, items: string[], visibility: "public" | "unlisted" = "unlisted", note: string | null = null) {
  const res = await call(h, "POST", `/workspaces/${h.wsA}/lists`, h.advisorA, {
    title: "Sample sophomore picks",
    visibility,
    items: items.map((programSlug) => ({ programSlug, cycleKey: null, note })),
  });
  expect(res.status).toBe(201);
  return ProgramListSchema.parse(await res.json());
}

/** Inserts `n` live trackers (one per new student) on a sample program with the given status. */
async function addTrackers(h: Harness, slug: string, n: number, status = "interested", consented = false) {
  for (let i = 0; i < n; i++) {
    const userId = await createUser(h.t.db);
    // Status-audience programs need the student's tracking consent (a database guard enforces it).
    if (consented) {
      const res = await changeConsent(h.t.db, userId, { kind: "sensitive_tracking", textVersion: "st-1", programId: sampleIds.program(slug), granted: true }, NOW);
      expect(res.ok).toBe(true);
    }
    await h.t.db.insert(s.trackerItems).values({ id: uuidv7(), userId, programCycleId: sampleIds.cycle(slug), status, createdAt: NOW, updatedAt: NOW });
  }
}

describe("advisor routes: permissions", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("answers 401 without a session and 403 for a student", async () => {
    const anon = await call(h, "GET", "/workspaces");
    expect(anon.status).toBe(401);
    expect(ProblemDetailsSchema.parse(await anon.json()).code).toBe("unauthenticated");
    const student = await call(h, "GET", "/workspaces", h.student);
    expect(student.status).toBe(403);
    expect((await call(h, "GET", `/workspaces/${h.wsA}/progress`, h.student)).status).toBe(403);
  });

  it("answers 403 second-factor-required to an advisor whose session has not passed TOTP", async () => {
    const pending = await signIn(h, ["advisor"], h.wsA, { totp: false });
    for (const path of ["/workspaces", `/workspaces/${h.wsA}/lists`, `/workspaces/${h.wsA}/progress`, `/workspaces/${h.wsA}/reports/2026-11`]) {
      const res = await call(h, "GET", path, pending);
      expect(res.status, path).toBe(403);
      const body = ProblemDetailsSchema.parse(await res.json());
      expect(body.type).toBe(SECOND_FACTOR_PROBLEM_TYPE);
    }
    const write = await call(h, "POST", `/workspaces/${h.wsA}/lists`, pending, { title: "Sample picks", items: [] });
    expect(write.status).toBe(403);
  });

  it("refuses a workspace route when the session holds no grant for that workspace", async () => {
    // A global advisor role (no workspace scope) passes requireRole but not the scoped matrix row.
    const unscoped = await signIn(h, ["advisor"]);
    await grantRole(h.t.db, h.users.get(unscoped)!.id, "advisor", NOW, { workspaceId: h.wsA });
    expect((await call(h, "GET", `/workspaces/${h.wsA}/lists`, unscoped)).status).toBe(404);
  });

  it("lists only the advisor's own workspaces", async () => {
    const res = await call(h, "GET", "/workspaces", h.advisorA);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { items: { id: string }[] };
    expect(body.items.map((w) => w.id)).toEqual([h.wsA]);
  });

  it("hides another workspace behind 404 on every workspace route", async () => {
    const list = await createList(h, [OPEN]);
    const paths: [string, string, unknown?][] = [
      ["GET", `/workspaces/${h.wsA}/lists`],
      ["POST", `/workspaces/${h.wsA}/lists`, { title: "Hijack", items: [] }],
      ["GET", `/workspaces/${h.wsA}/lists/${list.id}`],
      ["GET", `/workspaces/${h.wsA}/lists/${list.id}/export.csv`],
      ["DELETE", `/workspaces/${h.wsA}/lists/${list.id}`],
      ["PATCH", `/lists/${list.id}`, { title: "Hijack" }],
      ["GET", `/workspaces/${h.wsA}/progress`],
      ["GET", `/workspaces/${h.wsA}/reports/2026-11`],
      ["GET", `/workspaces/${h.wsA}/reports/2026-11/export.csv`],
      ["GET", `/workspaces/${h.wsA}/campus-deadlines`],
      ["POST", `/workspaces/${h.wsA}/campus-deadlines`, { programSlug: OPEN, cycleKey: "summer-2027", kind: "nomination", localDate: "2026-12-01", localTime: null, timeZone: "America/New_York", sourceUrl: null, note: null }],
    ];
    for (const [method, path, body] of paths) {
      const res = await call(h, method, path, h.advisorB, body);
      expect(res.status, `${method} ${path}`).toBe(404);
    }
    // Workspace A's list is untouched.
    const still = await call(h, "GET", `/workspaces/${h.wsA}/lists/${list.id}`, h.advisorA);
    expect(((await still.json()) as { title: string }).title).toBe("Sample sophomore picks");
  });

  it("does not let a revoked advisor role keep workspace access", async () => {
    const id = [...h.users.values()].find((u) => h.users.get(h.advisorA) === u)?.id ?? "";
    await h.t.db.update(s.userRoles).set({ revokedAt: NOW }).where(eq(s.userRoles.userId, id));
    expect((await call(h, "GET", `/workspaces/${h.wsA}/lists`, h.advisorA)).status).toBe(404);
  });
});

describe("advisor routes: lists", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
  });

  it("refuses bodies with status or identity keys before validation", async () => {
    const res = await call(h, "POST", `/workspaces/${h.wsA}/lists`, h.advisorA, { title: "x", items: [], citizenship: "us_citizen" });
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await res.json()).code).toBe("sensitive_field_rejected");
  });

  it("edits with If-Match and answers 409 to a stale version", async () => {
    const list = await createList(h, [OPEN]);
    const ok = await call(h, "PATCH", `/lists/${list.id}`, h.advisorA, { items: [{ programSlug: SECOND, cycleKey: null, note: null }] }, { "if-match": '"1"' });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("etag")).toBe('"2"');
    expect(ProgramListSchema.parse(await ok.json()).items.map((i) => i.programSlug)).toEqual([SECOND]);
    const stale = await call(h, "PATCH", `/lists/${list.id}`, h.advisorA, { title: "Again" }, { "if-match": '"1"' });
    expect(stale.status).toBe(409);
    expect(ProblemDetailsSchema.parse(await stale.json()).code).toBe("version_conflict");
  });

  it("exports a list as CSV with formula cells neutralized", async () => {
    const list = await createList(h, [OPEN], "unlisted", "=HYPERLINK(\"http://example.org\")");
    const res = await call(h, "GET", `/workspaces/${h.wsA}/lists/${list.id}/export.csv`, h.advisorA);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/csv/);
    expect(res.headers.get("cache-control")).toMatch(/\bno-store\b/);
    const text = await res.text();
    expect(text.split("\r\n")[0]).toMatch(/^position,program,organization/);
    expect(text).toContain(`"'=HYPERLINK(""http://example.org"")"`);
    expect(text).toContain("sample");
  });

  it("serves public and unlisted lists without a session and without the workspace id", async () => {
    const pub = await createList(h, [OPEN], "public");
    const res = await call(h, "GET", `/lists/by-slug/${pub.slug}`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.workspaceId).toBeUndefined();
    expect(body.title).toBe("Sample sophomore picks");

    const unlisted = await createList(h, [OPEN], "unlisted");
    const u = await call(h, "GET", `/lists/u/${unlisted.token}`);
    expect(u.status).toBe(200);
    expect(u.headers.get("x-robots-tag")).toBe("noindex");
    expect(u.headers.get("cache-control")).toBe("private, no-store");
    // An unlisted list is not reachable by slug, and a wrong token is a plain 404.
    expect((await call(h, "GET", `/lists/u/${"0".repeat(22)}`)).status).toBe(404);
  });
});

describe("advisor routes: campus deadlines", () => {
  let h: Harness;
  let cycleKey: string;
  beforeEach(async () => {
    h = await setup();
    await createList(h, [OPEN]);
    const cycle = await h.t.db.query.programCycles.findFirst({ where: eq(s.programCycles.id, sampleIds.cycle(OPEN)) });
    cycleKey = cycle?.cycleKey ?? "";
  });

  const submission = (over: Record<string, unknown> = {}) => ({
    programSlug: OPEN,
    cycleKey,
    kind: "nomination",
    localDate: "2026-12-01",
    localTime: null,
    timeZone: "America/New_York",
    sourceUrl: "https://example.org/sample-fellowship-office",
    note: null,
    ...over,
  });

  it("queues a Curator review task and shows nothing as approved yet", async () => {
    const res = await call(h, "POST", `/workspaces/${h.wsA}/campus-deadlines`, h.advisorA, submission());
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ status: "pending_review" });
    const tasks = await h.t.db.select().from(s.reviewTasks).where(eq(s.reviewTasks.kind, "campus_deadline"));
    expect(tasks).toHaveLength(1);
    expect(tasks[0]?.payload[`campus:${h.wsA}`]).toMatchObject({ localDate: "2026-12-01", workspaceId: h.wsA });

    const view = await call(h, "GET", `/workspaces/${h.wsA}/campus-deadlines`, h.advisorA);
    expect(await view.json()).toEqual({ institutionLinked: true, pending: 1, approved: [] });
  });

  it("refuses past dates, unknown cycles and workspaces without an institution", async () => {
    expect((await call(h, "POST", `/workspaces/${h.wsA}/campus-deadlines`, h.advisorA, submission({ localDate: "2026-11-01" }))).status).toBe(400);
    expect((await call(h, "POST", `/workspaces/${h.wsA}/campus-deadlines`, h.advisorA, submission({ cycleKey: "summer-2031" }))).status).toBe(400);
    const res = await call(h, "POST", `/workspaces/${h.wsB}/campus-deadlines`, h.advisorB, submission());
    expect(res.status).toBe(409);
  });
});

describe("advisor routes: aggregate progress (k >= 5)", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await setup();
    await createList(h, [OPEN, SECOND, RESTRICTED]);
  });

  type Table = { suppressed: boolean; reason?: string; total?: string; cells?: { key: string; label: string }[] };
  const progress = async () => (await (await call(h, "GET", `/workspaces/${h.wsA}/progress`, h.advisorA)).json()) as {
    population: string;
    minGroupSize: number;
    excluded: { slug: string }[];
    byProgram: Table;
    byStage: Table;
  };

  it("withholds everything while fewer than 5 students track the listed programs", async () => {
    await addTrackers(h, OPEN, 2);
    await addTrackers(h, SECOND, 2, "applying");
    const view = await progress();
    expect(view.minGroupSize).toBe(5);
    expect(view.byProgram).toMatchObject({ suppressed: true, reason: "below_min_total" });
    expect(view.byStage).toMatchObject({ suppressed: true, reason: "below_min_total" });
  });

  it("bands a small cell and hides a complementary one so it cannot be recovered", async () => {
    await addTrackers(h, OPEN, 12);
    await addTrackers(h, SECOND, 3, "applying");
    const view = await progress();
    expect(view.byProgram.suppressed).toBe(false);
    const labels = Object.fromEntries((view.byProgram.cells ?? []).map((c) => [c.key, c.label]));
    expect(labels[SECOND]).toBe("fewer than 5");
    // With two cells, showing OPEN's count next to the total would pin SECOND's.
    expect(labels[OPEN]).toBe("not shown");
    expect(view.byProgram.total).toBe("10-19");
  });

  it("never counts restricted (identity- or status-audience) programs", async () => {
    await addTrackers(h, OPEN, 6);
    await addTrackers(h, SECOND, 6, "submitted");
    // Consented trackers on the restricted program exist, and the view must still ignore them.
    h.t.raw.exec("INSERT INTO consent_texts (version, kind, text_sha256, published_at) VALUES ('st-1', 'sensitive_tracking', 'x', 1)");
    await addTrackers(h, RESTRICTED, 9, "interested", true);
    expect((await h.t.db.select().from(s.trackerItems).where(eq(s.trackerItems.programCycleId, sampleIds.cycle(RESTRICTED)))).length).toBe(9);
    const view = await progress();
    expect(view.population).toBe("all_novus_students");
    expect(view.excluded.map((p) => p.slug)).toEqual([RESTRICTED]);
    expect((view.byProgram.cells ?? []).map((c) => c.key)).not.toContain(RESTRICTED);
    expect(view.byProgram.total).toBe("10-19");
    const stage = Object.fromEntries((view.byStage.cells ?? []).map((c) => [c.key, c.label]));
    // "started" is zero, which reads like a small cell, so one more cell is hidden beside it.
    expect(stage).toEqual({ saved: "not shown", started: "fewer than 5", submitted: "5-9" });
  });

  it("returns no per-student field anywhere in the progress or report payloads", async () => {
    await addTrackers(h, OPEN, 7);
    const raw = JSON.stringify(await progress()) + JSON.stringify(await (await call(h, "GET", `/workspaces/${h.wsA}/reports/2026-11`, h.advisorA)).json());
    expect(raw).not.toMatch(/userId|user_id|email|publicId|displayName/);
  });
});

describe("advisor routes: reports", () => {
  it("returns the banded report and marks list views unknown without the events database", async () => {
    const h = await setup();
    await createList(h, [OPEN], "public");
    const res = await call(h, "GET", `/workspaces/${h.wsA}/reports/2026-11`, h.advisorA);
    expect(res.status).toBe(200);
    const report = WorkspaceReportSchema.parse(await res.json());
    expect(report.listViews).toBe("not available");
    expect((await call(h, "GET", `/workspaces/${h.wsA}/reports/2027-01`, h.advisorA)).status).toBe(400);
    expect((await call(h, "GET", `/workspaces/${h.wsA}/reports/nonsense`, h.advisorA)).status).toBe(400);
  });

  it("counts page views of the workspace's list pages inside the period, banded", async () => {
    const { edb } = await freshEventsDb();
    const h = await setup({ eventsDb: edb });
    const list = await createList(h, [OPEN], "public");
    const at = Date.parse("2026-11-05T12:00:00Z");
    const rows = Array.from({ length: 12 }, (_, i) => ({ id: uuidv7(at + i), name: "page_view", at: at + i, path: `/lists/${list.slug}` }));
    rows.push({ id: uuidv7(at + 99), name: "page_view", at: Date.parse("2026-10-05T12:00:00Z"), path: `/lists/${list.slug}` });
    await edb.insert(analyticsEvents).values(rows);
    const report = WorkspaceReportSchema.parse(await (await call(h, "GET", `/workspaces/${h.wsA}/reports/2026-11`, h.advisorA)).json());
    expect(report.listViews).toBe("10-24");
    const csv = await (await call(h, "GET", `/workspaces/${h.wsA}/reports/2026-11/export.csv`, h.advisorA)).text();
    expect(csv).toContain("list views,,10-24");
  });
});
