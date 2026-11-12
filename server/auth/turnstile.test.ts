import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import {
  TURNSTILE_ACTIONS,
  TURNSTILE_FAILED_DETAIL,
  TURNSTILE_HEADER,
  TURNSTILE_TEST_KEYS,
  readTurnstileToken,
  requireTurnstile,
  turnstileClientConfig,
  turnstileConfigIssues,
  turnstileConfigRoutes,
  type TurnstileBindings,
} from "./turnstile";

type Env = { Bindings: TurnstileBindings };
const SECRET = "test-only-turnstile-secret";
const SITE_KEY = "0x4AAAAAAA-public-site-key";

function siteverify(body: unknown, status = 200) {
  const calls: FormData[] = [];
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    calls.push(init.body as FormData);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  });
  return { fetch, calls };
}

function guarded(options: Parameters<typeof requireTurnstile<Env>>[0] = {}) {
  const app = new Hono<Env>();
  app.post("/api/v1/remind-me", requireTurnstile<Env>(options), (c) => c.json({ status: "pending_confirmation" }));
  return app;
}

const post = (app: Hono<Env>, env: TurnstileBindings, init: { headers?: Record<string, string>; body?: unknown } = {}) =>
  app.request(
    "/api/v1/remind-me",
    { method: "POST", headers: { "content-type": "application/json", ...init.headers }, body: JSON.stringify(init.body ?? { email: "s@example.org" }) },
    env,
  );

describe("turnstileClientConfig", () => {
  it("is off with no secret, whatever the site key", () => {
    expect(turnstileClientConfig({ TURNSTILE_SITE_KEY: SITE_KEY })).toEqual({ enabled: false, siteKey: null, header: TURNSTILE_HEADER, action: "send-code" });
  });

  it("hands out the public site key and the action when a secret is set", () => {
    const config = turnstileClientConfig({ TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITE_KEY: ` ${SITE_KEY} `, ENVIRONMENT: "production" }, TURNSTILE_ACTIONS.remindMe);
    expect(config).toEqual({ enabled: true, siteKey: SITE_KEY, header: "x-novus-turnstile", action: "remind-me" });
    expect(JSON.stringify(config)).not.toContain(SECRET);
  });

  it("pairs a local test secret with the matching test site key", () => {
    expect(turnstileClientConfig({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretPass, ENVIRONMENT: "local" }).siteKey).toBe(TURNSTILE_TEST_KEYS.siteKeyPass);
    expect(turnstileClientConfig({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretFail }).siteKey).toBe(TURNSTILE_TEST_KEYS.siteKeyBlock);
    expect(turnstileClientConfig({ TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretPass, ENVIRONMENT: "staging" }).siteKey).toBeNull();
  });
});

describe("turnstileConfigIssues", () => {
  it("requires nothing locally", () => {
    expect(turnstileConfigIssues({ ENVIRONMENT: "local" })).toEqual([]);
    expect(turnstileConfigIssues({})).toEqual([]);
  });

  it("reports deploy mistakes outside local", () => {
    expect(turnstileConfigIssues({ ENVIRONMENT: "production" })).toEqual(["not_configured"]);
    expect(turnstileConfigIssues({ ENVIRONMENT: "staging", TURNSTILE_SECRET_KEY: TURNSTILE_TEST_KEYS.secretPass, TURNSTILE_SITE_KEY: TURNSTILE_TEST_KEYS.siteKeyPass })).toEqual([
      "test_secret_outside_local",
      "test_site_key_outside_local",
    ]);
    expect(turnstileConfigIssues({ ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: SECRET })).toEqual(["secret_without_site_key"]);
    expect(turnstileConfigIssues({ ENVIRONMENT: "production", TURNSTILE_SITE_KEY: SITE_KEY })).toEqual(["site_key_without_secret"]);
    expect(turnstileConfigIssues({ ENVIRONMENT: "production", TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITE_KEY: SITE_KEY })).toEqual([]);
  });
});

