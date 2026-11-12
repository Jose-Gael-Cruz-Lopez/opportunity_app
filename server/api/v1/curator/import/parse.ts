import type { z } from "zod";
import { CsvError, parseCsv } from "./csv";
import { CandidateSchema, fromFlatColumns, normalizeKeys, type Candidate } from "./schema";

/**
 * Reads a candidates file (JSON or CSV) into validated rows. One bad row never sinks the file:
 * each row is validated on its own and reported by its row number (the array position for JSON,
 * the line for CSV). Error messages are fixed strings or schema-authored text; no submitted value
 * is echoed back, so the report is safe to log by code and to show in the console.
 */

export type CandidateFormat = "json" | "csv";

export interface RowIssue {
  path: string;
  message: string;
}

export type ParsedRow =
  | { row: number; ok: true; candidate: Candidate; ignored: string[] }
  | { row: number; ok: false; errors: RowIssue[]; ignored: string[] };

export type ParseResult =
  | { ok: true; format: CandidateFormat; rows: ParsedRow[] }
  | { ok: false; format: CandidateFormat | null; error: string };

/** Hard limits for one file. The route lowers `maxRows` (see routes.ts). */
export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_ROWS = 2000;

const FIXED: Record<string, string> = {
  invalid_type: "Wrong type",
  invalid_enum_value: "Not an allowed value",
  invalid_string: "Invalid format",
  too_small: "Too small or too short",
  too_big: "Too large or too long",
  invalid_union: "Does not match any allowed shape",
};

export function issuesOf(error: z.ZodError, max = 20): RowIssue[] {
  return error.issues.slice(0, max).map((i) => ({
    path: i.path.map(String).join(".").slice(0, 120) || "(row)",
    // `required` reads better than "Wrong type" for a missing column.
    message: (i.code === "invalid_type" && i.received === "undefined" ? "Required" : i.code === "custom" ? i.message : (FIXED[i.code] ?? i.message)).slice(0, 200),
  }));
}

/** Format from a file name or content type, else from the first character. */
export function detectFormat(text: string, hint?: string | null): CandidateFormat {
  const h = (hint ?? "").toLowerCase();
  if (h.endsWith(".json") || h.includes("json")) return "json";
  if (h.endsWith(".csv") || h.includes("csv")) return "csv";
  const first = text.replace(/^\ufeff/, "").trimStart()[0];
  return first === "[" || first === "{" ? "json" : "csv";
}

/** File-level defaults a JSON wrapper object may give: `{ researcher, checkedOn, candidates: [...] }`. */
const DEFAULT_KEYS = ["researcher", "checkedOn"] as const;

/** `organization: { name, kind, url, country }` becomes the flat organization columns. */
function flattenOrganization(record: Record<string, unknown>): Record<string, unknown> {
  const org = record.organization;
  if (org === null || typeof org !== "object" || Array.isArray(org)) return record;
  const { record: o } = normalizeKeys(org as Record<string, unknown>, { type: "kind", website: "url", websiteUrl: "url" }, null);
  const out: Record<string, unknown> = { ...record, organization: o.name };
  if (out.organizationKind === undefined && o.kind !== undefined) out.organizationKind = o.kind;
  if (out.organizationUrl === undefined && o.url !== undefined) out.organizationUrl = o.url;
  if (out.organizationCountry === undefined && o.country !== undefined) out.organizationCountry = o.country;
  return out;
}

function validateRow(row: number, raw: unknown, defaults: Record<string, unknown>): ParsedRow {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return { row, ok: false, errors: [{ path: "(row)", message: "Each candidate must be an object" }], ignored: [] };
  }
  const { record, ignored } = normalizeKeys(raw as Record<string, unknown>);
  const merged = { ...defaults, ...fromFlatColumns(flattenOrganization(record)) };
  const parsed = CandidateSchema.safeParse(merged);
  if (!parsed.success) return { row, ok: false, errors: issuesOf(parsed.error), ignored };
  return { row, ok: true, candidate: parsed.data as Candidate, ignored };
}

function parseJson(text: string, maxRows: number): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(text.replace(/^\ufeff/, ""));
  } catch {
    return { ok: false, format: "json", error: "The file is not valid JSON." };
  }
  let list: unknown;
  const defaults: Record<string, unknown> = {};
  if (Array.isArray(data)) list = data;
  else if (data !== null && typeof data === "object") {
    const { record } = normalizeKeys(data as Record<string, unknown>, {}, null);
    list = record.candidates ?? record.programs ?? record.rows;
    for (const k of DEFAULT_KEYS) if (record[k] !== undefined) defaults[k] = record[k];
  }
  if (!Array.isArray(list)) return { ok: false, format: "json", error: "Expected an array of candidates, or an object with a `candidates` array." };
  if (list.length === 0) return { ok: false, format: "json", error: "The file has no candidates." };
  if (list.length > maxRows) return { ok: false, format: "json", error: `The file has ${list.length} candidates; the limit is ${maxRows}. Split it.` };
  return { ok: true, format: "json", rows: list.map((raw, i) => validateRow(i + 1, raw, defaults)) };
}

function parseCsvFile(text: string, maxRows: number): ParseResult {
  let table;
  try {
    table = parseCsv(text, maxRows);
  } catch (err) {
    if (err instanceof CsvError) return { ok: false, format: "csv", error: `CSV error on line ${err.line}: ${err.message}.` };
    throw err;
  }
  if (table.header.length === 0) return { ok: false, format: "csv", error: "The file is empty." };
  if (table.rows.length === 0) return { ok: false, format: "csv", error: "The file has a header but no candidates." };
  if (table.rows.length > maxRows) return { ok: false, format: "csv", error: `The file has ${table.rows.length} candidates; the limit is ${maxRows}. Split it.` };
  const rows = table.rows.map(({ line, cells }) => {
    if (cells.length > table.header.length && cells.slice(table.header.length).some((c) => c.trim() !== "")) {
      return { row: line, ok: false as const, errors: [{ path: "(row)", message: "More cells than header columns" }], ignored: [] };
    }
    const raw: Record<string, unknown> = {};
    table.header.forEach((h, i) => {
      if (h) raw[h] = cells[i] ?? "";
    });
    return validateRow(line, raw, {});
  });
  return { ok: true, format: "csv", rows };
}

export function parseCandidateFile(text: string, opts: { hint?: string | null; maxRows?: number } = {}): ParseResult {
  const format = detectFormat(text, opts.hint);
  if (new TextEncoder().encode(text).byteLength > MAX_FILE_BYTES) return { ok: false, format, error: `The file is larger than ${MAX_FILE_BYTES / 1024 / 1024} MB. Split it.` };
  const maxRows = Math.min(opts.maxRows ?? MAX_ROWS, MAX_ROWS);
  return format === "json" ? parseJson(text, maxRows) : parseCsvFile(text, maxRows);
}
