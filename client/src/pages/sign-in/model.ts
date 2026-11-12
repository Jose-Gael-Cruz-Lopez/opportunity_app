import { ProblemDetailsSchema } from "@shared/contracts/common";

/**
 * Sign-in by emailed code (Better Auth email OTP, allowlisted in server/auth/routes.ts). These
 * helpers are pure or take an injected fetch so they can be unit-tested; the page only wires
 * state to them.
 *
 * The age screen runs first, on this device: under 16 nothing is sent and no account is made.
 * Only the email address and the code ever leave the browser here.
 */

export const AUTH_BASE = "/api/auth";
export const SEND_CODE_PATH = `${AUTH_BASE}/email-otp/send-verification-otp`;
export const VERIFY_CODE_PATH = `${AUTH_BASE}/sign-in/email-otp`;

/** Six digits, matching server/auth/config.ts OTP.length. */
export const CODE_LENGTH = 6;

export type SignInStep = "age" | "email" | "code";

export type AuthOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "invalid_code" | "rate_limited" | "unavailable" | "rejected" };

/** A deliberately loose check: the server and the inbox are the real validators. */
export function isPlausibleEmail(raw: string): boolean {
  const email = raw.trim();
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

/** Keeps digits only and caps the length, so pasted codes like "123 456" work. */
export function normalizeCode(raw: string): string {
  return raw.replace(/\D/g, "").slice(0, CODE_LENGTH);
}

/**
 * Where to go after signing in. Only in-app paths (relative to /app) are allowed, so a crafted
 * `?next=https://evil.example` or `//evil.example` cannot turn sign-in into an open redirect.
 */
export function safeNextPath(raw: string | null | undefined): string {
  if (!raw) return "/";
  if (!raw.startsWith("/") || raw.startsWith("//") || raw.includes("\\") || /[\u0000-\u001f]/.test(raw)) return "/";
  if (raw.startsWith("/sign-in")) return "/";
  return raw;
}

export function nextFromSearch(search: string): string {
  return safeNextPath(new URLSearchParams(search).get("next"));
}

/** The guided first-run flow (relative to /app). */
export const FIRST_RUN_PATH = "/start";

/**
 * Where to go once signed in. A new account (not onboarded yet) lands on the guided flow at
 * /start, whatever `next` says (a `next` of /start keeps its query), because nothing else is
 * useful before the quiz and the first matches; the flow keeps the student's place on this device. Everyone else goes to the safe
 * `next` path. `onboarded` is null when the session could not be read: then `next` wins, so a
 * slow session check never traps a returning student in onboarding.
 */
export function destinationAfterSignIn(search: string, onboarded: boolean | null): string {
  const next = nextFromSearch(search);
  // A `next` inside the guided flow keeps its query (for example /start?save=1, which finishes
  // saving the plan the student made before signing in).
  if (onboarded === false) return next.split(/[?#]/)[0] === FIRST_RUN_PATH ? next : FIRST_RUN_PATH;
  return next;
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

async function errorCode(res: Response): Promise<string | null> {
  try {
    const json: unknown = await res.json();
    const problem = ProblemDetailsSchema.safeParse(json);
    if (problem.success) return problem.data.code;
    // Better Auth's own errors are { code, message }.
    if (json && typeof json === "object" && "code" in json && typeof json.code === "string") return json.code;
  } catch {
    // Not JSON: treated by status below.
  }
  return null;
}

/** Maps a failed response to an outcome a student can act on. */
export async function outcomeFor(res: Response): Promise<AuthOutcome> {
  if (res.ok) return { ok: true };
  if (res.status === 429) return { ok: false, reason: "rate_limited" };
  const contentType = res.headers.get("content-type") ?? "";
  if (!/\bjson\b/i.test(contentType) || res.status >= 500) return { ok: false, reason: "unavailable" };
  const code = (await errorCode(res))?.toUpperCase() ?? "";
  if (code.includes("OTP") || code.includes("CODE") || res.status === 401) return { ok: false, reason: "invalid_code" };
  return { ok: false, reason: "rejected" };
}

async function post(path: string, body: unknown, fetcher: FetchLike): Promise<AuthOutcome> {
  let res: Response;
  try {
    res = await fetcher(path, {
      method: "POST",
      credentials: "same-origin",
      // The auth routes require Origin to equal the surface's origin; a no-referrer policy on the
      // page (the console once had one) would send "Origin: null" and every sign-in would 403.
      referrerPolicy: "same-origin",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { ok: false, reason: "unavailable" };
  }
  return outcomeFor(res);
}

export function sendCode(email: string, fetcher: FetchLike = (i, r) => fetch(i, r)): Promise<AuthOutcome> {
  return post(SEND_CODE_PATH, { email: email.trim(), type: "sign-in" }, fetcher);
}

export function verifyCode(email: string, code: string, fetcher: FetchLike = (i, r) => fetch(i, r)): Promise<AuthOutcome> {
  return post(VERIFY_CODE_PATH, { email: email.trim(), otp: normalizeCode(code) }, fetcher);
}

export function describeOutcome(outcome: AuthOutcome, step: "email" | "code"): string | null {
  if (outcome.ok) return null;
  switch (outcome.reason) {
    case "invalid_code":
      return step === "code" ? "That code is not right or has expired. Check the latest email, or send a new code." : "Novus could not send a code to that address.";
    case "rate_limited":
      return "Too many tries just now. Wait a few minutes and try again.";
    case "unavailable":
      return "Sign-in is not reachable right now. Check your connection and try again.";
    case "rejected":
      return step === "code" ? "That code did not work. Send a new one and try again." : "Novus could not send a code to that address. Check it and try again.";
  }
}

// ---------------------------------------------------------------------------------------------
// Turnstile on the code send (server half: server/auth/send-guard.ts and server/auth/turnstile.ts)
// ---------------------------------------------------------------------------------------------

export const TURNSTILE_CONFIG_PATH = "/api/v1/turnstile";
/** Explicit rendering, so the widget mounts only on the email step. The /app CSP admits it. */
export const TURNSTILE_SCRIPT_URL = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
export const SEND_CODE_ACTION = "send-code";

export interface TurnstileConfig {
  /** True when the server rejects a code send without a valid token. */
  readonly enabled: boolean;
  readonly siteKey: string | null;
  readonly header: string;
  readonly action: string;
}

/** What the email step shows: no widget, the widget, or "temporarily unavailable". */
export type TurnstileMode = "off" | "widget" | "unavailable";

export function turnstileMode(config: TurnstileConfig | null): TurnstileMode {
  if (!config || !config.enabled) return "off";
  return config.siteKey ? "widget" : "unavailable";
}

function isTurnstileConfig(value: unknown): value is TurnstileConfig {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.enabled === "boolean" &&
    (v.siteKey === null || typeof v.siteKey === "string") &&
    typeof v.header === "string" &&
    /^x-[a-z0-9-]{1,60}$/.test(v.header) &&
    typeof v.action === "string"
  );
}

/**
 * The widget config for the code send. Null when it cannot be read (no API in development, a
 * network error): the page then sends without a token and the server's answer decides.
 */
export async function fetchTurnstileConfig(fetcher: FetchLike = (i, r) => fetch(i, r)): Promise<TurnstileConfig | null> {
  try {
    const res = await fetcher(`${TURNSTILE_CONFIG_PATH}?action=${SEND_CODE_ACTION}`, {
      method: "GET",
      credentials: "same-origin",
      headers: { accept: "application/json" },
    });
    if (!res.ok || !/\bjson\b/i.test(res.headers.get("content-type") ?? "")) return null;
    const body: unknown = await res.json();
    return isTurnstileConfig(body) ? body : null;
  } catch {
    return null;
  }
}

/** A fetcher that adds the single-use Turnstile token to one request. */
export function withTurnstileToken(header: string, token: string, fetcher: FetchLike = (i, r) => fetch(i, r)): FetchLike {
  return (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set(header, token);
    return fetcher(input, { ...init, headers });
  };
}
