import { eq } from "drizzle-orm";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ANALYTICS_EVENT_NAMES } from "@shared/contracts/api";
import { isSensitiveKey } from "@shared/contracts/sensitive";
import * as e from "@server/db/events-schema";
import * as s from "@server/db/schema";
import { sweepClientErrorDaily } from "@server/db/repos/events";
import { createUser, freshEventsDb, seededDb } from "@server/db/testing/fixtures";
import { createLogger, rootLogger, setRootLogger, type Logger } from "@server/lib/log";
import { checkProps, EVENT_PROPS, ROUTE_TEMPLATES, routeTemplate, type AnalyticsEventName } from "./allowlist";
import { ClientErrorReportSchema, errorKey } from "./client-errors";
import { createEventsRoutes, createLimiters, isBotUserAgent, LIMITS, MAX_BATCH_EVENTS } from "./index";
import { inSample, sampleBucket, SAMPLE_RATES } from "./sampling";
import { ONBOARDING_FUNNEL, onboardingEvent, type OnboardingEventData } from "@shared/onboarding/analytics";
import { PLAN_STEP_KINDS, TIERS, type MatchSet } from "@shared/onboarding/types";
import { funnelCounts } from "../admin/metrics/queries";
import { createD1EventsStore } from "./store";

const NOW = Date.UTC(2026, 10, 11, 15, 0);
const AT = new Date(NOW - 5_000).toISOString();
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
/** A session id that falls inside every sample (bucket 0..2499 keeps filter_change at 0.25). */
const SID = findSession((b) => b < 2_000);
const SID_OUT = findSession((b) => b >= 9_000);

function findSession(pred: (bucket: number) => boolean): string {
  for (let i = 0; i < 10_000; i++) {
    const id = `sess${i.toString(36).padStart(18, "0")}`;
    if (pred(sampleBucket(id))) return id;
  }
  throw new Error("no session id found");
}

let lines: string[] = [];
let previous: Logger;
beforeEach(() => {
  lines = [];
  previous = rootLogger();
  setRootLogger(createLogger({ sink: (_level, line) => lines.push(line), minLevel: "debug" }));
});
afterEach(() => setRootLogger(previous));

/** FNV-1a("novus") % 10000; the client test asserts the same number. */
const SHARED_VECTOR_NOVUS = 3_040;

