import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { buildConfig, parseInternalKeys, parseOrigin, trustedOriginsFor } from "../config";
import { FLAG_DEFAULTS } from "../config/flags";
import { buildCsp } from "../config/security";
import { computeETag, ifNoneMatchMatches, isPrivateCacheControl, lastGoodKey, MemoryCache, pageCacheKey } from "./cache";
import { fromHex, hmacSha256Hex, sha256Hex, timingSafeEqual, toHex, verifyHmacSha256Hex } from "./crypto";
import { FlagCache, isEnabledFor, mergeFlags, parseRollouts, rolloutBucket, type FlagSource } from "./flags";
import { canonicalString, signInternalRequest, verifyInternalRequest } from "./hmac";
import { createLogger, sanitizeFields, sanitizeValue, type LogLevel } from "./log";
import { ApiError, problemResponse } from "./problem";
import { WindowLimiter, checkBinding, clientIp, truncateIp } from "./rate-limit";
import { findInternalRoute, isPublicApiGet, pathPatternToRegExp } from "./route-match";
import { buildEnvelope, parseDsn, sendErrorReport } from "./sentry";
import { verifyTurnstile } from "./turnstile";
import { parseInput, queryToObject, safeIssues } from "./validation";

const SECRET = "test-secret-0123456789abcdef0123456789";

