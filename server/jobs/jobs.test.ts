import { describe, expect, it } from "vitest";
import { jobs } from "@server/db/repos";
import * as s from "@server/db/schema";
import { freshDb } from "@server/db/testing/fixtures";
import { Budget } from "./budget";
import { ACCOUNT_UNDO_WINDOW_MS, deletionProcess, enqueueDueSources } from "./handlers";
import { students } from "@server/db/repos";
import { createUser } from "@server/db/testing/fixtures";
import { catchUp, runInvocation, runScheduled, TRIGGER_HEARTBEAT } from "./index";
import { jobsForTrigger, slotFor, triggerForCron, WORKER_JOBS } from "./registry";
import { evaluateHealth, PIPELINE_STALE_MS } from "./watchdog";
import { silentLogger, type JobHandler, type Logger, type WorkerBindings } from "./types";

const NOW = Date.UTC(2026, 10, 11, 8, 0, 30);
const MIN = 60_000;

async function setup() {
  const { raw, db } = await freshDb();
  const env: WorkerBindings = { DB: raw.d1 as unknown as D1Database };
  return { db, env };
}

const ok: JobHandler = async () => ({ processed: 1, outcome: "ok" });

/** Handlers for every implemented kind that just count calls, so runner tests need no data. */
function countingHandlers(calls: string[], override: Record<string, JobHandler> = {}) {
  const out: Record<string, JobHandler> = {};
  for (const spec of WORKER_JOBS) {
    out[spec.kind] = override[spec.kind] ?? (async (ctx) => {
      calls.push(`${spec.kind}@${ctx.slot ?? "-"}`);
      return ok(ctx);
    });
  }
  return out;
}

describe("Budget", () => {
  it("shares limits to children and charges the parent", () => {
    let t = 0;
    const root = new Budget({ ms: 1000, calls: 100 }, () => t);
    const child = root.share(0.25);
    expect(child.remainingCalls).toBe(25);
    child.spend(20);
    expect(root.remainingCalls).toBe(80);
    expect(child.allows(5)).toBe(true);
    expect(child.allows(6)).toBe(false);
    t = 1001;
    expect(root.exhausted).toBe(true);
    expect(child.allows(1)).toBe(false);
  });

  it("never gives a child more than the parent has left", () => {
    const root = new Budget({ ms: 1000, calls: 10 }, () => 0);
    root.spend(9);
    expect(root.share(1).remainingCalls).toBe(1);
  });
});

describe("registry", () => {
  it("maps the wrangler crons to triggers", () => {
    expect(triggerForCron("*/5 * * * *")).toBe("tick");
    expect(triggerForCron("0 * * * *")).toBe("hourly");
    expect(triggerForCron("0 8 * * *")).toBe("daily");
    expect(triggerForCron("1 2 3 4 5")).toBeNull();
  });

  it("derives hour and day slots in UTC", () => {
    expect(slotFor("hourly", NOW)).toBe("2026-11-11T08");
    expect(slotFor("daily", NOW)).toBe("2026-11-11");
    expect(slotFor("tick", NOW)).toBeNull();
  });

  it("orders notify.dispatch before alerts.match on the tick", () => {
    expect(jobsForTrigger("tick").map((j) => j.kind)).toEqual(["notify.dispatch", "alerts.match", "sources.enqueue_due", "release.build"]);
  });

  it("keeps each trigger's budget shares within the whole", () => {
    for (const trigger of ["tick", "hourly", "daily"] as const) {
      const implemented = jobsForTrigger(trigger).filter((j) => j.implemented);
      expect(implemented.reduce((sum, j) => sum + j.share, 0)).toBeLessThanOrEqual(1.0001);
    }
  });
});

