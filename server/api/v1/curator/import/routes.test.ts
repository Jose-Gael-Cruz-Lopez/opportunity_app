import { beforeEach, describe, expect, it } from "vitest";
import { Hono, type Context } from "hono";
import { and, eq } from "drizzle-orm";
import { ProblemDetailsSchema } from "@shared/contracts";
import type { Role } from "@shared/taxonomy";
import type { AppEnv, SessionUser } from "@server/env";
import { SECOND_FACTOR_PROBLEM_TYPE, type RoleGrant } from "@server/auth";
import * as s from "@server/db/schema";
import { uuidv7 } from "@server/db/columns";
import { registry } from "@server/db/repos";
import { grantRole } from "@server/db/repos/students";
import { createUser, seededDb, type TestDb } from "@server/db/testing/fixtures";
import { sensitiveGuard } from "@server/middleware/sensitive-guard";
import { createCuratorRoutes } from "../routes";
import { QueueResponseSchema } from "../schemas";
import { IMPORT_SYSTEM } from "./existing";
import { createCuratorImportRoutes, MAX_ROUTE_ROWS, ROUTE_MAX_BYTES } from "./routes";
import type { ImportReport } from "./service";

// SAMPLE DATA ONLY: the seeded registry is labelled sample, and every candidate below is invented
// (example.org/.net/.edu hosts); none describes a real program.

const NOW = Date.parse("2026-11-11T15:00:00Z");
const BASE = "http://localhost";

interface Harness {
  t: TestDb;
  app: Hono<AppEnv>;
  users: Map<string, SessionUser>;
  env: { name: string };
  logs: { level: string; event: string; fields?: Record<string, unknown> }[];
  ana: string;
}

async function signIn(h: Pick<Harness, "t" | "users">, roles: Role[], opts: { totp?: boolean; handle?: string | null } = {}): Promise<string> {
  const id = await createUser(h.t.db);
  for (const role of roles) await grantRole(h.t.db, id, role, NOW);
  if (opts.handle) await h.t.db.insert(s.curators).values({ id: uuidv7(), publicHandle: opts.handle, role: "curator", userId: id, isSample: true, createdAt: NOW });
  const token = `tok-${id}`;
  const grants: RoleGrant[] = [{ role: "student", scope: { kind: "global" } }, ...roles.filter((r) => r !== "student").map((role): RoleGrant => ({ role, scope: { kind: "global" } }))];
  h.users.set(token, {
    id,
    publicId: `u${id.replace(/-/g, "").slice(-20)}`,
    email: `${id}@example.org`,
    displayName: null,
    roles: [...new Set<Role>(["student", ...roles])],
    onboarded: true,
    grants,
    sessionId: `sess-${id}`,
    sessionExpiresAt: NOW + 3_600_000,
    surface: "console",
    secondFactor: { enrolled: true, verified: opts.totp ?? true },
  });
  return token;
}

async function setup(): Promise<Harness> {
  const t = await seededDb();
  const users = new Map<string, SessionUser>();
  const env = { name: "local" };
  const logs: Harness["logs"] = [];
  const ana = await signIn({ t, users }, ["curator"], { handle: "Sample Curator Ana" });
  const deps = {
    db: () => t.db,
    bucket: () => null,
    user: (c: Context<AppEnv>) => c.get("user"),
    now: () => NOW,
    environment: () => env.name,
    log: (level: string, event: string, fields?: Record<string, unknown>) => {
      logs.push({ level, event, fields });
    },
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const user = users.get(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (user) c.set("user", user);
    c.set("requestId", "test");
    await next();
  });
  // The app-wide guard parses JSON and form bodies before any route; the import must still read them.
  app.use("/api/v1/*", sensitiveGuard());
  app.route("/api/v1", createCuratorRoutes(deps as never));
  app.route("/api/v1", createCuratorImportRoutes(deps as never));
  return { t, app, users, env, logs, ana };
}

let h: Harness;
beforeEach(async () => {
  h = await setup();
});

