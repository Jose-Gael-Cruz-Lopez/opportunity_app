import { HMAC_HEADERS } from "@shared/contracts/internal";
import { canonicalString, CONTENT_SHA_HEADER, HMAC_MAX_SKEW_SECONDS, HMAC_SCHEME, type CanonicalParts } from "@server/lib/hmac";
import { hmacSha256Hex, timingSafeEqual } from "./crypto";

/**
 * Request verification for `/internal/v1/*` (architecture 2.3.14). The canonical string comes
 * from server/lib/hmac.ts, which matches `novus_pipeline/internal_client.py` byte for byte:
 *
 *   NOVUS-HMAC-SHA256 \n METHOD \n path?query \n unix-seconds \n nonce \n sha256(body) \n key id
 *
 * The pipeline sends `hex(HMAC-SHA256(secret, canonical))`. The body hash covers the exact bytes,
 * so a proxy that re-encodes JSON breaks the signature instead of slipping a changed body through.
 * This module adds what the router needs on top: header shape checks, a failure reason for logs,
 * and the nonce expiry used by the D1 replay table.
 */

export { canonicalString, CONTENT_SHA_HEADER, HMAC_SCHEME, type CanonicalParts };
/** Requests older or newer than this are refused; nonces only need to outlive the window. */
export const MAX_SKEW_SECONDS = HMAC_MAX_SKEW_SECONDS;
export const IDEMPOTENCY_HEADER = "idempotency-key";

export async function signCanonical(secret: string, p: CanonicalParts): Promise<string> {
  return hmacSha256Hex(secret, canonicalString(p));
}

export interface SignedHeaderValues {
  keyId: string;
  timestamp: string;
  nonce: string;
  signature: string;
  contentSha256: string | null;
}

const KEY_ID_RE = /^[a-z][a-z0-9_]{1,30}(?:[.:][A-Za-z0-9_-]{1,40})?$/;
const NONCE_RE = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP_RE = /^\d{9,11}$/;
const HEX64_RE = /^[0-9a-f]{64}$/;

/** Reads and shape-checks the signing headers; null when any is missing or malformed. */
export function readSignedHeaders(headers: Headers): SignedHeaderValues | null {
  const keyId = headers.get(HMAC_HEADERS.keyId);
  const timestamp = headers.get(HMAC_HEADERS.timestamp);
  const nonce = headers.get(HMAC_HEADERS.nonce);
  const signature = headers.get(HMAC_HEADERS.signature)?.toLowerCase() ?? null;
  const contentSha256 = headers.get(CONTENT_SHA_HEADER)?.toLowerCase() ?? null;
  if (!keyId || !timestamp || !nonce || !signature) return null;
  if (!KEY_ID_RE.test(keyId) || !TIMESTAMP_RE.test(timestamp) || !NONCE_RE.test(nonce) || !HEX64_RE.test(signature)) return null;
  if (contentSha256 !== null && !HEX64_RE.test(contentSha256)) return null;
  return { keyId, timestamp, nonce, signature, contentSha256 };
}

export type VerifyFailure = "stale_timestamp" | "unknown_key" | "content_hash_mismatch" | "bad_signature";

export interface VerifyInput {
  method: string;
  pathAndQuery: string;
  headers: SignedHeaderValues;
  bodySha256: string;
  /** The secret for `headers.keyId`, or undefined when the key id is not in the keyring. */
  secret: string | undefined;
  nowMs: number;
}

/**
 * Verifies a signed request. Checks run cheapest first, and every failure maps to one reason the
 * caller logs; the response never says which check failed.
 */
export async function verifySignedRequest(input: VerifyInput): Promise<{ ok: true } | { ok: false; reason: VerifyFailure }> {
  const skew = Math.abs(input.nowMs / 1000 - Number(input.headers.timestamp));
  if (!(skew <= MAX_SKEW_SECONDS)) return { ok: false, reason: "stale_timestamp" };
  if (!input.secret) return { ok: false, reason: "unknown_key" };
  if (input.headers.contentSha256 !== null && input.headers.contentSha256 !== input.bodySha256) {
    return { ok: false, reason: "content_hash_mismatch" };
  }
  const expected = await signCanonical(input.secret, {
    method: input.method,
    pathAndQuery: input.pathAndQuery,
    timestamp: input.headers.timestamp,
    nonce: input.headers.nonce,
    bodySha256: input.bodySha256,
    keyId: input.headers.keyId,
  });
  return timingSafeEqual(expected, input.headers.signature) ? { ok: true } : { ok: false, reason: "bad_signature" };
}

/** When a nonce row may be swept: after the timestamp window has closed on both sides. */
export function nonceExpiresAt(timestampSeconds: number): number {
  return (timestampSeconds + 2 * MAX_SKEW_SECONDS) * 1000;
}
