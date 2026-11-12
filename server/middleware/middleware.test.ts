import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { z } from "zod";
import { ProblemDetailsSchema } from "@shared/contracts/common";
import type { AppEnv, Env } from "../env";
import { composeApp, type AppModules, type ComposeOptions } from "../lib/app-factory";
import { createLogger, rootLogger, setRootLogger, type Logger } from "../lib/log";
import { ApiError } from "../lib/problem";
import { FLAG_DEFAULTS } from "../config/flags";
import type { FlagSnapshot } from "../lib/flags";
import { MemoryCache } from "../lib/cache";
import { API_BODY_LIMIT_BYTES, API_BODY_LIMIT_OVERRIDES, buildCsp } from "../config/security";
import { ROUTE_MAX_BYTES } from "../api/v1/curator/import/routes";
import {
  CACHE_STATUS_HEADER,
  NEAR_DEADLINE_HEADER,
  REQUEST_ID_HEADER,
  corsDecision,
  edgeCache,
  isStaticAssetCandidate,
  originVerdict,
  rateLimit,
  shouldNoindex,
  validateJson,
  validateQuery,
} from ".";

/**
 * The middleware stack, exercised through composeApp with stub route modules, so the order and
 * the contract error shape are tested without the feature modules.
 */

const ORIGIN = "https://novus.example.org";
const SECRET = "x".repeat(32);

type TestEnv = Partial<Env> & { ASSETS?: Fetcher };

function fakeAssets(files: Record<string, { body: string; type: string }>): Fetcher {
  const fetcher = {
    async fetch(input: RequestInfo | URL): Promise<Response> {
      const url = new URL(input instanceof Request ? input.url : String(input));
      const file = files[url.pathname];
      if (!file) return new Response("missing", { status: 404 });
      // Real asset responses have immutable headers; mimic that to test the copy path.
      const res = new Response(file.body, { status: 200, headers: { "content-type": file.type } });
      const immutable = (): never => {
        throw new TypeError("Can't modify immutable headers.");
      };
      Object.assign(res.headers, { set: immutable, append: immutable, delete: immutable });
      return res;
    },
    connect(): never {
      throw new Error("not used");
    },
  };
  return fetcher as unknown as Fetcher;
}

function env(overrides: TestEnv = {}): Env {
  return {
    ENVIRONMENT: "production",
    APP_ORIGIN: ORIGIN,
    BETTER_AUTH_SECRET: SECRET,
    INTERNAL_HMAC_KEYS: JSON.stringify({ fetch: "k".repeat(40) }),
    ASSETS: fakeAssets({
      "/index.html": { body: "<!doctype html><div id=root></div>", type: "text/html; charset=utf-8" },
      "/favicon.png": { body: "png", type: "image/png" },
    }),
    ...overrides,
  } as Env;
}

const ProfileSchema = z.object({ classYear: z.enum(["first_year", "second_year"]), interests: z.array(z.string()).max(3) }).strict();

