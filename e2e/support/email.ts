/**
 * Reads sign-in codes from the local email capture.
 *
 * In `wrangler dev` the `EMAIL` (send_email) binding never sends mail: Miniflare writes the
 * message to a temp file and logs a block like this to wrangler's output, which global setup
 * appends to LOG_FILE:
 *
 *   send_email binding called with MessageBuilder:
 *   From: Novus <no-reply@localhost>
 *   To: student@example.com
 *   Subject: 123456 is your Novus code
 *
 * No test-only hook in the Worker is needed: the subject line (server/auth/mailer.ts
 * `renderSignInCode`) carries the code.
 */
import { readFileSync } from "node:fs";
import { LOG_FILE } from "./env";

const BLOCK = /^To: (.+)\r?\nSubject: (\d{6}) is your Novus code$/gm;

/** Every code sent to `email` so far, oldest first. */
export function codesFor(email: string, log = safeRead(LOG_FILE)): string[] {
  const wanted = email.trim().toLowerCase();
  const out: string[] = [];
  for (const m of log.matchAll(BLOCK)) {
    if (m[1]?.trim().toLowerCase() === wanted && m[2]) out.push(m[2]);
  }
  return out;
}

function safeRead(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/**
 * Waits until a code newer than the `seen` count arrives for `email`, and returns it.
 * Call `codesFor(email).length` before sending to get `seen`.
 */
export async function waitForCode(email: string, seen = 0, timeoutMs = 15_000): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const codes = codesFor(email);
    if (codes.length > seen) return codes[codes.length - 1]!;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error(`No sign-in code for ${email} in ${LOG_FILE} after ${timeoutMs} ms`);
}

/** A fresh address per run, on the reserved example.org domain. */
export function uniqueEmail(label: string): string {
  return `e2e-${label}-${Date.now().toString(36)}${Math.floor(Math.random() * 1e4)}@example.org`;
}
