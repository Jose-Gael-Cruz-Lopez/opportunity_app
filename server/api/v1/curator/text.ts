/**
 * Text helpers for the evidence view. Pure and deterministic.
 *
 * - `locateQuote`: where a verbatim quote sits in a Snapshot's stored text, tolerant only of
 *   whitespace and typographic quote/dash differences (never of different words).
 * - `highlightRanges`: every quote's range, for the side-by-side view.
 * - `lineDiff`: a small line diff between the baseline and the latest Snapshot ("changes first").
 * - `plainModelText`: model-written text rendered as plain text with links stripped (plan 4.10).
 */

export interface TextRange {
  start: number;
  end: number;
}

const FOLD: Readonly<Record<string, string>> = {
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
  "–": "-",
  "—": "-",
  " ": " ",
};

/**
 * Folds `text` into a comparable form and keeps, for every folded character, the index of the
 * original character it came from: runs of whitespace become one space.
 */
export function foldWithMap(text: string): { folded: string; map: number[] } {
  let folded = "";
  const map: number[] = [];
  let lastSpace = true;
  for (let i = 0; i < text.length; i++) {
    let ch = text[i]!;
    ch = FOLD[ch] ?? ch;
    if (/\s/.test(ch)) {
      if (lastSpace) continue;
      folded += " ";
      map.push(i);
      lastSpace = true;
      continue;
    }
    folded += ch.toLowerCase();
    map.push(i);
    lastSpace = false;
  }
  if (folded.endsWith(" ")) {
    folded = folded.slice(0, -1);
    map.pop();
  }
  return { folded, map };
}

/** Range of `quote` in `text` (original offsets, end exclusive), or null when it is not there. */
export function locateQuote(text: string, quote: string, from = 0): TextRange | null {
  const q = foldWithMap(quote).folded;
  if (q.length === 0) return null;
  const { folded, map } = foldWithMap(text);
  let startFolded = 0;
  if (from > 0) {
    startFolded = map.findIndex((orig) => orig >= from);
    if (startFolded < 0) return null;
  }
  const at = folded.indexOf(q, startFolded);
  if (at < 0) return null;
  return { start: map[at]!, end: map[at + q.length - 1]! + 1 };
}

export interface QuoteMark extends TextRange {
  /** Which quote: an evidence id or `proposal:{n}`. */
  ref: string;
  kind: "verified" | "proposed";
}

/**
 * Ranges of every quote found in `text`, sorted, overlaps kept (the client nests them).
 * Quotes not found are returned separately: "quote_missing" is itself a finding.
 */
export function highlightRanges(
  text: string,
  quotes: readonly { ref: string; quote: string; kind: QuoteMark["kind"] }[],
): { marks: QuoteMark[]; missing: string[] } {
  const marks: QuoteMark[] = [];
  const missing: string[] = [];
  for (const q of quotes) {
    const r = locateQuote(text, q.quote);
    if (r) marks.push({ ...r, ref: q.ref, kind: q.kind });
    else missing.push(q.ref);
  }
  marks.sort((a, b) => a.start - b.start || b.end - a.end);
  return { marks, missing };
}

export type DiffOp = { op: "same" | "add" | "del"; line: string };

/**
 * Line diff (LCS) of two texts. Long inputs are trimmed to `maxLines` each, so the cost stays
 * bounded inside a Worker request; `truncated` says so.
 */
export function lineDiff(before: string, after: string, maxLines = 400): { ops: DiffOp[]; truncated: boolean } {
  const split = (t: string) =>
    t
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l.length > 0);
  let a = split(before);
  let b = split(after);
  const truncated = a.length > maxLines || b.length > maxLines;
  a = a.slice(0, maxLines);
  b = b.slice(0, maxLines);
  const n = a.length;
  const m = b.length;
  const dp: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const ops: DiffOp[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ op: "same", line: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ op: "del", line: a[i]! });
      i++;
    } else {
      ops.push({ op: "add", line: b[j]! });
      j++;
    }
  }
  while (i < n) ops.push({ op: "del", line: a[i++]! });
  while (j < m) ops.push({ op: "add", line: b[j++]! });
  return { ops, truncated };
}

/** Only the changed lines with `context` unchanged lines around each, in order ("changes first"). */
export function changedHunks(ops: readonly DiffOp[], context = 1): DiffOp[] {
  const keep = new Set<number>();
  ops.forEach((o, idx) => {
    if (o.op === "same") return;
    for (let k = Math.max(0, idx - context); k <= Math.min(ops.length - 1, idx + context); k++) keep.add(k);
  });
  return ops.filter((_, idx) => keep.has(idx));
}

/**
 * Model-written text as plain text: Markdown links keep their label, bare URLs and HTML tags go,
 * and control characters are dropped. The console renders the result as text, never as HTML.
 */
export function plainModelText(value: unknown, max = 2000): string {
  if (typeof value !== "string") return "";
  return value
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/<[^>]*>/g, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "[link removed]")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .slice(0, max);
}

/** The host of a URL, lower-cased, or null. */
export function hostOf(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}
