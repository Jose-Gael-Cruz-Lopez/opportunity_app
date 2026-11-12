import { SENSITIVE_RULES, type SensitiveRule } from "./lexicon/sensitive-rules";
import type { SensitiveHit } from "./types";

/**
 * Detects statements that may reveal a SensitiveAnswers category (citizenship or immigration
 * status, income, disability, race or ethnicity, gender, sexual orientation, religion,
 * first-generation, veteran, foster care, health, and the taxonomy's tribal, parenting and
 * crime-victim categories).
 *
 * Runs on the device before anything leaves, and again on the server over the text the
 * student approved. Hits carry their category for on-device use only; nothing that crosses
 * the network may name it.
 */

/**
 * The one reason shown for every sensitive removal. It names no category, so the preview cannot
 * reveal which rule fired either.
 */
export const SENSITIVE_REASON =
  "This line may share something personal about you or your background. Novus never sends that to AI; it stays on this device.";

/** Context that turns a health or disability term into a topic rather than a disclosure. */
const RESEARCH_CONTEXT = /\b(?:research(?:ed|ing)?|stud(?:y|ies|ied|ying)|lab(?:oratory)?|projects?|analy[sz](?:is|ed|ing|e)|datasets?|data\s+on|papers?|thesis|literature|surveys?|clinical|trials?|investigat\w*|model(?:ed|ing|s)?|patients?|course|class|seminar|app|tool|platform|awareness|screening)\b/i;

const WINDOW_TOKENS = 8;

interface CompiledRule {
  rule: SensitiveRule;
  global: RegExp;
  excludes: readonly RegExp[];
}

const COMPILED: readonly CompiledRule[] = SENSITIVE_RULES.map((rule) => ({
  rule,
  global: toGlobal(rule.pattern),
  excludes: (rule.excludes ?? []).map(toGlobal),
}));

function toGlobal(re: RegExp): RegExp {
  return new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
}

/** The text within `n` tokens of a span, on the same line. */
export function contextWindow(line: string, start: number, end: number, n = WINDOW_TOKENS): string {
  const tokens = [...line.matchAll(/\S+/g)].map((m) => ({ start: m.index ?? 0, end: (m.index ?? 0) + m[0].length }));
  let first = tokens.findIndex((t) => t.end > start);
  if (first < 0) first = tokens.length - 1;
  let last = first;
  for (let i = first; i < tokens.length && (tokens[i] as { start: number }).start < end; i++) last = i;
  const from = tokens[Math.max(0, first - n)];
  const to = tokens[Math.min(tokens.length - 1, last + n)];
  return from && to ? line.slice(from.start, to.end) : line;
}

function overlapsAny(patterns: readonly RegExp[], line: string, start: number, end: number): boolean {
  for (const re of patterns) {
    re.lastIndex = 0;
    for (const m of line.matchAll(re)) {
      const a = m.index ?? 0;
      if (a < end && a + m[0].length > start) return true;
    }
  }
  return false;
}

/**
 * The same line with ALL-CAPS words in Title Case, one character for one character so offsets
 * still line up. Organization names are often set in caps ("BLACK STUDENT UNION", "U.S. ARMY"),
 * and the rules that must be case-sensitive ("Black", "Army", "Navy") would otherwise miss them.
 * Acronym rules ("DACA", "TRIO") still read the original line.
 */
export function titleCaseCaps(line: string): string | null {
  if (!/\p{Lu}{3,}/u.test(line)) return null;
  const out = line.replace(/(?<![\p{L}])(\p{Lu})(\p{Lu}+)(?![\p{L}])/gu, (_, first: string, rest: string) => {
    let lower = "";
    for (const ch of rest) {
      const l = ch.toLowerCase();
      lower += l.length === ch.length ? l : ch;
    }
    return first + lower;
  });
  return out === line ? null : out;
}

function scanVariant(line: string, offset: number, out: SensitiveHit[], seen: Set<string>): void {
  for (const { rule, global, excludes } of COMPILED) {
    global.lastIndex = 0;
    for (const m of line.matchAll(global)) {
      if (m[0].length === 0) continue;
      const start = m.index ?? 0;
      const end = start + m[0].length;
      const key = `${rule.id}:${start}:${end}`;
      if (seen.has(key)) continue;
      if (excludes.length > 0 && overlapsAny(excludes, line, start, end)) continue;
      if (rule.requires && !rule.requires.test(contextWindow(line, start, end))) continue;
      let strength = rule.strength;
      if (rule.research && strength === "definite" && RESEARCH_CONTEXT.test(line.slice(Math.max(0, start - 60), start))) {
        strength = "contextual";
      }
      seen.add(key);
      out.push({ category: rule.category, strength, start: offset + start, end: offset + end, match: m[0], ruleId: rule.id });
    }
  }
}

function scanLine(line: string, offset: number, out: SensitiveHit[]): void {
  const seen = new Set<string>();
  scanVariant(line, offset, out, seen);
  const caps = titleCaseCaps(line);
  if (caps) {
    const before = out.length;
    scanVariant(caps, offset, out, seen);
    // Report the original characters, not the Title Case copy.
    for (let i = before; i < out.length; i++) {
      const h = out[i] as SensitiveHit;
      h.match = line.slice(h.start - offset, h.end - offset);
    }
  }
}

/**
 * Finds every sensitive statement, line by line (context never crosses a line break), sorted
 * by position. Overlapping hits of the same category collapse into the longest.
 */
export function detectSensitive(text: string): SensitiveHit[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits: SensitiveHit[] = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    if (line.trim() !== "") scanLine(line, offset, hits);
    offset += line.length + 1;
  }
  hits.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start));
  const kept: SensitiveHit[] = [];
  for (const h of hits) {
    const dup = kept.some((k) => k.category === h.category && k.start <= h.start && k.end >= h.end);
    if (!dup) kept.push(h);
  }
  return kept;
}

/** True when the text holds any sensitive statement. */
export function hasSensitive(text: string): boolean {
  return detectSensitive(text).length > 0;
}