function stubModules(): AppModules {
  const registry = new Hono<AppEnv>();
  registry.get("/programs", (c) => c.json({ items: [{ slug: "sample-program" }] }));
  registry.get("/programs/:slug", (c) => c.json({ slug: c.req.param("slug") }));
  registry.get("/boom", () => {
    throw new TypeError("secret detail: alice@example.org");
  });
  registry.get("/conflict", () => {
    throw new ApiError("version_conflict");
  });
  registry.post("/curator/import", async (c) => c.json({ len: (await c.req.text()).length }));
  registry.get("/zod", () => {
    ProfileSchema.parse({ classYear: "senior-ish" });
    return new Response("unreachable");
  });

  const student = new Hono<AppEnv>();
  student.patch("/me/profile", validateJson(ProfileSchema), (c) => c.json({ saved: c.req.valid("json") }));
  student.get("/me/list", validateQuery(z.object({ limit: z.coerce.number().int().max(100) }).strict()), (c) =>
    c.json({ limit: c.req.valid("query").limit }),
  );
  student.post("/me/echo", async (c) => c.json({ ok: true, len: JSON.stringify(await c.req.json()).length }));
  student.get("/me/private", (c) => c.json({ mine: true }, 200, { "cache-control": "private, no-store" }));

  const empty = new Hono<AppEnv>();
  const internal = new Hono<AppEnv>();
  internal.post("/jobs/lease", (c) => c.json({ leased: [] }));
  const mcp = new Hono<AppEnv>();
  mcp.post("/", (c) => c.json({ jsonrpc: "2.0" }));
  const pages = new Hono<AppEnv>();
  pages.get("/", (c) => c.html("<!doctype html><title>Explore</title>", 200, { "cache-control": "public, max-age=60" }));
  pages.get("/cal/u/:token", (c) => c.text("ics"));

  return {
    authRoutes: empty,
    registryRoutes: registry,
    studentRoutes: student,
    advisorRoutes: empty,
    calRoutes: empty,
    internalRoutes: internal,
    mcpRoutes: mcp,
    pageRoutes: pages,
  };
}

function snapshot(values: Partial<Record<keyof typeof FLAG_DEFAULTS, boolean>> = {}): FlagSnapshot {
  return { values: { ...FLAG_DEFAULTS, ...values }, rollouts: {}, fetchedAt: 0, source: "d1" };
}

function makeApp(options: ComposeOptions = {}, modules: AppModules = stubModules()) {
  const reports: unknown[] = [];
  const app = composeApp(modules, {
    report: (_c, report) => reports.push(report),
    loadFlags: async () => snapshot(),
    ...options,
  });
  return { app, reports };
}

async function problemOf(res: Response) {
  expect(res.headers.get("content-type")).toContain("application/problem+json");
  return ProblemDetailsSchema.parse(await res.json());
}

let lines: string[] = [];
let previous: Logger;

beforeEach(() => {
  lines = [];
  previous = rootLogger();
  setRootLogger(createLogger({ sink: (_level, line) => lines.push(line), minLevel: "debug" }));
});

afterEach(() => {
  setRootLogger(previous);
});

describe("request ids and access logs", () => {
  it("adds a request id, echoes a well-formed incoming one and refuses odd ones", async () => {
    const { app } = makeApp();
    const fresh = await app.request("/healthz", {}, env());
    expect(fresh.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);

    const echoed = await app.request("/healthz", { headers: { [REQUEST_ID_HEADER]: "job-12345678" } }, env());
    expect(echoed.headers.get(REQUEST_ID_HEADER)).toBe("job-12345678");

    const refused = await app.request("/healthz", { headers: { [REQUEST_ID_HEADER]: "<script>alert(1)</script>" } }, env());
    expect(refused.headers.get(REQUEST_ID_HEADER)).not.toContain("script");
  });

  it("logs the route template, never the concrete path or query", async () => {
    const { app } = makeApp();
    await app.request("/api/v1/programs/sample-secret-slug?q=my+search", {}, env());
    const line = lines.map((l) => JSON.parse(l)).find((l) => l.event === "request");
    expect(line).toMatchObject({ method: "GET", route: "/api/v1/programs/:slug", status: 200 });
    expect(lines.join("\n")).not.toContain("sample-secret-slug");
    expect(lines.join("\n")).not.toContain("my+search");
  });
});

