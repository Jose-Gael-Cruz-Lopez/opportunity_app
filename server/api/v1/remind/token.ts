import { base64UrlDecode, base64UrlEncode, deriveSubkey, hmacSha256, timingSafeEqual, utf8 } from "@server/internal/crypto";

/**
 * Remind-me confirmation tokens. Stateless like the unsubscribe tokens: the token names the
 * Contact, the one ProgramCycle the request asked for and when it was issued, carries a MAC
 * under a purpose-bound sub-key of BETTER_AUTH_SECRET, and lasts as long as an unconfirmed
 * Contact is kept (7 days). Confirming creates exactly that one subscription: nothing anyone
 * else requested for the same address, before or after, rides on the owner's click.
 */

export interface ConfirmClaims {
  readonly v: 2;
  /** Contact id. */
  readonly c: string;
  /** The ProgramCycle id this confirmation covers (the only subscription it creates). */
  readonly p: string;
  /** Issued at, epoch ms. */
  readonly i: number;
  /** Expiry, epoch ms. */
  readonly x: number;
}

export const CONFIRM_TTL_MS = 7 * 24 * 3_600_000;
const MAC_BYTES = 16;
const ID_RE = /^[0-9a-f-]{36}$/;

async function mac(secret: string, payload: string): Promise<string> {
  const key = await deriveSubkey(secret, "remind-confirm-v2");
  return base64UrlEncode((await hmacSha256(key, payload)).slice(0, MAC_BYTES));
}

export async function signConfirmToken(secret: string, contactId: string, programCycleId: string, nowMs: number): Promise<string> {
  const claims: ConfirmClaims = { v: 2, c: contactId, p: programCycleId, i: nowMs, x: nowMs + CONFIRM_TTL_MS };
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  return `${payload}.${await mac(secret, payload)}`;
}

/** Null when malformed, forged, expired or of an older version. */
export async function verifyConfirmToken(secret: string, token: string, nowMs: number): Promise<ConfirmClaims | null> {
  if (token.length > 400) return null;
  const [payload, sig, extra] = token.split(".");
  if (!payload || !sig || extra !== undefined) return null;
  if (!timingSafeEqual(await mac(secret, payload), sig)) return null;
  const bytes = base64UrlDecode(payload);
  if (!bytes) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 2 || typeof o.c !== "string" || !ID_RE.test(o.c) || typeof o.p !== "string" || !ID_RE.test(o.p)) return null;
  if (typeof o.i !== "number" || typeof o.x !== "number" || !Number.isFinite(o.i) || !Number.isFinite(o.x)) return null;
  if (o.x < nowMs) return null;
  return { v: 2, c: o.c, p: o.p, i: o.i, x: o.x };
}

export function confirmPath(token: string): string {
  return `/e/rc/${token}`;
}
