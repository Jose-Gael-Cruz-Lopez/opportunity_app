import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { freshDb } from "@server/db/testing/fixtures";
import { createAuthRoutes } from "./routes";
import { SECOND_FACTOR_DDL } from "./schema";
import { guardCodeSend, SEND_CODE_LIMITS, TURNSTILE_HEADER, type SendGuardBindings } from "./send-guard";
import type { AuthBindings, AuthEnv } from "./types";
import type { AuthMailer, SignInCodeMessage } from "./mailer";

const ORIGIN = "https://novus.example.org";
const NOW = Date.UTC(2026, 10, 11, 15, 0, 0);
// Test-only placeholders; real secrets come from bindings.
const SECRET = "test-only-secret-not-used-anywhere-0123456789";
const TURNSTILE_SECRET = "test-only-turnstile-secret";

function sendRequest(email: string, ip = "203.0.113.7", headers: Record<string, string> = {}): Request {
  return new Request(`${ORIGIN}/api/auth/email-otp/send-verification-otp`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: ORIGIN, "cf-connecting-ip": ip, ...headers },
    body: JSON.stringify({ email, type: "sign-in" }),
  });
}

async function bindings(extra: Partial<SendGuardBindings> = {}): Promise<SendGuardBindings> {
  const t = await freshDb();
  return { DB: t.raw.d1, BETTER_AUTH_SECRET: SECRET, ENVIRONMENT: "local", ...extra };
}

/** A siteverify stand-in: answers with the given status and body. */
function siteverify(status: number, body: unknown) {
  const calls: string[] = [];
  const fetch = async (url: string) => {
    calls.push(url);
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetch, calls };
}