describe("security headers", () => {
  it("sets the plan's CSP, HSTS and no-store by default", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/v1/programs", {}, env());
    expect(res.headers.get("content-security-policy")).toBe(buildCsp());
    expect(res.headers.get("strict-transport-security")).toContain("max-age=63072000");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(res.headers.get("x-frame-options")).toBe("DENY");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("keeps a handler's own Cache-Control and lets public pages be indexed in production", async () => {
    const { app } = makeApp();
    const res = await app.request("/", {}, env());
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("x-robots-tag")).toBeNull();
  });

  it("skips HSTS locally and marks every non-production page noindex", async () => {
    const { app } = makeApp();
    const res = await app.request("/", {}, env({ ENVIRONMENT: "local", APP_ORIGIN: "http://localhost:8787" }));
    expect(res.headers.get("strict-transport-security")).toBeNull();
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(shouldNoindex("/programs/x", "production")).toBe(false);
    expect(shouldNoindex("/cal/u/abc.ics", "production")).toBe(true);
  });
});

describe("SPA shell and static assets", () => {
  it("serves the shell for /app and deep links with Turnstile CSP and no-store", async () => {
    const { app } = makeApp();
    for (const path of ["/app", "/app/tracker", "/app/programs/sample/readiness"]) {
      const res = await app.request(path, {}, env());
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('id=root');
      expect(res.headers.get("content-security-policy")).toContain("https://challenges.cloudflare.com");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-frame-options")).toBe("DENY");
    }
  });

  it("serves the Curator console shell only on the curate. host outside local, with a strict CSP", async () => {
    const { app } = makeApp();
    const assets = fakeAssets({ "/src/console/index.html": { body: "<!doctype html><div id=root data-console></div>", type: "text/html; charset=utf-8" } });
    for (const path of ["/curate", "/curate/tasks/abc"]) {
      const res = await app.request(`https://curate.novus.example.org${path}`, {}, env({ ASSETS: assets }));
      expect(res.status).toBe(200);
      expect(await res.text()).toContain("data-console");
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp).toBe(buildCsp({ turnstile: false, inlineStyles: false }));
      expect(csp).not.toContain("challenges.cloudflare.com");
      expect(csp).not.toContain("'unsafe-inline'");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    const appHost = await app.request("https://novus.example.org/curate", {}, env({ ASSETS: assets }));
    expect(appHost.status).toBe(404);
    expect(await appHost.text()).not.toContain("data-console");
    const local = await app.request("http://localhost:8787/curate/ops", {}, env({ ENVIRONMENT: "local", APP_ORIGIN: "http://localhost:8787", ASSETS: assets }));
    expect(local.status).toBe(200);
  });

  it("answers 503 problem when the shell is not built", async () => {
    const { app } = makeApp();
    const res = await app.request("/app", {}, env({ ASSETS: fakeAssets({}) }));
    expect(res.status).toBe(503);
    expect((await problemOf(res)).code).toBe("unavailable");
  });

  it("falls back to static files for unmatched paths and adds headers to immutable responses", async () => {
    const { app } = makeApp();
    const res = await app.request("/favicon.png", {}, env());
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("png");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");

    const missing = await app.request("/nothing-here", {}, env());
    expect(missing.status).toBe(404);
    expect(missing.headers.get("content-type")).toContain("text/html");

    expect(isStaticAssetCandidate("GET", "/index.html")).toBe(false);
    expect(isStaticAssetCandidate("POST", "/favicon.png")).toBe(false);
    expect(isStaticAssetCandidate("GET", "/fonts/dm-sans.woff2")).toBe(true);
    expect(isStaticAssetCandidate("GET", "/manifest.webmanifest")).toBe(true);
    expect(isStaticAssetCandidate("GET", "/favicon.ico")).toBe(true);
    expect(isStaticAssetCandidate("GET", "/x.abcdefghijkl")).toBe(false);
  });
});

