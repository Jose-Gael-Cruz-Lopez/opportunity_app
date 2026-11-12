import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import type { AppEnv } from "@server/env";
import { sha256Hex } from "@server/lib/crypto";
import { MemoryCache } from "@server/lib/cache";
import { createCalRoutes } from "./routes";
import type { CalStore, ProgramFeedLookup, UserFeed } from "./store";
import { FIXED_EXACT, GOLDEN_PROGRAM, goldenFeed } from "./golden/fixtures";
import { newCalendarToken } from "./token";

const NOW = Date.UTC(2026, 10, 11, 15);
const TOKEN = "AbCdEfGhIjKlMnOpQrStUv";

interface Calls {
  programSlugs: string[];
  tokenHashes: string[];
}

function harness(opts: { program?: ProgramFeedLookup; user?: (hash: string) => UserFeed | null; cache?: MemoryCache | null } = {}) {
  const calls: Calls = { programSlugs: [], tokenHashes: [] };
  const store: CalStore = {
    async programFeed(slug) {
      calls.programSlugs.push(slug);
      return opts.program === undefined ? goldenFeed([FIXED_EXACT]) : opts.program;
    },
    async userFeed(hash) {
      calls.tokenHashes.push(hash);
      return opts.user ? opts.user(hash) : null;
    },
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "test");
    await next();
  });
  app.route("/cal", createCalRoutes({ store: () => store, now: () => NOW, origin: () => "https://novus.example.org", programCache: opts.cache ?? null }));
  return { app, calls };
}

describe("GET /cal/p/{slug}.ics", () => {
  it("serves a public, edge-cacheable calendar", async () => {
    const { app, calls } = harness();
    const res = await app.request("/cal/p/sample-national-stem-scholarship.ics");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/calendar; charset=utf-8");
    expect(res.headers.get("cache-control")).toBe("public, max-age=3600");
    expect(res.headers.get("content-disposition")).toBe('inline; filename="sample-national-stem-scholarship.ics"');
    const body = await res.text();
    expect(body.startsWith("BEGIN:VCALENDAR\r\n")).toBe(true);
    expect(body).toContain("DTSTART:20270129T230000Z");
    expect(calls.programSlugs).toEqual(["sample-national-stem-scholarship"]);
  });

  it("keeps a copy in the edge cache and answers revalidation with 304", async () => {
    const cache = new MemoryCache();
    const { app, calls } = harness({ cache });
    const first = await app.request("http://localhost/cal/p/sample-national-stem-scholarship.ics");
    expect(first.headers.get("x-novus-cache")).toBe("MISS");
    const etag = first.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    // Cache writes go through waitUntil; give them a tick to land.
    await new Promise((r) => setTimeout(r, 0));
    const second = await app.request("http://localhost/cal/p/sample-national-stem-scholarship.ics");
    expect(second.headers.get("x-novus-cache")).toBe("HIT");
    expect(await second.text()).toContain("BEGIN:VCALENDAR");
    const revalidated = await app.request("http://localhost/cal/p/sample-national-stem-scholarship.ics", { headers: { "if-none-match": etag! } });
    expect(revalidated.status).toBe(304);
    expect(calls.programSlugs).toHaveLength(1);
  });

  it("redirects a renamed slug to its new feed", async () => {
    const { app } = harness({ program: { kind: "redirect", slug: "sample-new-name" } });
    const res = await app.request("/cal/p/sample-old-name.ics");
    expect(res.status).toBe(301);
    expect(res.headers.get("location")).toBe("/cal/p/sample-new-name.ics");
  });

  it("answers 404 for unknown or malformed slugs without touching the store for bad input", async () => {
    const { app, calls } = harness({ program: null });
    expect((await app.request("/cal/p/sample-unknown.ics")).status).toBe(404);
    expect((await app.request("/cal/p/--bad--.ics")).status).toBe(404);
    expect((await app.request("/cal/p/sample.txt")).status).toBe(404);
    expect(calls.programSlugs).toEqual(["sample-unknown"]);
  });
});

describe("GET /cal/u/{token}.ics", () => {
  const feed: UserFeed = { groups: [{ context: GOLDEN_PROGRAM, neutral: false, deadlines: [FIXED_EXACT], ownCampus: null }] };

  it("looks the feed up by the token's SHA-256, never the raw token", async () => {
    const want = await sha256Hex(TOKEN);
    const { app, calls } = harness({ user: (hash) => (hash === want ? feed : null) });
    const res = await app.request(`/cal/u/${TOKEN}.ics`);
    expect(res.status).toBe(200);
    expect(calls.tokenHashes).toEqual([want]);
    expect(calls.tokenHashes[0]).not.toContain(TOKEN);
  });

  it("is private, revalidated every time, has an ETag and stays out of indexes", async () => {
    const { app } = harness({ user: () => feed });
    const res = await app.request(`/cal/u/${TOKEN}.ics`);
    expect(res.headers.get("cache-control")).toBe("private, no-cache");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(res.headers.get("referrer-policy")).toBe("no-referrer");
    const etag = res.headers.get("etag");
    expect(etag).toMatch(/^"[0-9a-f]{32}"$/);
    const body = await res.text();
    expect(body).toContain("X-WR-CALNAME:Novus: my deadlines");

    const again = await app.request(`/cal/u/${TOKEN}.ics`, { headers: { "if-none-match": etag! } });
    expect(again.status).toBe(304);
    expect(again.headers.get("etag")).toBe(etag);
    expect(await again.text()).toBe("");
  });

  it("answers 404 for a revoked or unknown token, and for malformed tokens without a lookup", async () => {
    const { app, calls } = harness({ user: () => null });
    const res = await app.request(`/cal/u/${TOKEN}.ics`);
    expect(res.status).toBe(404);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = await res.text();
    expect(body).not.toContain(TOKEN);
    expect((await app.request("/cal/u/short.ics")).status).toBe(404);
    expect(calls.tokenHashes).toHaveLength(1);
  });

  it("issues 128-bit base64url tokens", () => {
    const token = newCalendarToken();
    expect(token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(newCalendarToken()).not.toBe(token);
  });
});
