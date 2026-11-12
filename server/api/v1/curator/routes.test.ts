import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import { ProblemDetailsSchema, ReviewTaskSchema } from "@shared/contracts";
import { ReleasePointerSchema } from "@shared/contracts/registry";
import type { Role } from "@shared/taxonomy";
import type { AppEnv, SessionUser } from "@server/env";
import { SECOND_FACTOR_PROBLEM_TYPE, type RoleGrant } from "@server/auth";
import * as s from "@server/db/schema";
import { uuidv7 } from "@server/db/columns";
import { review } from "@server/db/repos";
import { grantRole } from "@server/db/repos/students";
import { sampleIds } from "@server/db/seed/build";
import { createUser, seededDb, type TestDb } from "@server/db/testing/fixtures";
import type { CuratorBucket } from "./ports";
import { holdCycle } from "@server/db/repos/bands";
import { upsertCycleTask } from "@server/jobs/kinds/outcomes-quality";
import { createCuratorRoutes } from "./routes";
import { QueueResponseSchema } from "./schemas";

// Sample data only: the seeded registry is labelled sample (is_sample = 1); the page texts below
// are synthetic and describe no real program.
const NOW = Date.parse("2026-11-11T15:00:00Z");
const SLUG = "sample-reu-site-ecology";
const OTHER = "sample-phd-pathway-program";
const BASE = "http://localhost";

class MemoryBucket implements CuratorBucket {
  readonly objects = new Map<string, string>();
  async get(key: string) {
    const v = this.objects.get(key);
    return v === undefined ? null : { text: async () => v };
  }
  async head(key: string) {
    return this.objects.has(key) ? {} : null;
  }
  async put(key: string, value: string) {
    this.objects.set(key, value);
    return {};
  }
}

interface Harness {
  t: TestDb;
  app: Hono<AppEnv>;
  bucket: MemoryBucket;
  users: Map<string, SessionUser>;
  clock: { now: number };
  env: { name: string };
  logs: { level: string; event: string }[];
  cycleId: string;
  programId: string;
  deadline: typeof s.deadlines.$inferSelect;
  sourceId: string;
  latestSnapshot: string;
  baselineSnapshot: string;
  taskId: string;
  ana: string;
  ben: string;
  admin: string;
}

async function signIn(
  h: Pick<Harness, "t" | "users">,
  roles: Role[],
  opts: { totp?: boolean; surface?: "app" | "console"; handle?: string | null } = {},
): Promise<string> {
  const id = await createUser(h.t.db);
  for (const role of roles) await grantRole(h.t.db, id, role, NOW);
  if (opts.handle) await h.t.db.insert(s.curators).values({ id: uuidv7(), publicHandle: opts.handle, role: roles.includes("admin") ? "admin" : "curator", userId: id, isSample: true, createdAt: NOW });
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
    surface: opts.surface ?? "console",
    secondFactor: { enrolled: true, verified: opts.totp ?? true },
  });
  return token;
}

const PAGE_V1 = [
  "Sample REU Site in Field Ecology (sample page)",
  "Applications for the summer program are open.",
  "Applications are due February 17, 2027 at 11:59 PM Central.",
  "Two letters of recommendation are required.",
].join("\n");