function post(token: string | null, body: string, opts: { type?: string; query?: string } = {}) {
  const headers: Record<string, string> = { "content-type": opts.type ?? "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return h.app.request(`${BASE}/api/v1/curator/import${opts.query ?? ""}`, { method: "POST", headers, body });
}

function call(token: string, method: string, path: string, body?: unknown) {
  return h.app.request(`${BASE}/api/v1${path}`, { method, headers: { "content-type": "application/json", authorization: `Bearer ${token}` }, body: body === undefined ? undefined : JSON.stringify(body) });
}

const CANDIDATES = [
  {
    name: "Sample Coastal Ecology Fellowship",
    organization: "Example Ocean Institute",
    organization_kind: "nonprofit",
    official_url: "https://ocean.example.org/fellowship",
    types: ["undergraduate_fellowship"],
    deadlines: [{ date: "2027-01-15", quote: "Apply by January 15, 2027." }],
    eligibility: ["First- and second-year undergraduates"],
    researcher: "Sample Researcher 1",
  },
  {
    // Exact duplicate of a seeded sample program (same name, Organization and host).
    name: "Sample REU Site in Field Ecology",
    organization: "Example Science Foundation (sample)",
    official_url: "https://example.org/sample/another-page",
    types: ["research_program"],
  },
  {
    // Same name and Organization as a seeded program, on another host: possible duplicate.
    name: "Sample REU Site in Field Ecology",
    organization: "Example Science Foundation (sample)",
    official_url: "https://ecology.example.net/reu",
    types: ["research_program"],
  },
  { name: "Sample Invalid Row" },
];

const json = JSON.stringify(CANDIDATES);

async function report(res: Response): Promise<ImportReport> {
  expect(res.status).toBe(200);
  return (await res.json()) as ImportReport;
}

describe("access", () => {
  it("401 signed out, 403 for a student, second-factor problem without TOTP, 403 without a handle", async () => {
    expect((await post(null, json)).status).toBe(401);
    const student = await signIn(h, ["student"]);
    expect((await post(student, json)).status).toBe(403);
    const noTotp = await signIn(h, ["curator"], { totp: false, handle: "Sample Curator Cy" });
    const res = await post(noTotp, json);
    expect(res.status).toBe(403);
    expect(ProblemDetailsSchema.parse(await res.json()).type).toBe(SECOND_FACTOR_PROBLEM_TYPE);
    const noHandle = await signIn(h, ["curator"]);
    expect((await post(noHandle, json)).status).toBe(403);
  });

  it("requires the console surface in production", async () => {
    h.env.name = "production";
    const user = h.users.get(h.ana)!;
    h.users.set(h.ana, { ...user, surface: "app" });
    expect((await post(h.ana, json)).status).toBe(403);
  });
});

describe("import", () => {
  it("dry run reports every row and writes nothing", async () => {
    const before = await h.t.db.select().from(s.programs);
    const r = await report(await post(h.ana, json, { query: "?dryRun=1" }));
    expect(r.dryRun).toBe(true);
    expect(r.rows.map((x) => x.status)).toEqual(["created", "duplicate", "created", "invalid"]);
    expect((await h.t.db.select().from(s.programs)).length).toBe(before.length);
    expect(await h.t.db.select().from(s.reviewTasks)).toEqual([]);
  });

  it("creates unpublished drafts with Curator tasks, never published, and a second run creates nothing", async () => {
    const r = await report(await post(h.ana, json));
    expect(r.summary).toMatchObject({ rows: 4, created: 2, duplicates: 1, invalid: 1, newOrganizations: 1, reviewTasks: 3, possibleDuplicates: 1 });

    const created = r.rows.filter((x) => x.status === "created");
    for (const row of created) {
      const p = (await h.t.db.query.programs.findFirst({ where: eq(s.programs.id, row.programId!) }))!;
      expect(p).toMatchObject({ isPublished: false, isSample: false, summary: null });
      expect(await h.t.db.select().from(s.programCycles).where(eq(s.programCycles.programId, p.id))).toEqual([]);
      const src = await h.t.db.query.sources.findFirst({ where: eq(s.sources.programId, p.id) });
      expect(src).toMatchObject({ approval: "pending_approval", nextCheckAt: null });
      const audit = await h.t.db.select().from(s.registryAudit).where(and(eq(s.registryAudit.entityId, p.id), eq(s.registryAudit.field, "import.created")));
      expect(audit[0]).toMatchObject({ actorKind: "curator", actorRef: "Sample Curator Ana" });
    }
    // No FieldEvidence: a researcher's quote is a proposal, not a verified fact.
    expect(await h.t.db.select().from(s.fieldEvidence)).toEqual([]);
    const refs = await h.t.db.select().from(s.externalRefs).where(eq(s.externalRefs.system, IMPORT_SYSTEM));
    expect(refs).toHaveLength(2);

    // The drafts are not in the public registry.
    const snapshot = await registry.loadRegistrySnapshot(h.t.db);
    const publicIds = snapshot.programs.map((p) => p.id);
    expect(publicIds.length).toBeGreaterThan(0);
    for (const row of created) expect(publicIds).not.toContain(row.programId);

    // The Curator queue shows the new tasks with their program context.
    const q = await call(h.ana, "GET", "/review-tasks?view=queue&kind=new_program");
    expect(q.status).toBe(200);
    const queue = QueueResponseSchema.parse(await q.json());
    expect(queue.items.map((i) => queue.context[i.id]!.programName).sort()).toEqual(["Sample Coastal Ecology Fellowship", "Sample REU Site in Field Ecology"]);
    const task = queue.items.find((i) => queue.context[i.id]!.programName === "Sample Coastal Ecology Fellowship")!;
    expect(task.payload).toMatchObject({ proposal: { verified: false, deadlines: [{ date: "2027-01-15" }], researcher: "Sample Researcher 1" } });

    // Approving the task without edits records the decision and still publishes nothing.
    expect((await call(h.ana, "POST", `/review-tasks/${task.id}/claim`, {})).status).toBe(200);
    const resolved = await call(h.ana, "POST", `/review-tasks/${task.id}/resolve`, { decision: "approve", resolution: "checked", subjectVersion: null });
    expect(resolved.status).toBeLessThan(300);
    expect((await h.t.db.query.programs.findFirst({ where: eq(s.programs.id, task.subject.id) }))!.isPublished).toBe(false);

    // Re-running the same file creates nothing.
    const again = await report(await post(h.ana, json));
    expect(again.summary).toMatchObject({ created: 0, alreadyImported: 2, duplicates: 1, invalid: 1 });
    expect((await h.t.db.select().from(s.reviewTasks)).length).toBe(3);

    // Logs carry counts only.
    const line = h.logs.find((l) => l.event === "curator.import")!;
    expect(JSON.stringify(line)).not.toContain("Ocean");
    expect(line.fields).toMatchObject({ created: 2, rows: 4 });
  });

  it("accepts a multipart upload and a raw CSV body", async () => {
    const form = new FormData();
    form.set("file", new File([JSON.stringify([CANDIDATES[0]])], "candidates.json", { type: "application/json" }));
    form.set("dryRun", "1");
    const res = await h.app.request(`${BASE}/api/v1/curator/import`, { method: "POST", headers: { authorization: `Bearer ${h.ana}` }, body: form });
    const r = await report(res);
    expect(r).toMatchObject({ dryRun: true, format: "json", summary: { created: 1 } });

    const csv = "name,organization,official url,types\nSample CSV Program,Example CSV Org,https://csv.example.org/p,competition\n";
    const r2 = await report(await post(h.ana, csv, { type: "text/csv" }));
    expect(r2).toMatchObject({ dryRun: false, format: "csv", summary: { created: 1 } });
    const ref = await h.t.db.query.externalRefs.findFirst({ where: eq(s.externalRefs.system, IMPORT_SYSTEM) });
    expect(ref?.rowKind).toBe("hand");
  });

  it("marks sample imports, and refuses them in production", async () => {
    const r = await report(await post(h.ana, JSON.stringify([CANDIDATES[0]]), { query: "?sample=1" }));
    const p = (await h.t.db.query.programs.findFirst({ where: eq(s.programs.id, r.rows[0]!.programId!) }))!;
    expect(p.isSample).toBe(true);
    h.env.name = "production";
    expect((await post(h.ana, JSON.stringify([CANDIDATES[0]]), { query: "?sample=1" })).status).toBe(400);
  });

  it("refuses broken files, unknown content types and too many rows", async () => {
    const bad = await post(h.ana, "{oops");
    expect(bad.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await bad.json()).detail).toBe("The file is not valid JSON.");
    expect((await post(h.ana, "x", { type: "application/octet-stream" })).status).toBe(400);
    const many = JSON.stringify(Array.from({ length: MAX_ROUTE_ROWS + 1 }, (_, i) => ({ ...CANDIDATES[0], name: `Sample ${i}` })));
    expect((await post(h.ana, many)).status).toBe(400);
    const missingFile = new FormData();
    missingFile.set("other", "x");
    const res = await h.app.request(`${BASE}/api/v1/curator/import`, { method: "POST", headers: { authorization: `Bearer ${h.ana}` }, body: missingFile });
    expect(res.status).toBe(400);
  });

  it("is behind the app-wide sensitive-key guard: a status-shaped key refuses the JSON body", async () => {
    const res = await post(h.ana, JSON.stringify([{ ...CANDIDATES[0], citizenship: "US citizens only" }]));
    expect(res.status).toBe(400);
    expect(ProblemDetailsSchema.parse(await res.json()).code).toBe("sensitive_field_rejected");
    expect(await h.t.db.select().from(s.reviewTasks)).toEqual([]);
  });

  it("refuses an oversized declared body before reading it", async () => {
    const res = await h.app.request(`${BASE}/api/v1/curator/import`, {
      method: "POST",
      headers: { authorization: `Bearer ${h.ana}`, "content-type": "application/json", "content-length": String(ROUTE_MAX_BYTES + 128 * 1024) },
      body: "[]",
    });
    expect(res.status).toBe(413);
  });
});
