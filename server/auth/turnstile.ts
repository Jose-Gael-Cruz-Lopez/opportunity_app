/**
 * Turnstile for the sign-in code send and the other anonymous writes (plan 02 2.3.10, S02-039).
 *
 * The server check for the code send already runs in send-guard.ts (step 1 of guardCodeSend): the
 * token travels in TURNSTILE_HEADER because Better Auth's body schema is strict. What this module
 * adds is the other half of the hook:
 *
 * - turnstileClientConfig: what the sign-in page needs to render the widget (public site key,
 *   the header name and the action), and whether the server will demand a token at all;
 * - turnstileConfigRoutes: `GET ?action=send-code` answering that config (no-store);
 * - requireTurnstile: the same check as middleware for routes whose contract auth class is
 *   "turnstile" (Remind me, error reports), reading the header or a JSON `turnstileToken`;
 * - turnstileConfigIssues: deploy mistakes worth an alert (a test key outside local, a secret
 *   without a site key).
 *
 * Fail-open rules are server/lib/turnstile.ts's: only outages fail open, never a bad, missing,
 * expired or reused token. The site key is public by design; the secret only ever comes from the
 * TURNSTILE_SECRET_KEY binding. Nothing here logs a token, an address or an IP.
 */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import { problemFor } from "@server/lib/problem";
import { clientIp } from "@server/lib/rate-limit";
import { verifyTurnstile, type TurnstileResult } from "@server/lib/turnstile";
import { TURNSTILE_HEADER } from "./send-guard";

export { TURNSTILE_HEADER };

/** Actions bind a token to its purpose; the widget sends one and siteverify echoes it back. */
export const TURNSTILE_ACTIONS = {
  sendCode: "send-code",
  remindMe: "remind-me",
  errorReport: "error-report",
} as const;
export type TurnstileAction = (typeof TURNSTILE_ACTIONS)[keyof typeof TURNSTILE_ACTIONS];
const ACTION_VALUES: readonly string[] = Object.values(TURNSTILE_ACTIONS);

/**
 * Cloudflare's published Turnstile test keys (developers.cloudflare.com/turnstile/troubleshooting/
 * testing). They are public dummies, not secrets: the "pass" pair always succeeds, the "fail"
 * pair always fails. Only local development may use them.
 */
export const TURNSTILE_TEST_KEYS = {
  siteKeyPass: "1x00000000000000000000AA",
  siteKeyBlock: "2x00000000000000000000AB",
  secretPass: "1x0000000000000000000000000000000AA",
  secretFail: "2x0000000000000000000000000000000AA",
} as const;

const TEST_SECRETS: readonly string[] = [TURNSTILE_TEST_KEYS.secretPass, TURNSTILE_TEST_KEYS.secretFail];
const TEST_SITE_KEYS: readonly string[] = [TURNSTILE_TEST_KEYS.siteKeyPass, TURNSTILE_TEST_KEYS.siteKeyBlock];

export interface TurnstileBindings {
  /** Server secret (wrangler secret). With none, the server demands no token. */
  readonly TURNSTILE_SECRET_KEY?: string;
  /** Public site key ([vars] in wrangler.toml); sent to the browser to render the widget. */
  readonly TURNSTILE_SITE_KEY?: string;
  readonly ENVIRONMENT?: string;
}

export interface TurnstileClientConfig {
  /** True when the server will reject a request without a valid token. */
  readonly enabled: boolean;
  /** Public site key, or null when the widget cannot be rendered. */
  readonly siteKey: string | null;
  /** Request header that carries the token. */
  readonly header: string;
  readonly action: TurnstileAction;
}

function isLocal(env: TurnstileBindings): boolean {
  return !env.ENVIRONMENT || env.ENVIRONMENT === "local";
}

export function isTurnstileAction(value: unknown): value is TurnstileAction {
  return typeof value === "string" && ACTION_VALUES.includes(value);
}

/**
 * The widget config for a page. Locally, a test secret without a site key gets the matching
 * test site key, so `TURNSTILE_SECRET_KEY=<test secret>` in .dev.vars is all a developer sets.
 */
export function turnstileClientConfig(env: TurnstileBindings, action: TurnstileAction = TURNSTILE_ACTIONS.sendCode): TurnstileClientConfig {
  const secret = env.TURNSTILE_SECRET_KEY || null;
  let siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  if (!siteKey && secret && isLocal(env) && TEST_SECRETS.includes(secret)) {
    siteKey = secret === TURNSTILE_TEST_KEYS.secretPass ? TURNSTILE_TEST_KEYS.siteKeyPass : TURNSTILE_TEST_KEYS.siteKeyBlock;
  }
  return { enabled: secret !== null, siteKey: secret ? siteKey : null, header: TURNSTILE_HEADER, action };
}