describe("runner", () => {
  it("runs a slot kind once per slot, even when the trigger fires twice", async () => {
    const { db, env } = await setup();
    const calls: string[] = [];
    const handlers = countingHandlers(calls);
    await runInvocation("daily", env, { now: () => NOW, slotTime: NOW, log: silentLogger, handlers });
    const second = await runInvocation("daily", env, { now: () => NOW + MIN, slotTime: NOW, log: silentLogger, handlers });
    expect(calls.filter((c) => c.startsWith("audit.digest"))).toEqual(["audit.digest@2026-11-11"]);
    expect(second.results.find((r) => r.kind === "audit.digest")?.status).toBe("skipped_done");
    const slotJob = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.idempotencyKey, "audit.digest:2026-11-11") });
    expect(slotJob?.status).toBe("done");
  });

  it("drain kinds run on every tick", async () => {
    const { env } = await setup();
    const calls: string[] = [];
    const handlers = countingHandlers(calls);
    await runInvocation("tick", env, { now: () => NOW, log: silentLogger, handlers });
    await runInvocation("tick", env, { now: () => NOW + 5 * MIN, log: silentLogger, handlers });
    expect(calls.filter((c) => c.startsWith("notify.dispatch"))).toHaveLength(2);
  });

  it("records a failing kind and still runs the next one", async () => {
    const { db, env } = await setup();
    const calls: string[] = [];
    const boom: JobHandler = async () => {
      throw new TypeError("contains a private value that must not be logged");
    };
    const logged: string[] = [];
    const log: Logger = (_level, event, fields) => logged.push(`${event}:${JSON.stringify(fields ?? {})}`);
    const report = await runInvocation("tick", env, { now: () => NOW, log, handlers: countingHandlers(calls, { "notify.dispatch": boom }) });
    expect(report.results.map((r) => [r.kind, r.status])).toEqual([
      ["notify.dispatch", "failed"],
      ["alerts.match", "ok"],
      ["sources.enqueue_due", "ok"],
      ["release.build", "ok"],
    ]);
    const runs = await db.select().from(s.jobRuns);
    const failed = runs.find((r) => r.kind === "notify.dispatch");
    expect(failed?.outcome).toBe("failed");
    expect(failed?.errorClass).toBe("TypeError");
    expect(logged.join("\n")).not.toContain("private value");
  });

  it("retries a failed slot job with backoff and keeps its attempts", async () => {
    const { db, env } = await setup();
    const calls: string[] = [];
    const flaky: JobHandler = async () => {
      throw new Error("x");
    };
    await runInvocation("hourly", env, { now: () => NOW, slotTime: NOW, log: silentLogger, handlers: countingHandlers(calls, { sweep: flaky }) });
    const job = await db.query.jobs.findFirst({ where: (j, { eq }) => eq(j.idempotencyKey, "sweep:2026-11-11T08") });
    expect(job?.status).toBe("pending");
    expect(job?.attempts).toBe(1);
    expect(job!.runAfter).toBeGreaterThan(NOW);
  });

  it("skips kinds once the invocation budget is spent", async () => {
    const { env } = await setup();
    const calls: string[] = [];
    const report = await runInvocation("tick", env, { now: () => NOW, log: silentLogger, handlers: countingHandlers(calls), limits: { ms: 25_000, calls: 2 } });
    expect(report.results.every((r) => r.status === "skipped_budget")).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it("marks kinds without a handler as not implemented", async () => {
    const { env } = await setup();
    const report = await runInvocation("daily", env, { now: () => NOW, slotTime: NOW, log: silentLogger, handlers: {} });
    expect(report.results.every((r) => r.status === "not_implemented")).toBe(true);
  });

  it("ignores unknown crons", async () => {
    const { env } = await setup();
    await expect(runScheduled({ cron: "7 7 7 7 7", scheduledTime: NOW, noRetry() {} } as ScheduledController, env, {} as ExecutionContext)).resolves.toBeUndefined();
  });
});