describe("send-code guard", () => {
  it("caps sends per address at 3 an hour, whatever the IP, and counts case-insensitively", async () => {
    const env = await bindings();
    const results = [];
    for (const [i, email] of ["a@example.org", "A@Example.org ", "a@example.org", "a@example.org"].entries()) {
      results.push(await guardCodeSend({ env, request: sendRequest(email, `198.51.100.${i}`), now: NOW, limits: true }));
    }
    expect(results.slice(0, 3).every((r) => r.ok)).toBe(true);
    expect(results[3]).toMatchObject({ ok: false, code: "rate_limited" });
    // Another address is unaffected; the next hour opens again.
    expect((await guardCodeSend({ env, request: sendRequest("b@example.org"), now: NOW, limits: true })).ok).toBe(true);
    expect((await guardCodeSend({ env, request: sendRequest("a@example.org"), now: NOW + 3_600_000, limits: true })).ok).toBe(true);
  });

  it("caps sends per address at 10 a day across hours", async () => {
    const env = await bindings();
    let allowed = 0;
    for (let hour = 0; hour < 6; hour++) {
      for (let i = 0; i < SEND_CODE_LIMITS.perAddressHour.limit; i++) {
        const r = await guardCodeSend({ env, request: sendRequest("c@example.org"), now: NOW - (NOW % 86_400_000) + hour * 3_600_000, limits: true });
        if (r.ok) allowed++;
      }
    }
    expect(allowed).toBe(SEND_CODE_LIMITS.perAddressDay.limit);
  });

  it("stores only HMAC keys, never the address", async () => {
    const t = await freshDb();
    const env: SendGuardBindings = { DB: t.raw.d1, BETTER_AUTH_SECRET: SECRET };
    await guardCodeSend({ env, request: sendRequest("private.person@example.org"), now: NOW, limits: true });
    const rows = JSON.stringify(t.raw.query("SELECT key FROM rate_limits"));
    expect(rows).toContain("send_code:addr:");
    expect(rows).not.toContain("private.person");
    expect(rows).not.toContain("203.0.113.7");
  });

  it("refuses when the per-IP binding says no", async () => {
    const env = await bindings({ RATE_LIMIT_SEND: { limit: async () => ({ success: false }) } });
    expect(await guardCodeSend({ env, request: sendRequest("d@example.org"), now: NOW, limits: true })).toEqual({ ok: false, code: "rate_limited", retryAfterSeconds: 60 });
  });

  it("applies the global hourly cap", async () => {
    const env = await bindings();
    let last = await guardCodeSend({ env, request: sendRequest("e0@example.org"), now: NOW, limits: true });
    for (let i = 1; i <= SEND_CODE_LIMITS.globalHour.limit; i++) {
      last = await guardCodeSend({ env, request: sendRequest(`e${i}@example.org`), now: NOW, limits: true });
    }
    expect(last).toMatchObject({ ok: false, code: "rate_limited" });
  });

  it("requires a valid Turnstile token once the secret is configured", async () => {
    const env = await bindings({ TURNSTILE_SECRET_KEY: TURNSTILE_SECRET });
    const rejected = siteverify(200, { success: false, "error-codes": ["invalid-input-response"] });
    expect(await guardCodeSend({ env, request: sendRequest("f@example.org"), now: NOW, limits: true, fetch: rejected.fetch })).toMatchObject({ ok: false, code: "forbidden" });
    // Missing token: refused without calling siteverify.
    const unused = siteverify(200, { success: true });
    expect(await guardCodeSend({ env, request: sendRequest("f@example.org"), now: NOW, limits: true, fetch: unused.fetch })).toMatchObject({ ok: false, code: "forbidden" });
    expect(unused.calls).toEqual([]);
    const passed = siteverify(200, { success: true });
    const ok = await guardCodeSend({ env, request: sendRequest("f@example.org", undefined, { [TURNSTILE_HEADER]: "token" }), now: NOW, limits: true, fetch: passed.fetch });
    expect(ok.ok).toBe(true);
  });

  it("fails open on a siteverify outage but then allows one send per IP per 10 minutes", async () => {
    const env = await bindings({ TURNSTILE_SECRET_KEY: TURNSTILE_SECRET });
    const down = siteverify(503, {});
    const send = (email: string, now: number) =>
      guardCodeSend({ env, request: sendRequest(email, "192.0.2.10", { [TURNSTILE_HEADER]: "token" }), now, limits: true, fetch: down.fetch });
    expect((await send("g1@example.org", NOW)).ok).toBe(true);
    expect(await send("g2@example.org", NOW + 60_000)).toMatchObject({ ok: false, code: "rate_limited" });
    expect((await send("g3@example.org", NOW + 10 * 60_000)).ok).toBe(true);
  });

  it("guards the real send route: a refused Turnstile check sends no mail", async () => {
    const t = await freshDb();
    t.raw.exec(SECOND_FACTOR_DDL);
    const sent: SignInCodeMessage[] = [];
    const mailer: AuthMailer = { sendSignInCode: async (m) => void sent.push(m) };
    const env: AuthBindings = { DB: t.raw.d1, APP_ORIGIN: ORIGIN, ENVIRONMENT: "local", BETTER_AUTH_SECRET: SECRET, TURNSTILE_SECRET_KEY: TURNSTILE_SECRET };
    const app = new Hono<AuthEnv>();
    app.route("/api/auth", createAuthRoutes({ mailer, rateLimit: false }));
    const res = await app.request(sendRequest("h@example.org"), undefined, env);
    expect(res.status).toBe(403);
    expect(sent).toEqual([]);

    // Without the secret (local), the per-address cap still applies on the route.
    const env2: AuthBindings = { ...env, TURNSTILE_SECRET_KEY: undefined };
    const app2 = new Hono<AuthEnv>();
    app2.route("/api/auth", createAuthRoutes({ mailer, rateLimit: true }));
    const statuses: number[] = [];
    for (let i = 0; i < 4; i++) statuses.push((await app2.request(sendRequest("h@example.org", `198.51.100.${20 + i}`), undefined, env2)).status);
    expect(statuses).toEqual([200, 200, 200, 429]);
    expect(sent).toHaveLength(3);
  });
});