describe("turnstileConfigRoutes", () => {
  const app = new Hono<Env>().route("/api/v1/turnstile", turnstileConfigRoutes<Env>());

  it("answers the config with no-store", async () => {
    const res = await app.request("/api/v1/turnstile?action=remind-me", {}, { TURNSTILE_SECRET_KEY: SECRET, TURNSTILE_SITE_KEY: SITE_KEY, ENVIRONMENT: "production" });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ enabled: true, siteKey: SITE_KEY, header: TURNSTILE_HEADER, action: "remind-me" });
  });

  it("defaults to the code send and refuses unknown actions", async () => {
    expect(((await (await app.request("/api/v1/turnstile", {}, {})).json()) as { action: string }).action).toBe("send-code");
    const bad = await app.request("/api/v1/turnstile?action=login", {}, {});
    expect(bad.status).toBe(400);
  });
});

describe("readTurnstileToken", () => {
  it("prefers the header, falls back to a JSON body field, and ignores other bodies", async () => {
    const withHeader = new Request("https://x.test/", { method: "POST", headers: { [TURNSTILE_HEADER]: "h", "content-type": "application/json" }, body: '{"turnstileToken":"b"}' });
    expect(await readTurnstileToken(withHeader)).toBe("h");
    const req = new Request("https://x.test/", { method: "POST", headers: { "content-type": "application/json" }, body: '{"turnstileToken":"b"}' });
    expect(await readTurnstileToken(req)).toBe("b");
    expect(await req.json()).toEqual({ turnstileToken: "b" }); // body still readable by the handler
    expect(await readTurnstileToken(new Request("https://x.test/", { method: "POST", body: "turnstileToken=b" }))).toBeNull();
    expect(await readTurnstileToken(new Request("https://x.test/", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }))).toBeNull();
  });
});

describe("requireTurnstile", () => {
  it("lets requests through when no secret is configured", async () => {
    const res = await post(guarded(), { ENVIRONMENT: "local" });
    expect(res.status).toBe(200);
  });

  it("refuses a missing or rejected token with 403 problem+json", async () => {
    const rejected = siteverify({ success: false, "error-codes": ["invalid-input-response"] });
    const app = guarded({ fetch: rejected.fetch });
    const missing = await post(app, { TURNSTILE_SECRET_KEY: SECRET });
    expect(missing.status).toBe(403);
    expect(rejected.fetch).not.toHaveBeenCalled();
    const bad = await post(app, { TURNSTILE_SECRET_KEY: SECRET }, { body: { email: "s@example.org", turnstileToken: "tok" } });
    expect(bad.status).toBe(403);
    expect(bad.headers.get("content-type")).toContain("application/problem+json");
    expect(((await bad.json()) as { detail: string }).detail).toBe(TURNSTILE_FAILED_DETAIL);
  });

  it("passes a verified token and sends the client IP to siteverify", async () => {
    const ok = siteverify({ success: true });
    const res = await post(guarded({ fetch: ok.fetch }), { TURNSTILE_SECRET_KEY: SECRET }, { headers: { [TURNSTILE_HEADER]: "tok", "cf-connecting-ip": "192.0.2.7" } });
    expect(res.status).toBe(200);
    expect(ok.calls[0]?.get("response")).toBe("tok");
    expect(ok.calls[0]?.get("remoteip")).toBe("192.0.2.7");
  });

  it("fails open on an outage and lets the route add a tighter limit", async () => {
    const down = siteverify({}, 503);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const open = await post(guarded({ fetch: down.fetch }), { TURNSTILE_SECRET_KEY: SECRET }, { headers: { [TURNSTILE_HEADER]: "tok" } });
    expect(open.status).toBe(200);
    const limited = await post(
      guarded({ fetch: down.fetch, onFailOpen: () => new Response("slow down", { status: 429 }) }),
      { TURNSTILE_SECRET_KEY: SECRET },
      { headers: { [TURNSTILE_HEADER]: "tok" } },
    );
    expect(limited.status).toBe(429);
    const logged = warn.mock.calls.map((c) => String(c[0])).join("\n");
    expect(logged).toContain("turnstile_fail_open");
    expect(logged).not.toContain("tok");
    warn.mockRestore();
  });
});
