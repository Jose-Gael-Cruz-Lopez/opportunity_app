import { describe, expect, it } from "vitest";
import { decryptBackup, encryptStream, importUnwrappingKey, importWrappingKey, rechunk } from "./crypto";
import { backupKey, fixedParts, parseDatabases } from "./worker-helpers";

async function keyPair(): Promise<{ wrap: CryptoKey; unwrap: CryptoKey }> {
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["wrapKey", "unwrapKey"],
  );
  return {
    wrap: await importWrappingKey(await crypto.subtle.exportKey("jwk", pair.publicKey)),
    unwrap: await importUnwrappingKey(await crypto.subtle.exportKey("jwk", pair.privateKey)),
  };
}

async function* pieces(data: Uint8Array, size: number): AsyncGenerator<Uint8Array> {
  for (let i = 0; i < data.length; i += size) yield data.subarray(i, i + size);
}

async function collect(gen: AsyncIterable<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const p of gen) parts.push(p);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const keys = await keyPair();

describe("rechunk", () => {
  it("marks exactly the last chunk final, including on exact multiples", async () => {
    const data = new Uint8Array(30).map((_, i) => i);
    const chunks: Array<{ len: number; final: boolean }> = [];
    for await (const c of rechunk(pieces(data, 7), 10)) chunks.push({ len: c.data.length, final: c.final });
    expect(chunks).toEqual([
      { len: 10, final: false },
      { len: 10, final: false },
      { len: 10, final: true },
    ]);
  });

  it("yields one empty final chunk for empty input", async () => {
    const chunks = [];
    for await (const c of rechunk(pieces(new Uint8Array(0), 4), 10)) chunks.push(c);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.final).toBe(true);
  });
});

describe("nvbk1 envelope encryption", () => {
  const plain = new TextEncoder().encode("CREATE TABLE sample(id);\n".repeat(500));

  it("round-trips across many frames", async () => {
    const file = await collect(encryptStream(pieces(plain, 333), keys.wrap, "test", 1000));
    expect(await decryptBackup(file, keys.unwrap)).toEqual(plain);
  });

  it("round-trips an empty dump", async () => {
    const file = await collect(encryptStream(pieces(new Uint8Array(0), 1), keys.wrap, "test", 64));
    expect(await decryptBackup(file, keys.unwrap)).toEqual(new Uint8Array(0));
  });

  it("never contains the plaintext", async () => {
    const file = await collect(encryptStream(pieces(plain, 333), keys.wrap, "test", 1000));
    expect(new TextDecoder().decode(file)).not.toContain("CREATE TABLE");
  });

  it("detects truncation at a frame boundary", async () => {
    const frames: Uint8Array[] = [];
    for await (const f of encryptStream(pieces(plain, 333), keys.wrap, "test", 1000)) frames.push(f);
    const truncated = await collect(pieces(concat(frames.slice(0, -1)), 1 << 20));
    await expect(decryptBackup(truncated, keys.unwrap)).rejects.toThrow(/truncated/);
  });

  it("detects a flipped ciphertext bit", async () => {
    const file = await collect(encryptStream(pieces(plain, 333), keys.wrap, "test", 1000));
    file[file.length - 3] = (file[file.length - 3] ?? 0) ^ 1;
    await expect(decryptBackup(file, keys.unwrap)).rejects.toThrow();
  });

  it("detects reordered frames", async () => {
    const frames: Uint8Array[] = [];
    for await (const f of encryptStream(pieces(plain, 333), keys.wrap, "test", 1000)) frames.push(f);
    const [header, a, b, ...rest] = frames;
    if (!header || !a || !b) throw new Error("expected at least two frames");
    await expect(decryptBackup(concat([header, b, a, ...rest]), keys.unwrap)).rejects.toThrow();
  });
});

describe("backup worker helpers", () => {
  it("cuts equal-size parts with a short last part", async () => {
    const sizes: number[] = [];
    for await (const p of fixedParts(pieces(new Uint8Array(25), 3), 10)) sizes.push(p.length);
    expect(sizes).toEqual([10, 10, 5]);
  });

  it("parses the database list and refuses odd names", () => {
    expect(parseDatabases('[{"name":"novus-main","id":"x"}]')).toEqual([{ name: "novus-main", id: "x" }]);
    expect(() => parseDatabases('[{"name":"../etc","id":"x"}]')).toThrow();
    expect(() => parseDatabases("{}")).toThrow();
  });

  it("stores ciphertext under full/{date}/", () => {
    expect(backupKey("2026-11-15", "novus-main")).toBe("full/2026-11-15/novus-main.sql.nvbk1");
  });
});

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}
