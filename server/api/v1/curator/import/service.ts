import { sql } from "drizzle-orm";
import type { Actor } from "../../../../../shared/contracts/ops";
import type { Db } from "../../../../db/client";
import { applyPlan } from "./apply";
import { loadExisting, type ExistingRegistry } from "./existing";
import { sha256Hex } from "./normalize";
import { parseCandidateFile } from "./parse";
import { planImport, summarize, type ImportPlan, type ImportSummary, type RowOutcome } from "./plan";

/**
 * One import, end to end: parse and validate the file, load the registry, plan, and (unless
 * `dryRun`) write. Used by the Curator route; the CLI does the same steps through wrangler.
 */

export interface ImportReport {
  batchId: string;
  dryRun: boolean;
  format: "json" | "csv";
  fileSha256: string;
  summary: ImportSummary;
  rows: RowOutcome[];
}

export type ImportResult = { ok: true; report: ImportReport } | { ok: false; error: string };

export function reportOf(plan: ImportPlan, dryRun: boolean): ImportReport {
  return { batchId: plan.batchId, dryRun, format: plan.format, fileSha256: plan.fileSha256, summary: summarize(plan), rows: plan.outcomes };
}

export async function loadExistingFromDb(db: Db): Promise<ExistingRegistry> {
  return loadExisting(async (query) => db.all<Record<string, unknown>>(sql.raw(query)));
}

export async function runImport(
  db: Db,
  text: string,
  opts: { hint?: string | null; maxRows?: number; actor: Actor; now: number; dryRun: boolean; sample?: boolean },
): Promise<ImportResult> {
  const parsed = parseCandidateFile(text, { hint: opts.hint, maxRows: opts.maxRows });
  if (!parsed.ok) return { ok: false, error: parsed.error };
  const existing = await loadExistingFromDb(db);
  const plan = await planImport(parsed.rows, existing, { now: opts.now, fileSha256: await sha256Hex(text), format: parsed.format, actor: opts.actor, sample: opts.sample });
  if (!opts.dryRun) await applyPlan(db, plan);
  return { ok: true, report: reportOf(plan, opts.dryRun) };
}