async function setup(opts: { user?: string; withErrorTable?: boolean; env?: Record<string, unknown> } = {}) {
  const main = await seededDb();
  const events = await freshEventsDb();
  // The table comes from server/db/migrations-events/0002_client_error_daily.sql; dropping it
  // reproduces an environment where that migration is not applied yet.
  if (opts.withErrorTable === false) events.raw.exec("DROP TABLE client_error_daily");
  const cycleOf = async (slug: string) => {
    const [row] = await main.db
      .select({ cycleId: s.programCycles.id, programId: s.programs.id })
      .from(s.programCycles)
      .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
      .where(eq(s.programs.slug, slug))
      .limit(1);
    if (!row) throw new Error(`seed is missing ${slug}`);
    return row;
  };
  const open = await cycleOf("sample-undergraduate-research-conference");
  const identity = await cycleOf("sample-women-in-computing-cohort");
  const [sensitiveRow] = await main.db.select({ id: s.programs.id }).from(s.programs).where(eq(s.programs.sensitiveAudience, true)).limit(1);
  const sensitive = await main.db
    .select({ cycleId: s.programCycles.id, programId: s.programCycles.programId })
    .from(s.programCycles)
    .where(eq(s.programCycles.programId, sensitiveRow!.id))
    .limit(1)
    .then((r) => r[0]!);

  const routes = createEventsRoutes({ now: () => NOW, limiters: createLimiters() });
  const app = new Hono<{ Variables: { user?: { id: string } } }>();
  app.use("*", async (c, next) => {
    if (opts.user) c.set("user", { id: opts.user });
    await next();
  });
  app.route("/", routes);
  const env = { DB: main.raw.d1, EVENTS_DB: events.raw.d1, ...opts.env };
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    app.request(
      path,
      {
        method: "POST",
        headers: { "content-type": "text/plain;charset=UTF-8", "user-agent": UA, "cf-connecting-ip": "203.0.113.7", ...headers },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      env,
    );
  const rows = () => events.edb.select().from(e.analyticsEvents);
  const counters = () => events.edb.select().from(e.programDailyCounts);
  return { main, events, post, rows, counters, open, identity, sensitive, env };
}

const ev = (name: string, props: Record<string, unknown> = {}, over: Record<string, unknown> = {}) => ({ name, deviceId: SID, at: AT, path: "/app/explore", props, ...over });

describe("allowlist", () => {
  it("declares a property list for every contract event name and no sensitive key", () => {
    expect(Object.keys(EVENT_PROPS).sort()).toEqual([...ANALYTICS_EVENT_NAMES].sort());
    for (const props of Object.values(EVENT_PROPS)) for (const key of Object.keys(props)) expect(isSensitiveKey(key)).toBe(false);
  });

  it("has no free-text property type", () => {
    for (const props of Object.values(EVENT_PROPS)) for (const spec of Object.values(props)) expect(["id", "enum", "int", "bool"]).toContain(spec.type);
  });

  it("rejects unknown keys, wrong types, long strings and sensitive keys", () => {
    const pid = "0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f";
    expect(checkProps("program_view", { programId: pid.toUpperCase(), entry: "explore" })).toEqual({ ok: true, props: { programId: pid, entry: "explore" } });
    expect(checkProps("search", { query: "biology" })).toEqual({ ok: false, reason: "unknown_key" });
    expect(checkProps("search", { resultBucket: "11" })).toEqual({ ok: false, reason: "bad_value" });
    expect(checkProps("program_view", { programId: "not-a-uuid" })).toEqual({ ok: false, reason: "bad_value" });
    expect(checkProps("onboarding_step", { step: "quiz_completed", asked: 2.5 })).toEqual({ ok: false, reason: "bad_value" });
    expect(checkProps("onboarding_step", { step: "quiz_completed", stepIndex: 2 })).toEqual({ ok: false, reason: "unknown_key" });
    expect(checkProps("onboarding_step", { step: "intro" })).toEqual({ ok: false, reason: "bad_value" });
    // A step carries only its own keys, and always names its step.
    expect(checkProps("onboarding_step", { step: "started", tier: "strong" })).toEqual({ ok: false, reason: "unknown_key" });
    expect(checkProps("onboarding_step", { ok: true })).toEqual({ ok: false, reason: "bad_value" });
    expect(checkProps("filter_change", { citizenship: "x" })).toEqual({ ok: false, reason: "sensitive_key" });
    expect(checkProps("filter_change", { filter: "pell" })).toEqual({ ok: false, reason: "unknown_key" });
  });

  it("maps paths to route templates and everything else to other", () => {
    expect(routeTemplate("/programs/nsf-reu?utm_source=x#top")).toBe("/programs/:slug");
    expect(routeTemplate("/app/programs/abc/")).toBe("/app/programs/:slug");
    expect(routeTemplate("/app/readiness/0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f")).toBe("/app/readiness/:programCycleId");
    expect(routeTemplate("/app/settings/privacy")).toBe("/app/settings");
    expect(routeTemplate("/lists/u/secret-token")).toBe("/lists/u/:token");
    expect(routeTemplate("/cal/u/abcdef.ics")).toBe("other");
    expect(routeTemplate("/e/rc/abc.def")).toBe("other");
    expect(routeTemplate("https://example.org/explore")).toBe("other");
    expect(routeTemplate("/programs/:slug")).toBe("/programs/:slug");
    for (const t of ROUTE_TEMPLATES) expect(t).not.toMatch(/[?#]/);
  });
});

describe("sampling", () => {
  it("is deterministic per session and matches the shared test vector", () => {
    // Same vector as client/src/lib/telemetry/telemetry.test.ts.
    expect(sampleBucket("")).toBe(6_261 /* 0x811c9dc5 % 10000 */);
    expect(sampleBucket("novus")).toBe(SHARED_VECTOR_NOVUS);
    expect(sampleBucket("abcdefghijklmnop")).toBe(sampleBucket("abcdefghijklmnop"));
    expect(sampleBucket("novus-session-000001")).toBe(Number(BigInt(fnv("novus-session-000001")) % 10_000n));
    expect(inSample(SID, 0.25)).toBe(true);
    expect(inSample(SID_OUT, 0.5)).toBe(false);
    expect(inSample(SID_OUT, 1)).toBe(true);
    expect(inSample(SID, 0)).toBe(false);
  });
});

function fnv(text: string): number {
  let h = 0x811c9dc5;
  for (const ch of text) {
    h ^= ch.charCodeAt(0);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

describe("POST /events", () => {
  it("stores allowlisted events keyed only by the session id, with a route template", async () => {
    const t = await setup();
    const res = await t.post("/events", { events: [ev("page_view", { surface: "app" }, { path: "/app/programs/some-slug?ref=email" }), ev("search", { resultBucket: "1-9" })] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ accepted: 2 });
    expect(res.headers.get("cache-control")).toBe("no-store");
    const rows = await t.rows();
    expect(rows).toHaveLength(2);
    const page = rows.find((r) => r.name === "page_view")!;
    expect(page).toMatchObject({ deviceId: SID, userHmac: null, hmacKeyId: null, path: "/app/programs/:slug", props: { surface: "app" } });
    expect(page.at % 1000).toBe(0);
    // A sampled event carries its rate so counts can be reweighted.
    expect(rows.find((r) => r.name === "search")!.props).toEqual({ resultBucket: "1-9", sampleRate: SAMPLE_RATES.search });
    // Nothing in a stored row names the IP, the user agent or a query string.
    const dump = JSON.stringify(rows);
    expect(dump).not.toContain("203.0.113");
    expect(dump).not.toContain("Safari");
    expect(dump).not.toContain("ref=email");
  });

  it("answers 204 and stores nothing under Global Privacy Control or for a bot", async () => {
    const t = await setup();
    const gpc = await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "sec-gpc": "1" });
    expect(gpc.status).toBe(204);
    const bot = await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "user-agent": "Googlebot/2.1 (+http://www.google.com/bot.html)" });
    expect(bot.status).toBe(204);
    const none = await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "user-agent": "" });
    expect(none.status).toBe(204);
    expect(await t.rows()).toHaveLength(0);
    expect(isBotUserAgent(UA)).toBe(false);
  });

  it("refuses a sensitive key anywhere in the body, stores nothing and alerts", async () => {
    const t = await setup();
    const res = await t.post("/events", { events: [ev("filter_change", { pellEligible: true })] });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { code?: string; errors?: { path: string; message: string }[] };
    expect(JSON.stringify(body)).not.toContain("true");
    expect(body.errors?.[0]?.path).toContain("pellEligible");
    expect(await t.rows()).toHaveLength(0);
    expect(lines.some((l) => l.includes("events.sensitive_key_rejected"))).toBe(true);
  });

  it("drops events with undeclared keys or values instead of trimming them", async () => {
    const t = await setup();
    const res = await t.post("/events", {
      events: [ev("search", { resultBucket: "10+", text: "first gen scholarships" }), ev("onboarding_step", { step: "quiz_completed", asked: 12, skipped: 1 })],
    });
    expect(await res.json()).toEqual({ accepted: 1 });
    const rows = await t.rows();
    expect(rows.map((r) => r.name)).toEqual(["onboarding_step"]);
    expect(JSON.stringify(rows)).not.toContain("first gen");
    expect(lines.some((l) => l.includes("events.dropped") && l.includes('"invalid":1'))).toBe(true);
  });

  it("validates the envelope: unknown names, bad session ids, too many events, too large, not JSON", async () => {
    const t = await setup();
    expect((await t.post("/events", { events: [ev("purchase")] })).status).toBe(400);
    expect((await t.post("/events", { events: [ev("page_view", {}, { deviceId: "short" })] })).status).toBe(400);
    expect((await t.post("/events", { events: [ev("page_view", {}, { email: "a@b.c" })] })).status).toBe(400);
    const many = Array.from({ length: MAX_BATCH_EVENTS + 1 }, () => ev("page_view", { surface: "app" }));
    expect((await t.post("/events", { events: many })).status).toBe(400);
    expect((await t.post("/events", "x".repeat(17_000))).status).toBe(413);
    expect((await t.post("/events", "{not json")).status).toBe(400);
    expect(await t.rows()).toHaveLength(0);
  });

  it("drops stale or future-dated events and sessions outside an event's sample", async () => {
    const t = await setup();
    const res = await t.post("/events", {
      events: [
        ev("page_view", { surface: "app" }, { at: new Date(NOW - 25 * 3_600_000).toISOString() }),
        ev("page_view", { surface: "app" }, { at: new Date(NOW + 10 * 60_000).toISOString() }),
      ],
    });
    expect(await res.json()).toEqual({ accepted: 0 });
    const out = await t.post("/events", { events: [ev("filter_change", {}, { deviceId: SID_OUT }), ev("page_view", { surface: "app" }, { deviceId: SID_OUT })] });
    expect(await out.json()).toEqual({ accepted: 1 });
    expect((await t.rows()).map((r) => r.name)).toEqual(["page_view"]);
  });

  it("stores a row for an open program but only a day counter for a restricted one", async () => {
    const t = await setup();
    const open = await t.post("/events", { events: [ev("program_view", { programId: t.open.programId, cycleId: t.open.cycleId, entry: "explore" }, { path: "/programs/x" })] });
    expect(await open.json()).toEqual({ accepted: 1 });

    // Restricted events travel alone (the client's counter path).
    for (const target of [t.sensitive, t.identity]) {
      const res = await t.post("/events", { events: [ev("apply_click", { programId: target.programId, cycleId: target.cycleId, entry: "direct" })] });
      expect(await res.json()).toEqual({ accepted: 1 });
    }
    const rows = await t.rows();
    expect(rows).toHaveLength(1);
    expect(rows[0]!.props).toMatchObject({ programId: t.open.programId });
    expect(JSON.stringify(rows)).not.toContain(t.sensitive.programId);
    expect(JSON.stringify(rows)).not.toContain(t.identity.programId);
    const counters = await t.counters();
    expect(counters).toHaveLength(2);
    expect(counters.every((c) => c.day === "2026-11-11" && c.eventName === "apply_click" && c.n === 1)).toBe(true);
    expect(counters.map((c) => c.programId).sort()).toEqual([t.sensitive.programId, t.identity.programId].sort());
  });

  it("counts a restricted event found inside a keyed batch, stores no row for it and alerts", async () => {
    const t = await setup();
    const res = await t.post("/events", {
      events: [ev("page_view", { surface: "public" }), ev("readiness_open", { cycleId: t.sensitive.cycleId }), ev("program_view", { cycleId: t.identity.cycleId })],
    });
    expect(await res.json()).toEqual({ accepted: 3 });
    const rows = await t.rows();
    expect(rows.map((r) => r.name)).toEqual(["page_view"]);
    // No stored row or column can be joined to the restricted programs.
    const dump = JSON.stringify(rows);
    for (const id of [t.sensitive.programId, t.sensitive.cycleId, t.identity.programId, t.identity.cycleId]) expect(dump).not.toContain(id);
    expect((await t.counters()).map((c) => c.eventName).sort()).toEqual(["program_view", "readiness_open"]);
    expect(lines.some((l) => l.includes("events.restricted_in_batch"))).toBe(true);
  });

  it("drops events naming an unknown program or a cycle of another program", async () => {
    const t = await setup();
    const res = await t.post("/events", {
      events: [
        ev("program_view", { programId: "0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f" }),
        ev("program_view", { programId: t.open.programId, cycleId: t.identity.cycleId }),
      ],
    });
    expect(await res.json()).toEqual({ accepted: 0 });
    expect(await t.rows()).toHaveLength(0);
    expect(await t.counters()).toHaveLength(0);
  });

  it("stores nothing for a signed-in account with analytics off or in minor mode", async () => {
    const main = await seededDb();
    const off = await createUser(main.db);
    await main.db.update(s.users).set({ analyticsOffAt: NOW - 1000 }).where(eq(s.users.id, off));
    const store = createD1EventsStore({ DB: main.raw.d1, EVENTS_DB: (await freshEventsDb()).raw.d1 });
    expect(await store.viewerAllowsAnalytics(off, NOW)).toBe(false);
    const minor = await createUser(main.db);
    await main.db.insert(s.studentProfiles).values({ userId: minor, birthYearMonth: "2009-06" });
    expect(await store.viewerAllowsAnalytics(minor, NOW)).toBe(false);
    const adult = await createUser(main.db);
    await main.db.insert(s.studentProfiles).values({ userId: adult, birthYearMonth: "2006-01" });
    expect(await store.viewerAllowsAnalytics(adult, NOW)).toBe(true);
    const unknownAge = await createUser(main.db);
    expect(await store.viewerAllowsAnalytics(unknownAge, NOW)).toBe(true);
    expect(await store.viewerAllowsAnalytics("0190f7a2-5c3e-7b4d-8e9f-000000000000", NOW)).toBe(false);
  });

  it("answers 204 for a signed-in viewer whose account turned analytics off", async () => {
    const main = await seededDb();
    const events = await freshEventsDb();
    const user = await createUser(main.db);
    await main.db.update(s.users).set({ analyticsOffAt: NOW }).where(eq(s.users.id, user));
    const app = new Hono<{ Variables: { user?: { id: string } } }>();
    app.use("*", async (c, next) => {
      c.set("user", { id: user });
      await next();
    });
    app.route("/", createEventsRoutes({ now: () => NOW, limiters: createLimiters() }));
    const res = await app.request(
      "/events",
      { method: "POST", headers: { "user-agent": UA, "content-type": "application/json" }, body: JSON.stringify({ events: [ev("page_view", { surface: "app" })] }) },
      { DB: main.raw.d1, EVENTS_DB: events.raw.d1 },
    );
    expect(res.status).toBe(204);
    expect(await events.edb.select().from(e.analyticsEvents)).toHaveLength(0);
  });

  it("rate-limits per IP and caps events per session per day", async () => {
    const t = await setup();
    let last = 200;
    for (let i = 0; i <= LIMITS.batchesPerMinutePerIp; i++) {
      last = (await t.post("/events", { events: [ev("page_view", { surface: "app" }, { deviceId: `${SID}x${i}`.slice(0, 64) })] }, { "cf-connecting-ip": "198.51.100.1" })).status;
    }
    expect(last).toBe(429);

    const limiters = createLimiters();
    const app = createEventsRoutes({ now: () => NOW, limiters });
    // Exhaust the per-session day cap directly, then one more event is dropped (not stored).
    for (let i = 0; i < LIMITS.eventsPerDayPerSession; i++) limiters.sessionDay.check(`d:${SID}`, NOW);
    const res = await app.request(
      "/events",
      { method: "POST", headers: { "user-agent": UA }, body: JSON.stringify({ events: [ev("page_view", { surface: "app" })] }) },
      t.env,
    );
    expect(await res.json()).toEqual({ accepted: 0 });
  });

  it("limits by network, so rotating addresses inside one IPv6 /64 or IPv4 /24 does not help", async () => {
    const t = await setup();
    let last = 200;
    for (let i = 0; i <= LIMITS.batchesPerMinutePerIp; i++) {
      const ip = `2001:db8:1:2:${(i + 1).toString(16)}::${(i + 7).toString(16)}`;
      last = (await t.post("/events", { events: [ev("page_view", { surface: "app" }, { deviceId: `${SID}r${i}`.slice(0, 64) })] }, { "cf-connecting-ip": ip })).status;
    }
    expect(last).toBe(429);
    // Another /64 is unaffected.
    expect((await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "cf-connecting-ip": "2001:db8:1:3::1" })).status).toBe(200);
  });

  it("asks the shared rate-limit binding under a network key", async () => {
    const keys: string[] = [];
    const t = await setup({ env: { RATE_LIMIT_PUBLIC: { limit: async ({ key }: { key: string }) => (keys.push(key), { success: false }) } } });
    const res = await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "cf-connecting-ip": "203.0.113.200" });
    expect(res.status).toBe(429);
    expect(keys).toEqual(["events:203.0.113.0/24"]);
    expect(await t.rows()).toHaveLength(0);
  });

  it("keeps a durable daily cap per network in D1, stored as an HMAC, never the address", async () => {
    const t = await setup({ env: { BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789" } });
    expect((await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "cf-connecting-ip": "203.0.113.200" })).status).toBe(200);
    const rows = (await t.main.raw.d1.prepare("SELECT key, count FROM rate_limits WHERE key LIKE 'novus:events:%'").all()).results as { key: string; count: number }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.key).toMatch(/^novus:events:events:[0-9a-f]{32}$/);
    expect(JSON.stringify(rows)).not.toContain("203.0.113");
    // At the cap, the next batch from that network is refused and nothing is stored.
    await t.main.raw.d1.prepare("UPDATE rate_limits SET count = ? WHERE key = ?").bind(LIMITS.eventBatchesPerDayPerNetwork, rows[0]!.key).run();
    const before = (await t.rows()).length;
    expect((await t.post("/events", { events: [ev("page_view", { surface: "app" })] }, { "cf-connecting-ip": "203.0.113.9" })).status).toBe(429);
    expect(await t.rows()).toHaveLength(before);
    expect(lines.some((l) => l.includes("events.network_day_cap"))).toBe(true);
  });
});

