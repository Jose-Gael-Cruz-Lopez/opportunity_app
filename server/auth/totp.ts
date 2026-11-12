/**
 * TOTP (RFC 6238 over RFC 4226 HOTP) and recovery codes for staff second factors.
 *
 * Why not Better Auth's two-factor plugin: in 1.7.20 its sign-in hook only intercepts
 * /sign-in/email, /sign-in/username and /sign-in/phone-number, so a staff member signing in with
 * an emailed code would get a full session without a second factor. Novus therefore steps a
 * code-signed-in session up with its own TOTP check, bound to that session (see second-factor.ts).
 */
import { randomBytes, timingSafeEqual } from "./crypto";

export const TOTP_PERIOD_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** One step either side tolerates phone clock drift of up to about 30 seconds. */
export const TOTP_WINDOW = 1;
export const RECOVERY_CODE_COUNT = 10;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Uint8Array {
  const clean = text.toUpperCase().replace(/[\s=-]/g, "");
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error("Invalid base32 character");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return new Uint8Array(out);
}

/** 160 random bits, the HMAC-SHA-1 block-size recommendation in RFC 4226 section 4. */
export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20));
}

export function totpStep(nowMs: number, period = TOTP_PERIOD_SECONDS): number {
  return Math.floor(nowMs / 1000 / period);
}

/** HOTP value for one counter (RFC 4226 section 5.3 dynamic truncation). */
export async function hotp(secret: Uint8Array, counter: number, digits = TOTP_DIGITS): Promise<string> {
  const msg = new Uint8Array(8);
  // Counters stay far below 2^53, so splitting into two 32-bit halves is exact.
  const view = new DataView(msg.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);
  const key = await crypto.subtle.importKey("raw", secret, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, msg));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary =
    (((mac[offset] ?? 0) & 0x7f) << 24) |
    ((mac[offset + 1] ?? 0) << 16) |
    ((mac[offset + 2] ?? 0) << 8) |
    (mac[offset + 3] ?? 0);
  return String(binary % 10 ** digits).padStart(digits, "0");
}

export async function totpAt(secretBase32: string, nowMs: number): Promise<string> {
  return hotp(base32Decode(secretBase32), totpStep(nowMs));
}

export type TotpCheck = { ok: true; step: number } | { ok: false };

/**
 * Checks a code against the current step and TOTP_WINDOW steps either side. A step at or before
 * `lastUsedStep` is refused, so an observed code cannot be replayed (RFC 6238 section 5.2).
 */
export async function verifyTotp(
  secretBase32: string,
  code: string,
  nowMs: number,
  lastUsedStep: number | null = null,
): Promise<TotpCheck> {
  const candidate = code.replace(/\s/g, "");
  if (!new RegExp(`^\\d{${TOTP_DIGITS}}$`).test(candidate)) return { ok: false };
  const secret = base32Decode(secretBase32);
  const current = totpStep(nowMs);
  let matched: number | null = null;
  // Check every step in the window (no early exit) so timing does not reveal which one matched.
  for (let delta = -TOTP_WINDOW; delta <= TOTP_WINDOW; delta++) {
    const step = current + delta;
    if (step < 0) continue;
    if (timingSafeEqual(await hotp(secret, step), candidate) && (lastUsedStep === null || step > lastUsedStep)) {
      matched = matched === null ? step : Math.max(matched, step);
    }
  }
  return matched === null ? { ok: false } : { ok: true, step: matched };
}

/** otpauth:// URI for authenticator apps (Key Uri Format). */
export function otpauthUri(issuer: string, accountLabel: string, secretBase32: string): string {
  const label = encodeURIComponent(`${issuer}:${accountLabel}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(TOTP_DIGITS),
    period: String(TOTP_PERIOD_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

// Recovery codes avoid 0/o, 1/l/i so they survive being read aloud or written down.
const RECOVERY_ALPHABET = "abcdefghjkmnpqrstuvwxyz23456789";

/** Ten codes of 10 characters (about 49 bits each), formatted "xxxxx-xxxxx". */
export function generateRecoveryCodes(count = RECOVERY_CODE_COUNT): string[] {
  return Array.from({ length: count }, () => {
    const chars = randomChars(10, RECOVERY_ALPHABET);
    return `${chars.slice(0, 5)}-${chars.slice(5)}`;
  });
}

/** Uniform characters by rejection sampling (a plain `byte % n` would favour the first letters). */
function randomChars(length: number, alphabet: string): string {
  const limit = 256 - (256 % alphabet.length);
  let out = "";
  while (out.length < length) {
    for (const b of randomBytes(length * 2)) {
      if (b < limit && out.length < length) out += alphabet[b % alphabet.length];
    }
  }
  return out;
}

/** Lower-cases and drops separators so "ABCDE FGHJK" and "abcde-fghjk" hash the same. */
export function normalizeRecoveryCode(code: string): string {
  return code.toLowerCase().replace(/[^a-z0-9]/g, "");
}
