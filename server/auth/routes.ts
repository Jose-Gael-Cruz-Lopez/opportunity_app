/**
 * Routes under /api/auth:
 * - a small allowlist of Better Auth endpoints (send code, sign in with code, sign out, sign out
 *   other sessions). Everything else Better Auth would serve (get-session with internal ids and
 *   the session token, list-sessions, password and account endpoints) answers 404, so no
 *   response exposes an internal id or a token the httpOnly cookie is meant to hide.
 * - the staff second factor under /novus/second-factor.
 */
import { Hono, type Context } from "hono";
import { z } from "zod";
import { getDb } from "@server/db/client";
import { clientIp, consumeD1Window, type WindowRule } from "@server/lib/rate-limit";
import { getAuth } from "./better-auth";
import { hmacHex } from "./crypto";
import { SHARED_DEVICE_COOKIE_NAME, SHARED_DEVICE_HEADER, SURFACES, originForSurface, surfaceForUrl } from "./config";
import {
  NO_STORE,
  clearSharedDeviceCookie,
  problemFor,
  readCookie,
  rewriteForSharedDevice,
  sharedDeviceCookie,
  withCookies,
} from "./http";
import { requiresSecondFactor } from "./permissions";
import {
  remainingRecoveryCodes,
  startEnrollment,
  useRecoveryCode,
  verifyTotpForSession,
  type SecondFactorResult,
} from "./second-factor";
import { guardCodeSend } from "./send-guard";
import { createSessionMiddleware, type AuthRuntime } from "./session";
import type { AuthEnv, SessionUser } from "./types";

/** Better Auth paths (relative to /api/auth) that Novus exposes, with their methods. */
export const BETTER_AUTH_ALLOWLIST: Readonly<Record<string, "POST">> = {
  "/email-otp/send-verification-otp": "POST",
  "/sign-in/email-otp": "POST",
  "/sign-out": "POST",
  "/revoke-other-sessions": "POST",
};

const SEND_CODE_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/sign-in/email-otp";
const SIGN_OUT_PATH = "/sign-out";

/** Code checks per staff user, and per client address, in 15 minutes (the lockout still applies). */
export const SECOND_FACTOR_USER_RULE: WindowRule = { limit: 10, windowMs: 15 * 60_000 };
export const SECOND_FACTOR_IP_RULE: WindowRule = { limit: 30, windowMs: 15 * 60_000 };

const CodeBodySchema = z.object({ code: z.string().trim().min(6).max(32) }).strict();

function authPath(c: Context): string {
  const path = new URL(c.req.url).pathname;
  const i = path.indexOf("/api/auth");
  return i >= 0 ? path.slice(i + "/api/auth".length) || "/" : path;
}

/** Cookie-authenticated POSTs must come from the surface's own origin (CSRF). */
function sameOrigin(c: Context<AuthEnv>): boolean {
  const origin = c.req.header("origin");
  return !!origin && origin === originForSurface(c.env.APP_ORIGIN, surfaceForUrl(c.req.url));
}

function isStaff(user: SessionUser): boolean {
  return user.grants.some((g) => requiresSecondFactor(g.role));
}

function secondFactorAnswer(c: Context<AuthEnv>, result: SecondFactorResult): Response {
  if (result.ok) return c.json({ verified: true }, 200, { "cache-control": NO_STORE });
  if (result.reason === "locked") {
    const retryAfter = String(Math.ceil((result.retryAfterMs ?? 0) / 1000));
    const res = problemFor(c, "rate_limited", { detail: "Too many incorrect codes. Try again later." });
    res.headers.set("retry-after", retryAfter);
    return res;
  }
  if (result.reason === "invalid_code") return problemFor(c, "bad_request", { detail: "That code is not correct." });
  if (result.reason === "not_enrolled") return problemFor(c, "precondition_failed", { detail: "No authenticator is set up yet." });
  return problemFor(c, "conflict", { detail: "An authenticator is already set up." });
}