describe("catch-up watchdog", () => {
  it("runs only triggers whose last start is stale, and is idempotent", async () => {
    const { db, env } = await setup();
    const calls: string[] = [];
    const handlers = countingHandlers(calls);
    await jobs.heartbeat(db, TRIGGER_HEARTBEAT.tick, NOW - 2 * MIN);
    await jobs.heartbeat(db, TRIGGER_HEARTBEAT.hourly, NOW - 2 * 3_600_000);
    await jobs.heartbeat(db, TRIGGER_HEARTBEAT.daily, NOW - 3_600_000);
    const first = await catchUp(env, { now: () => NOW, log: silentLogger, handlers });
    expect(first.ran).toEqual(["hourly"]);
    // The catch-up run moved the hourly heartbeat, so an immediate second call does nothing.
    const second = await catchUp(env, { now: () => NOW + MIN, log: silentLogger, handlers });
    expect(second.ran).toEqual([]);
    expect(calls.filter((c) => c.startsWith("sweep"))).toHaveLength(1);
  });

  it("runs every trigger on a fresh database", async () => {
    const { env } = await setup();
    const res = await catchUp(env, { now: () => NOW, log: silentLogger, handlers: {} });
    expect(res.ran).toEqual(["tick", "hourly", "daily"]);
  });
});

describe("health evaluation", () => {
  it("alerts on a late kind and a stale pipeline heartbeat", () => {
    const alerts = evaluateHealth({ pending: [{ kind: "fetch", oldestRunAfter: NOW - 3 * 3_600_000, pending: 4 }], pipelineSeenAt: NOW - PIPELINE_STALE_MS - 1, now: NOW });
    expect(alerts.map((a) => a.code).sort()).toEqual(["job_late", "pipeline_heartbeat_stale"]);
  });

  it("stays quiet when the pipeline is alive and jobs are on time", () => {
    expect(evaluateHealth({ pending: [{ kind: "fetch", oldestRunAfter: NOW - MIN, pending: 1 }], pipelineSeenAt: NOW - MIN, now: NOW })).toEqual([]);
    // No pipeline work waiting: an old heartbeat is not an alert.
    expect(evaluateHealth({ pending: [], pipelineSeenAt: null, now: NOW })).toEqual([]);
  });
});

describe("sources.enqueue_due", () => {
  it("enqueues one fetch job per due approved Source and pushes its due time", async () => {
    const { db, env } = await setup();
    const t = NOW - 1000;
    await db.insert(s.sourceHosts).values({ host: "programs.example.org", policy: "allowed", policySource: "default", updatedAt: t });
    for (const [i, approval] of (["approved", "approved", "pending_approval"] as const).entries()) {
      await db.insert(s.sources).values({
        id: `01890000-0000-7000-8000-00000000000${i}`,
        url: `https://programs.example.org/${i}`,
        kind: "official_page",
        host: "programs.example.org",
        approval,
        nextCheckAt: t,
        createdAt: t,
        updatedAt: t,
      });
    }
    const ctx = { env, db, edb: null, now: () => NOW, budget: new Budget({ ms: 25_000, calls: 900 }, () => NOW), log: silentLogger, trigger: "tick" as const, slot: null };
    expect((await enqueueDueSources(ctx)).processed).toBe(2);
    // Next tick: the due time moved forward, so nothing new is queued.
    expect((await enqueueDueSources(ctx)).processed).toBe(0);
    const queued = await db.select().from(s.jobs);
    expect(queued).toHaveLength(2);
    expect(queued.every((j) => j.kind === "fetch" && j.concurrencyKey === "host:programs.example.org")).toBe(true);
  });
});

describe("deletion.process", () => {
  it("purges accounts only after the undo window and leaves restorable ones alone", async () => {
    const { db, env } = await setup();
    const old = await createUser(db);
    const recent = await createUser(db);
    const live = await createUser(db);
    await students.softDeleteUser(db, old, NOW - ACCOUNT_UNDO_WINDOW_MS - MIN);
    await students.softDeleteUser(db, recent, NOW - MIN);
    const ctx = { env, db, edb: null, now: () => NOW, budget: new Budget({ ms: 25_000, calls: 900 }, () => NOW), log: silentLogger, trigger: "daily" as const, slot: "2026-11-11" };
    expect(await deletionProcess(ctx)).toEqual({ processed: 1, outcome: "ok" });
    const ids = (await db.select({ id: s.users.id }).from(s.users)).map((u) => u.id);
    expect(ids).not.toContain(old);
    expect(ids).toContain(recent);
    expect(ids).toContain(live);
  });
});
