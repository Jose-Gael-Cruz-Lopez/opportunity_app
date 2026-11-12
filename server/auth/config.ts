/**
 * Auth settings from plan 2.3.10 and 9.11.2, in one place so the contract tests can assert them.
 * Better Auth's defaults differ (5-minute codes, 3 attempts, plain-text codes, in-memory rate
 * limits, `__Secure-` cookie prefixes), so every value here is explicit.
 */
import type { AuthSurface } from "./types";

export const AUTH_BASE_PATH = "/api/auth";

/** Emailed sign-in codes. */
export const OTP = {
  length: 6,
  expiresInSeconds: 600,
  allowedAttempts: 5,
  storage: "hashed",
} as const;

/**
 * Cookies. `useSecureCookies` stays false because Better Auth would otherwise prefix
 * `__Secure-` to every name (turning `__Host-` into `__Secure-__Host-`); the attributes below
 * still mark every cookie Secure, Path=/ and host-only, which is what `__Host-` requires.
 */
export const COOKIE_PREFIX = "__Host-novus";
export const SESSION_COOKIE_NAME = `${COOKIE_PREFIX}.session`;
/** Set (session-only) when a student says "This is a shared or public computer". */
export const SHARED_DEVICE_COOKIE_NAME = `${COOKIE_PREFIX}.shared_device`;
/** Request header the sign-in screen sends with the code when the shared-computer box is ticked. */
export const SHARED_DEVICE_HEADER = "x-novus-shared-device";

const DAY_SECONDS = 24 * 60 * 60;

export interface SurfaceSettings {
  sameSite: "lax" | "strict";
  sessionSeconds: number;
  /** Rolling sessions refresh their expiry after this age; null means a fixed lifetime. */
  refreshAfterSeconds: number | null;
}

/** Students: Lax, 30 days rolling. Staff console on `curate.`: Strict, 12 hours fixed. */
export const SURFACES: Record<AuthSurface, SurfaceSettings> = {
  app: { sameSite: "lax", sessionSeconds: 30 * DAY_SECONDS, refreshAfterSeconds: DAY_SECONDS },
  console: { sameSite: "strict", sessionSeconds: 12 * 60 * 60, refreshAfterSeconds: null },
};

/** Per-IP limits Better Auth enforces with its D1-backed limiter (the per-address caps are separate). */
export const RATE_LIMITS = {
  default: { window: 60, max: 60 },
  rules: {
    "/email-otp/send-verification-otp": { window: 60, max: 2 },
    "/sign-in/email-otp": { window: 60, max: 10 },
  },
} as const;

/** The console host is the app host with a `curate.` label in front (a leading `www.` is dropped). */
export function consoleOriginFor(appOrigin: string): string {
  const url = new URL(appOrigin);
  const host = url.hostname.replace(/^www\./, "");
  return `${url.protocol}//curate.${host}${url.port ? `:${url.port}` : ""}`;
}

export function surfaceForUrl(requestUrl: string): AuthSurface {
  return new URL(requestUrl).hostname.startsWith("curate.") ? "console" : "app";
}

export function originForSurface(appOrigin: string, surface: AuthSurface): string {
  return surface === "console" ? consoleOriginFor(appOrigin) : new URL(appOrigin).origin;
}
