/**
 * Contract test (plan S02-038 / S09-037): a real Better Auth instance over the committed
 * migrations in node:sqlite. Signs in with an emailed code and checks what reaches the browser
 * and what is stored: only `__Host-` cookies, no token or internal id in bodies, no raw IP, user
 * agent or plain-text code in D1. Then walks the staff TOTP step-up.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { Hono } from "hono";
import { freshDb, type TestDb } from "@server/db/testing/fixtures";
import { grantRole } from "@server/db/repos/students";
import { createAuthRoutes } from "./routes";
import { createSessionMiddleware, requireRole, requireUser } from "./session";
import { SECOND_FACTOR_DDL } from "./schema";
import { totpAt } from "./totp";
import type { AuthBindings, AuthEnv } from "./types";
import type { AuthMailer, SignInCodeMessage } from "./mailer";

const ORIGIN = "https://novus.example.org";
const EMAIL = "sample.student@example.org";
const UA = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 Mobile/15E148";
const IP = "203.0.113.77";

interface Harness {
  t: TestDb;
  env: AuthBindings;
  sent: SignInCodeMessage[];
  app: Hono<AuthEnv>;
}

async function harness(rateLimit = false): Promise<Harness> {
  const t = await freshDb();
  t.raw.exec(SECOND_FACTOR_DDL);
  const sent: SignInCodeMessage[] = [];
  const mailer: AuthMailer = { sendSignInCode: async (m) => void sent.push(m) };
  const env: AuthBindings = {
    DB: t.raw.d1,
    APP_ORIGIN: ORIGIN,
    ENVIRONMENT: "local",
    // Test-only placeholder; real secrets come from the BETTER_AUTH_SECRET binding.
    BETTER_AUTH_SECRET: "test-only-secret-not-used-anywhere-0123456789",
  };
  const runtime = { mailer, rateLimit };
  const app = new Hono<AuthEnv>();
  app.use("*", createSessionMiddleware(runtime));
  app.route("/api/auth", createAuthRoutes(runtime));
  app.get("/api/v1/me", requireUser, (c) => c.json({ publicId: c.get("user")?.publicId, roles: c.get("user")?.roles }));
  app.get("/api/v1/review-tasks", requireRole("curator", "admin"), (c) => c.json({ ok: true }));
  return { t, env, sent, app };
}

function post(h: Harness, path: string, body: unknown, cookie = "", extra: Record<string, string> = {}) {
  return h.app.request(
    `${ORIGIN}${path}`,
    {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, "user-agent": UA, "cf-connecting-ip": IP, ...(cookie ? { cookie } : {}), ...extra },
      body: JSON.stringify(body),
    },
    h.env,
  );
}

function get(h: Harness, path: string, cookie: string) {
  return h.app.request(`${ORIGIN}${path}`, { headers: { cookie, origin: ORIGIN, "user-agent": UA, "cf-connecting-ip": IP } }, h.env);
}

/** "a=1; Path=/..." values to a Cookie request header. */
function cookieHeader(setCookies: string[]): string {
  return setCookies
    .map((v) => v.split(";")[0] ?? "")
    .filter((pair) => !/=$/.test(pair))
    .join("; ");
}

