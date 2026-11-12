import type { z } from "zod";

/**
 * Post-call checks. Gemini returns syntactically valid JSON, but values are not guaranteed and
 * length or uniqueness keywords are ignored, so every output goes through:
 *   1. JSON.parse + zod (shape),
 *   2. route checks: cited ids exist, quotes and excerpts are verbatim, dates appear in sources,
 *   3. the no-number-about-the-student rule (rule 4),
 *   4. clamping to the contract's length limits.
 * A failure is retried once with the issues appended, then the deterministic fallback is used.
 */

export type ParseOutcome<T> = { ok: true; value: T } | { ok: false; issues: string[] };

export function parseModelJson<T>(text: string, schema: z.ZodType<T>): ParseOutcome<T> {
  let raw: unknown;
  try {
    raw = JSON.parse(stripCodeFence(text));
  } catch {
    return { ok: false, issues: ["output is not valid JSON"] };
  }
  const parsed = schema.safeParse(raw);
  if (parsed.success) return { ok: true, value: parsed.data };
  const issues = parsed.error.issues.slice(0, 8).map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`);
  return { ok: false, issues };
}

/** Some models wrap JSON in a ```json fence despite the mime type; tolerate exactly that. */
function stripCodeFence(text: string): string {
  const m = /^\s*```(?:json)?\s*([\s\S]*?)\s*```\s*$/i.exec(text);
  return m?.[1] ?? text;
}

// ---------------------------------------------------------------------------------------------
// Text normalisation and verbatim checks
// ---------------------------------------------------------------------------------------------

/** NFKC, lowercase, straight quotes, plain dashes, no zero-width characters, collapsed spaces. */
export function normalizeForMatch(s: string): string {
  return s
    .normalize("NFKC")
    .replace(/[​-‍﻿]/g, "")
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/** True when `quote` occurs in `source` after normalisation. Empty quotes never match. */
export function isVerbatim(quote: string, source: string): boolean {
  const q = normalizeForMatch(quote);
  if (q.length === 0) return false;
  return normalizeForMatch(source).includes(q);
}

// ---------------------------------------------------------------------------------------------
// Rule 4: no score, percentage or chance about the student
// ---------------------------------------------------------------------------------------------

const PERCENT_RE = /\d\s*(?:%|percent\b|per cent\b)/i;
const OUT_OF_RE = /\b\d+(?:\.\d+)?\s*(?:\/|out of)\s*(?:5|10|100)\b/i;
const CHANCE_WORD_RE = /\b(?:chances?|odds|likelihood|likely|probability|probable)\b/i;
const NUMBER_RE = /\d|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|half|quarter)\b/i;
const SCORE_WORD_RE = /\b(?:score|rating|rated|grade[ds]?|match(?:es)?)\b[^.]{0,20}\d/i;
// Case-sensitive on the letter so the article "a" is not read as a grade.
const GRADE_GIVE_RE = /\b(?:[Ii](?:'d| would)? give|[Dd]eserves?|[Ee]arns?)\b[^.]{0,30}\s[A-F][+-]?(?![\w])/;
const YOU_RE = /\b(?:you|your|you're|yours)\b/i;

export interface ScoreClaimOptions {
  /** Readiness and statement feedback ban percentages outright; Ask may report official rates. */
  readonly banAllPercent: boolean;
}

/** Sentences in `text` that state a number-shaped judgement. Empty means clean. */
export function findScoreClaims(text: string, opts: ScoreClaimOptions): string[] {
  const found: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+|\n+/)) {
    const s = sentence.trim();
    if (!s) continue;
    const aboutYou = YOU_RE.test(s);
    if (PERCENT_RE.test(s) && (opts.banAllPercent || aboutYou)) found.push("percentage");
    else if (OUT_OF_RE.test(s)) found.push("out_of_scale");
    else if (CHANCE_WORD_RE.test(s) && NUMBER_RE.test(s)) found.push("chance_with_number");
    else if (SCORE_WORD_RE.test(s)) found.push("score_with_number");
    else if (GRADE_GIVE_RE.test(s)) found.push("letter_grade");
  }
  return found;
}

// ---------------------------------------------------------------------------------------------
// Dates: the model may restate a date only if a source states it (deterministic code owns dates)
// ---------------------------------------------------------------------------------------------

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const ISO_RE = /\b(\d{4})-(\d{2})-(\d{2})\b/g;
// Full month names or their exact abbreviations, so "separate 2" is not read as Sep 2.
const MONTH_NAME =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";
const MONTH_DAY_RE = new RegExp(`\\b${MONTH_NAME}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b`, "gi");
const DAY_MONTH_RE = new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_NAME}\\b`, "gi");

function monthIndex(name: string): number {
  return MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
}

/** Month-day pairs ("1-15") mentioned in text, in ISO or written form. */
export function monthDays(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(ISO_RE)) out.add(`${Number(m[2])}-${Number(m[3])}`);
  for (const m of text.matchAll(MONTH_DAY_RE)) out.add(`${monthIndex(m[1] ?? "")}-${Number(m[2])}`);
  for (const m of text.matchAll(DAY_MONTH_RE)) out.add(`${monthIndex(m[2] ?? "")}-${Number(m[1])}`);
  return out;
}

/** Dates in `text` that no source mentions. */
export function unsupportedDates(text: string, sourceText: string): string[] {
  const known = monthDays(sourceText);
  return [...monthDays(text)].filter((d) => !known.has(d));
}

// ---------------------------------------------------------------------------------------------
// Clamping (the API ignores maxLength, so the contract's limits are applied here)
// ---------------------------------------------------------------------------------------------

/** Cuts at a word boundary and adds an ellipsis when text exceeds `max` characters. */
export function clampText(text: string, max: number): string {
  const t = text.trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, Math.max(0, max - 1));
  const space = cut.lastIndexOf(" ");
  return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

export function uniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)];
}

/** Strips links and markup from model-written free text that may be shown or stored. */
export function stripLinksAndMarkup(text: string): string {
  return text
    .replace(/<[^>]{0,200}>/g, "")
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}
