/**
 * Small HTTP helpers for the auth module: problem+json answers and Set-Cookie rewriting.
 */
import type { Context } from "hono";
import { problem, type ApiErrorCode } from "@shared/contracts/common";
import { SESSION_COOKIE_NAME, SHARED_DEVICE_COOKIE_NAME } from "./config";

export const NO_STORE = "private, no-store";

/** A problem+json response. `type` can be overridden to tell clients what to do next. */
export function problemResponse(
  code: ApiErrorCode,
  extra: { detail?: string; type?: string; requestId?: string } = {},
  headers: Record<string, string> = {},
): Response {
  const body = problem(code, {
    ...(extra.detail ? { detail: extra.detail } : {}),
    ...(extra.type ? { type: extra.type } : {}),
    ...(extra.requestId ? { requestId: extra.requestId } : {}),
  });
  return new Response(JSON.stringify(body), {
    status: body.status,
    headers: { "content-type": "application/problem+json", "cache-control": NO_STORE, ...headers },
  });
}

export function problemFor(c: Context, code: ApiErrorCode, extra: { detail?: string; type?: string } = {}): Response {
  const requestId = c.get("requestId") as string | undefined;
  return problemResponse(code, { ...extra, ...(requestId ? { requestId } : {}) });
}

/** Reads one cookie from a Cookie header without decoding anything else. */
export function readCookie(cookieHeader: string | null | undefined, name: string): string | null {
  if (!cookieHeader) return null;
  for (const part of cookieHeader.split(";")) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return null;
}

export function cookieName(setCookie: string): string {
  return setCookie.slice(0, setCookie.indexOf("=")).trim();
}

function maxAgeOf(setCookie: string): number | null {
  const m = /;\s*max-age=(-?\d+)/i.exec(setCookie);
  return m?.[1] ? Number(m[1]) : null;
}

/**
 * Turns a persistent session cookie into a browser-session cookie (no Max-Age or Expires), for
 * "This is a shared or public computer". A deletion (Max-Age <= 0) is left alone so sign-out
 * still clears the cookie.
 */
export function toBrowserSessionCookie(setCookie: string): string {
  const maxAge = maxAgeOf(setCookie);
  if (maxAge !== null && maxAge <= 0) return setCookie;
  return setCookie
    .split(";")
    .filter((attr, i) => i === 0 || !/^\s*(max-age|expires)=/i.test(attr))
    .join(";");
}

export function sharedDeviceCookie(sameSite: "Lax" | "Strict"): string {
  return `${SHARED_DEVICE_COOKIE_NAME}=1; Path=/; Secure; HttpOnly; SameSite=${sameSite}`;
}

export function clearSharedDeviceCookie(): string {
  return `${SHARED_DEVICE_COOKIE_NAME}=; Max-Age=0; Path=/; Secure; HttpOnly; SameSite=Lax`;
}

/** Rewrites the session cookies in a list of Set-Cookie values for a shared device. */
export function rewriteForSharedDevice(setCookies: readonly string[]): string[] {
  return setCookies.map((v) => (cookieName(v).startsWith(SESSION_COOKIE_NAME) ? toBrowserSessionCookie(v) : v));
}

/** A copy of `response` with new Set-Cookie values and extra headers (responses may be immutable). */
export function withCookies(response: Response, setCookies: readonly string[], extraHeaders: Record<string, string> = {}): Response {
  const headers = new Headers();
  response.headers.forEach((value, key) => {
    if (key.toLowerCase() !== "set-cookie") headers.append(key, value);
  });
  for (const v of setCookies) headers.append("set-cookie", v);
  for (const [k, v] of Object.entries(extraHeaders)) headers.set(k, v);
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
