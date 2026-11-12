/**
 * Offline tooling for the encrypted weekly backups (infra/backup).
 *
 *   node --experimental-strip-types infra/scripts/backup-keys.ts keygen --out /secure/offline/dir
 *     Writes a new RSA-OAEP-3072 key pair: private.jwk.json (keep OFFLINE, never in this repo)
 *     and public.jwk.json, whose one-line JSON goes into BACKUP_PUBLIC_KEY_JWK.
 *
 *   node --experimental-strip-types infra/scripts/backup-keys.ts decrypt --key private.jwk.json \
 *     --in novus-main.sql.nvbk1 --out novus-main.sql
 *     Decrypts one backup downloaded from R2 `novus-backups/full/{date}/`.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { decryptBackup, importUnwrappingKey } from "../backup/crypto.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

function arg(argv: readonly string[], name: string): string {
  const i = argv.indexOf(name);
  const v = i >= 0 ? argv[i + 1] : undefined;
  if (!v) throw new Error(`${name} is required`);
  return v;
}

function insideRepo(path: string): boolean {
  const rel = relative(REPO_ROOT, resolve(path));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
}

async function keygen(outDir: string): Promise<void> {
  // A private backup key inside a public repository's working tree is one `git add` from a leak.
  if (insideRepo(outDir)) throw new Error("refusing to write a private key inside the repository");
  const pair = await crypto.subtle.generateKey(
    { name: "RSA-OAEP", modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" },
    true,
    ["wrapKey", "unwrapKey"],
  );
  const pub = await crypto.subtle.exportKey("jwk", pair.publicKey);
  const priv = await crypto.subtle.exportKey("jwk", pair.privateKey);
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "private.jwk.json"), JSON.stringify(priv), { mode: 0o600 });
  writeFileSync(join(outDir, "public.jwk.json"), JSON.stringify(pub));
  console.log(`wrote ${join(outDir, "private.jwk.json")} (keep offline) and public.jwk.json`);
  console.log("BACKUP_PUBLIC_KEY_JWK value:");
  console.log(JSON.stringify(pub));
}

async function decrypt(keyPath: string, input: string, output: string): Promise<void> {
  const key = await importUnwrappingKey(JSON.parse(readFileSync(keyPath, "utf8")) as JsonWebKey);
  const plain = await decryptBackup(new Uint8Array(readFileSync(input)), key);
  writeFileSync(output, plain, { mode: 0o600 });
  console.log(`decrypted ${plain.length} bytes to ${output}`);
}

async function main(argv: readonly string[]): Promise<void> {
  const cmd = argv[0];
  if (cmd === "keygen") await keygen(arg(argv, "--out"));
  else if (cmd === "decrypt") await decrypt(arg(argv, "--key"), arg(argv, "--in"), arg(argv, "--out"));
  else throw new Error("usage: backup-keys.ts keygen --out DIR | decrypt --key FILE --in FILE --out FILE");
}

main(process.argv.slice(2)).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
