/**
 * Playwright global setup: a fresh local Worker for every run.
 *
 *   1. build the SPA into dist/public (skip with E2E_SKIP_BUILD=1 when it is already current),
 *   2. create an empty D1 state directory under .wrangler/e2e/state,
 *   3. apply the novus-main and novus-events migrations,
 *   4. load the SAMPLE seed, anchored to today's date so every sample deadline is still ahead,
 *   5. start `wrangler dev` on BASE_URL with throwaway secrets, logging to .wrangler/e2e/wrangler.log,
 *   6. wait for /readyz.
 *
 * The returned function stops the Worker. No Gemini key is set, so every AI feature runs on its
 * deterministic fallback, which is what the suite asserts.
 */
import { spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  BASE_URL,
  ENV_FILE,
  LOG_FILE,
  PID_FILE,
  PORT,
  ROOT,
  RUN_DIR,
  SEED_FILE,
  STATE_DIR,
  WRANGLER_CONFIG,
  relative,
  todayIso,
} from "./support/env";

const BIN = join(ROOT, "node_modules", ".bin");

/** Runs a command (no shell) and returns its stdout; throws with both streams on failure. */
function run(command: string, args: readonly string[]): string {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1" },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(
      `[e2e] ${relative(command)} ${args.join(" ")} exited with ${result.status}\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

/** Stops a Worker left behind by an interrupted earlier run (it would hold the port). */
function stopStale(): void {
  if (!existsSync(PID_FILE)) return;
  const pid = Number(readFileSync(PID_FILE, "utf8"));
  if (Number.isInteger(pid) && pid > 0) {
    try {
      process.kill(-pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
  rmSync(PID_FILE, { force: true });
}

async function waitForReady(timeoutMs: number, exited: () => string | null): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = "no response";
  while (Date.now() < deadline) {
    const exit = exited();
    if (exit) throw new Error(`[e2e] wrangler dev exited early (${exit}); see ${relative(LOG_FILE)}`);
    try {
      const res = await fetch(`${BASE_URL}/readyz`);
      if (res.ok) return;
      last = `HTTP ${res.status}`;
    } catch (err) {
      last = err instanceof Error ? err.message : String(err);
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`[e2e] Worker not ready at ${BASE_URL}/readyz after ${timeoutMs} ms (${last}); see ${relative(LOG_FILE)}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  if (process.env.E2E_REUSE_SERVER === "1") {
    // For iterating on specs against a Worker left running by an earlier `E2E_KEEP_SERVER=1` run.
    await waitForReady(5_000, () => null);
    return async () => {};
  }
  stopStale();

  rmSync(RUN_DIR, { recursive: true, force: true });
  mkdirSync(STATE_DIR, { recursive: true });

  if (process.env.E2E_SKIP_BUILD !== "1" || !existsSync(join(ROOT, "dist", "public", "index.html"))) {
    run(join(BIN, "vite"), ["build", "--logLevel", "error"]);
  }

  // Throwaway secrets for this run only, in a git-ignored directory. No GEMINI_API_KEY: AI is off.
  writeFileSync(
    ENV_FILE,
    [
      `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64")}`,
      `INTERNAL_HMAC_KEYS={"e2e":"${randomBytes(32).toString("hex")}"}`,
      `APP_ORIGIN=${BASE_URL}`,
      "ENVIRONMENT=local",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );

  const wrangler = join(BIN, "wrangler");
  for (const db of ["novus-main", "novus-events"]) {
    run(wrangler, ["d1", "migrations", "apply", db, "--local", "--persist-to", STATE_DIR, "--config", WRANGLER_CONFIG]);
  }
  writeFileSync(SEED_FILE, run(join(BIN, "tsx"), ["server/db/seed/cli.ts", "sample", "--today", todayIso()]));
  run(wrangler, [
    "d1", "execute", "novus-main", "--local", "--persist-to", STATE_DIR, "--config", WRANGLER_CONFIG,
    "--file", SEED_FILE, "--yes",
  ]);

  const log = openSync(LOG_FILE, "a");
  const child = spawn(
    wrangler,
    [
      "dev", "--config", WRANGLER_CONFIG, "--persist-to", STATE_DIR, "--env-file", ENV_FILE,
      "--port", String(PORT), "--ip", "127.0.0.1", "--test-scheduled", "--show-interactive-dev-session=false",
      "--log-level", "info",
    ],
    {
      cwd: ROOT,
      detached: true, // own process group, so teardown also stops workerd
      stdio: ["ignore", log, log],
      env: { ...process.env, CI: "1", WRANGLER_SEND_METRICS: "false", NO_COLOR: "1", FORCE_COLOR: "0" },
    },
  );
  closeSync(log);
  child.unref();
  writeFileSync(PID_FILE, String(child.pid));
  let exitInfo: string | null = null;
  child.on("exit", (code, signal) => {
    exitInfo = `code ${code}, signal ${signal}`;
  });

  await waitForReady(90_000, () => exitInfo);

  // One scheduler tick builds release 1 from the SAMPLE programs (public data files, search).
  await fetch(`${BASE_URL}/__scheduled?cron=${encodeURIComponent("*/5 * * * *")}`).catch(() => undefined);

  return async () => {
    if (process.env.E2E_KEEP_SERVER === "1") return;
    try {
      if (child.pid) process.kill(-child.pid, "SIGTERM");
    } catch {
      /* already stopped */
    }
    rmSync(PID_FILE, { force: true });
  };
}
