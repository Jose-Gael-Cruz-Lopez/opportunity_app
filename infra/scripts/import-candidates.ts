/**
 * Loads a researcher's candidates file into the LOCAL D1 as unverified draft programs with
 * Curator ReviewTasks. Nothing is published.
 *
 *   npx tsx infra/scripts/import-candidates.ts --file <path> --local [--dry-run] [--sample] [--json]
 *
 * Steps: read and validate the file (JSON or CSV), read the local registry through
 * `wrangler d1 execute --local --json`, plan (de-duplication by normalized name, Organization and
 * official host), write the SQL to .wrangler/novus-import/ (gitignored), then apply it with
 * `wrangler d1 execute --local --file`. `--dry-run` stops before the last step.
 *
 * There is no remote mode: staging and production imports go through the Curator console upload
 * (POST /api/v1/curator/import), which signs the audit rows with the Curator's handle.
 *
 * Real program data lives outside this public repository (the curated registry is a business
 * asset). Point --file at it; never copy it into the repo. The logic lives in
 * server/api/v1/curator/import/ and is tested there; this file only does IO. See
 * docs/registry-import.md.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { renderPlanSql } from "../../server/api/v1/curator/import/apply";
import { existingCommand, existingFromWranglerJson, exitCodeOf, formatReport, parseCliArgs, USAGE } from "../../server/api/v1/curator/import/cli";
import { sha256Hex } from "../../server/api/v1/curator/import/normalize";
import { MAX_FILE_BYTES, parseCandidateFile } from "../../server/api/v1/curator/import/parse";
import { planImport } from "../../server/api/v1/curator/import/plan";
import { reportOf } from "../../server/api/v1/curator/import/service";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ACTOR = { kind: "system" as const, ref: "local-cli:import-candidates" };

/** Runs a command with arguments (no shell); throws on failure. */
function run(command: string, args: readonly string[], capture: boolean): string {
  const result = spawnSync(command, args, { cwd: ROOT, encoding: "utf8", stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit", maxBuffer: 256 * 1024 * 1024 });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} ${args.slice(0, 4).join(" ")} ... exited with ${result.status}`);
  return capture ? result.stdout : "";
}

async function main(): Promise<number> {
  const parsedArgs = parseCliArgs(process.argv.slice(2));
  if (!parsedArgs.ok) {
    if (parsedArgs.error !== "help") console.error(parsedArgs.error);
    console.error(USAGE);
    return parsedArgs.error === "help" ? 0 : 2;
  }
  const opts = parsedArgs.options;
  const file = resolve(process.cwd(), opts.file);
  if (statSync(file).size > MAX_FILE_BYTES) throw new Error("the file is larger than 2 MB; split it");
  const text = readFileSync(file, "utf8");

  const parsed = parseCandidateFile(text, { hint: opts.format ?? basename(file) });
  if (!parsed.ok) {
    console.error(parsed.error);
    return 1;
  }

  const d1 = ["wrangler", "d1", "execute", opts.database, "--local", "--config", opts.config, ...(opts.persistTo ? ["--persist-to", opts.persistTo] : [])];
  const existing = existingFromWranglerJson(run("npx", [...d1, "--json", "--command", existingCommand()], true));

  const plan = await planImport(parsed.rows, existing, { now: Date.now(), fileSha256: await sha256Hex(text), format: parsed.format, actor: ACTOR, sample: opts.sample });
  const report = reportOf(plan, opts.dryRun);

  // .wrangler/ is gitignored: the SQL holds program data and never lands in the public repo.
  const outDir = join(ROOT, ".wrangler", "novus-import");
  mkdirSync(outDir, { recursive: true });
  const sqlFile = join(outDir, `import-${plan.batchId}.sql`);
  writeFileSync(sqlFile, renderPlanSql(plan), "utf8");

  if (!opts.dryRun && plan.units.length + plan.organizations.length > 0) {
    // Captured so the report stays readable; wrangler's errors still reach stderr.
    run("npx", [...d1, "--file", sqlFile, "--yes"], true);
  }

  console.log(opts.json ? JSON.stringify(report, null, 2) : formatReport(report));
  console.error(`SQL: ${sqlFile}`);
  return exitCodeOf(report);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
