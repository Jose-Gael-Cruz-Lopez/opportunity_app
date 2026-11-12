import { EXISTING_QUERIES, existingFromRows, type ExistingQueryName, type ExistingRegistry, type RowsByQuery } from "./existing";
import type { ImportReport } from "./service";

/**
 * Pure helpers for infra/scripts/import-candidates.ts (the local CLI): argument parsing, the
 * wrangler read query and its JSON output, and the printed report. The script itself only does
 * file and process IO, so everything here is unit-tested.
 */

export interface CliOptions {
  file: string;
  local: boolean;
  dryRun: boolean;
  sample: boolean;
  json: boolean;
  format: "json" | "csv" | null;
  config: string;
  database: string;
  persistTo: string | null;
}

export const USAGE = [
  "usage: npx tsx infra/scripts/import-candidates.ts --file <path> --local [options]",
  "",
  "  --file PATH        candidates file (.json or .csv)",
  "  --local            required: write to the LOCAL D1 (there is no remote mode)",
  "  --dry-run          plan and write the SQL file, print the report, change nothing",
  "  --sample           mark every row is_sample = 1 (invented development data)",
  "  --format json|csv  override detection by extension and content",
  "  --json             print the report as JSON",
  "  --config PATH      wrangler config (default infra/wrangler/wrangler.toml)",
  "  --database NAME    D1 database name (default novus-main)",
  "  --persist-to DIR   wrangler local state directory (default: wrangler's own)",
].join("\n");

export function parseCliArgs(argv: readonly string[]): { ok: true; options: CliOptions } | { ok: false; error: string } {
  const flags = new Set(["--local", "--dry-run", "--sample", "--json", "--help", "-h"]);
  const valued = new Set(["--file", "--format", "--config", "--database", "--persist-to"]);
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    const [name, inline] = a.includes("=") ? [a.slice(0, a.indexOf("=")), a.slice(a.indexOf("=") + 1)] : [a, undefined];
    if (flags.has(name) && inline === undefined) {
      seen.add(name);
      continue;
    }
    if (valued.has(name)) {
      const v = inline ?? argv[i + 1];
      if (v === undefined || (inline === undefined && v.startsWith("--"))) return { ok: false, error: `${name} needs a value` };
      if (inline === undefined) i++;
      values[name] = v;
      continue;
    }
    return { ok: false, error: `unknown argument: ${a.slice(0, 40)}` };
  }
  if (seen.has("--help") || seen.has("-h")) return { ok: false, error: "help" };
  if (!values["--file"]) return { ok: false, error: "--file is required" };
  if (!seen.has("--local")) return { ok: false, error: "--local is required: this CLI only writes to the local D1 (use the Curator console upload for staging and production)" };
  const format = values["--format"] ?? null;
  if (format !== null && format !== "json" && format !== "csv") return { ok: false, error: "--format must be json or csv" };
  const database = values["--database"] ?? "novus-main";
  if (!/^[a-z0-9-]+$/.test(database)) return { ok: false, error: "--database must be a plain D1 name" };
  return {
    ok: true,
    options: {
      file: values["--file"],
      local: true,
      dryRun: seen.has("--dry-run"),
      sample: seen.has("--sample"),
      json: seen.has("--json"),
      format,
      config: values["--config"] ?? "infra/wrangler/wrangler.toml",
      database,
      persistTo: values["--persist-to"] ?? null,
    },
  };
}

const QUERY_ORDER = Object.keys(EXISTING_QUERIES) as ExistingQueryName[];

/** All read queries as one `--command` (wrangler returns one result per statement, in order). */
export function existingCommand(): string {
  return QUERY_ORDER.map((n) => EXISTING_QUERIES[n]).join("; ");
}

/** `wrangler d1 execute --json` prints an array of `{ results, success, meta }`, one per statement. */
export function existingFromWranglerJson(stdout: string): ExistingRegistry {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("wrangler printed no JSON");
  const data = JSON.parse(stdout.slice(start)) as unknown;
  if (!Array.isArray(data) || data.length !== QUERY_ORDER.length) throw new Error(`expected ${QUERY_ORDER.length} result sets from wrangler`);
  const rows = Object.fromEntries(
    QUERY_ORDER.map((n, i) => {
      const r = data[i] as { results?: unknown; success?: unknown };
      if (r.success === false || !Array.isArray(r.results)) throw new Error(`wrangler query ${n} failed`);
      return [n, r.results as Record<string, unknown>[]];
    }),
  ) as unknown as RowsByQuery;
  return existingFromRows(rows);
}

/** Human-readable report: one line per row that needs attention, then the totals. */
export function formatReport(report: ImportReport): string {
  const lines: string[] = [];
  for (const r of report.rows) {
    const label = r.name ? ` ${r.name}` : "";
    if (r.status === "created") {
      const dup = r.possibleDuplicates?.length ? ` (possible duplicate of ${r.possibleDuplicates.map((d) => d.slug).join(", ")})` : "";
      lines.push(`row ${r.row}: created draft ${r.slug}${dup}`);
    } else if (r.status === "duplicate" || r.status === "already_imported") {
      lines.push(`row ${r.row}: skipped, ${r.status.replace("_", " ")}${r.slug ? ` (${r.slug})` : ""}${label ? ` -${label}` : ""}`);
    } else if (r.status === "duplicate_in_file") {
      lines.push(`row ${r.row}: skipped, duplicate of an earlier row${label ? ` -${label}` : ""}`);
    } else {
      lines.push(`row ${r.row}: ${r.status}${label ? ` -${label}` : ""}`);
      for (const e of r.errors ?? []) lines.push(`    ${e.path}: ${e.message}`);
    }
    for (const w of r.warnings ?? []) lines.push(`    note: ${w}`);
  }
  const s = report.summary;
  lines.push("");
  lines.push(
    `${report.dryRun ? "DRY RUN, nothing written. " : ""}${s.rows} rows: ${s.created} created as drafts, ${s.duplicates} duplicates, ${s.alreadyImported} already imported, ${s.invalid} invalid, ${s.rejected} rejected, ${s.failed} failed.`,
  );
  lines.push(`${s.newOrganizations} new Organizations, ${s.reviewTasks} review tasks (${s.possibleDuplicates} possible duplicates). Nothing is published until a Curator publishes it.`);
  return lines.join("\n");
}

/** Exit code: 0 when every row was created or skipped as a duplicate, 1 when any row was invalid, rejected or failed. */
export function exitCodeOf(report: ImportReport): number {
  const s = report.summary;
  return s.invalid + s.rejected + s.failed > 0 ? 1 : 0;
}
