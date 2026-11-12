/**
 * Small Web Crypto helpers. Everything here runs unchanged in workerd and in Node 24 (tests),
 * which both expose `crypto.subtle` globally.
 */

const encoder = new TextEncoder();

export function toBytes(data: string | ArrayBuffer | Uint8Array): Uint8Array {
  if (typeof data === "string") return encoder.encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(hex: string): Uint8Array | null {
  if (hex.length % 2 !== 0 || !/^[0-9a-fA-F]*$/.test(hex)) return null;
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", toBytes(data) as BufferSource));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Imports an HMAC-SHA256 key. Imported keys are cached per secret, since imports cost CPU. */
export function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", toBytes(secret) as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, [
      "sign",
      "verify",
    ]);
    // Bound the cache: secrets are few (one per internal key id plus a few derived ones).
    if (keyCache.size > 64) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, message: string | Uint8Array): Promise<Uint8Array> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), toBytes(message) as BufferSource);
  return new Uint8Array(sig);
}

export async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

/**
 * Verifies a hex HMAC with crypto.subtle.verify, which compares in constant time, so the
 * signature check leaks nothing through timing.
 */
export async function verifyHmacSha256Hex(secret: string, message: string | Uint8Array, signatureHex: string): Promise<boolean> {
  const sig = fromHex(signatureHex);
  if (!sig || sig.length !== 32) return false;
  return crypto.subtle.verify("HMAC", await hmacKey(secret), sig as BufferSource, toBytes(message) as BufferSource);
}

/** Constant-time comparison for equal-length strings (tokens, ETags are not secret). */
export function timingSafeEqual(a: string, b: string): boolean {
  const ab = toBytes(a);
  const bb = toBytes(b);
  let diff = ab.length ^ bb.length;
  const n = Math.max(ab.length, bb.length);
  for (let i = 0; i < n; i++) diff |= (ab[i] ?? 0) ^ (bb[i] ?? 0);
  return diff === 0;
}

export function randomHex(bytes = 16): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}
