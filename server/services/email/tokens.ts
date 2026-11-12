import { base64UrlDecode, base64UrlEncode, deriveSubkey, hmacSha256, timingSafeEqual, toHex, utf8 } from "@server/internal/crypto";

/**
 * Unsubscribe tokens (RFC 8058, plan 6.7.4). Stateless: the token names the recipient and the
 * list and carries a MAC, so the one-click POST needs no session, cookie or lookup table. Tokens
 * last one year (beyond CAN-SPAM's 30 days). They are signed with a sub-key of
 * BETTER_AUTH_SECRET bound to this purpose, so they cannot be confused with any other token.
 */

export const UNSUBSCRIBE_LISTS = ["weekly", "alerts", "reminders", "cycle_reminders"] as const;
export type UnsubscribeList = (typeof UNSUBSCRIBE_LISTS)[number];

export interface UnsubscribeClaims {
  readonly v: 1;
  /** `u:{userId}` or `c:{contactId}`. */
  readonly r: string;
  readonly l: UnsubscribeList;
  /** ProgramCycle id for `cycle_reminders`. */
  readonly c?: string;
  /** Expiry, epoch seconds. */
  readonly x: number;
}

export const UNSUBSCRIBE_TTL_MS = 365 * 24 * 3_600_000;
const MAC_BYTES = 16;
const RECIPIENT_RE = /^[uc]:[0-9a-f-]{36}$/;
const ID_RE = /^[0-9a-f-]{36}$/;

async function mac(secret: string, payload: string): Promise<string> {
  const key = await deriveSubkey(secret, "email-unsubscribe-v1");
  return base64UrlEncode((await hmacSha256(key, payload)).slice(0, MAC_BYTES));
}

export async function signUnsubscribeToken(
  secret: string,
  input: { recipientKey: string; list: UnsubscribeList; cycleId?: string | null; nowMs: number },
): Promise<string> {
  const claims: UnsubscribeClaims = {
    v: 1,
    r: input.recipientKey,
    l: input.list,
    ...(input.list === "cycle_reminders" && input.cycleId ? { c: input.cycleId } : {}),
    x: Math.floor((input.nowMs + UNSUBSCRIBE_TTL_MS) / 1000),
  };
  const payload = base64UrlEncode(utf8(JSON.stringify(claims)));
  return `${payload}.${await mac(secret, payload)}`;
}

function parseClaims(raw: unknown): UnsubscribeClaims | null {
  if (!raw || typeof raw !== "object") return null;
  const o = raw as Record<string, unknown>;
  if (o.v !== 1 || typeof o.r !== "string" || !RECIPIENT_RE.test(o.r)) return null;
  if (typeof o.l !== "string" || !(UNSUBSCRIBE_LISTS as readonly string[]).includes(o.l)) return null;
  if (typeof o.x !== "number" || !Number.isFinite(o.x)) return null;
  if (o.l === "cycle_reminders" && (typeof o.c !== "string" || !ID_RE.test(o.c))) return null;
  return { v: 1, r: o.r, l: o.l as UnsubscribeList, ...(typeof o.c === "string" ? { c: o.c } : {}), x: o.x };
}

/** Verifies a token; null when malformed, forged or expired. */
export async function verifyUnsubscribeToken(secret: string, token: string, nowMs: number): Promise<UnsubscribeClaims | null> {
  if (token.length > 600) return null;
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
  const claims = parseClaims(raw);
  if (!claims || claims.x * 1000 < nowMs) return null;
  return claims;
}

/** RFC 8058 headers; the URL serves GET (confirmation page) and POST (one-click). */
export function listUnsubscribeHeaders(url: string): Record<string, string> {
  return { "List-Unsubscribe": `<${url}>`, "List-Unsubscribe-Post": "List-Unsubscribe=One-Click" };
}

export function unsubscribeUrl(appOrigin: string, token: string): string {
  return `${appOrigin.replace(/\/$/, "")}/e/u/${token}`;
}

/** Keyed HMAC of a normalized address for suppression lookups; the address itself is never a key. */
export async function emailLookupHmac(secret: string, email: string): Promise<{ hmac: string; keyId: string }> {
  const key = await deriveSubkey(secret, "email-lookup-v1");
  return { hmac: toHex(await hmacSha256(key, email.trim().toLowerCase())), keyId: "lookup-v1" };
}