describe("crypto", () => {
  it("hashes and round-trips hex", async () => {
    expect(await sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(toHex(fromHex("00ff10")!)).toBe("00ff10");
    expect(fromHex("abc")).toBeNull();
  });

  it("verifies HMACs and rejects tampering", async () => {
    const sig = await hmacSha256Hex(SECRET, "message");
    expect(await verifyHmacSha256Hex(SECRET, "message", sig)).toBe(true);
    expect(await verifyHmacSha256Hex(SECRET, "message!", sig)).toBe(false);
    expect(await verifyHmacSha256Hex(SECRET, "message", "zz")).toBe(false);
  });

  it("compares strings without short-circuiting on length", () => {
    expect(timingSafeEqual("abc", "abc")).toBe(true);
    expect(timingSafeEqual("abc", "abd")).toBe(false);
    expect(timingSafeEqual("abc", "abcd")).toBe(false);
  });
});

describe("internal HMAC", () => {
  // Produced by pipeline/novus_pipeline/internal_client.py `sign(...)` with the same inputs, so
  // the Worker and the pipeline cannot drift apart silently.
  const PY_VECTOR = {
    signature: "dc5bfdfcc9ad940be0d169c9d2151bb03abdaf580c10c9552bea88fb0c509001",
    bodySha: "7487d2579fcff988319a0fc9c34109543d55d9ce5ef4001675b8ed219f4df0a6",
  };
  const body = '{"kinds":["fetch"]}';
  const base = {
    method: "POST",
    pathAndQuery: "/internal/v1/jobs/lease",
    body,
    keyId: "fetch",
    secret: SECRET,
    nowSeconds: 1794398400,
    nonce: "0123456789abcdef0123456789abcdef",
  };

  it("matches the Python signer byte for byte", async () => {
    const headers = await signInternalRequest(base);
    expect(headers["x-novus-signature"]).toBe(PY_VECTOR.signature);
    expect(headers["x-novus-content-sha256"]).toBe(PY_VECTOR.bodySha);
    expect(canonicalString({ ...base, timestamp: "1", bodySha256: "h" }).split("\n")[0]).toBe("NOVUS-HMAC-SHA256");
  });

  const verify = async (overrides: Partial<{ headers: Record<string, string>; body: string; now: number; path: string }>) => {
    const signed = await signInternalRequest(base);
    return verifyInternalRequest({
      method: "POST",
      pathAndQuery: overrides.path ?? base.pathAndQuery,
      headers: new Headers({ ...signed, ...overrides.headers }),
      body: new TextEncoder().encode(overrides.body ?? body),
      keys: new Map([["fetch", SECRET]]),
      nowSeconds: overrides.now ?? base.nowSeconds + 5,
    });
  };

  it("accepts a fresh, correctly signed request", async () => {
    const r = await verify({});
    expect(r).toMatchObject({ ok: true, keyId: "fetch", nonce: base.nonce });
  });

  it("refuses each kind of tampering with a reason", async () => {
    expect(await verify({ body: '{"kinds":["llm"]}' })).toEqual({ ok: false, reason: "body_hash_mismatch" });
    expect(await verify({ body: '{"kinds":["llm"]}', headers: { "x-novus-content-sha256": await sha256Hex('{"kinds":["llm"]}') } })).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(await verify({ path: "/internal/v1/jobs/lease?x=1" })).toEqual({ ok: false, reason: "bad_signature" });
    expect(await verify({ now: base.nowSeconds + 61 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(await verify({ now: base.nowSeconds - 61 })).toEqual({ ok: false, reason: "stale_timestamp" });
    expect(await verify({ headers: { "x-novus-key-id": "llm" } })).toEqual({ ok: false, reason: "unknown_key" });
    expect(await verify({ headers: { "x-novus-nonce": "short" } })).toEqual({ ok: false, reason: "malformed_headers" });
  });

  it("refuses requests with missing headers", async () => {
    const r = await verifyInternalRequest({
      method: "POST",
      pathAndQuery: "/internal/v1/jobs/lease",
      headers: new Headers(),
      body: new Uint8Array(),
      keys: new Map([["fetch", SECRET]]),
      nowSeconds: 0,
    });
    expect(r).toEqual({ ok: false, reason: "missing_headers" });
  });
});

describe("config", () => {
  it("parses origins and refuses non-http values", () => {
    expect(parseOrigin("https://novus.example.org/path/")).toBe("https://novus.example.org");
    expect(parseOrigin("javascript:alert(1)")).toBeNull();
    expect(parseOrigin(undefined)).toBeNull();
  });

  it("parses internal keys and rejects short secrets or odd key ids", () => {
    const good = parseInternalKeys(JSON.stringify({ fetch: SECRET, "fetch.2026q4": SECRET }));
    expect([...good.keys.keys()]).toEqual(["fetch", "fetch.2026q4"]);
    expect(good.ok).toBe(true);
    const bad = parseInternalKeys(JSON.stringify({ fetch: "short", "Bad Key": SECRET }));
    expect(bad.keys.size).toBe(0);
    expect(bad.ok).toBe(false);
    expect(parseInternalKeys("not json").ok).toBe(false);
  });

  it("builds a config that names issues but never values", () => {
    const c = buildConfig({ ENVIRONMENT: "production", APP_ORIGIN: "http://novus.example.org", INTERNAL_HMAC_KEYS: "{", BETTER_AUTH_SECRET: "x" });
    expect(c.issues).toEqual(expect.arrayContaining(["APP_ORIGIN", "INTERNAL_HMAC_KEYS", "BETTER_AUTH_SECRET"]));
    expect(JSON.stringify(c.issues)).not.toContain("novus.example.org");
    expect(c.trustedOrigins).toEqual(["http://novus.example.org"]);
  });

  it("trusts only the console origin for writes to the console host, and only app origins elsewhere", () => {
    const c = buildConfig({ ENVIRONMENT: "production", APP_ORIGIN: "https://novus.example.org" });
    expect(c.consoleOrigin).toBe("https://curate.novus.example.org");
    expect(trustedOriginsFor(c, "https://curate.novus.example.org/api/auth/sign-in/email-otp")).toEqual(["https://curate.novus.example.org"]);
    expect(trustedOriginsFor(c, "https://novus.example.org/api/v1/me")).toEqual(["https://novus.example.org"]);
  });

  it("trusts the Vite dev server only locally and treats unknown environments as production", () => {
    const local = buildConfig({ ENVIRONMENT: "local", APP_ORIGIN: "http://localhost:8787" });
    expect(local.trustedOrigins).toContain("http://localhost:5173");
    const odd = buildConfig({ ENVIRONMENT: "preview" as never, APP_ORIGIN: "https://novus.example.org" });
    expect(odd.environment).toBe("production");
    expect(odd.trustedOrigins).not.toContain("http://localhost:5173");
  });

  it("reads the Gemini settings without exposing the key", () => {
    const c = buildConfig({ GEMINI_API_KEY: "placeholder", GEMINI_MODEL: " gemini-x ", AI_DISABLED: "true" });
    expect(c.hasGeminiKey).toBe(true);
    expect(c.geminiModel).toBe("gemini-x");
    expect(c.aiDisabled).toBe(true);
    expect(JSON.stringify(c)).not.toContain("placeholder");
  });
});

describe("CSP", () => {
  it("matches the plan's base policy", () => {
    expect(buildCsp()).toBe(
      "default-src 'self'; script-src 'self'; connect-src 'self'; font-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
    );
  });

  it("adds Turnstile to script-src and frame-src only when asked", () => {
    const csp = buildCsp({ turnstile: true });
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain("frame-src https://challenges.cloudflare.com");
    expect(buildCsp()).not.toContain("challenges.cloudflare.com");
    expect(buildCsp({ inlineStyles: true })).toContain("style-src 'self' 'unsafe-inline'");
    expect(buildCsp({ inlineStyles: true })).not.toMatch(/script-src[^;]*unsafe/);
  });
});

describe("logger", () => {
  const capture = () => {
    const lines: { level: LogLevel; obj: Record<string, unknown> }[] = [];
    const log = createLogger({ sink: (level, line) => lines.push({ level, obj: JSON.parse(line) }), now: () => 0 });
    return { lines, log };
  };

  it("writes JSON lines with event names and allowed fields", () => {
    const { lines, log } = capture();
    log.child({ requestId: "r1" }).info("request", { route: "/api/v1/programs/:slug", status: 200, durationMs: 4 });
    expect(lines[0]).toEqual({
      level: "info",
      obj: { level: "info", event: "request", ts: "1970-01-01T00:00:00.000Z", requestId: "r1", route: "/api/v1/programs/:slug", status: 200, durationMs: 4 },
    });
  });

  it("drops content keys and sensitive keys, and counts them", () => {
    const fields = sanitizeFields({
      body: "{...}",
      email: "a@example.org",
      token: "abc",
      citizenship: "x",
      firstGen: true,
      errorCode: "E1",
      route: "/x",
    });
    expect(fields).toEqual({ errorCode: "E1", route: "/x", droppedFields: 5 });
  });

  it("redacts emails and URLs in values and truncates long strings", () => {
    expect(sanitizeValue("contact a@example.org")).toBe("[redacted]");
    expect(sanitizeValue("https://example.org/cal/u/secret.ics")).toBe("[redacted]");
    expect(sanitizeValue("/search?q=daca")).toBe("[redacted]");
    expect((sanitizeValue("x".repeat(500)) as string).length).toBeLessThan(200);
    expect(sanitizeValue("line\nforged")).toBe("line forged");
    expect(sanitizeValue({ nested: 1 })).toBeUndefined();
  });

  it("refuses free-text event names", () => {
    const { lines, log } = capture();
    log.error("User a@example.org failed");
    expect(lines[0]!.obj.event).toBe("invalid_event_name");
  });
});

describe("validation", () => {
  const Schema = z.object({ kind: z.enum(["a", "b"]), n: z.number().int().max(3) }).strict();

  it("never echoes submitted values in issues", () => {
    const r = Schema.safeParse({ kind: "secret-value-123", n: 99, extra: "x" });
    expect(r.success).toBe(false);
    const issues = safeIssues((r as { error: z.ZodError }).error);
    expect(JSON.stringify(issues)).not.toContain("secret-value-123");
    expect(issues).toEqual(
      expect.arrayContaining([
        { path: "kind", message: "Not an allowed value" },
        { path: "n", message: "Too large or too long" },
        { path: "extra", message: "Unrecognized key" },
      ]),
    );
  });

  it("does not echo free-text unknown key names", () => {
    const r = Schema.safeParse({ kind: "a", n: 1, "my id is 123-45-6789": 1 });
    const issues = safeIssues((r as { error: z.ZodError }).error);
    expect(JSON.stringify(issues)).not.toContain("6789");
  });

  it("refuses sensitive keys before parsing", () => {
    const r = parseInput(Schema, { kind: "a", n: 1, profile: { citizenship: "us_citizen" } });
    expect(r).toEqual({ ok: false, code: "sensitive_field_rejected", errors: [{ path: "profile.citizenship", message: "Not accepted by this endpoint" }] });
    expect(JSON.stringify(r)).not.toContain("us_citizen");
  });

  it("returns parsed data on success", () => {
    expect(parseInput(Schema, { kind: "b", n: 2 })).toEqual({ ok: true, data: { kind: "b", n: 2 } });
  });

  it("turns repeated query keys into arrays", () => {
    expect(queryToObject(new URLSearchParams("type=a&type=b&limit=5"))).toEqual({ type: ["a", "b"], limit: "5" });
  });
});

describe("problem responses", () => {
  it("use problem+json, no-store and Retry-After", async () => {
    const res = problemResponse("rate_limited", { requestId: "r1" }, { retryAfter: 2.2 });
    expect(res.status).toBe(429);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("retry-after")).toBe("3");
    expect(await res.json()).toMatchObject({ code: "rate_limited", status: 429, requestId: "r1" });
  });

  it("ApiError carries only its code as a message", () => {
    const e = new ApiError("consent_required", { detail: "Consent required for this program." });
    expect(e.message).toBe("consent_required");
  });
});

describe("rate limits", () => {
  it("counts fixed windows per key and reports Retry-After", () => {
    const l = new WindowLimiter([{ limit: 2, windowMs: 60_000 }]);
    expect(l.check("k", 0).allowed).toBe(true);
    expect(l.check("k", 1).allowed).toBe(true);
    expect(l.check("k", 30_000)).toEqual({ allowed: false, retryAfterSeconds: 30 });
    expect(l.check("other", 30_000).allowed).toBe(true);
    expect(l.check("k", 60_000).allowed).toBe(true);
  });

  it("does not count refused hits against the longer window", () => {
    const l = new WindowLimiter([
      { limit: 1, windowMs: 1_000 },
      { limit: 3, windowMs: 60_000 },
    ]);
    expect(l.check("k", 0).allowed).toBe(true);
    for (let i = 0; i < 5; i++) expect(l.check("k", 10).allowed).toBe(false);
    expect(l.check("k", 1_000).allowed).toBe(true);
    expect(l.check("k", 2_000).allowed).toBe(true);
    expect(l.check("k", 3_000).allowed).toBe(false);
  });

  it("uses the binding and fails open when it throws", async () => {
    expect(await checkBinding({ limit: async () => ({ success: false }) }, "k", 10)).toEqual({ allowed: false, retryAfterSeconds: 10 });
    expect((await checkBinding({ limit: async () => Promise.reject(new Error("x")) }, "k")).allowed).toBe(true);
    expect((await checkBinding(undefined, "k")).allowed).toBe(true);
  });

  it("trusts only CF-Connecting-IP and truncates addresses", () => {
    expect(clientIp(new Headers({ "x-forwarded-for": "1.2.3.4" }))).toBe("unknown");
    expect(clientIp(new Headers({ "cf-connecting-ip": "203.0.113.9" }))).toBe("203.0.113.9");
    expect(truncateIp("203.0.113.9")).toBe("203.0.113.0/24");
    expect(truncateIp("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
  });
});

describe("flags", () => {
  const source = (impl: FlagSource["load"]): FlagSource => ({ load: impl });

  it("merges stored rows over defaults and ignores unknown keys", () => {
    const v = mergeFlags({ "site.read_only": true, "made.up": true });
    expect(v["site.read_only"]).toBe(true);
    expect((v as Record<string, boolean>)["made.up"]).toBeUndefined();
    expect(v["llm.all"]).toBe(FLAG_DEFAULTS["llm.all"]);
    expect(parseRollouts({ "llm.ask": 150, "llm.all": "x", nope: 5 })).toEqual({ "llm.ask": 100 });
  });

  it("caches for the TTL and reads D1 once for concurrent callers", async () => {
    let t = 0;
    const load = vi.fn(async () => ({ flags: { "mcp.enabled": true }, rollouts: {} }));
    const cache = new FlagCache(60_000, () => t);
    const [a, b] = await Promise.all([cache.get(source(load)), cache.get(source(load))]);
    expect(a.values["mcp.enabled"]).toBe(true);
    expect(b).toBe(a);
    t = 59_999;
    await cache.get(source(load));
    expect(load).toHaveBeenCalledTimes(1);
    t = 60_000;
    await cache.get(source(load));
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("falls back to defaults, then keeps the last good copy when D1 fails", async () => {
    let t = 0;
    const cache = new FlagCache(60_000, () => t);
    const failing = source(async () => {
      throw new Error("D1_ERROR: unavailable");
    });
    const first = await cache.get(failing);
    expect(first.source).toBe("defaults");
    expect(first.values).toEqual(FLAG_DEFAULTS);

    t = 10_000;
    await cache.get(source(async () => ({ flags: { "site.read_only": true }, rollouts: {} })));
    t = 80_000;
    const stale = await cache.get(failing);
    expect(stale.source).toBe("stale");
    expect(stale.values["site.read_only"]).toBe(true);
  });

  it("buckets rollouts stably per subject and flag", async () => {
    const a1 = await rolloutBucket(SECRET, "llm.ask", "user-1");
    expect(await rolloutBucket(SECRET, "llm.ask", "user-1")).toBe(a1);
    expect(a1).toBeGreaterThanOrEqual(0);
    expect(a1).toBeLessThan(100);
    const snap = { values: { ...FLAG_DEFAULTS }, rollouts: { "llm.ask": 0 }, fetchedAt: 0, source: "d1" as const };
    expect(await isEnabledFor(snap, "llm.ask", "user-1", SECRET)).toBe(false);
    expect(await isEnabledFor({ ...snap, rollouts: {} }, "llm.ask", "user-1", SECRET)).toBe(true);
    // Roughly half of 400 subjects land inside a 50% rollout.
    const half = { ...snap, rollouts: { "llm.ask": 50 } };
    let inside = 0;
    for (let i = 0; i < 400; i++) if (await isEnabledFor(half, "llm.ask", `u${i}`, SECRET)) inside++;
    expect(inside).toBeGreaterThan(150);
    expect(inside).toBeLessThan(250);
  });
});

describe("cache helpers", () => {
  it("computes strong ETags and matches If-None-Match lists and weak tags", async () => {
    const tag = await computeETag("hello");
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    expect(ifNoneMatchMatches(`"x", ${tag}`, tag)).toBe(true);
    expect(ifNoneMatchMatches(`W/${tag}`, tag)).toBe(true);
    expect(ifNoneMatchMatches("*", tag)).toBe(true);
    expect(ifNoneMatchMatches(null, tag)).toBe(false);
  });

  it("keys pages by path and allowlisted params only", () => {
    const key = pageCacheKey(new URL("https://novus.example.org/deadlines?utm_source=x&type=b&type=a&q=daca"), ["type"]);
    expect(key).toBe("https://novus.example.org/deadlines?type=b&type=a");
    expect(lastGoodKey(key)).toBe("https://lastgood.novus.internal/deadlines?type=b&type=a");
  });

  it("detects private cache-control values", () => {
    expect(isPrivateCacheControl("private, max-age=0")).toBe(true);
    expect(isPrivateCacheControl("no-store")).toBe(true);
    expect(isPrivateCacheControl("public, max-age=60")).toBe(false);
  });

  it("stores and replays responses in the memory cache", async () => {
    const c = new MemoryCache();
    await c.put("k", new Response("body", { headers: { "x-a": "1" } }));
    const hit = await c.match("k");
    expect(await hit!.text()).toBe("body");
    expect(hit!.headers.get("x-a")).toBe("1");
  });
});

describe("route matching", () => {
  it("converts Hono patterns, including regex params", () => {
    const re = pathPatternToRegExp("/data/client-core/:file{[0-9]+\\.json}");
    expect(re.test("/data/client-core/12.json")).toBe(true);
    expect(re.test("/data/client-core/x.json")).toBe(false);
    expect(pathPatternToRegExp("/app/*").test("/app/tracker/x")).toBe(true);
    expect(pathPatternToRegExp("/programs/:slug").test("/programs/a/b")).toBe(false);
  });

  it("opens only public GET API routes to CORS", () => {
    expect(isPublicApiGet("/api/v1/programs")).toBe(true);
    expect(isPublicApiGet("/api/v1/programs/sample-program")).toBe(true);
    expect(isPublicApiGet("/api/v1/me/session")).toBe(false);
    expect(isPublicApiGet("/api/v1/me/tracker")).toBe(false);
    expect(isPublicApiGet("/api/v1/review-tasks")).toBe(false);
  });

  it("prefers literal internal routes over parameterised ones", () => {
    expect(findInternalRoute("POST", "/internal/v1/jobs/lease")?.id).toBe("leaseJobs");
    expect(findInternalRoute("POST", "/internal/v1/jobs/abc/complete")?.id).toBe("completeJob");
    expect(findInternalRoute("GET", "/internal/v1/jobs/lease")).toBeNull();
  });
});

describe("sentry", () => {
  it("parses DSNs and refuses malformed ones", () => {
    expect(parseDsn("https://pub@o1.ingest.example.org/42")).toEqual({ publicKey: "pub", host: "o1.ingest.example.org", projectId: "42", protocol: "https" });
    expect(parseDsn("https://o1.ingest.example.org/42")).toBeNull();
    expect(parseDsn("nope")).toBeNull();
  });

  it("sends an envelope with no message, URL or user", async () => {
    const fetchMock = vi.fn(async (_url: string, _init: RequestInit) => new Response(null, { status: 200 }));
    const ok = await sendErrorReport(
      "https://pub@o1.ingest.example.org/42",
      { errorClass: "TypeError", route: "/cal/u/:file{[A-Za-z0-9_-]+\\.ics}", method: "GET", requestId: "r-1", environment: "staging" },
      { fetch: fetchMock, now: 0, eventId: "e".repeat(32) },
    );
    expect(ok).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://o1.ingest.example.org/api/42/envelope/");
    const body = String(init.body);
    expect(body.split("\n")).toHaveLength(3);
    const event = JSON.parse(body.split("\n")[2]!);
    expect(event.exception.values[0]).toEqual({ type: "TypeError", value: "redacted" });
    expect(event).not.toHaveProperty("request");
    expect(event).not.toHaveProperty("user");
  });

  it("replaces unsafe tag values instead of sending them", () => {
    const dsn = parseDsn("https://pub@o1.ingest.example.org/42")!;
    const env = buildEnvelope(dsn, { errorClass: "a@example.org", route: "/x?token=1 2", method: "GET", requestId: "r", environment: "local" }, "e", 0);
    expect(env).not.toContain("example.org\"}");
    expect(env).not.toContain("token=1");
  });

  it("returns false without a DSN or when fetch fails", async () => {
    const report = { errorClass: "E", route: "/", method: "GET", requestId: "r", environment: "local" };
    expect(await sendErrorReport(null, report)).toBe(false);
    expect(await sendErrorReport("https://pub@h.example.org/1", report, { fetch: async () => Promise.reject(new Error("down")) })).toBe(false);
  });
});

describe("turnstile", () => {
  const respond = (status: number, body: unknown) => async () => new Response(JSON.stringify(body), { status });

  it("accepts success and refuses bad tokens", async () => {
    expect(await verifyTurnstile({ secret: "s", token: "t", fetch: respond(200, { success: true }) })).toEqual({ ok: true, failOpen: false });
    for (const code of ["invalid-input-response", "timeout-or-duplicate", "missing-input-response", "bad-request"]) {
      expect(await verifyTurnstile({ secret: "s", token: "t", fetch: respond(200, { success: false, "error-codes": [code] }) })).toEqual({
        ok: false,
        reason: "rejected",
      });
    }
    expect(await verifyTurnstile({ secret: "s", token: "" })).toEqual({ ok: false, reason: "missing_token" });
    expect(await verifyTurnstile({ secret: undefined, token: "t" })).toEqual({ ok: false, reason: "not_configured" });
  });

  it("fails open only on network errors, 5xx, internal-error and timeouts", async () => {
    expect(await verifyTurnstile({ secret: "s", token: "t", fetch: respond(503, {}) })).toMatchObject({ ok: true, failOpen: true, reason: "server_error" });
    expect(
      await verifyTurnstile({ secret: "s", token: "t", fetch: respond(200, { success: false, "error-codes": ["internal-error"] }) }),
    ).toMatchObject({ ok: true, failOpen: true, reason: "internal_error" });
    expect(await verifyTurnstile({ secret: "s", token: "t", fetch: async () => Promise.reject(new TypeError("net")) })).toMatchObject({
      failOpen: true,
      reason: "network",
    });
    const slow = (_u: string, init: RequestInit) =>
      new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(new Error("aborted"))));
    expect(await verifyTurnstile({ secret: "s", token: "t", fetch: slow, timeoutMs: 10 })).toMatchObject({ failOpen: true, reason: "timeout" });
  });
});
