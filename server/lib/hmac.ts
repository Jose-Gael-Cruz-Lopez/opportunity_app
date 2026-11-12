import { HMAC_HEADERS } from "@shared/contracts/internal";
import { hmacSha256Hex, sha256Hex, verifyHmacSha256Hex } from "./crypto";

/**
 * HMAC-SHA256 signatures for /internal/v1 (plan 02 2.3.14). The canonical string matches
 * pipeline/novus_pipeline/internal_client.py exactly; change both together:
 *
 *   NOVUS-HMAC-SHA256\nMETHOD\npath_and_query\ntimestamp\nnonce\nbody_sha256_hex\nkey_id
 *
 * The timestamp is unix seconds, accepted within 60 seconds either way. The nonce is 32 hex
 * characters and single-use: the caller records it in D1 (jobs.useNonce), ideally in the same
 * batch as the write, because KV converges too slowly to stop a replay.
 *
 * server/internal owns request verification, key scopes and nonce recording for its router;
 * these helpers sign requests (tests, Worker-to-Worker calls) and verify without side effects.
 */

export const HMAC_SCHEME = "NOVUS-HMAC-SHA256";
export const CONTENT_SHA_HEADER = "x-novus-content-sha256";
export const HMAC_MAX_SKEW_SECONDS = 60;
/** Nonces are kept a little longer than the accepted skew on either side. */
export const NONCE_TTL_MS = 2 * HMAC_MAX_SKEW_SECONDS * 1000 + 60_000;

// Same shapes server/internal accepts; the pipeline sends 32 hex characters.
const NONCE_PATTERN = /^[A-Za-z0-9_-]{16,64}$/;
const TIMESTAMP_PATTERN = /^[0-9]{9,11}$/;
const SIGNATURE_PATTERN = /^[0-9a-f]{64}$/;

export interface CanonicalParts {
  readonly method: string;
  /** Path plus query string, exactly as sent (e.g. `/internal/v1/jobs/lease`). */
  readonly pathAndQuery: string;
  readonly timestamp: string;
  readonly nonce: string;
  readonly bodySha256: string;
  readonly keyId: string;
}

export function canonicalString(p: CanonicalParts): string {
  return [HMAC_SCHEME, p.method.toUpperCase(), p.pathAndQuery, p.timestamp, p.nonce, p.bodySha256, p.keyId].join("\n");
}

export interface SignInput {
  readonly method: string;
  readonly pathAndQuery: string;
  readonly body: string | Uint8Array;
  readonly keyId: string;
  readonly secret: string;
  readonly nowSeconds: number;
  readonly nonce: string;
}

/** Signs a request (used by tests and by any Worker-to-Worker internal call). */
export async function signInternalRequest(input: SignInput): Promise<Record<string, string>> {
  const bodySha256 = await sha256Hex(input.body);
  const timestamp = String(Math.floor(input.nowSeconds));
  const signature = await hmacSha256Hex(
    input.secret,
    canonicalString({ ...input, timestamp, bodySha256 }),
  );
  return {
    [HMAC_HEADERS.keyId]: input.keyId,
    [HMAC_HEADERS.timestamp]: timestamp,
    [HMAC_HEADERS.nonce]: input.nonce,
    [HMAC_HEADERS.signature]: signature,
    [CONTENT_SHA_HEADER]: bodySha256,
  };
}

export type HmacFailure =
  | "missing_headers"
  | "malformed_headers"
  | "unknown_key"
  | "stale_timestamp"
  | "body_hash_mismatch"
  | "bad_signature";

export type HmacVerification =
  | { readonly ok: true; readonly keyId: string; readonly nonce: string; readonly timestamp: number; readonly bodySha256: string }
  | { readonly ok: false; readonly reason: HmacFailure };

export interface VerifyInput {
  readonly method: string;
  readonly pathAndQuery: string;
  readonly headers: Headers;
  readonly body: Uint8Array;
  readonly keys: ReadonlyMap<string, string>;
  readonly nowSeconds: number;
}

/**
 * Verifies a signed request. Pure apart from Web Crypto: nonce replay is the caller's check,
 * because it needs D1. Failure reasons are for logs and metrics; the client always gets 401.
 */
export async function verifyInternalRequest(input: VerifyInput): Promise<HmacVerification> {
  const keyId = input.headers.get(HMAC_HEADERS.keyId);
  const timestamp = input.headers.get(HMAC_HEADERS.timestamp);
  const nonce = input.headers.get(HMAC_HEADERS.nonce);
  const signature = input.headers.get(HMAC_HEADERS.signature);
  if (!keyId || !timestamp || !nonce || !signature) return { ok: false, reason: "missing_headers" };
  if (!TIMESTAMP_PATTERN.test(timestamp) || !NONCE_PATTERN.test(nonce) || !SIGNATURE_PATTERN.test(signature)) {
    return { ok: false, reason: "malformed_headers" };
  }
  const secret = input.keys.get(keyId);
  if (!secret) return { ok: false, reason: "unknown_key" };

  const ts = Number(timestamp);
  if (Math.abs(input.nowSeconds - ts) > HMAC_MAX_SKEW_SECONDS) return { ok: false, reason: "stale_timestamp" };

  const bodySha256 = await sha256Hex(input.body);
  const declared = input.headers.get(CONTENT_SHA_HEADER);
  // The declared hash is optional, but when sent it must match what arrived.
  if (declared !== null && declared.toLowerCase() !== bodySha256) return { ok: false, reason: "body_hash_mismatch" };

  const message = canonicalString({
    method: input.method,
    pathAndQuery: input.pathAndQuery,
    timestamp,
    nonce,
    bodySha256,
    keyId,
  });
  const valid = await verifyHmacSha256Hex(secret, message, signature);
  if (!valid) return { ok: false, reason: "bad_signature" };
  return { ok: true, keyId, nonce, timestamp: ts, bodySha256 };
}