describe("WindowLimiter under a key flood", () => {
  it("evicts ended and least recently used windows instead of resetting every client", async () => {
    const { WindowLimiter } = await import("@server/lib/rate-limit");
    const l = new WindowLimiter([{ limit: 1, windowMs: 60_000 }], 10);
    expect(l.check("victim", NOW).allowed).toBe(true);
    expect(l.check("victim", NOW).allowed).toBe(false);
    // A flood of fresh keys in the same window: the oldest go, the map stays bounded.
    for (let i = 0; i < 50; i++) l.check(`flood-${i}`, NOW);
    expect(l.size).toBeLessThanOrEqual(10);
    // The flooder's own most recent key is still limited (no global reset).
    expect(l.check("flood-49", NOW).allowed).toBe(false);
    // Ended windows are dropped first.
    const m = new WindowLimiter([{ limit: 1, windowMs: 1_000 }], 4);
    for (let i = 0; i < 4; i++) m.check(`old-${i}`, 0);
    m.check("live", 5_000);
    expect(m.check("live", 5_000).allowed).toBe(false);
    expect(m.size).toBe(1);
  });
});

describe("POST /error-reports", () => {
  const report = (over: Record<string, unknown> = {}) => ({
    kind: "error",
    surface: "spa",
    errorClass: "TypeError",
    route: "/app/programs/some-slug?x=1",
    release: "2026.11.11-abc123",
    browser: "safari",
    file: "index-BX12abCd.js",
    line: 120,
    column: 33,
    ...over,
  });

  it("stores day counters by crash site with the route as a template and no identifier", async () => {
    const t = await setup({ withErrorTable: true });
    const res = await t.post("/error-reports", { reports: [report(), report(), report({ errorClass: "ChunkLoadError", file: null, line: null, column: null })] });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ received: 3 });
    const rows = (await t.events.raw.d1.prepare("SELECT * FROM client_error_daily ORDER BY error_class").all()).results as Record<string, unknown>[];
    expect(rows).toEqual([
      { day: "2026-11-11", kind: "error", surface: "spa", error_class: "ChunkLoadError", route: "/app/programs/:slug", release: "2026.11.11-abc123", browser: "safari", file: "", line: 0, n: 1 },
      { day: "2026-11-11", kind: "error", surface: "spa", error_class: "TypeError", route: "/app/programs/:slug", release: "2026.11.11-abc123", browser: "safari", file: "index-BX12abCd.js", line: 120, n: 2 },
    ]);
  });

  it("refuses message text, stacks, URLs and unknown keys", async () => {
    const t = await setup({ withErrorTable: true });
    expect((await t.post("/error-reports", { reports: [report({ message: "Cannot read x of undefined" })] })).status).toBe(400);
    expect((await t.post("/error-reports", { reports: [report({ stack: "at foo (https://x/y.js:1:2)" })] })).status).toBe(400);
    expect((await t.post("/error-reports", { reports: [report({ file: "https://novus.example/assets/index.js" })] })).status).toBe(400);
    expect((await t.post("/error-reports", { reports: [report({ errorClass: "Error: secret@example.org" })] })).status).toBe(400);
    expect((await t.post("/error-reports", { reports: [report({ firstGen: true })] })).status).toBe(400);
    expect((await t.post("/error-reports", { reports: Array.from({ length: 6 }, () => report()) })).status).toBe(400);
    const rows = (await t.events.raw.d1.prepare("SELECT count(*) AS n FROM client_error_daily").first()) as { n: number };
    expect(rows.n).toBe(0);
  });

  it("logs a content-free line per report until the migration exists", async () => {
    const t = await setup({ withErrorTable: false });
    const res = await t.post("/error-reports", { reports: [report()] });
    expect(res.status).toBe(202);
    const line = lines.find((l) => l.includes('"event":"client_error"'));
    expect(line).toBeDefined();
    expect(JSON.parse(line!)).toMatchObject({ errorClass: "TypeError", route: "/app/programs/:slug", file: "index-BX12abCd.js", line: 120 });
    expect(line).not.toContain("x=1");
  });

  it("ignores bots and rate-limits per IP", async () => {
    const t = await setup({ withErrorTable: true });
    expect((await t.post("/error-reports", { reports: [report()] }, { "user-agent": "HeadlessChrome/120" })).status).toBe(204);
    let last = 202;
    for (let i = 0; i <= LIMITS.errorBatchesPerMinutePerIp; i++) last = (await t.post("/error-reports", { reports: [report()] }, { "cf-connecting-ip": "198.51.100.9" })).status;
    expect(last).toBe(429);
  });

  it("keeps only reports from the deployed build or an island, so client strings cannot multiply rows", async () => {
    const t = await setup({ withErrorTable: true, env: { RELEASE_ID: "2026.11.11-abc123" } });
    const res = await t.post("/error-reports", {
      reports: [
        report(),
        report({ release: "made-up-release" }),
        report({ file: "attacker-chosen-name.js" }),
        report({ kind: "island", surface: "island", release: "remind-me.v1", file: "remind-me.js", line: null, column: null }),
        report({ kind: "island", surface: "island", release: "remind-me.v9", file: "remind-me.js", line: null, column: null }),
      ],
    });
    expect(await res.json()).toEqual({ received: 2 });
    const rows = (await t.events.raw.d1.prepare("SELECT release, file FROM client_error_daily ORDER BY release").all()).results;
    expect(rows).toEqual([
      { release: "2026.11.11-abc123", file: "index-BX12abCd.js" },
      { release: "remind-me.v1", file: "remind-me.js" },
    ]);
    expect(lines.some((l) => l.includes("client_errors.dropped"))).toBe(true);
  });

  it("caps crash-report batches per network and globally per day, durably", async () => {
    const t = await setup({ withErrorTable: true, env: { BETTER_AUTH_SECRET: "test-secret-0123456789abcdef0123456789" } });
    expect((await t.post("/error-reports", { reports: [report()] }, { "cf-connecting-ip": "2001:db8:9::1" })).status).toBe(202);
    await t.main.raw.d1.prepare("UPDATE rate_limits SET count = ? WHERE key = 'novus:events:errors:all'").bind(LIMITS.errorBatchesPerDayGlobal).run();
    // A different network still hits the global cap.
    expect((await t.post("/error-reports", { reports: [report({ errorClass: "RangeError" })] }, { "cf-connecting-ip": "198.51.100.77" })).status).toBe(429);
    const n = (await t.events.raw.d1.prepare("SELECT count(*) AS n FROM client_error_daily").first()) as { n: number };
    expect(n.n).toBe(1);
  });

  it("sweeps counters older than 90 days and keeps newer ones", async () => {
    const t = await setup();
    const insert = (day: string) =>
      t.events.raw.d1.prepare("INSERT INTO client_error_daily (day, kind, surface, error_class, route, release, browser, n) VALUES (?, 'error', 'spa', 'TypeError', '/app', 'dev', 'chrome', 1)").bind(day).run();
    await insert("2026-08-12");
    await insert("2026-08-13");
    await insert("2026-11-11");
    expect(await sweepClientErrorDaily(t.events.edb, Date.parse("2026-11-11T12:00:00Z"))).toBe(1);
    const left = (await t.events.raw.d1.prepare("SELECT day FROM client_error_daily ORDER BY day").all()).results.map((r) => (r as { day: string }).day);
    expect(left).toEqual(["2026-08-13", "2026-11-11"]);
  });

  it("keys a report without its column", () => {
    expect(errorKey(ClientErrorReportSchema.parse(report()))).not.toHaveProperty("column");
  });
});