describe("errors", () => {
  it("answers problem+json with a request id and reports only the class and route", async () => {
    const { app, reports } = makeApp();
    const res = await app.request("/api/v1/boom", {}, env());
    expect(res.status).toBe(500);
    const body = await problemOf(res);
    expect(body.code).toBe("internal");
    expect(body.requestId).toBe(res.headers.get(REQUEST_ID_HEADER));
    expect(JSON.stringify(body)).not.toContain("alice");
    expect(reports).toEqual([expect.objectContaining({ errorClass: "TypeError", route: "/api/v1/boom", environment: "production" })]);
    expect(lines.join("\n")).not.toContain("alice");
  });

  it("maps ApiError and ZodError to their contract codes", async () => {
    const { app } = makeApp();
    expect((await problemOf(await app.request("/api/v1/conflict", {}, env()))).code).toBe("version_conflict");
    const zod = await app.request("/api/v1/zod", {}, env());
    expect(zod.status).toBe(400);
    const body = await problemOf(zod);
    expect(body.code).toBe("validation_failed");
    expect(JSON.stringify(body)).not.toContain("senior-ish");
  });

  it("answers problem+json 404 under API prefixes", async () => {
    const { app } = makeApp();
    for (const path of ["/api/v1/nope", "/internal/v1/nope", "/data/nope.json"]) {
      const res = await app.request(path, {}, env());
      expect(res.status).toBe(404);
      expect((await problemOf(res)).code).toBe("not_found");
    }
  });
});

describe("validation", () => {
  const json = (body: unknown, extra: Record<string, string> = {}) => ({
    method: "PATCH",
    headers: { "content-type": "application/json", origin: ORIGIN, ...extra },
    body: JSON.stringify(body),
  });

  it("passes typed data through and refuses bad input without echoing it", async () => {
    const { app } = makeApp();
    const ok = await app.request("/api/v1/me/profile", json({ classYear: "first_year", interests: ["data"] }), env());
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ saved: { classYear: "first_year", interests: ["data"] } });

    const bad = await app.request("/api/v1/me/profile", json({ classYear: "my-free-text", interests: [] }), env());
    expect(bad.status).toBe(400);
    const body = await problemOf(bad);
    expect(body.code).toBe("validation_failed");
    expect(body.errors).toEqual([{ path: "classYear", message: "Not an allowed value" }]);
    expect(JSON.stringify(body)).not.toContain("my-free-text");
  });

  it("validates query strings", async () => {
    const { app } = makeApp();
    expect(await (await app.request("/api/v1/me/list?limit=20", {}, env())).json()).toEqual({ limit: 20 });
    expect((await app.request("/api/v1/me/list?limit=500", {}, env())).status).toBe(400);
  });
});

describe("sensitive-key guard", () => {
  it("refuses status or identity keys in bodies and queries before any handler runs", async () => {
    const { app } = makeApp();
    const body = await app.request(
      "/api/v1/me/echo",
      {
        method: "POST",
        headers: { "content-type": "application/json", origin: ORIGIN },
        body: JSON.stringify({ profile: { citizenship: "value-that-must-not-leak" } }),
      },
      env(),
    );
    expect(body.status).toBe(400);
    const problem = await problemOf(body);
    expect(problem.code).toBe("sensitive_field_rejected");
    expect(problem.errors?.[0]?.path).toBe("body.profile.citizenship");
    expect(JSON.stringify(problem)).not.toContain("value-that-must-not-leak");
    expect(lines.join("\n")).not.toContain("value-that-must-not-leak");

    const query = await app.request("/api/v1/programs?citizenship=x", {}, env());
    expect((await problemOf(query)).code).toBe("sensitive_field_rejected");
  });

  it("lets ordinary bodies through to the handler", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/api/v1/me/echo",
      { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ note: "hi" }) },
      env(),
    );
    expect(await res.json()).toEqual({ ok: true, len: 13 });
  });

  it("refuses oversized bodies with payload_too_large", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/api/v1/me/echo",
      { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ a: "x".repeat(200_000) }) },
      env(),
    );
    expect(res.status).toBe(413);
    expect((await problemOf(res)).code).toBe("payload_too_large");
  });

  it("gives the Curator import its own, larger limit and keeps a ceiling on it", async () => {
    const { app } = makeApp();
    const post = (path: string, bytes: number) =>
      app.request(path, { method: "POST", headers: { "content-type": "text/csv", origin: ORIGIN }, body: "x".repeat(bytes) }, env());
    const override = API_BODY_LIMIT_OVERRIDES.find((o) => o.path === "/api/v1/curator/import");
    expect(override?.maxBytes).toBe(ROUTE_MAX_BYTES + 64 * 1024);
    const ok = await post("/api/v1/curator/import", 300_000);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ len: 300_000 });
    expect((await post("/api/v1/curator/import", ROUTE_MAX_BYTES + 64 * 1024 + 1)).status).toBe(413);
    // The default still applies to every other path, including look-alikes.
    expect((await post("/api/v1/curator/import-x", 300_000)).status).toBe(413);
    expect((await post("/api/v1/me/echo", API_BODY_LIMIT_BYTES + 1)).status).toBe(413);
  });
});

