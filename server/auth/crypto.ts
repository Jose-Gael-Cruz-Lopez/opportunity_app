/**
 * Small WebCrypto helpers shared by the TOTP and recovery-code code. WebCrypto exists in both
 * workerd and Node 24, so the same code runs in the Worker and in vitest.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64UrlToBytes(text: string): Uint8Array {
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function bytesToHex(bytes: Uint8Array): string {
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function randomBytes(length: number): Uint8Array {
  const out = new Uint8Array(length);
  crypto.getRandomValues(out);
  return out;
}

/** Constant-time comparison for equal-length strings (hashes, codes). */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret: string, usage: "sign"): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", encoder.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, [usage]);
}

/** HMAC-SHA-256 as hex; used to store recovery codes as keyed hashes, never in clear. */
export async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await hmacKey(secret, "sign");
  return bytesToHex(new Uint8Array(await crypto.subtle.sign("HMAC", key, encoder.encode(message))));
}

/**
 * Derives a purpose-bound AES-GCM key from the auth secret with HKDF, so the TOTP secrets are
 * not encrypted with the same key material Better Auth uses to sign cookies.
 */
async function aesKey(secret: string, purpose: string): Promise<CryptoKey> {
  const base = await crypto.subtle.importKey("raw", encoder.encode(secret), "HKDF", false, ["deriveKey"]);
  return crypto.subtle.deriveKey(
    { name: "HKDF", hash: "SHA-256", salt: encoder.encode("novus-auth-v1"), info: encoder.encode(purpose) },
    base,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"],
  );
}

/** Encrypts to "v1.<iv>.<ciphertext>" (base64url). */
export async function encryptString(secret: string, purpose: string, plaintext: string): Promise<string> {
  const key = await aesKey(secret, purpose);
  const iv = randomBytes(12);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plaintext)));
  return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(ct)}`;
}

export async function decryptString(secret: string, purpose: string, sealed: string): Promise<string> {
  const [version, ivText, ctText] = sealed.split(".");
  if (version !== "v1" || !ivText || !ctText) throw new Error("Unsupported sealed value");
  const key = await aesKey(secret, purpose);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: base64UrlToBytes(ivText) }, key, base64UrlToBytes(ctText));
  return decoder.decode(pt);
}
