/**
 * Small Web Crypto helpers shared by the internal API, email tokens and the audit digest. They use
 * only `crypto.subtle`, which both the Workers runtime and Node 24 (tests) provide.
 */

const encoder = new TextEncoder();

export type Bytes = Uint8Array<ArrayBuffer>;

export function utf8(text: string): Bytes {
  return encoder.encode(text) as Bytes;
}

export function toHex(bytes: ArrayBuffer | Uint8Array): string {
  const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}

function asBytes(data: string | Uint8Array | ArrayBuffer): Bytes {
  if (typeof data === "string") return utf8(data);
  if (data instanceof ArrayBuffer) return new Uint8Array(data) as Bytes;
  // Copy into a plain ArrayBuffer so SharedArrayBuffer-backed views never reach subtle.digest.
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy as Bytes;
}

export async function sha256Hex(data: string | Uint8Array | ArrayBuffer): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", asBytes(data)));
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/** Imports (and caches per isolate) an HMAC-SHA256 signing key for a secret string. */
function hmacKey(secret: string): Promise<CryptoKey> {
  let key = keyCache.get(secret);
  if (!key) {
    key = crypto.subtle.importKey("raw", utf8(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    // Bound the cache: keyrings are small, but a bug must not grow it without limit.
    if (keyCache.size > 64) keyCache.clear();
    keyCache.set(secret, key);
  }
  return key;
}

export async function hmacSha256(secret: string, message: string | Uint8Array): Promise<Bytes> {
  const sig = await crypto.subtle.sign("HMAC", await hmacKey(secret), asBytes(message));
  return new Uint8Array(sig) as Bytes;
}

export async function hmacSha256Hex(secret: string, message: string | Uint8Array): Promise<string> {
  return toHex(await hmacSha256(secret, message));
}

/**
 * Derives a purpose-bound sub-key from a root secret (HMAC(secret, label)), so one secret can
 * sign unsubscribe tokens and pseudonymize audit subjects without either use forging the other.
 */
export async function deriveSubkey(secret: string, label: string): Promise<string> {
  return hmacSha256Hex(secret, `novus:subkey:${label}`);
}

/** Constant-time comparison for equal-length strings (signatures, MACs). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function base64UrlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlDecode(text: string): Bytes | null {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) return null;
  return base64Decode(text.replace(/-/g, "+").replace(/_/g, "/"));
}

/** Decodes standard base64 (padding optional); null when the text is not base64. */
export function base64Decode(text: string): Bytes | null {
  const clean = text.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) return null;
  const padded = clean.padEnd(Math.ceil(clean.length / 4) * 4, "=");
  try {
    const bin = atob(padded);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out as Bytes;
  } catch {
    return null;
  }
}

/** A random 128-bit token, hex encoded. */
export function randomHex(bytes = 16): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return toHex(buf);
}