export type TurnstileConfigIssue = "test_secret_outside_local" | "test_site_key_outside_local" | "secret_without_site_key" | "site_key_without_secret" | "not_configured";

/** Deploy mistakes. Locally nothing is required, so only test keys elsewhere are reported. */
export function turnstileConfigIssues(env: TurnstileBindings): TurnstileConfigIssue[] {
  const issues: TurnstileConfigIssue[] = [];
  const secret = env.TURNSTILE_SECRET_KEY || null;
  const siteKey = env.TURNSTILE_SITE_KEY?.trim() || null;
  if (isLocal(env)) return issues;
  if (!secret && !siteKey) issues.push("not_configured");
  if (secret && TEST_SECRETS.includes(secret)) issues.push("test_secret_outside_local");
  if (siteKey && TEST_SITE_KEYS.includes(siteKey)) issues.push("test_site_key_outside_local");
  if (secret && !siteKey) issues.push("secret_without_site_key");
  if (siteKey && !secret) issues.push("site_key_without_secret");
  return issues;
}

/** `GET /?action=send-code`: the widget config. Mounted by server/app.ts (see the hardening hand-off). */
export function turnstileConfigRoutes<E extends { Bindings: TurnstileBindings }>(): Hono<E> {
  const app = new Hono<E>();
  app.get("/", (c) => {
    const requested = c.req.query("action") ?? TURNSTILE_ACTIONS.sendCode;
    if (!isTurnstileAction(requested)) return problemFor(c as unknown as Context, "validation_failed", { detail: "Unknown action." });
    const issues = turnstileConfigIssues(c.env ?? {});
    if (issues.length > 0) console.warn(JSON.stringify({ level: "warn", event: "turnstile_config", issues: issues.join(",") }));
    return c.json(turnstileClientConfig(c.env ?? {}, requested), 200, { "cache-control": "no-store" });
  });
  return app;
}

/** The token from TURNSTILE_HEADER, else a JSON body's `turnstileToken` (the Remind me contract). */
export async function readTurnstileToken(request: Request): Promise<string | null> {
  const header = request.headers.get(TURNSTILE_HEADER);
  if (header) return header;
  if (!(request.headers.get("content-type") ?? "").toLowerCase().includes("application/json")) return null;
  try {
    const body: unknown = await request.clone().json();
    if (body && typeof body === "object" && "turnstileToken" in body && typeof body.turnstileToken === "string") return body.turnstileToken;
  } catch {
    // An unreadable body has no token; the route's own validation answers it.
  }
  return null;
}

type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export interface RequireTurnstileOptions<E extends { Bindings: TurnstileBindings }> {
  /**
   * Runs while siteverify is down (fail-open). Return a Response to refuse (for example a tighter
   * per-IP limit, as send-guard.ts applies to the code send) or null to let the request through.
   */
  readonly onFailOpen?: (c: Context<E>, verdict: Extract<TurnstileResult, { failOpen: true }>) => Promise<Response | null> | Response | null;
  /** Test seam for siteverify. */
  readonly fetch?: FetchLike;
}

export const TURNSTILE_FAILED_DETAIL = "The security check did not pass. Reload the page and try again.";

/**
 * Middleware for routes whose contract auth class is "turnstile". With no secret configured it
 * lets requests through (local development), logging once per request outside local, as the
 * code send does: a missing control must not take the feature down.
 */
export function requireTurnstile<E extends { Bindings: TurnstileBindings }>(options: RequireTurnstileOptions<E> = {}): MiddlewareHandler<E> {
  return async (c, next) => {
    const env: TurnstileBindings = c.env ?? {};
    if (!env.TURNSTILE_SECRET_KEY) {
      if (!isLocal(env)) console.warn(JSON.stringify({ level: "warn", event: "turnstile_not_configured" }));
      await next();
      return;
    }
    const verdict = await verifyTurnstile({
      secret: env.TURNSTILE_SECRET_KEY,
      token: await readTurnstileToken(c.req.raw),
      remoteIp: clientIp(c.req.raw.headers),
      fetch: options.fetch,
    });
    if (!verdict.ok) return problemFor(c as unknown as Context, "forbidden", { detail: TURNSTILE_FAILED_DETAIL });
    if (verdict.failOpen) {
      console.warn(JSON.stringify({ level: "warn", event: "turnstile_fail_open", reason: verdict.reason }));
      const refusal = options.onFailOpen ? await options.onFailOpen(c, verdict) : null;
      if (refusal) return refusal;
    }
    await next();
  };
}