async function setup(): Promise<Harness> {
  const t = await seededDb();
  const users = new Map<string, SessionUser>();
  const bucket = new MemoryBucket();
  const clock = { now: NOW };
  const env = { name: "local" };
  const logs: { level: string; event: string }[] = [];
  const h0 = { t, users };
  const ana = await signIn(h0, ["curator"], { handle: "Sample Curator Ana" });
  const ben = await signIn(h0, ["curator"], { handle: "Sample Curator Ben" });
  const admin = await signIn(h0, ["admin"], { handle: "Sample Admin" });

  const programId = sampleIds.program(SLUG);
  const cycleId = sampleIds.cycle(SLUG);
  const deadline = (await t.db.select().from(s.deadlines).where(eq(s.deadlines.programCycleId, cycleId)))[0]!;

  // A Source with a baseline and a newer Snapshot whose text moved the deadline.
  const host = "sample-reu.example.org";
  await t.db.insert(s.sourceHosts).values({ host, policy: "allowed", updatedAt: NOW }).onConflictDoNothing();
  const sourceId = uuidv7(NOW);
  await t.db.insert(s.sources).values({ id: sourceId, kind: "official_page", url: `https://${host}/apply`, host, programId, approval: "approved", createdAt: NOW, updatedAt: NOW });
  const snap = async (text: string, at: number) => {
    const id = uuidv7(at);
    const key = `snapshots/text/${id}.txt`;
    bucket.objects.set(key, text);
    await t.db.insert(s.snapshots).values({
      id,
      sourceId,
      fetchedAt: at,
      requestedUrl: `https://${host}/apply`,
      finalUrl: `https://${host}/apply`,
      httpStatus: 200,
      contentType: "text/html",
      rawSha256: "a".repeat(64),
      normalizerVersion: "n1",
      rawKey: `snapshots/raw/${id}`,
      textKey: key,
      hostPolicy: "allowed",
      createdAt: at,
    });
    return id;
  };
  const baselineSnapshot = await snap(PAGE_V1, NOW - 86_400_000);
  const latestSnapshot = await snap(PAGE_V1.replace("February 17, 2027", "February 24, 2027"), NOW - 3_600_000);
  await t.db.update(s.sources).set({ baselineSnapshotId: baselineSnapshot }).where(eq(s.sources.id, sourceId));
  // A verified quote for the current deadline, as Phase 0 curation would have written it.
  await t.db.insert(s.fieldEvidence).values({
    id: uuidv7(NOW),
    entityType: "deadline",
    entityId: deadline.id,
    fieldPath: "localDate",
    basis: "snapshot",
    snapshotId: baselineSnapshot,
    url: `https://${host}/apply`,
    quote: "Applications are due February 17, 2027 at 11:59 PM Central.",
    match: "exact",
    createdAt: NOW,
  });

  const created = await review.createReviewTask(
    t.db,
    { kind: "cycle_update", subject: { type: "program_cycle", id: cycleId }, reasonCodes: ["key_change"], evidence: [latestSnapshot], priority: 4, dueAt: new Date(NOW + 48 * 3_600_000).toISOString() },
    NOW - 1000,
    {
      extraction: {
        snapshotId: latestSnapshot,
        payload: {
          application_url: { value: "Apply at [the portal](https://evil.example.com/x) now", quote: "Applications for the summer program are open.", status: "found", basis: "stated" },
          deadlines: [{ kind: "application", local_date: "2027-02-24", local_time: "23:59", time_zone_text: "Central", quote: "Applications are due February 24, 2027 at 11:59 PM Central.", status: "found" }],
        },
        validation: { fields: [{ path: "deadlines.0.local_date", code: "DATE_OK", blocked: false, flags: [], confidence: "high" }] },
      },
    },
  );
  if (!created.ok) throw new Error("task");

  const deps = {
    db: () => t.db,
    bucket: () => bucket,
    user: (c: Parameters<Parameters<Hono<AppEnv>["get"]>[1]>[0]) => c.get("user"),
    now: () => clock.now,
    environment: () => env.name,
    log: (level: string, event: string) => {
      logs.push({ level, event });
    },
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    const user = users.get(c.req.header("authorization")?.replace("Bearer ", "") ?? "");
    if (user) c.set("user", user);
    c.set("requestId", "test");
    await next();
  });
  app.route("/api/v1", createCuratorRoutes(deps as never));
  return { t, app, bucket, users, clock, env, logs, cycleId, programId, deadline, sourceId, latestSnapshot, baselineSnapshot, taskId: created.value.id, ana, ben, admin };
}

let h: Harness;
beforeEach(async () => {
  h = await setup();
});

