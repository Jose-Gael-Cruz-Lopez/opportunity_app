/**
 * Calendar UIDs (plan 6.7.5). RFC 7986 §5.3 says a UID must not identify a user, host or domain
 * and recommends a UUID, so every event UID is a deterministic UUIDv5 (RFC 9562 §5.5) under one
 * fixed Novus namespace. The same input always yields the same UID, so no storage is needed and a
 * mirrored or regenerated feed never duplicates events in a subscriber's calendar.
 *
 * FROZEN: changing the namespace or the name formats below would duplicate every event in every
 * subscribed calendar. Add new name formats; never edit existing ones.
 *
 * SHA-1 is implemented here (synchronously) because UUIDv5 requires it and the ICS writer is a
 * pure, synchronous module that must run unchanged in the browser for the alarm file. SHA-1 is
 * used only as the UUIDv5 name hash, never for security.
 */

/** The Novus ICS namespace UUID (random, generated once on 2026-11-11). */
export const NOVUS_ICS_NAMESPACE = "a36eeaa1-4df9-4a12-8c36-c1060db8f768";

/** Name formats, one per event source (plan 6.7.5). */
export const UID_NAMES = {
  deadline: (deadlineId: string) => `deadline:${deadlineId}`,
  estimate: (programCycleId: string, step: "e1" | "e2") => `estimate:${programCycleId}:${step}`,
  ownCampus: (trackerItemId: string) => `own-campus:${trackerItemId}`,
} as const;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function isUuid(value: string): boolean {
  return UUID_PATTERN.test(value);
}

function rotl(x: number, n: number): number {
  return (x << n) | (x >>> (32 - n));
}

/** SHA-1 (FIPS 180-4) over bytes; returns the 20-byte digest. */
export function sha1(message: Uint8Array): Uint8Array {
  const bitLength = message.length * 8;
  // Pad: 0x80, zeros, then the 64-bit big-endian length, to a multiple of 64 bytes.
  const padded = new Uint8Array(((message.length + 9 + 63) >> 6) << 6);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(padded.length - 8, Math.floor(bitLength / 0x1_0000_0000));
  view.setUint32(padded.length - 4, bitLength >>> 0);

  let h0 = 0x67452301;
  let h1 = 0xefcdab89;
  let h2 = 0x98badcfe;
  let h3 = 0x10325476;
  let h4 = 0xc3d2e1f0;
  const w = new Uint32Array(80);
  for (let offset = 0; offset < padded.length; offset += 64) {
    for (let i = 0; i < 16; i++) w[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 80; i++) w[i] = rotl(w[i - 3]! ^ w[i - 8]! ^ w[i - 14]! ^ w[i - 16]!, 1);
    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    for (let i = 0; i < 80; i++) {
      let f: number;
      let k: number;
      if (i < 20) {
        f = (b & c) | (~b & d);
        k = 0x5a827999;
      } else if (i < 40) {
        f = b ^ c ^ d;
        k = 0x6ed9eba1;
      } else if (i < 60) {
        f = (b & c) | (b & d) | (c & d);
        k = 0x8f1bbcdc;
      } else {
        f = b ^ c ^ d;
        k = 0xca62c1d6;
      }
      const temp = (rotl(a, 5) + f + e + k + w[i]!) >>> 0;
      e = d;
      d = c;
      c = rotl(b, 30) >>> 0;
      b = a;
      a = temp;
    }
    h0 = (h0 + a) >>> 0;
    h1 = (h1 + b) >>> 0;
    h2 = (h2 + c) >>> 0;
    h3 = (h3 + d) >>> 0;
    h4 = (h4 + e) >>> 0;
  }
  const out = new Uint8Array(20);
  const outView = new DataView(out.buffer);
  [h0, h1, h2, h3, h4].forEach((h, i) => outView.setUint32(i * 4, h));
  return out;
}

function uuidBytes(uuid: string): Uint8Array {
  if (!isUuid(uuid)) throw new RangeError("namespace must be a lowercase UUID");
  const hex = uuid.replace(/-/g, "");
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function formatUuid(bytes: Uint8Array): string {
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

/** UUIDv5: SHA-1 of namespace bytes + UTF-8 name, with version 5 and the RFC variant bits set. */
export function uuidv5(namespace: string, name: string): string {
  const ns = uuidBytes(namespace);
  const nameBytes = new TextEncoder().encode(name);
  const input = new Uint8Array(ns.length + nameBytes.length);
  input.set(ns);
  input.set(nameBytes, ns.length);
  const hash = sha1(input).slice(0, 16);
  hash[6] = (hash[6]! & 0x0f) | 0x50;
  hash[8] = (hash[8]! & 0x3f) | 0x80;
  return formatUuid(hash);
}

/** The event UID for a name built with UID_NAMES. */
export function eventUid(name: string): string {
  return uuidv5(NOVUS_ICS_NAMESPACE, name);
}
