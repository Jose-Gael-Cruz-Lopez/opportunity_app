import { sha256Hex, toBase64Url } from "@server/lib/crypto";

/**
 * Per-user calendar feed tokens (plan 6.7.5): 128 random bits, base64url (22 characters), shown
 * to the student once inside the feed URL and stored only as a SHA-256 hash, so a database read
 * cannot rebuild a working URL. Rotating revokes the old hash, which takes effect on the next
 * poll because per-user feeds are never cached at the edge.
 *
 * The student route that rotates a feed (`POST /api/v1/me/calendar-feed/rotate`) should call
 * newCalendarToken() and store calendarTokenHash(token).
 */

export const CALENDAR_TOKEN_BYTES = 16;
/** Accepts 16-64 base64url characters, so a future longer token format keeps working. */
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;

export function newCalendarToken(): string {
  const bytes = new Uint8Array(CALENDAR_TOKEN_BYTES);
  crypto.getRandomValues(bytes);
  return toBase64Url(bytes);
}

export function isCalendarToken(value: string): boolean {
  return TOKEN_PATTERN.test(value);
}

export function calendarTokenHash(token: string): Promise<string> {
  return sha256Hex(token);
}

/** The feed path for a token, relative to the origin. */
export function userFeedPath(token: string): string {
  return `/cal/u/${token}.ics`;
}

/** `abc.ics` -> `abc`; null when the suffix is missing. */
export function stripIcsSuffix(file: string): string | null {
  return file.endsWith(".ics") ? file.slice(0, -4) : null;
}
