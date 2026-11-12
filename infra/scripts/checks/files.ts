/** Repository file helpers shared by the CI checks. Node built-ins only. */
import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface Finding {
  check: string;
  file: string;
  line?: number;
  message: string;
}

/**
 * Files git would commit: tracked plus untracked-but-not-ignored. Including untracked files lets
 * the checks catch a secret before `git add`, not only in CI.
 */
export function listRepoFiles(root = REPO_ROOT): string[] {
  const out = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
    cwd: root,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
  });
  const seen = new Set<string>();
  for (const f of out.split("\0")) if (f) seen.add(f);
  return [...seen].sort();
}

const MAX_TEXT_BYTES = 2 * 1024 * 1024;

/** Reads a file as UTF-8 text, or returns null for missing, large or binary files. */
export function readText(root: string, file: string): string | null {
  const path = join(root, file);
  try {
    if (statSync(path).size > MAX_TEXT_BYTES) return null;
    const buf = readFileSync(path);
    if (buf.subarray(0, 8000).includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/** 1-based line number of a character offset. */
export function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text.charCodeAt(i) === 10) line++;
  return line;
}
