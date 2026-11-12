/**
 * Turns parameterised queries into self-contained SQL text, for seed files applied with
 * `wrangler d1 execute --file` (which takes no bind parameters). Only used for trusted,
 * repository-authored seed data; request handlers always bind parameters.
 */

export type SqlValue = string | number | bigint | boolean | null | undefined | Uint8Array;

export function sqlLiteral(value: SqlValue): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "boolean") return value ? "1" : "0";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error(`cannot inline non-finite number ${value}`);
    return String(value);
  }
  if (typeof value === "bigint") return value.toString();
  if (value instanceof Uint8Array) {
    return `X'${Array.from(value, (b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  return `'${value.replace(/'/g, "''")}'`;
}

/**
 * Replaces each `?` placeholder outside quoted strings and identifiers with its literal.
 * Throws when the placeholder count and the parameter count differ.
 */
export function inlineParams(sql: string, params: readonly unknown[]): string {
  let out = "";
  let next = 0;
  let quote: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i] as string;
    if (quote) {
      out += ch;
      if (ch === quote) {
        // A doubled quote is an escaped quote inside the same literal.
        if (sql[i + 1] === quote) {
          out += quote;
          i++;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (ch === "'" || ch === '"' || ch === "`") {
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "?") {
      if (next >= params.length) throw new Error("more placeholders than parameters");
      out += sqlLiteral(params[next++] as SqlValue);
      continue;
    }
    out += ch;
  }
  if (quote) throw new Error("unterminated quoted string in SQL");
  if (next !== params.length) throw new Error(`unused parameters: ${params.length - next}`);
  return out;
}

export interface BuiltQuery {
  sql: string;
  params: readonly unknown[];
}

/** One statement per line, each ending with `;`. */
export function renderStatements(queries: readonly BuiltQuery[]): string {
  return queries.map((q) => `${inlineParams(q.sql, q.params).trim().replace(/;$/, "")};`).join("\n") + "\n";
}

/** Splits rows into chunks so no statement passes D1's 100 KB / 100-parameter limits. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  if (size < 1) throw new Error("chunk size must be positive");
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
