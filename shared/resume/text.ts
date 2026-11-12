/**
 * Small text helpers shared by every step. Pure, dependency-free and safe in a Worker.
 */

// Character classes are written as escapes: literal invisible characters in source are hard to
// review, and a literal U+2028 inside a regex literal is a syntax error.
/** Private-use glyphs: Wingdings and Symbol bullets that PDFs emit. */
const PUA_RUN = /[\uE000-\uF8FF]+/g;
const LEADING_PUA = /^([ \t]*)[\uE000-\uF8FF]+[ \t]*/gm;
/** Soft hyphen, zero-width space and joiners, word joiner, byte-order mark. */
const INVISIBLE = /[\u00AD\u200B-\u200D\u2060\uFEFF]/g;
/** No-break, fixed-width and ideographic spaces. */
const ODD_SPACES = /[\u00A0\u1680\u2000-\u200A\u202F\u205F\u3000]/g;
/** Hyphen, figure dash, en and em dashes, horizontal bar, minus sign, small and fullwidth hyphens. */
const DASHES = /[\u2010-\u2015\u2212\uFE58\uFE63\uFF0D]/g;
const SINGLE_QUOTES = /[\u2018\u2019\u201A\u201B\u2032]/g;
const DOUBLE_QUOTES = /[\u201C\u201D\u201E\u201F\u2033]/g;
/** Line endings: CRLF, CR, line and paragraph separators, next-line, form feed, vertical tab. */
const LINE_BREAKS = /\r\n?|[\u2028\u2029\u0085\f\v]/g;
const CONTROL = /[\u0000-\u0008\u000E-\u001F\u007F]/g;

/**
 * Normalizes resume text so later regexes see one spelling of each character:
 * NFKC (ligatures such as "ﬁ" expand), private-use glyphs (Wingdings bullets) become "•" at
 * the start of a line and disappear elsewhere, soft hyphens and zero-width marks go, odd
 * spaces become spaces, the dash family becomes "-" (so "Jun 2024 – Aug 2024" is one range
 * pattern) and curly quotes become straight ones ("’25" reads as "'25").
 */
export function normalizeText(input: string): string {
  return input
    .normalize("NFKC")
    .replace(LINE_BREAKS, "\n")
    .replace(LEADING_PUA, "$1• ")
    .replace(PUA_RUN, "")
    .replace(INVISIBLE, "")
    .replace(ODD_SPACES, " ")
    .replace(DASHES, "-")
    .replace(SINGLE_QUOTES, "'")
    .replace(DOUBLE_QUOTES, '"')
    .replace(CONTROL, "");
}

