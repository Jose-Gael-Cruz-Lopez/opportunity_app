/**
 * Sensitive-terms guard (privacy by construction). SensitiveAnswers never reach a table, an
 * event, a request schema or a log line. The vocabulary is the one in shared/ (isSensitiveKey),
 * so this guard cannot drift from the runtime checks. This scans artifacts the Drizzle schema
 * test does not see:
 *
 *   1. committed migration SQL (hand-edited migrations included): every column of every table;
 *   2. the generated JSON Schemas of the API contracts: every property name, at any depth;
 *   3. log templates in server/ and pipeline/: interpolated names inside log calls.
 *
 * Program-level registry flags that describe a program (not a person) are allowlisted.
 */
import { lineOf, type Finding } from "./files";

const CHECK = "sensitive-terms";

/** table.column pairs that describe programs or institutions, never a person. */
export const REGISTRY_COLUMN_ALLOWLIST: ReadonlySet<string> = new Set([
  "programs.sensitive_audience",
  "programs.identity_audience",
  "program_cycles.pell_displacement",
  "attribution_codes.identity_owned",
  "institutions.is_tribal",
  "institutions.is_hbcu",
  "institutions.is_hsi",
]);

/** JSON Schema property paths that are registry facts (program audience flags, rule bodies). */
export const SCHEMA_PROPERTY_ALLOWLIST: ReadonlySet<string> = new Set([
  "identityOwned",
  "isTribal",
  "isHbcu",
  "isHsi",
]);

export type IsSensitiveKey = (key: string) => boolean;

/** Extracts (table, column) pairs from CREATE TABLE and ALTER TABLE ... ADD COLUMN statements. */
export function columnsFromSql(sql: string): Array<{ table: string; column: string; index: number }> {
  const out: Array<{ table: string; column: string; index: number }> = [];
  const create = /CREATE TABLE\s+(?:IF NOT EXISTS\s+)?[`"]?(\w+)[`"]?\s*\(/gi;
  for (const m of sql.matchAll(create)) {
    const table = m[1] ?? "";
    const start = (m.index ?? 0) + m[0].length;
    let depth = 1;
    let i = start;
    while (i < sql.length && depth > 0) {
      if (sql[i] === "(") depth++;
      else if (sql[i] === ")") depth--;
      i++;
    }
    const body = sql.slice(start, i - 1);
    for (const part of splitTopLevel(body)) {
      const col = /^\s*[`"]?(\w+)[`"]?\s+/.exec(part);
      const name = col?.[1];
      if (!name || /^(CONSTRAINT|PRIMARY|FOREIGN|UNIQUE|CHECK)$/i.test(name)) continue;
      out.push({ table, column: name, index: start + body.indexOf(part) });
    }
  }
  const alter = /ALTER TABLE\s+[`"]?(\w+)[`"]?\s+ADD(?:\s+COLUMN)?\s+[`"]?(\w+)[`"]?/gi;
  for (const m of sql.matchAll(alter)) out.push({ table: m[1] ?? "", column: m[2] ?? "", index: m.index ?? 0 });
  return out;
}

function splitTopLevel(body: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let last = 0;
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"' || c === "`") quote = c;
    else if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(body.slice(last, i));
      last = i + 1;
    }
  }
  parts.push(body.slice(last));
  return parts;
}

export function checkMigrationSql(file: string, sql: string, isSensitive: IsSensitiveKey): Finding[] {
  return columnsFromSql(sql)
    .filter(({ table, column }) => isSensitive(column) && !REGISTRY_COLUMN_ALLOWLIST.has(`${table}.${column}`))
    .map(({ table, column, index }) => ({
      check: CHECK,
      file,
      line: lineOf(sql, index),
      message: `column ${table}.${column} looks like a status or identity answer`,
    }));
}

/** Walks a JSON Schema and reports property names that look sensitive. */
export function checkJsonSchema(file: string, schema: unknown, isSensitive: IsSensitiveKey): Finding[] {
  const findings: Finding[] = [];
  const visit = (node: unknown, path: string): void => {
    if (node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((n, i) => visit(n, `${path}[${i}]`));
      return;
    }
    const record = node as Record<string, unknown>;
    const props = record.properties;
    if (props && typeof props === "object" && !Array.isArray(props)) {
      for (const key of Object.keys(props)) {
        if (isSensitive(key) && !SCHEMA_PROPERTY_ALLOWLIST.has(key)) {
          findings.push({ check: CHECK, file, message: `schema property ${path}.properties.${key} looks like a status or identity answer` });
        }
      }
    }
    for (const [k, v] of Object.entries(record)) visit(v, `${path}.${k}`);
  };
  visit(schema, "$");
  return findings;
}

const LOG_CALL = /\b(?:console\.(?:log|info|warn|error|debug)|logger\.\w+|log\.(?:info|warn|error|debug)|logging\.\w+)\s*\(/g;

/**
 * Flags identifiers interpolated into log calls (`${x.citizenship}`, `{income}`, `%s` args named
 * like a status) within the call's first line. Heuristic by design: it catches the common slip,
 * and the runtime redaction in server/ai and the analytics guard catch the rest.
 */
export function checkLogTemplates(file: string, source: string, isSensitive: IsSensitiveKey): Finding[] {
  const findings: Finding[] = [];
  for (const m of source.matchAll(LOG_CALL)) {
    const start = m.index ?? 0;
    const end = source.indexOf("\n", start);
    const line = codeOnly(source.slice(start, end < 0 ? undefined : end));
    for (const ident of line.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const name = ident[0];
      if (isSensitive(name)) {
        findings.push({ check: CHECK, file, line: lineOf(source, start), message: `log call mentions "${name}"` });
      }
    }
  }
  return findings;
}

/**
 * Drops string-literal text but keeps interpolations (`${...}` in JS templates, `{...}` in Python
 * f-strings), so fixed message codes such as "internal_key_disabled" are not mistaken for data
 * while `${profile.income}` still is.
 */
export function codeOnly(line: string): string {
  return line.replace(/(\bf)?(["'`])((?:\\.|(?!\2).)*)\2/g, (_all, fPrefix: string | undefined, quote: string, body: string) => {
    if (quote === "`") return ` ${[...body.matchAll(/\$\{([^}]*)\}/g)].map((x) => x[1]).join(" ")} `;
    if (fPrefix) return ` ${[...body.matchAll(/\{([^}]*)\}/g)].map((x) => x[1]).join(" ")} `;
    return " ";
  });
}