describe("onboarding funnel vocabulary", () => {
  // A minimal match set: onboardingEvent reads only each item's tier and reason codes.
  const matches = { relaxed: false, items: [{ tier: "strong", reasonCodes: ["EXPLORE"] }, { tier: "good", reasonCodes: [] }] } as unknown as MatchSet;
  const everyShape: OnboardingEventData[] = [
    { step: "started" },
    { step: "quiz_completed", asked: 13, skipped: 1 },
    { step: "quiz_completed", asked: 13, skipped: 0, seconds: 140 },
    ...(["pdf", "docx", "paste", "builder", "none"] as const).flatMap((source) => [true, false].map((ok) => ({ step: "resume_parsed" as const, source, ok }))),
    { step: "matches_shown", matches },
    ...TIERS.map((tier) => ({ step: "first_door_chosen" as const, tier })),
    ...PLAN_STEP_KINDS.map((kind) => ({ step: "first_step_done" as const, kind })),
    { step: "tracker_created", deviceOnly: true },
    { step: "tracker_created", deviceOnly: false },
  ];

  it("accepts every event shared/onboarding builds, unchanged", () => {
    for (const data of everyShape) {
      const built = onboardingEvent(data);
      expect(checkProps(built.name, built.props)).toEqual({ ok: true, props: built.props });
    }
  });

  it("stores onboardingEvent() output through the route and the founders' funnel counts it", async () => {
    const t = await setup();
    const devices = [findSession((b) => b < 100), findSession((b) => b >= 100 && b < 200)];
    const journey: OnboardingEventData[] = [
      { step: "started" },
      { step: "quiz_completed", asked: 13, skipped: 1 },
      { step: "resume_parsed", source: "pdf", ok: true },
      { step: "matches_shown", matches },
      { step: "first_door_chosen", tier: "strong" },
      { step: "first_step_done", kind: PLAN_STEP_KINDS[0] },
      { step: "tracker_created", deviceOnly: false },
    ];
    for (const [d, deviceId] of devices.entries()) {
      for (const [i, data] of journey.entries()) {
        const built = onboardingEvent(data);
        const at = new Date(NOW - 60_000 + d * 10_000 + i * 1_000).toISOString();
        const res = await t.post("/events", { events: [ev(built.name, built.props, { deviceId, at, path: "/app/start" })] });
        expect(await res.json()).toEqual({ accepted: 1 });
      }
    }
    const funnel = await funnelCounts(t.events.edb, NOW - 86_400_000, NOW + 1);
    expect(Object.fromEntries(ONBOARDING_FUNNEL.map((step) => [step, funnel.get(step) ?? 0]))).toEqual(Object.fromEntries(ONBOARDING_FUNNEL.map((step) => [step, 2])));
  });
});

// Every event name is reachable through the allowlist (keeps EVENT_PROPS honest).
const MINIMAL_PROPS: Partial<Record<AnalyticsEventName, Record<string, string>>> = { onboarding_step: { step: "started" } };
it.each([...ANALYTICS_EVENT_NAMES])("%s accepts an empty or minimal prop set", (name) => {
  const verdict = checkProps(name as AnalyticsEventName, MINIMAL_PROPS[name as AnalyticsEventName] ?? {});
  expect(verdict.ok).toBe(true);
});