async function signIn(h: Harness, extra: Record<string, string> = {}) {
  const send = await post(h, "/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
  expect(send.status).toBe(200);
  const code = h.sent.at(-1)?.code ?? "";
  const res = await post(h, "/api/auth/sign-in/email-otp", { email: EMAIL, otp: code }, "", extra);
  return { res, code, setCookies: res.headers.getSetCookie() };
}

describe("Better Auth contract", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await harness();
  });

  it("sends a 6-digit code that expires in 10 minutes", async () => {
    await post(h, "/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    expect(h.sent).toHaveLength(1);
    expect(h.sent[0]?.code).toMatch(/^\d{6}$/);
    expect(h.sent[0]?.expiresInMinutes).toBe(10);
    const rows = h.t.raw.query<{ expires_at: number; created_at: number }>("SELECT expires_at, created_at FROM verifications");
    expect(rows).toHaveLength(1);
    const ttl = (rows[0]?.expires_at ?? 0) - (rows[0]?.created_at ?? 0);
    expect(Math.round(ttl / 1000)).toBe(600);
  });

  it("stores neither the code nor the address in clear", async () => {
    await post(h, "/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    const code = h.sent[0]?.code ?? "";
    const dump = JSON.stringify(h.t.raw.query("SELECT * FROM verifications"));
    expect(dump).not.toContain(code);
    expect(dump).not.toContain(EMAIL);
  });

  it("signs in with the code: __Host- cookies only, no token or id in the body", async () => {
    const { res, setCookies } = await signIn(h);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signedIn: true });
    expect(setCookies.length).toBeGreaterThan(0);
    for (const v of setCookies) {
      expect(v.startsWith("__Host-")).toBe(true);
      expect(v).not.toMatch(/^__Secure-/);
      expect(v).toMatch(/;\s*Secure/i);
      expect(v).toMatch(/;\s*Path=\//i);
      expect(v).not.toMatch(/;\s*Domain=/i);
    }
    const session = setCookies.find((v) => v.startsWith("__Host-novus.session="));
    expect(session).toMatch(/SameSite=Lax/i);
    expect(session).toMatch(/Max-Age=2592000/);
  });

  it("stores a /24 network and a device class, never the raw IP or user agent", async () => {
    await signIn(h);
    const rows = h.t.raw.query<{ ip_address: string; user_agent: string }>("SELECT ip_address, user_agent FROM sessions");
    expect(rows).toEqual([{ ip_address: "203.0.113.0/24", user_agent: "phone" }]);
    const everything = JSON.stringify([
      h.t.raw.query("SELECT * FROM sessions"),
      h.t.raw.query("SELECT * FROM verifications"),
      h.t.raw.query("SELECT * FROM accounts"),
    ]);
    expect(everything).not.toContain(IP);
    expect(everything).not.toContain("iPhone");
  });

  it("allows 5 attempts per code", async () => {
    await post(h, "/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    const code = h.sent[0]?.code ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++) {
      const r = await post(h, "/api/auth/sign-in/email-otp", { email: EMAIL, otp: wrong });
      expect(r.status).toBeGreaterThanOrEqual(400);
    }
    const late = await post(h, "/api/auth/sign-in/email-otp", { email: EMAIL, otp: code });
    expect(late.status).toBeGreaterThanOrEqual(400);
  });

  it("accepts the right code on the fifth attempt", async () => {
    await post(h, "/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" });
    const code = h.sent[0]?.code ?? "";
    const wrong = code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 4; i++) await post(h, "/api/auth/sign-in/email-otp", { email: EMAIL, otp: wrong });
    expect((await post(h, "/api/auth/sign-in/email-otp", { email: EMAIL, otp: code })).status).toBe(200);
  });

  it("rate-limits code sends per IP in D1, with separate buckets per cf-connecting-ip", async () => {
    const limited = await harness(true);
    // A new address each time, so only the per-IP limit is in play (send-guard.ts caps addresses).
    let n = 0;
    const send = (ip: string) =>
      post(limited, "/api/auth/email-otp/send-verification-otp", { email: `sample.${n++}@example.org`, type: "sign-in" }, "", { "cf-connecting-ip": ip });
    expect((await send(IP)).status).toBe(200);
    expect((await send(IP)).status).toBe(200);
    expect((await send(IP)).status).toBe(429);
    expect((await send("198.51.100.9")).status).toBe(200);
    const keys = limited.t.raw.query<{ key: string }>("SELECT key FROM rate_limits");
    // Better Auth's own rows; the send guard's rows carry the "novus:" prefix.
    const betterAuth = keys.filter((k) => !k.key.startsWith("novus:"));
    expect(betterAuth.length).toBeGreaterThanOrEqual(2);
    // Keys are HMACs: the raw address never reaches D1.
    expect(JSON.stringify(keys)).not.toContain(IP);
    expect(JSON.stringify(keys)).not.toContain("example.org");
    for (const k of betterAuth) expect(k.key).toMatch(/^[0-9a-f]{64}$/);
  });

  it("resolves the session for later requests and hides non-allowlisted endpoints", async () => {
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    const me = await get(h, "/api/v1/me", cookie);
    expect(me.status).toBe(200);
    const body = (await me.json()) as { publicId: string; roles: string[] };
    expect(body.roles).toEqual(["student"]);
    expect(body.publicId).toBeTruthy();
    expect((await get(h, "/api/auth/get-session", cookie)).status).toBe(404);
    expect((await get(h, "/api/auth/list-sessions", cookie)).status).toBe(404);
  });

  it("answers 401 without a session and after sign-out", async () => {
    expect((await get(h, "/api/v1/me", "")).status).toBe(401);
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    const out = await post(h, "/api/auth/sign-out", {}, cookie);
    expect(out.status).toBe(200);
    expect(out.headers.getSetCookie().some((v) => v.startsWith("__Host-novus.session=") && /Max-Age=0/i.test(v))).toBe(true);
    expect((await get(h, "/api/v1/me", cookie)).status).toBe(401);
  });

  it("gives a browser-session cookie on a shared computer", async () => {
    const { setCookies } = await signIn(h, { "x-novus-shared-device": "1" });
    const session = setCookies.find((v) => v.startsWith("__Host-novus.session="));
    expect(session).toBeDefined();
    expect(session).not.toMatch(/Max-Age|Expires/i);
    expect(setCookies.some((v) => v.startsWith("__Host-novus.shared_device=1"))).toBe(true);
  });

  it("keeps staff routes closed until the session passes TOTP", async () => {
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    const userId = h.t.raw.query<{ id: string }>("SELECT id FROM users")[0]?.id ?? "";
    await grantRole(h.t.db, userId, "curator", Date.now());

    const before = await get(h, "/api/v1/review-tasks", cookie);
    expect(before.status).toBe(403);
    expect(((await before.json()) as { type: string }).type).toBe("/problems/second-factor-required");

    const enroll = await post(h, "/api/auth/novus/second-factor/enroll", {}, cookie);
    expect(enroll.status).toBe(201);
    const { secret, recoveryCodes, otpauthUri } = (await enroll.json()) as { secret: string; recoveryCodes: string[]; otpauthUri: string };
    expect(recoveryCodes).toHaveLength(10);
    expect(otpauthUri).toContain("otpauth://totp/");
    const stored = JSON.stringify(h.t.raw.query("SELECT * FROM staff_second_factors"));
    expect(stored).not.toContain(secret);
    for (const rc of recoveryCodes) expect(stored).not.toContain(rc);

    const confirm = await post(h, "/api/auth/novus/second-factor/enroll/confirm", { code: await totpAt(secret, Date.now()) }, cookie);
    expect(confirm.status).toBe(200);
    expect((await get(h, "/api/v1/review-tasks", cookie)).status).toBe(200);

    // A new session (new sign-in) must step up again.
    const second = await signIn(h);
    const cookie2 = cookieHeader(second.setCookies);
    expect((await get(h, "/api/v1/review-tasks", cookie2)).status).toBe(403);
    const viaRecovery = await post(h, "/api/auth/novus/second-factor/recovery", { code: recoveryCodes[0] }, cookie2);
    expect(viaRecovery.status).toBe(200);
    expect((await get(h, "/api/v1/review-tasks", cookie2)).status).toBe(200);
    // The same recovery code does not work twice.
    const third = await signIn(h);
    const reuse = await post(h, "/api/auth/novus/second-factor/recovery", { code: recoveryCodes[0] }, cookieHeader(third.setCookies));
    expect(reuse.status).toBe(400);
  });

  it("refuses second-factor POSTs from another origin and from students", async () => {
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    expect((await post(h, "/api/auth/novus/second-factor/enroll", {}, cookie)).status).toBe(403);
    const userId = h.t.raw.query<{ id: string }>("SELECT id FROM users")[0]?.id ?? "";
    await grantRole(h.t.db, userId, "admin", Date.now());
    const cross = await post(h, "/api/auth/novus/second-factor/enroll", {}, cookie, { origin: "https://evil.example.net" });
    expect(cross.status).toBe(403);
    // Neither may a request with no Origin at all (login CSRF from a form or a script).
    const bare = await h.app.request(
      `${ORIGIN}/api/auth/sign-in/email-otp`,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email: EMAIL, otp: "123456" }) },
      h.env,
    );
    expect(bare.status).toBe(403);
  });

  it("gives the curate. console Strict cookies that last 12 hours", async () => {
    const consoleOrigin = "https://curate.novus.example.org";
    const call = (path: string, body: unknown) =>
      h.app.request(
        `${consoleOrigin}${path}`,
        { method: "POST", headers: { "content-type": "application/json", origin: consoleOrigin, "cf-connecting-ip": IP }, body: JSON.stringify(body) },
        h.env,
      );
    expect((await call("/api/auth/email-otp/send-verification-otp", { email: EMAIL, type: "sign-in" })).status).toBe(200);
    const res = await call("/api/auth/sign-in/email-otp", { email: EMAIL, otp: h.sent.at(-1)?.code ?? "" });
    expect(res.status).toBe(200);
    const session = res.headers.getSetCookie().find((v) => v.startsWith("__Host-novus.session="));
    expect(session).toMatch(/SameSite=Strict/i);
    expect(session).toMatch(/Max-Age=43200/);
    // The student origin cannot drive the console's auth endpoints.
    const cross = await h.app.request(
      `${consoleOrigin}/api/auth/email-otp/send-verification-otp`,
      { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, cookie: "x=1" }, body: JSON.stringify({ email: EMAIL, type: "sign-in" }) },
      h.env,
    );
    expect(cross.status).toBe(403);
  });

  it("locks TOTP after 5 wrong codes", async () => {
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    const userId = h.t.raw.query<{ id: string }>("SELECT id FROM users")[0]?.id ?? "";
    await grantRole(h.t.db, userId, "admin", Date.now());
    const enroll = (await (await post(h, "/api/auth/novus/second-factor/enroll", {}, cookie)).json()) as { secret: string };
    await post(h, "/api/auth/novus/second-factor/enroll/confirm", { code: await totpAt(enroll.secret, Date.now()) }, cookie);
    const fresh = cookieHeader((await signIn(h)).setCookies);
    const right = await totpAt(enroll.secret, Date.now() + 30_000);
    const wrong = right === "000000" ? "111111" : "000000";
    const codes: number[] = [];
    for (let i = 0; i < 5; i++) codes.push((await post(h, "/api/auth/novus/second-factor/verify", { code: wrong }, fresh)).status);
    expect(codes).toEqual([400, 400, 400, 400, 429]);
    const locked = await post(h, "/api/auth/novus/second-factor/verify", { code: right }, fresh);
    expect(locked.status).toBe(429);
    expect(Number(locked.headers.get("retry-after"))).toBeGreaterThan(0);
  });

  it("counts parallel wrong guesses atomically: 20 at once still give at most 5 tries", async () => {
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    const userId = h.t.raw.query<{ id: string }>("SELECT id FROM users")[0]?.id ?? "";
    await grantRole(h.t.db, userId, "admin", Date.now());
    const enroll = (await (await post(h, "/api/auth/novus/second-factor/enroll", {}, cookie)).json()) as { secret: string };
    await post(h, "/api/auth/novus/second-factor/enroll/confirm", { code: await totpAt(enroll.secret, Date.now()) }, cookie);
    const fresh = cookieHeader((await signIn(h)).setCookies);
    const right = await totpAt(enroll.secret, Date.now() + 30_000);
    const wrong = right === "000000" ? "111111" : "000000";
    const statuses = await Promise.all(Array.from({ length: 20 }, () => post(h, "/api/auth/novus/second-factor/verify", { code: wrong }, fresh).then((r) => r.status)));
    // Four plain refusals, then the lockout: every other guess was refused without a check.
    expect(statuses.filter((x) => x === 400)).toHaveLength(4);
    expect(statuses.filter((x) => x === 429)).toHaveLength(16);
    const [row] = h.t.raw.query<{ failed_count: number; locked_until: number | null }>("SELECT failed_count, locked_until FROM staff_second_factors");
    expect(row?.failed_count).toBe(5);
    expect(row?.locked_until).toBeGreaterThan(Date.now());
    // Recovery codes share the same counter and lock.
    expect((await post(h, "/api/auth/novus/second-factor/recovery", { code: "aaaaa-bbbbb" }, fresh)).status).toBe(429);
  });
});

describe("second-factor rate limit", () => {
  it("limits code checks per user even below the lockout", async () => {
    const h = await harness(true);
    const { setCookies } = await signIn(h);
    const cookie = cookieHeader(setCookies);
    const userId = h.t.raw.query<{ id: string }>("SELECT id FROM users")[0]?.id ?? "";
    await grantRole(h.t.db, userId, "admin", Date.now());
    expect((await post(h, "/api/auth/novus/second-factor/enroll", {}, cookie)).status).toBe(201);
    const details: string[] = [];
    // Bad codes: the factor's lockout answers first; the 11th request never reaches it.
    for (let i = 0; i < 11; i++) {
      const res = await post(h, "/api/auth/novus/second-factor/enroll/confirm", { code: "12345x" }, cookie);
      expect(res.status).not.toBe(200);
      details.push(((await res.json()) as { detail?: string }).detail ?? "");
    }
    expect(details.slice(0, 10).filter((d) => d === "Too many attempts. Try again later.")).toHaveLength(0);
    expect(details.at(-1)).toBe("Too many attempts. Try again later.");
    const stored = JSON.stringify(h.t.raw.query("SELECT key FROM rate_limits"));
    expect(stored).not.toContain(IP);
  });
});
