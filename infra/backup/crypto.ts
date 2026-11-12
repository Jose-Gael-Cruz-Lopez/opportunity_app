/**
 * Envelope encryption for database exports (format "nvbk1").
 *
 * Each export gets a fresh AES-256-GCM data key, wrapped with RSA-OAEP-3072 (SHA-256) to the
 * founders' offline public key, so the Worker that writes backups can never read them back.
 *
 * Layout:
 *   header line: UTF-8 JSON + "\n"  { v, alg, wrap, keyId, wrappedKey, noncePrefix, chunkSize }
 *   frames:      [u32 BE ciphertext length][u8 final flag][ciphertext + 16-byte tag] ...
 *
 * Nonce = 8-byte random prefix || u32 BE frame counter. AAD = counter || final flag, so frames
 * cannot be reordered, dropped from the middle, or truncated at the end without detection.
 * Uses only Web Crypto, so the same code runs in workerd and in Node (restore tooling, tests).
 */

export const FORMAT_VERSION = 1;
export const DEFAULT_CHUNK_SIZE = 1024 * 1024;
const MAX_FRAMES = 0xffffffff;

export interface BackupHeader {
  v: typeof FORMAT_VERSION;
  alg: "AES-256-GCM";
  wrap: "RSA-OAEP-3072-SHA256";
  keyId: string;
  wrappedKey: string;
  noncePrefix: string;
  chunkSize: number;
}

const RSA_PARAMS = { name: "RSA-OAEP", hash: "SHA-256" } as const;

export async function importWrappingKey(publicJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", publicJwk, RSA_PARAMS, false, ["wrapKey"]);
}

export async function importUnwrappingKey(privateJwk: JsonWebKey): Promise<CryptoKey> {
  return crypto.subtle.importKey("jwk", privateJwk, RSA_PARAMS, false, ["unwrapKey"]);
}

function toBase64(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}

function fromBase64(text: string): Uint8Array<ArrayBuffer> {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

function frameMeta(counter: number, final: boolean): Uint8Array<ArrayBuffer> {
  const meta = new Uint8Array(5);
  new DataView(meta.buffer).setUint32(0, counter);
  meta[4] = final ? 1 : 0;
  return meta;
}

function nonceFor(prefix: Uint8Array, counter: number): Uint8Array<ArrayBuffer> {
  const nonce = new Uint8Array(12);
  nonce.set(prefix, 0);
  new DataView(nonce.buffer).setUint32(8, counter);
  return nonce;
}

/** Splits a byte stream into fixed-size chunks, marking the last one (an empty input yields one empty final chunk). */
export async function* rechunk(
  source: AsyncIterable<Uint8Array>,
  chunkSize: number,
): AsyncGenerator<{ data: Uint8Array<ArrayBuffer>; final: boolean }> {
  let buffer = new Uint8Array(chunkSize);
  let filled = 0;
  let pending: Uint8Array<ArrayBuffer> | null = null;
  for await (const piece of source) {
    let offset = 0;
    while (offset < piece.length) {
      const take = Math.min(chunkSize - filled, piece.length - offset);
      buffer.set(piece.subarray(offset, offset + take), filled);
      filled += take;
      offset += take;
      if (filled === chunkSize) {
        // Hold one full chunk back: only the next read tells us whether it was the last.
        if (pending) yield { data: pending, final: false };
        pending = buffer;
        buffer = new Uint8Array(chunkSize);
        filled = 0;
      }
    }
  }
  if (filled > 0) {
    if (pending) yield { data: pending, final: false };
    yield { data: buffer.slice(0, filled), final: true };
  } else {
    yield { data: pending ?? new Uint8Array(0), final: true };
  }
}

export async function* streamToIterable(stream: ReadableStream<Uint8Array>): AsyncGenerator<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return;
      if (value) yield value;
    }
  } finally {
    reader.releaseLock();
  }
}

/** Encrypts a plaintext stream; yields the header line first, then one frame per chunk. */
export async function* encryptStream(
  source: AsyncIterable<Uint8Array>,
  wrappingKey: CryptoKey,
  keyId: string,
  chunkSize = DEFAULT_CHUNK_SIZE,
): AsyncGenerator<Uint8Array> {
  // Workers types widen generateKey to CryptoKey | CryptoKeyPair; AES-GCM always yields one key.
  const dataKey = (await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt"])) as CryptoKey;
  const wrapped = new Uint8Array(await crypto.subtle.wrapKey("raw", dataKey, wrappingKey, RSA_PARAMS));
  const noncePrefix = crypto.getRandomValues(new Uint8Array(8));
  const header: BackupHeader = {
    v: FORMAT_VERSION,
    alg: "AES-256-GCM",
    wrap: "RSA-OAEP-3072-SHA256",
    keyId,
    wrappedKey: toBase64(wrapped),
    noncePrefix: toBase64(noncePrefix),
    chunkSize,
  };
  yield new TextEncoder().encode(`${JSON.stringify(header)}\n`);

  let counter = 0;
  for await (const { data, final } of rechunk(source, chunkSize)) {
    if (counter >= MAX_FRAMES) throw new Error("backup too large for one data key");
    const meta = frameMeta(counter, final);
    const ciphertext = new Uint8Array(
      await crypto.subtle.encrypt(
        { name: "AES-GCM", iv: nonceFor(noncePrefix, counter), additionalData: meta },
        dataKey,
        data,
      ),
    );
    const frame = new Uint8Array(5 + ciphertext.length);
    new DataView(frame.buffer).setUint32(0, ciphertext.length);
    frame[4] = meta[4] ?? 0;
    frame.set(ciphertext, 5);
    yield frame;
    counter++;
  }
}

/** Decrypts a whole nvbk1 file held in memory (restore tooling and tests). */
export async function decryptBackup(input: Uint8Array, unwrappingKey: CryptoKey): Promise<Uint8Array> {
  const file = new Uint8Array(input); // own ArrayBuffer copy: Web Crypto types refuse shared buffers
  const newline = file.indexOf(0x0a);
  if (newline < 0) throw new Error("missing header");
  const header = JSON.parse(new TextDecoder().decode(file.subarray(0, newline))) as BackupHeader;
  if (header.v !== FORMAT_VERSION || header.alg !== "AES-256-GCM") throw new Error("unsupported format");
  const dataKey = await crypto.subtle.unwrapKey(
    "raw",
    fromBase64(header.wrappedKey),
    unwrappingKey,
    RSA_PARAMS,
    { name: "AES-GCM", length: 256 },
    false,
    ["decrypt"],
  );
  const prefix = fromBase64(header.noncePrefix);
  const parts: Uint8Array[] = [];
  let offset = newline + 1;
  let counter = 0;
  let sawFinal = false;
  while (offset < file.length) {
    if (sawFinal) throw new Error("data after final frame");
    if (offset + 5 > file.length) throw new Error("truncated frame header");
    const length = new DataView(file.buffer, file.byteOffset + offset, 4).getUint32(0);
    const final = file[offset + 4] === 1;
    const start = offset + 5;
    if (start + length > file.length) throw new Error("truncated frame");
    const plain = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: nonceFor(prefix, counter), additionalData: frameMeta(counter, final) },
      dataKey,
      file.slice(start, start + length),
    );
    parts.push(new Uint8Array(plain));
    sawFinal = final;
    offset = start + length;
    counter++;
  }
  if (!sawFinal) throw new Error("backup is truncated (no final frame)");
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