/** Collapses runs of spaces and trims; tabs become spaces too. */
export function squash(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

// -------------------------------------------------------------------------------------------
// Bullets
// -------------------------------------------------------------------------------------------

/**
 * A leading list marker: a bullet glyph, "-" or "*" before text, "o" before a capital (Word's
 * sub-bullet when pasted), or "1." / "1)" before a letter. "3.8 GPA" and "-5%" are not bullets.
 */
const BULLET = /^\s*(?:[•◦▪▫●○■□►▶▸➢➤➣✓✔✗✘⁃∙·‣⦿⦾]\s*|[-*]\s+(?=\S)|[-*](?=[\p{L}"'(\[])|o\s+(?=\p{Lu})|\(?\d{1,2}[.)]\s+(?=\p{L}))/u;

export function isBulletLine(line: string): boolean {
  return BULLET.test(line);
}

export function stripBullet(line: string): string {
  return line.replace(BULLET, "").trim();
}

// -------------------------------------------------------------------------------------------
// Cells
// -------------------------------------------------------------------------------------------

/**
 * Separators between cells of one visual line: tabs (positioned segments are joined with a
 * tab), three or more spaces, "|", a spaced "-", and mid-line bullets. Commas are not cell
 * separators; field extractors split on them only where it is safe.
 */
const CELL_SEPARATOR = /\t+| {3,}|\s*\|\s*|\s+-{1,2}\s+|\s+[•·∙◦▪]\s+/g;

/**
 * Splits a line into cells, leaving separators that fall inside `protect` spans alone (a date
 * range such as "Jun 2024 - Aug 2024" must not be cut at its dash).
 */
export function splitCells(line: string, protect: ReadonlyArray<readonly [number, number]> = []): string[] {
  const cells: string[] = [];
  let last = 0;
  for (const m of line.matchAll(CELL_SEPARATOR)) {
    const start = m.index ?? 0;
    const end = start + m[0].length;
    if (protect.some(([a, b]) => start < b && end > a)) continue;
    cells.push(line.slice(last, start));
    last = end;
  }
  cells.push(line.slice(last));
  return cells.map((c) => c.trim()).filter((c) => c.length > 0);
}

/**
 * Splits a list ("Python, Java; SQL • Git") on commas, semicolons, pipes, bullets and tabs,
 * but never inside parentheses or brackets, so "Dean's List (Fall 2025, Spring 2026)" stays
 * one item.
 */
export function splitList(text: string, separators: RegExp = /[,;|•·∙\t]/): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of text) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    if ((ch === ")" || ch === "]" || ch === "}") && depth > 0) depth--;
    if (depth === 0 && separators.test(ch)) {
      out.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  out.push(current);
  return out.map((s) => s.trim()).filter((s) => s.length > 0);
}

// -------------------------------------------------------------------------------------------
// Case and matching
// -------------------------------------------------------------------------------------------

/** Two or more uppercase letters and no lowercase letter. Caseless scripts never count. */
export function isAllCaps(s: string): boolean {
  const upper = s.match(/\p{Lu}/gu)?.length ?? 0;
  return upper >= 2 && !/\p{Ll}/u.test(s);
}

export function wordCount(s: string): number {
  return s.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length;
}

/**
 * Lowercases and strips diacritics one UTF-16 unit at a time, so the result has exactly the
 * same length as the input and match offsets map straight back ("José" -> "jose").
 */
export function foldForMatch(s: string): string {
  let out = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i] as string;
    const base = ch.normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    const one = base.length === 1 ? base : ch;
    const lower = one.toLowerCase();
    out += lower.length === 1 ? lower : one;
  }
  return out;
}

/** Lowercase, diacritics folded, "&" read as "and", punctuation dropped, spaces collapsed. */
export function normalizeKey(s: string): string {
  return foldForMatch(s)
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}+#]+/gu, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Optimal string alignment distance (Damerau-Levenshtein with adjacent transpositions), used
 * to accept "Experiance" for "Experience" in headings.
 */
export function editDistance(a: string, b: string): number {
  const m = a.length;
  const n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const d: number[][] = [];
  for (let i = 0; i <= m; i++) {
    d.push(new Array<number>(n + 1).fill(0));
    d[i]![0] = i;
  }
  for (let j = 0; j <= n; j++) d[0]![j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) v = Math.min(v, d[i - 2]![j - 2]! + 1);
      d[i]![j] = v;
    }
  }
  return d[m]![n]!;
}

export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Lowercase slug for ids: "Node.js" -> "node-js", "C++" -> "c-plus-plus", "C#" -> "c-sharp". */
export function slugify(s: string): string {
  return foldForMatch(s)
    .replace(/\+\+/g, "-plus-plus")
    .replace(/#/g, "-sharp")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/** Removes leading and trailing separators and punctuation that cells pick up. */
export function trimPunctuation(s: string): string {
  return s.replace(/^[\s,;:|/\\\-–—•·*]+/, "").replace(/[\s,;:|/\\\-–—•·*]+$/, "").trim();
}

/** Median of a list, or null when it is empty. */
export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? (sorted[mid] as number) : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

/** Order-preserving dedupe by a key. */
export function uniqueBy<T>(items: readonly T[], key: (item: T) => string): T[] {
  const seen = new Set<string>();
  const out: T[] = [];
  for (const item of items) {
    const k = key(item);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(item);
  }
  return out;
}
