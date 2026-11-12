import { describe, expect, it } from "vitest";
import { freshDb } from "@server/db/testing/fixtures";
import { setFlag } from "@server/db/repos/jobs";
import { config as configTable } from "@server/db/schema";
import { FlagCache, d1FlagSource } from "./flags";
import { D1_RATE_KEY_PREFIX, consumeD1Window } from "./rate-limit";

/** These run against real SQLite with the committed migrations (server/db/testing). */

describe("consumeD1Window", () => {
  it("counts within a window, refuses past the limit and resets in the next window", async () => {
    const { db, raw } = await freshDb();
    const rule = { limit: 3, windowMs: 3_600_000 };
    const t0 = 7_200_000;
    for (let i = 0; i < 3; i++) expect((await consumeD1Window(db, "send:abc", rule, t0 + i)).allowed).toBe(true);
    const refused = await consumeD1Window(db, "send:abc", rule, t0 + 1_800_000);
    expect(refused).toEqual({ allowed: false, retryAfterSeconds: 1800 });
    expect((await consumeD1Window(db, "send:other", rule, t0)).allowed).toBe(true);
    expect((await consumeD1Window(db, "send:abc", rule, t0 + 3_600_000)).allowed).toBe(true);

    const rows = raw.d1 as unknown as D1Database;
    const row = await rows.prepare("SELECT key, count FROM rate_limits WHERE key = ?").bind(`${D1_RATE_KEY_PREFIX}send:abc`).first<{ count: number }>();
    expect(row?.count).toBe(1);
  });
});

describe("d1FlagSource", () => {
  it("reads flags and rollout percentages through the cache", async () => {
    const { db } = await freshDb();
    await setFlag(db, "site.read_only", true, 1);
    await db.insert(configTable).values({ key: "rollout.llm.ask", value: 25, updatedAt: 1 });
    await db.insert(configTable).values({ key: "abuse.threshold", value: 9, updatedAt: 1 });
    const snap = await new FlagCache(60_000, () => 0).get(d1FlagSource(db));
    expect(snap.source).toBe("d1");
    expect(snap.values["site.read_only"]).toBe(true);
    expect(snap.values["mcp.enabled"]).toBe(false);
    expect(snap.rollouts).toEqual({ "llm.ask": 25 });
  });
});