function call(token: string | null, method: string, path: string, body?: unknown) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (token) headers.authorization = `Bearer ${token}`;
  return h.app.request(`${BASE}/api/v1${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
}

const claim = (token: string, id = h.taskId) => call(token, "POST", `/review-tasks/${id}/claim`, {});
const resolve = (token: string, body: unknown, id = h.taskId) => call(token, "POST", `/review-tasks/${id}/resolve`, body);
const opened = (token: string, id = h.taskId) => call(token, "POST", `/review-tasks/${id}/official-opened`, { snapshotId: h.latestSnapshot });

async function cycleVersion(): Promise<number> {
  return (await h.t.db.query.programCycles.findFirst({ where: eq(s.programCycles.id, h.cycleId) }))!.version;
}

function moveDeadline(localDate: string, quote: string) {
  return {
    op: "upsert",
    deadline: {
      kind: h.deadline.kind,
      scope: h.deadline.scope,
      precision: h.deadline.precision,
      tzMode: h.deadline.tzMode,
      localDate,
      localTime: h.deadline.localTime,
      timeZone: h.deadline.timeZone,
    },
    evidence: { snapshotId: h.latestSnapshot, url: "https://sample-reu.example.org/apply", quote },
  };
}

const NEW_QUOTE = "Applications are due February 24, 2027 at 11:59 PM Central.";

describe("access: role, TOTP, console surface, Curator handle", () => {
  it("401 signed out, 403 for a student, second-factor problem until TOTP passes", async () => {
    expect((await call(null, "GET", "/review-tasks")).status).toBe(401);
    const student = await signIn(h, ["student"]);
    expect((await call(student, "GET", "/review-tasks")).status).toBe(403);
    const noTotp = await signIn(h, ["curator"], { totp: false, handle: "Sample Curator Cy" });
    const res = await call(noTotp, "GET", "/review-tasks");
    expect(res.status).toBe(403);
    expect(ProblemDetailsSchema.parse(await res.json()).type).toBe(SECOND_FACTOR_PROBLEM_TYPE);
    expect((await call(noTotp, "GET", "/ops/pipeline")).status).toBe(403);
  });

  it("requires the console surface in staging and production, not locally", async () => {
    const appSession = await signIn(h, ["curator"], { surface: "app", handle: "Sample Curator Dee" });
    expect((await call(appSession, "GET", "/review-tasks")).status).toBe(200);
    h.env.name = "production";
    expect((await call(appSession, "GET", "/review-tasks")).status).toBe(403);
    expect((await call(h.ana, "GET", "/review-tasks")).status).toBe(200);
  });

  it("needs an active Curator handle to work tasks", async () => {
    const noHandle = await signIn(h, ["curator"]);
    const res = await call(noHandle, "GET", "/review-tasks");
    expect(res.status).toBe(403);
    // The ops view needs only the role.
    expect((await call(noHandle, "GET", "/ops/pipeline")).status).toBe(200);
  });
});

describe("queue, claim and release", () => {
  it("lists the queue with contract items, context and the viewer handle", async () => {
    const res = await call(h.ana, "GET", "/review-tasks");
    expect(res.status).toBe(200);
    const body = QueueResponseSchema.parse(await res.json());
    expect(body.items.map((i) => i.id)).toContain(h.taskId);
    for (const item of body.items) ReviewTaskSchema.parse(item);
    expect(body.context[h.taskId]).toMatchObject({ programSlug: SLUG, isSample: true, overdue: false });
    expect(body.viewer).toEqual({ handle: "Sample Curator Ana", roles: ["curator"] });
    expect(JSON.stringify(body)).not.toContain("@example.org");
  });

  it("orders by due time, then severity", async () => {
    const other = sampleIds.cycle(OTHER);
    const soon = await review.createReviewTask(h.t.db, { kind: "reconfirm", subject: { type: "program_cycle", id: other }, reasonCodes: ["deadline_audit"], evidence: [], priority: 9, dueAt: new Date(NOW + 3_600_000).toISOString() }, NOW);
    const body = QueueResponseSchema.parse(await (await call(h.ana, "GET", "/review-tasks")).json());
    expect(body.items[0]!.id).toBe(soon.ok && soon.value.id);
  });

  it("claims under a 15-minute lease, refuses a second claimant and audits the claim", async () => {
    const res = await claim(h.ana);
    expect(res.status).toBe(200);
    const task = ReviewTaskSchema.parse(await res.json());
    expect(task.state).toBe("claimed");
    expect(task.claimedBy).toBe("Sample Curator Ana");
    expect(Date.parse(task.claimExpiresAt!)).toBe(NOW + 15 * 60_000);
    expect((await claim(h.ben)).status).toBe(409);
    const rows = await h.t.db.select().from(s.registryAudit).where(eq(s.registryAudit.taskId, h.taskId));
    expect(rows.map((r) => r.field)).toContain("review_task.claim");
    expect(rows.find((r) => r.field === "review_task.claim")!.actorRef).toBe("Sample Curator Ana");
  });

  it("an expired claim can be taken over and the old holder can no longer act", async () => {
    await claim(h.ana);
    h.clock.now = NOW + 16 * 60_000;
    expect((await claim(h.ben)).status).toBe(200);
    const res = await resolve(h.ana, { decision: "reject", rejectReason: "no_material_change", resolution: "", subjectVersion: null });
    expect(res.status).toBe(409);
    // The batch assertion rolled the audit row back with the state change.
    const fields = (await h.t.db.select().from(s.registryAudit).where(eq(s.registryAudit.taskId, h.taskId))).map((r) => r.field);
    expect(fields).not.toContain("review_task.reject");
    expect((await h.t.db.query.reviewTasks.findFirst({ where: eq(s.reviewTasks.id, h.taskId) }))!.state).toBe("claimed");
  });

  it("release returns the task to the queue", async () => {
    await claim(h.ana);
    const res = await call(h.ana, "POST", `/review-tasks/${h.taskId}/release`);
    expect(res.status).toBe(200);
    expect(ReviewTaskSchema.parse(await res.json()).state).toBe("open");
    expect((await call(h.ben, "POST", `/review-tasks/${h.taskId}/release`, {})).status).toBe(409);
  });
});

describe("evidence side by side", () => {
  it("returns Snapshot text with highlighted quotes, the window diff, plain proposals and findings", async () => {
    await claim(h.ana);
    const res = await call(h.ana, "GET", `/review-tasks/${h.taskId}`);
    expect(res.status).toBe(200);
    const view = (await res.json()) as {
      cycle: { version: number; id: string };
      snapshots: { id: string; text: string; highlights: { start: number; end: number; ref: string; kind: string }[]; missingQuotes: string[] }[];
      diffs: { hunks: { op: string; line: string }[] }[];
      proposals: { value: string; quote: string }[];
      findings: Record<string, unknown>[];
      verified: { evidence: { id: string }[] };
      program: { isSample: boolean };
    };
    expect(view.program.isSample).toBe(true);
    expect(view.cycle.id).toBe(h.cycleId);
    const latest = view.snapshots.find((x) => x.id === h.latestSnapshot)!;
    const baseline = view.snapshots.find((x) => x.id === h.baselineSnapshot)!;
    // The verified quote is on the baseline page and missing from the new one (a finding).
    const verifiedId = view.verified.evidence[0]!.id;
    expect(baseline.highlights.some((m) => m.ref === verifiedId && m.kind === "verified")).toBe(true);
    expect(latest.missingQuotes).toContain(verifiedId);
    // The proposed quote is highlighted at its exact place on the new page.
    const proposed = latest.highlights.find((m) => m.kind === "proposed" && latest.text.slice(m.start, m.end).includes("February 24"));
    expect(proposed).toBeDefined();
    expect(view.diffs[0]!.hunks.some((d) => d.op === "add" && d.line.includes("February 24"))).toBe(true);
    expect(view.diffs[0]!.hunks.some((d) => d.op === "del" && d.line.includes("February 17"))).toBe(true);
    // Model text is plain: no links survive.
    expect(JSON.stringify(view.proposals)).not.toContain("evil.example.com");
    expect(view.proposals[0]!.value).toBe("Apply at the portal now");
    // Validator findings never carry model confidence.
    expect(view.findings[0]).toEqual({ path: "deadlines.0.local_date", code: "DATE_OK", blocked: false, flags: [] });
  });

  it("404 for an unknown or malformed id", async () => {
    expect((await call(h.ana, "GET", `/review-tasks/${uuidv7()}`)).status).toBe(404);
    expect((await call(h.ana, "GET", "/review-tasks/not-a-uuid")).status).toBe(404);
  });
});

describe("approve and publish", () => {
  it("needs the official link opened before a changed deadline", async () => {
    await claim(h.ana);
    const res = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: await cycleVersion(), edits: { deadlines: [moveDeadline("2027-02-24", NEW_QUOTE)] } });
    expect(res.status).toBe(412);
  });

  it("publishes in one batch: deadline revision, evidence, audit, ChangeEvents, baseline, release", async () => {
    await claim(h.ana);
    expect((await opened(h.ana)).status).toBe(204);
    const version = await cycleVersion();
    const res = await resolve(h.ana, { decision: "approve", resolution: "Deadline extended a week", subjectVersion: version, activeSeconds: 95, edits: { deadlines: [moveDeadline("2027-02-24", NEW_QUOTE)] } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: string; outcome: string; activeSeconds: number };
    expect(body.outcome).toBe("applied");
    expect(body.state).toBe("applied");
    expect(body.activeSeconds).toBe(95);

    const d = (await h.t.db.query.deadlines.findFirst({ where: eq(s.deadlines.id, h.deadline.id) }))!;
    expect(d.localDate).toBe("2027-02-24");
    expect(d.revision).toBe(h.deadline.revision + 1);
    expect(await cycleVersion()).toBe(version + 1);
    const cycle = (await h.t.db.query.programCycles.findFirst({ where: eq(s.programCycles.id, h.cycleId) }))!;
    expect(cycle.lastVerifiedAt).toBe(NOW);
    expect(cycle.verificationState).toBe("verified");

    const events = await h.t.db.select().from(s.changeEvents).where(eq(s.changeEvents.taskId, h.taskId));
    expect(events.map((e) => e.type).sort()).toEqual(["deadline.changed", "program_cycle.verified"]);
    const changed = events.find((e) => e.type === "deadline.changed")!;
    expect(changed.payload).toMatchObject({ localDate: "2027-02-24", previousLocalDate: h.deadline.localDate, revision: h.deadline.revision + 1 });
    // Fan-out needs scope, institution, kind and both sides' times to target and rank the alert.
    expect(changed.payload).toMatchObject({ kind: h.deadline.kind, scope: "national", institutionId: null, previousLocalTime: h.deadline.localTime ?? null, previousDueAt: h.deadline.dueAt ?? null });
    expect(Object.keys(changed.payload)).toEqual(expect.arrayContaining(["dueAt", "localTime", "timeZone", "previousTimeZone"]));

    const ev = await h.t.db.select().from(s.fieldEvidence).where(and(eq(s.fieldEvidence.entityId, h.deadline.id), eq(s.fieldEvidence.fieldPath, "localDate")));
    const live = ev.filter((e) => e.supersededAt === null);
    expect(live).toHaveLength(1);
    expect(live[0]).toMatchObject({ snapshotId: h.latestSnapshot, match: "exact", quote: NEW_QUOTE });
    expect(live[0]!.locator).toMatchObject({ kind: "html" });

    const auditRows = await h.t.db.select().from(s.registryAudit).where(eq(s.registryAudit.taskId, h.taskId));
    expect(auditRows.map((r) => r.field)).toEqual(expect.arrayContaining(["review_task.claim", "review_task.official_link_opened", "deadline", "verification_state", "review_task.approve"]));

    const src = (await h.t.db.query.sources.findFirst({ where: eq(s.sources.id, h.sourceId) }))!;
    expect(src.baselineSnapshotId).toBe(h.latestSnapshot);
    const pending = await h.t.db.select().from(s.registryReleases).where(eq(s.registryReleases.state, "pending"));
    expect(pending).toHaveLength(1);
    expect(h.logs.some((l) => l.event === "curator_publish")).toBe(true);
  });

  it("an unchanged approval is a verification: one program_cycle.verified event, no deadline change", async () => {
    await claim(h.ana);
    const res = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: await cycleVersion() });
    expect(res.status).toBe(200);
    const events = await h.t.db.select().from(s.changeEvents).where(eq(s.changeEvents.taskId, h.taskId));
    expect(events.map((e) => e.type)).toEqual(["program_cycle.verified"]);
  });

  it("refuses a quote that is not on the cited Snapshot", async () => {
    await claim(h.ana);
    await opened(h.ana);
    const res = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: await cycleVersion(), edits: { deadlines: [moveDeadline("2027-02-24", "Applications are due March 3, 2027.")] } });
    expect(res.status).toBe(400);
    const p = ProblemDetailsSchema.parse(await res.json());
    expect(p.errors?.[0]?.path).toBe("edits.deadlines.0.evidence");
    expect(await h.t.db.select().from(s.changeEvents).where(eq(s.changeEvents.taskId, h.taskId))).toHaveLength(0);
  });

  it("a stale cycle version writes nothing and re-opens the task", async () => {
    await claim(h.ana);
    await opened(h.ana);
    const version = await cycleVersion();
    await h.t.db.update(s.programCycles).set({ version: version + 1 }).where(eq(s.programCycles.id, h.cycleId));
    const res = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: version, edits: { deadlines: [moveDeadline("2027-02-24", NEW_QUOTE)] } });
    expect(res.status).toBe(409);
    expect(ProblemDetailsSchema.parse(await res.json()).code).toBe("version_conflict");
    expect(await h.t.db.select().from(s.changeEvents).where(eq(s.changeEvents.taskId, h.taskId))).toHaveLength(0);
    const fields = (await h.t.db.select().from(s.registryAudit).where(eq(s.registryAudit.taskId, h.taskId))).map((r) => r.field);
    expect(fields).not.toContain("deadline");
    expect(fields).toContain("review_task.apply_failed");
    const task = (await h.t.db.query.reviewTasks.findFirst({ where: eq(s.reviewTasks.id, h.taskId) }))!;
    expect(task.state).toBe("open");
    expect(task.payload.lastApplyFailure).toMatchObject({ reason: "stale_version" });
    expect((await h.t.db.query.deadlines.findFirst({ where: eq(s.deadlines.id, h.deadline.id) }))!.localDate).toBe(h.deadline.localDate);
  });

  it("a high-impact change waits for a second, different Curator", async () => {
    await claim(h.ana);
    await opened(h.ana);
    const quote = "Applications are due February 17, 2027 at 11:59 PM Central.";
    // Move the deadline 30 days earlier (cited from the baseline text, which still has a quote).
    const edits = { deadlines: [{ ...moveDeadline("2027-01-18", quote), evidence: { snapshotId: h.baselineSnapshot, url: "https://sample-reu.example.org/apply", quote } }] };
    const first = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: await cycleVersion(), edits });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { outcome: string; state: string; secondReviewReasons: string[] };
    expect(firstBody).toMatchObject({ outcome: "second_review", state: "second_review", secondReviewReasons: ["deadline_moved_earlier"] });
    expect(await h.t.db.select().from(s.changeEvents).where(eq(s.changeEvents.taskId, h.taskId))).toHaveLength(0);

    // Not visible to Ana's queue, not claimable by her.
    const anaQueue = QueueResponseSchema.parse(await (await call(h.ana, "GET", "/review-tasks")).json());
    expect(anaQueue.items.map((i) => i.id)).not.toContain(h.taskId);
    expect((await claim(h.ana)).status).toBe(409);

    const benQueue = QueueResponseSchema.parse(await (await call(h.ben, "GET", "/review-tasks?view=second_review")).json());
    expect(benQueue.context[h.taskId]!.secondReviewOf).toBe("Sample Curator Ana");
    expect((await claim(h.ben)).status).toBe(200);
    await opened(h.ben);
    const second = await resolve(h.ben, { decision: "approve", resolution: "Confirmed on the official page", subjectVersion: null });
    expect(second.status).toBe(200);
    expect(((await second.json()) as { outcome: string }).outcome).toBe("applied");
    const d = (await h.t.db.query.deadlines.findFirst({ where: eq(s.deadlines.id, h.deadline.id) }))!;
    expect(d.localDate).toBe("2027-01-18");
    const task = (await h.t.db.query.reviewTasks.findFirst({ where: eq(s.reviewTasks.id, h.taskId) }))!;
    expect(task.payload.approval).toMatchObject({ secondApprover: expect.any(String), firstApprover: expect.any(String) });
  });

  it("a status change publishes cycle.status_changed and validates the transition", async () => {
    await claim(h.ana);
    await opened(h.ana);
    const cycle = (await h.t.db.query.programCycles.findFirst({ where: eq(s.programCycles.id, h.cycleId) }))!;
    const quote = "Applications for the summer program are open.";
    const evidence = { status: { snapshotId: h.latestSnapshot, url: "https://sample-reu.example.org/apply", quote } };
    const bad = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: cycle.version, edits: { cycle: { status: "relaunched" }, cycleEvidence: evidence } });
    expect(bad.status).toBe(400);
    const res = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: cycle.version, edits: { cycle: { status: "closed" }, cycleEvidence: evidence } });
    expect(res.status).toBe(200);
    const events = await h.t.db.select().from(s.changeEvents).where(eq(s.changeEvents.taskId, h.taskId));
    expect(events.find((e) => e.type === "cycle.status_changed")!.payload).toEqual({ from: cycle.status, to: "closed" });
  });
});

describe("community hints (REQ-063)", () => {
  it("are approved only with a quote from an official Snapshot", async () => {
    const hint = await review.createReviewTask(h.t.db, { kind: "community_hint", subject: { type: "program_cycle", id: h.cycleId }, reasonCodes: ["list_row"], evidence: [], priority: 6, dueAt: null }, NOW);
    if (!hint.ok) throw new Error("hint");
    const id = hint.value.id;
    await claim(h.ana, id);
    await opened(h.ana, id);
    const version = await cycleVersion();
    expect((await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: version }, id)).status).toBe(400);
    const res = await resolve(h.ana, { decision: "approve", resolution: "", subjectVersion: version, edits: { deadlines: [moveDeadline("2027-02-24", NEW_QUOTE)] } }, id);
    expect(res.status).toBe(200);
  });
});

describe("reject, snooze, escalate, recheck", () => {
  it("reject needs a reason code", async () => {
    await claim(h.ana);
    expect((await resolve(h.ana, { decision: "reject", resolution: "", subjectVersion: null })).status).toBe(400);
    const res = await resolve(h.ana, { decision: "reject", rejectReason: "no_material_change", resolution: "Cosmetic edit only", subjectVersion: null });
    expect(res.status).toBe(200);
    const task = ReviewTaskSchema.parse(await res.json());
    expect(task.state).toBe("rejected");
    expect(task.resolution).toBe("no_material_change: Cosmetic edit only");
  });

  it("snooze needs a future date and a reason, and hides the task until then", async () => {
    await claim(h.ana);
    expect((await resolve(h.ana, { decision: "snooze", resolution: "Waiting on the office", subjectVersion: null })).status).toBe(400);
    const until = new Date(NOW + 3 * 86_400_000).toISOString();
    const res = await resolve(h.ana, { decision: "snooze", resolution: "Waiting on the office", snoozeUntil: until, subjectVersion: null });
    expect(res.status).toBe(200);
    let queue = QueueResponseSchema.parse(await (await call(h.ben, "GET", "/review-tasks")).json());
    expect(queue.items.map((i) => i.id)).not.toContain(h.taskId);
    queue = QueueResponseSchema.parse(await (await call(h.ben, "GET", "/review-tasks?view=snoozed")).json());
    expect(queue.items.map((i) => i.id)).toContain(h.taskId);
    h.clock.now = NOW + 4 * 86_400_000;
    queue = QueueResponseSchema.parse(await (await call(h.ben, "GET", "/review-tasks")).json());
    expect(queue.items.map((i) => i.id)).toContain(h.taskId);
  });

  it("resolving an over-count outcome anomaly lifts the cycle's hold; other tasks leave it", async () => {
    const anomalyId = await upsertCycleTask(h.t.db, { kind: "outcome_anomaly", programCycleId: h.cycleId, reason: "outcome_over_count", priority: 1, payload: {} }, NOW - 500);
    await holdCycle(h.t.db, { programCycleId: h.cycleId, reason: "over_count", reviewTaskId: anomalyId }, NOW - 500);
    const live = async () => (await h.t.db.select().from(s.outcomeCycleHolds).where(eq(s.outcomeCycleHolds.programCycleId, h.cycleId))).filter((r) => r.releasedAt === null);
    // Rejecting the cycle's other task (a cycle_update) changes nothing.
    await claim(h.ben);
    expect((await resolve(h.ben, { decision: "reject", rejectReason: "no_material_change", resolution: "Cosmetic edit only", subjectVersion: null })).status).toBe(200);
    expect(await live()).toHaveLength(1);
    // Escalating keeps the anomaly live, so the hold stays.
    await claim(h.ana, anomalyId);
    expect((await resolve(h.ana, { decision: "escalate", resolution: "Needs a founder call", subjectVersion: null }, anomalyId)).status).toBe(200);
    expect(await live()).toHaveLength(1);
    // Resolving it releases the hold.
    expect((await claim(h.admin, anomalyId)).status).toBe(200);
    expect((await resolve(h.admin, { decision: "reject", rejectReason: "no_material_change", resolution: "Counts check out", subjectVersion: null }, anomalyId)).status).toBe(200);
    expect(await live()).toHaveLength(0);
  });

  it("escalated tasks are claimable by an admin only", async () => {
    await claim(h.ana);
    expect((await resolve(h.ana, { decision: "escalate", resolution: "Needs a founder call", subjectVersion: null })).status).toBe(200);
    expect((await claim(h.ben)).status).toBe(409);
    expect((await claim(h.admin)).status).toBe(200);
  });

  it("recheck enqueues one fetch job per approved Source and audits it", async () => {
    await claim(h.ana);
    const res = await call(h.ana, "POST", `/review-tasks/${h.taskId}/recheck`, { urgent: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ requested: true, jobsCreated: 1 });
    const jobs = await h.t.db.select().from(s.jobs).where(eq(s.jobs.kind, "fetch"));
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ priority: 1, status: "pending" });
    expect(jobs[0]!.payload).toMatchObject({ sourceId: h.sourceId, programCycleId: h.cycleId });
  });
});

describe("ops pipeline and job retry", () => {
  it("shows queues and failures by kind with payload key names only, and retries a dead job", async () => {
    const jobId = uuidv7(NOW);
    await h.t.db.insert(s.jobs).values({
      id: jobId,
      kind: "fetch",
      payload: { sourceId: h.sourceId, url: "https://sample-reu.example.org/apply" },
      idempotencyKey: "fetch:test",
      status: "dead",
      attempts: 8,
      runAfter: NOW - 3_600_000,
      lastError: "http_503",
      finishedAt: NOW - 60_000,
      createdAt: NOW - 7_200_000,
      updatedAt: NOW - 60_000,
    });
    const res = await call(h.ana, "GET", "/ops/pipeline");
    expect(res.status).toBe(200);
    const view = (await res.json()) as { failures: { id: string; payloadKeys: string[]; retryable: boolean }[]; review: { open: number } };
    const failure = view.failures.find((f) => f.id === jobId)!;
    expect(failure).toMatchObject({ payloadKeys: ["sourceId", "url"], retryable: true });
    expect(JSON.stringify(view)).not.toContain("sample-reu.example.org");
    expect(view.review.open).toBeGreaterThanOrEqual(1);

    const retry = await call(h.ana, "POST", `/ops/jobs/${jobId}/retry`, {});
    expect(retry.status).toBe(200);
    const job = (await h.t.db.query.jobs.findFirst({ where: eq(s.jobs.id, jobId) }))!;
    expect(job).toMatchObject({ status: "pending", attempts: 0, runAfter: NOW });
    const audits = await h.t.db.select().from(s.accessAudit).where(eq(s.accessAudit.subjectKey, `job:${jobId}`));
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ purpose: "console.job_retry", actorRef: "Sample Curator Ana" });
    expect((await call(h.ana, "POST", `/ops/jobs/${jobId}/retry`, {})).status).toBe(409);
  });
});

describe("release rollback", () => {
  async function releases() {
    const put = async (n: number, state: string) => {
      const key = `releases/${n}/client-core.json`;
      h.bucket.objects.set(key, JSON.stringify({ v: 1, release: n }));
      await h.t.db.insert(s.registryReleases).values({ number: n, state, clientCoreKey: key, sizeBytes: 10, sha256: "b".repeat(64), createdAt: NOW - n, builtAt: NOW - n, publishedAt: NOW - n });
    };
    await put(1, "published");
    await put(2, "published");
  }

  it("is admin only", async () => {
    await releases();
    expect((await call(h.ana, "POST", "/registry/release/rollback", { release: 1 })).status).toBe(403);
  });

  it("points the release pointer back, marks newer releases failed, audits and alerts", async () => {
    await releases();
    const res = await call(h.admin, "POST", "/registry/release/rollback", { release: 1 });
    expect(res.status).toBe(200);
    const pointer = ReleasePointerSchema.parse(await res.json());
    expect(pointer).toMatchObject({ release: 1, path: "/data/client-core/1.json" });
    const stored = ReleasePointerSchema.parse(JSON.parse(h.bucket.objects.get("releases/current.json")!));
    expect(stored).toMatchObject({ release: 1, path: "releases/1/client-core.json" });
    const rows = await h.t.db.select().from(s.registryReleases);
    expect(rows.find((r) => r.number === 2)!.state).toBe("failed");
    expect(rows.find((r) => r.number === 1)!.state).toBe("published");
    const audits = await h.t.db.select().from(s.accessAudit).where(eq(s.accessAudit.purpose, "console.release_rollback"));
    expect(audits).toHaveLength(1);
    expect(h.logs).toContainEqual({ level: "alert", event: "release_rolled_back" });
    // Rolling "back" to the live release, or to one never built, is refused.
    expect((await call(h.admin, "POST", "/registry/release/rollback", { release: 1 })).status).toBe(409);
    expect((await call(h.admin, "POST", "/registry/release/rollback", { release: 7 })).status).toBe(404);
  });
});