describe("origin check (CSRF)", () => {
  const post = (headers: Record<string, string>) => ({ method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

  it("refuses cross-site writes and allows same-origin, header-less and exempt ones", async () => {
    const { app } = makeApp();
    const cross = await app.request("/api/v1/me/echo", post({ origin: "https://evil.example.net" }), env());
    expect(cross.status).toBe(403);
    expect((await problemOf(cross)).code).toBe("forbidden");

    expect((await app.request("/api/v1/me/echo", post({ origin: ORIGIN }), env())).status).toBe(200);
    expect((await app.request("/api/v1/me/echo", post({}), env())).status).toBe(200);
    // Signed internal calls are not browser requests; server/internal verifies them.
    expect((await app.request("/internal/v1/jobs/lease", post({ origin: "https://evil.example.net" }), env())).status).toBe(200);
  });

  it("trusts each surface's own origin only: console writes from curate., app writes from the app", async () => {
    const { app } = makeApp();
    const CONSOLE = "https://curate.novus.example.org";
    // A console sign-in or TOTP POST must reach its route instead of a blanket 403.
    expect((await app.request(`${CONSOLE}/api/v1/me/echo`, post({ origin: CONSOLE }), env())).status).toBe(200);
    // Neither surface may drive the other's cookie-authenticated endpoints.
    expect((await app.request(`${CONSOLE}/api/v1/me/echo`, post({ origin: ORIGIN }), env())).status).toBe(403);
    expect((await app.request(`${ORIGIN}/api/v1/me/echo`, post({ origin: CONSOLE }), env())).status).toBe(403);
  });

  it("decides from Sec-Fetch-Site when Origin is absent", () => {
    const base = { method: "POST", pathname: "/api/v1/me/echo", origin: undefined, trustedOrigins: [ORIGIN] };
    expect(originVerdict({ ...base, secFetchSite: "cross-site" })).toBe("deny");
    expect(originVerdict({ ...base, secFetchSite: "same-origin" })).toBe("allow");
    expect(originVerdict({ ...base, origin: "null", secFetchSite: undefined })).toBe("deny");
    expect(originVerdict({ ...base, pathname: "/e/u/token", origin: "https://mail.example.com", secFetchSite: undefined })).toBe("allow");
  });
});

describe("CORS", () => {
  it("gives the app origin credentialed CORS and preflights", async () => {
    const { app } = makeApp();
    const pre = await app.request(
      "/api/v1/me/profile",
      { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "PATCH" } },
      env(),
    );
    expect(pre.status).toBe(204);
    expect(pre.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(pre.headers.get("access-control-allow-credentials")).toBe("true");

    const res = await app.request("/api/v1/programs", { headers: { origin: ORIGIN } }, env());
    expect(res.headers.get("access-control-allow-origin")).toBe(ORIGIN);
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("opens only public GETs to other origins, without credentials", async () => {
    const { app } = makeApp();
    const other = "https://partner.example.com";
    const pub = await app.request("/api/v1/programs", { headers: { origin: other } }, env());
    expect(pub.headers.get("access-control-allow-origin")).toBe("*");
    expect(pub.headers.get("access-control-allow-credentials")).toBeNull();

    const priv = await app.request("/api/v1/me/private", { headers: { origin: other } }, env());
    expect(priv.headers.get("access-control-allow-origin")).toBeNull();

    expect(corsDecision("http://localhost:5173", "GET", "/api/v1/me/profile", [ORIGIN])).toEqual({ kind: "none" });
  });

  it("trusts the Vite dev server only locally", async () => {
    const { app } = makeApp();
    const res = await app.request(
      "/api/v1/me/private",
      { headers: { origin: "http://localhost:5173" } },
      env({ ENVIRONMENT: "local", APP_ORIGIN: "http://localhost:8787" }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe("http://localhost:5173");
  });
});

describe("rate limiting", () => {
  it("answers 429 rate_limited with Retry-After and logs the limiter name only", async () => {
    const { app } = makeApp({ publicRatePerMinute: 2 });
    const headers = { "cf-connecting-ip": "203.0.113.9" };
    expect((await app.request("/api/v1/programs", { headers }, env())).status).toBe(200);
    expect((await app.request("/api/v1/programs", { headers }, env())).status).toBe(200);
    const limited = await app.request("/api/v1/programs", { headers }, env());
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await problemOf(limited)).code).toBe("rate_limited");
    expect(lines.join("\n")).toContain('"limiter":"public_api"');
    expect(lines.join("\n")).not.toContain("203.0.113.9");

    // A different client is unaffected.
    expect((await app.request("/api/v1/programs", { headers: { "cf-connecting-ip": "203.0.113.10" } }, env())).status).toBe(200);
  });

  it("refuses when the binding says no and skips requests with no key", async () => {
    const app = new Hono<AppEnv>();
    app.use("/a", rateLimit({ name: "send", key: () => "k", rules: [{ limit: 100, windowMs: 60_000 }], binding: () => ({ limit: async () => ({ success: false }) }) }));
    app.use("/b", rateLimit({ name: "ai", key: () => null, rules: [{ limit: 0, windowMs: 60_000 }] }));
    app.get("/a", (c) => c.text("a"));
    app.get("/b", (c) => c.text("b"));
    expect((await app.request("/a", {}, env())).status).toBe(429);
    expect((await app.request("/b", {}, env())).status).toBe(200);
  });
});

describe("flags", () => {
  it("refuses writes with 503 while site.read_only is on, and keeps reads working", async () => {
    const { app } = makeApp({ loadFlags: async () => snapshot({ "site.read_only": true }) });
    const write = await app.request(
      "/api/v1/me/profile",
      { method: "PATCH", headers: { "content-type": "application/json", origin: ORIGIN }, body: JSON.stringify({ classYear: "first_year", interests: [] }) },
      env(),
    );
    expect(write.status).toBe(503);
    expect(write.headers.get("retry-after")).toBe("300");
    expect((await app.request("/api/v1/programs", {}, env())).status).toBe(200);
  });

  it("hides /mcp until mcp.enabled is on", async () => {
    const off = makeApp().app;
    expect((await off.request("/mcp", { method: "POST", body: "{}" }, env())).status).toBe(404);
    const on = makeApp({ loadFlags: async () => snapshot({ "mcp.enabled": true }) }).app;
    expect((await on.request("/mcp", { method: "POST", body: "{}" }, env())).status).toBe(200);
  });

  it("uses compiled-in defaults when no database is bound", async () => {
    const app = composeApp(stubModules(), { report: () => undefined });
    expect((await app.request("/mcp", { method: "POST", body: "{}" }, env())).status).toBe(404);
  });
});

describe("ETag", () => {
  it("adds an ETag to cacheable GETs and answers 304 to a matching If-None-Match", async () => {
    const { app } = makeApp();
    const first = await app.request("/api/v1/programs", {}, env());
    const tag = first.headers.get("etag");
    expect(tag).toMatch(/^"[0-9a-f]{32}"$/);
    const second = await app.request("/api/v1/programs", { headers: { "if-none-match": tag! } }, env());
    expect(second.status).toBe(304);
    expect(await second.text()).toBe("");
  });

  it("skips no-store responses", async () => {
    const { app } = makeApp();
    const res = await app.request("/api/v1/me/private", {}, env());
    expect(res.headers.get("etag")).toBeNull();
  });
});

describe("edge cache", () => {
  function pageApp(cache: MemoryCache, render: () => Response | Promise<Response>) {
    const app = new Hono<AppEnv>();
    app.get("/programs/:slug", edgeCache({ cache, varyParams: ["view"], now: () => 1_700_000_000_000 }), () => render());
    return app;
  }

  it("stores fresh and last-good copies, then serves hits without rendering", async () => {
    const cache = new MemoryCache();
    let renders = 0;
    const app = pageApp(cache, () => {
      renders++;
      return new Response("<html><body>page</body></html>", {
        headers: { "content-type": "text/html", "cache-control": "public, max-age=60", [NEAR_DEADLINE_HEADER]: "1" },
      });
    });
    const miss = await app.request("/programs/a?utm_source=x", {}, env());
    expect(miss.headers.get(CACHE_STATUS_HEADER)).toBe("MISS");
    expect(miss.headers.get(NEAR_DEADLINE_HEADER)).toBeNull();
    await new Promise((r) => setTimeout(r, 0));
    expect([...cache.entries.keys()].sort()).toEqual([
      "http://localhost/programs/a",
      "https://lastgood.novus.internal/programs/a",
    ]);
    expect(cache.entries.get("https://lastgood.novus.internal/programs/a")?.init.headers).toBeDefined();
    const kept = new Headers(cache.entries.get("https://lastgood.novus.internal/programs/a")!.init.headers);
    expect(kept.get("cache-control")).toBe("public, max-age=86400");

    const hit = await app.request("/programs/a", {}, env());
    expect(hit.headers.get(CACHE_STATUS_HEADER)).toBe("HIT");
    expect(renders).toBe(1);
  });

  it("serves the last-good copy when rendering fails", async () => {
    const cache = new MemoryCache();
    await cache.put(
      "https://lastgood.novus.internal/programs/b",
      new Response("<html><body>saved</body></html>", { headers: { "content-type": "text/html", "x-novus-rendered-at": "1" } }),
    );
    const app = pageApp(cache, () => new Response("down", { status: 503 }));
    const res = await app.request("/programs/b", {}, env());
    expect(res.status).toBe(200);
    expect(res.headers.get(CACHE_STATUS_HEADER)).toBe("STALE");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toContain("saved");
  });

  it("never stores a response that sets a cookie or is private", async () => {
    const cache = new MemoryCache();
    const app = pageApp(cache, () => new Response("x", { headers: { "set-cookie": "a=b", "cache-control": "public, max-age=60" } }));
    const res = await app.request("/programs/c", { headers: { cookie: "session=secret" } }, env());
    expect(res.headers.get(CACHE_STATUS_HEADER)).toBe("BYPASS");
    expect(cache.entries.size).toBe(0);
  });
});

describe("health", () => {
  it("reports liveness and D1 readiness without details", async () => {
    const { app } = makeApp();
    expect(await (await app.request("/healthz", {}, env())).json()).toEqual({ status: "ok" });
    const noDb = await app.request("/readyz", {}, env());
    expect(noDb.status).toBe(503);
    const db = { prepare: () => ({ first: async () => ({ ok: 1 }) }) } as unknown as D1Database;
    const ready = await app.request("/readyz", {}, env({ DB: db }));
    expect(ready.status).toBe(200);
    expect(await ready.json()).toEqual({ status: "ok", checks: { db: "ok" } });
  });
});
