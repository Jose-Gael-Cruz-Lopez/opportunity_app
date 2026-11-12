/**
 * The guard in front of `POST /api/auth/email-otp/send-verification-otp` (plan 2.3.10, S02-039).
 * Every code send costs account-wide mail quota and lands in someone's inbox, so four controls
 * run before Better Auth sees the request, cheapest refusal first:
 *
 * 1. Turnstile, when TURNSTILE_SECRET_KEY is set. The token comes in the TURNSTILE_HEADER header
 *    because Better Auth's body schema is strict. It fails open only on the outages
 *    server/lib/turnstile.ts lists; while it does, an IP (as an HMAC) gets 1 send per 10 minutes.
 * 2. The RATE_LIMIT_SEND binding, keyed by client IP (absent locally).
 * 3. D1 counters per address, keyed by an HMAC of the normalized address: 3 an hour, 10 a day.
 * 4. A global hourly cap on all code sends, which logs an alert when reached.
 *
 * Better Auth's own per-IP limiter (config.ts RATE_LIMITS) still runs after this guard. Keys are
 * HMACs or the in-memory IP; no address or IP is stored or logged.
 */
import { getDb } from "@server/db/client";
import { checkBinding, clientIp, consumeD1Window, type RateDecision, type RateLimitBindingLike, type WindowRule } from "@server/lib/rate-limit";
import { verifyTurnstile } from "@server/lib/turnstile";
import { hmacHex } from "./crypto";

/** Request header carrying the Turnstile token from the sign-in page. */
export const TURNSTILE_HEADER = "x-novus-turnstile";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export const SEND_CODE_LIMITS = {
  perAddressHour: { limit: 3, windowMs: HOUR },
  perAddressDay: { limit: 10, windowMs: 24 * HOUR },
  /** Judgment: well above launch sign-up volume, well below the account's daily mail quota. */
  globalHour: { limit: 300, windowMs: HOUR },
  /** While Turnstile fails open (plan 2.3.10). */
  failOpenPerIp: { limit: 1, windowMs: 10 * MINUTE },
} as const satisfies Record<string, WindowRule>;

export interface SendGuardBindings {
  DB: D1Database;
  BETTER_AUTH_SECRET: string;
  ENVIRONMENT?: string;
  RATE_LIMIT_SEND?: RateLimitBindingLike;
  TURNSTILE_SECRET_KEY?: string;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface SendGuardInput {
  env: SendGuardBindings;
  request: Request;
  now: number;
  /** False only in tests that exercise Better Auth itself; Turnstile still applies. */
  limits: boolean;
  fetch?: FetchLike;
}

export type SendGuardResult =
  | { ok: true }
  | { ok: false; code: "forbidden"; detail: string }
  | { ok: false; code: "rate_limited"; retryAfterSeconds: number };

/** The address Better Auth will send to, normalized; null when the body has none (Better Auth answers 400). */
export async function sendTarget(request: Request): Promise<string | null> {
  try {
    const body: unknown = await request.clone().json();
    if (!body || typeof body !== "object" || !("email" in body) || typeof body.email !== "string") return null;
    const email = body.email.trim().toLowerCase();
    return email.length > 0 && email.length <= 254 ? email : null;
  } catch {
    return null;
  }
}

function limited(decision: RateDecision): SendGuardResult {
  return { ok: false, code: "rate_limited", retryAfterSeconds: Math.max(1, decision.retryAfterSeconds) };
}

/** Runs the four controls; the caller answers with the refusal or passes the request on. */
export async function guardCodeSend(input: SendGuardInput): Promise<SendGuardResult> {
  const { env, request, now } = input;
  const ip = clientIp(request.headers);
  const db = getDb(env.DB);
  const keyed = (purpose: string, value: string) => hmacHex(`${env.BETTER_AUTH_SECRET}:${purpose}`, value);

  if (env.TURNSTILE_SECRET_KEY) {
    const verdict = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token: request.headers.get(TURNSTILE_HEADER),
      remoteIp: ip,
      fetch: input.fetch,
    });
    if (!verdict.ok) return { ok: false, code: "forbidden", detail: "The security check did not pass. Reload the page and try again." };
    if (verdict.failOpen) {
      console.warn(JSON.stringify({ level: "warn", event: "turnstile_fail_open", reason: verdict.reason }));
      const slow = await consumeD1Window(db, `send_code:fail_open:${await keyed("send-code-ip", ip)}`, SEND_CODE_LIMITS.failOpenPerIp, now);
      if (!slow.allowed) return limited(slow);
    }
  } else if (env.ENVIRONMENT && env.ENVIRONMENT !== "local") {
    // Not fatal (sign-in must keep working), but the deploy is missing a control.
    console.warn(JSON.stringify({ level: "warn", event: "turnstile_not_configured" }));
  }

  if (!input.limits) return { ok: true };

  const byIp = await checkBinding(env.RATE_LIMIT_SEND, `send_code:${ip}`, 60);
  if (!byIp.allowed) return limited(byIp);

  const email = await sendTarget(request);
  if (email) {
    const addressKey = `send_code:addr:${await keyed("send-code-address", email)}`;
    for (const [suffix, rule] of [["h", SEND_CODE_LIMITS.perAddressHour], ["d", SEND_CODE_LIMITS.perAddressDay]] as const) {
      const decision = await consumeD1Window(db, `${addressKey}:${suffix}`, rule, now);
      if (!decision.allowed) return limited(decision);
    }
  }

  const global = await consumeD1Window(db, "send_code:global", SEND_CODE_LIMITS.globalHour, now);
  if (!global.allowed) {
    console.error(JSON.stringify({ level: "alert", event: "send_code_global_cap", limit: SEND_CODE_LIMITS.globalHour.limit }));
    return limited(global);
  }
  return { ok: true };
}
