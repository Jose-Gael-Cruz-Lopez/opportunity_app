import { describe, expect, it } from "vitest";
import { seededDb } from "@server/db/testing/fixtures";
import { Budget } from "../budget";
import { silentLogger, type JobContext, type WorkerBindings } from "../types";
import { digestSend } from "./digest-send";
import { remindersSchedule } from "./reminders-schedule";

// The cron adapters: JobContext in, HandlerResult out. Behaviour is tested in server/services/reminders.

const NOW = Date.UTC(2026, 10, 11, 15, 0);

async function ctx(env: Partial<WorkerBindings> = {}): Promise<JobContext> {
  const t = await seededDb();
  return {
    env: { DB: t.raw.d1, ENVIRONMENT: "local", ...env } as WorkerBindings,
    db: t.db,
    edb: null,
    now: () => NOW,
    budget: new Budget({ ms: 60_000, calls: 900 }, () => NOW),
    log: silentLogger,
    trigger: "hourly",
    slot: "2026-11-11T15",
  };
}

describe("cron kind adapters", () => {
  it("reminders.schedule runs on an empty audience", async () => {
    const res = await remindersSchedule(await ctx());
    expect(res).toMatchObject({ processed: 0, outcome: "ok" });
  });

  it("digest.send defers without BETTER_AUTH_SECRET and runs with it (dry-run provider locally)", async () => {
    expect((await digestSend(await ctx())).outcome).toBe("deferred");
    const res = await digestSend(await ctx({ BETTER_AUTH_SECRET: "test-only-root-secret-0123456789abcdef0123" }));
    expect(res).toMatchObject({ processed: 0, outcome: "ok" });
  });
});
