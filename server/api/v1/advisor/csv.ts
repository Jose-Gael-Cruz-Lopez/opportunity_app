/**
 * CSV for advisor exports (RFC 4180, CRLF line ends). Spreadsheet apps run a cell that starts
 * with =, +, -, @, a tab or a carriage return as a formula, so such cells get a leading single
 * quote (plan 9.11.1). Program names and advisor notes are text other people typed, so every
 * cell is treated as untrusted.
 */

const FORMULA_START = /^[=+\-@\t\r]/;

export function neutralizeFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return "";
  const text = neutralizeFormula(String(value));
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function toCsv(header: readonly string[], rows: readonly (readonly (string | number | boolean | null | undefined)[])[]): string {
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n") + "\r\n";
}

/** A safe download file name: lowercase ASCII words joined by hyphens. */
export function exportFileName(base: string, suffix: string): string {
  const clean = base
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return `${clean || "export"}-${suffix}.csv`;
}
