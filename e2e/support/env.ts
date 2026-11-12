/**
 * Shared constants for the end-to-end suite. Everything the run writes lives under
 * `.wrangler/e2e/` (git-ignored), so a run never touches the developer's own local state in
 * `infra/wrangler/.wrangler/state` and never writes a secret into the repository.
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** Port for the e2e Worker. Not 8787, so a running `npm run dev:worker` is left alone. */
export const PORT = Number(process.env.E2E_PORT ?? 8788);

/** The browser and the Worker's APP_ORIGIN must agree, or the origin (CSRF) check denies POSTs. */
export const BASE_URL = `http://localhost:${PORT}`;

export const RUN_DIR = join(ROOT, ".wrangler", "e2e");
export const STATE_DIR = join(RUN_DIR, "state");
export const ENV_FILE = join(RUN_DIR, "e2e.vars");
export const SEED_FILE = join(RUN_DIR, "seed.sql");
/** Wrangler's stdout and stderr. Local sign-in codes are read from here (see ./email.ts). */
export const LOG_FILE = join(RUN_DIR, "wrangler.log");
export const PID_FILE = join(RUN_DIR, "wrangler.pid");
/** Saved browser state of the student signed in by `auth.setup.ts`. */
export const STUDENT_STATE = join(RUN_DIR, "student.json");
export const STUDENT_EMAIL_FILE = join(RUN_DIR, "student-email.txt");

export const WRANGLER_CONFIG = "infra/wrangler/wrangler.toml";

/** Today's date (UTC) as YYYY-MM-DD: the seed anchors every SAMPLE date to it so deadlines stay ahead. */
export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export function relative(p: string): string {
  return p.startsWith(ROOT) ? p.slice(ROOT.length + 1) : p;
}