async function readCode(c: Context<AuthEnv>): Promise<string | null> {
  const body: unknown = await c.req.json().catch(() => null);
  const parsed = CodeBodySchema.safeParse(body);
  return parsed.success ? parsed.data.code : null;
}

/** Rewrites Better Auth's response: no token or internal ids in bodies, shared-device cookies. */
async function finishBetterAuthResponse(c: Context<AuthEnv>, path: string, response: Response): Promise<Response> {
  const request = c.req.raw;
  const sharedRequested = request.headers.get(SHARED_DEVICE_HEADER) === "1";
  const sharedAlready = !!readCookie(request.headers.get("cookie"), SHARED_DEVICE_COOKIE_NAME);
  let setCookies = response.headers.getSetCookie();
  const sameSite = SURFACES[surfaceForUrl(request.url)].sameSite === "strict" ? "Strict" : "Lax";

  if (path === SIGN_IN_PATH && response.ok) {
    // Each sign-in decides afresh: the box ticked now sets the flag, unticked clears an old one.
    if (sharedRequested) setCookies = [...rewriteForSharedDevice(setCookies), sharedDeviceCookie(sameSite)];
    else if (sharedAlready) setCookies = [...setCookies, clearSharedDeviceCookie()];
    // The body would carry the session token and the internal user id; the client reads the
    // session from /api/v1/me/session instead.
    const res = withCookies(new Response(JSON.stringify({ signedIn: true }), { status: 200 }), setCookies, {
      "content-type": "application/json",
      "cache-control": NO_STORE,
    });
    return res;
  }
  if (path === SIGN_OUT_PATH) setCookies = [...setCookies, clearSharedDeviceCookie()];
  else if (sharedAlready) setCookies = rewriteForSharedDevice(setCookies);
  return withCookies(response, setCookies, { "cache-control": NO_STORE });
}

export function createAuthRoutes(runtime: AuthRuntime = {}) {
  const now = () => runtime.now?.() ?? Date.now();
  const app = new Hono<AuthEnv>();

  // --- Staff second factor -------------------------------------------------------------------
  const second = new Hono<AuthEnv>();
  second.use("*", createSessionMiddleware(runtime));
  second.use("*", async (c, next) => {
    const user = c.get("user");
    if (!user) return problemFor(c, "unauthenticated");
    if (!isStaff(user)) return problemFor(c, "forbidden", { detail: "Only staff accounts use an authenticator." });
    if (c.req.method !== "GET" && !sameOrigin(c)) return problemFor(c, "forbidden");
    await next();
    c.header("cache-control", NO_STORE);
  });

  second.get("/", async (c) => {
    const user = c.get("user") as SessionUser;
    const remaining = user.secondFactor.enrolled ? await remainingRecoveryCodes(getDb(c.env.DB), user.id) : 0;
    return c.json({ required: true, enrolled: user.secondFactor.enrolled, verified: user.secondFactor.verified, recoveryCodesRemaining: remaining });
  });

  second.post("/enroll", async (c) => {
    const user = c.get("user") as SessionUser;
    const result = await startEnrollment(getDb(c.env.DB), {
      userId: user.id,
      accountLabel: user.email,
      authSecret: c.env.BETTER_AUTH_SECRET,
      now: now(),
    });
    if (!result.ok) return problemFor(c, "conflict", { detail: "An authenticator is already set up." });
    // Shown once: the secret for manual entry, the otpauth URI for a QR code, and recovery codes.
    return c.json(result.enrollment, 201);
  });

  const sessionRef = (user: SessionUser) => ({ userId: user.id, sessionId: user.sessionId, sessionExpiresAt: user.sessionExpiresAt });

  // Code-checking routes (/enroll/confirm, /verify, /recovery) sit outside /api/v1 (no public
  // limiter) and outside Better Auth's own limiter, so they get theirs: exact D1 windows per user
  // and per client address, checked before the code. The address is stored only as an HMAC.
  // The per-factor lockout still applies underneath.
  async function secondFactorLimit(c: Context<AuthEnv>): Promise<Response | null> {
    if (runtime.rateLimit === false) return null;
    const user = c.get("user") as SessionUser;
    const db = getDb(c.env.DB);
    const t = now();
    const ipKey = await hmacHex(`${c.env.BETTER_AUTH_SECRET}:second-factor-ip`, clientIp(c.req.raw.headers));
    for (const [key, rule] of [
      [`2fa:user:${user.id}`, SECOND_FACTOR_USER_RULE],
      [`2fa:ip:${ipKey.slice(0, 32)}`, SECOND_FACTOR_IP_RULE],
    ] as const) {
      const decision = await consumeD1Window(db, key, rule, t);
      if (!decision.allowed) {
        const res = problemFor(c, "rate_limited", { detail: "Too many attempts. Try again later." });
        res.headers.set("retry-after", String(decision.retryAfterSeconds));
        return res;
      }
    }
    return null;
  }

  second.post("/enroll/confirm", async (c) => {
    const user = c.get("user") as SessionUser;
    const limited = await secondFactorLimit(c);
    if (limited) return limited;
    const code = await readCode(c);
    if (!code) return problemFor(c, "validation_failed");
    const result = await verifyTotpForSession(getDb(c.env.DB), sessionRef(user), {
      code,
      authSecret: c.env.BETTER_AUTH_SECRET,
      now: now(),
      confirming: true,
    });
    return secondFactorAnswer(c, result);
  });

  second.post("/verify", async (c) => {
    const user = c.get("user") as SessionUser;
    const limited = await secondFactorLimit(c);
    if (limited) return limited;
    const code = await readCode(c);
    if (!code) return problemFor(c, "validation_failed");
    const result = await verifyTotpForSession(getDb(c.env.DB), sessionRef(user), { code, authSecret: c.env.BETTER_AUTH_SECRET, now: now() });
    return secondFactorAnswer(c, result);
  });

  second.post("/recovery", async (c) => {
    const user = c.get("user") as SessionUser;
    const limited = await secondFactorLimit(c);
    if (limited) return limited;
    const code = await readCode(c);
    if (!code) return problemFor(c, "validation_failed");
    const result = await useRecoveryCode(getDb(c.env.DB), sessionRef(user), { code, authSecret: c.env.BETTER_AUTH_SECRET, now: now() });
    return secondFactorAnswer(c, result);
  });

  app.route("/novus/second-factor", second);

  // --- Better Auth (allowlisted) ----------------------------------------------------------------
  app.all("*", async (c) => {
    const path = authPath(c);
    if (BETTER_AUTH_ALLOWLIST[path] !== c.req.method) return problemFor(c, "not_found");
    // Every exposed endpoint is a POST from our own pages. Requiring the exact Origin blocks
    // login CSRF and cross-surface calls (the app driving the console), whatever cookies exist.
    if (!sameOrigin(c)) return problemFor(c, "forbidden");
    if (path === SEND_CODE_PATH) {
      const guard = await guardCodeSend({ env: c.env, request: c.req.raw, now: now(), limits: runtime.rateLimit ?? true });
      if (!guard.ok && guard.code === "forbidden") return problemFor(c, "forbidden", { detail: guard.detail });
      if (!guard.ok) {
        const res = problemFor(c, "rate_limited", { detail: "Too many codes requested. Try again later." });
        res.headers.set("retry-after", String(guard.retryAfterSeconds));
        return res;
      }
    }
    const auth = getAuth(c.env, surfaceForUrl(c.req.url), runtime.mailer, runtime.rateLimit ?? true);
    const response = await auth.handler(c.req.raw);
    return finishBetterAuthResponse(c, path, response);
  });

  return app;
}

/** Mounted by server/app.ts at /api/auth. */
export const authRoutes = createAuthRoutes();
