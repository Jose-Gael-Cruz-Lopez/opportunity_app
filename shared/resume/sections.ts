import type { LogicalLine } from "./layout";
import { AMBIGUOUS_HEADINGS, HEAD_NOUNS, HEADING_LEXICON } from "./lexicon/headings";
import { hasOrgWord, hasRoleWord } from "./lexicon/roles";
import { editDistance, isAllCaps, isBulletLine, normalizeKey, wordCount } from "./text";
import type { SectionKey } from "./types";

/**
 * Section detection. A line is a heading when it matches the heading lexicon (exactly, or
 * within one edit for words of six letters or more), or when it carries a head noun plus a
 * visual cue, or, failing both, when it is styled exactly like the lexicon headings found on
 * the same resume. Everything above the first heading is the profile (name and contact).
 */

export interface DetectedSection {
  key: SectionKey;
  heading: string | null;
  headingLine: number | null;
  lines: LogicalLine[];
}

export interface Sectioned {
  profile: LogicalLine[];
  sections: DetectedSection[];
  /** True when no heading was found at all. */
  noHeadings: boolean;
}

const LEXICON: ReadonlyArray<{ key: SectionKey; phrase: string; words: string[] }> = HEADING_LEXICON.flatMap(([key, phrases]) =>
  phrases.map((phrase) => ({ key, phrase, words: phrase.split(" ") })),
);

/** The heading text with decoration removed: "## EDUCATION:" -> "EDUCATION". */
export function headingText(raw: string): string {
  return raw
    .replace(/^[\s#=*_~>|-]+/, "")
    .replace(/[\s=*_~|:-]+$/, "")
    .trim();
}

/** Lexicon key for a heading text, allowing one edit in words of six or more letters. */
export function lexiconKey(text: string): SectionKey | null {
  const key = normalizeKey(text.replace(/\//g, " & "));
  if (!key) return null;
  const parts = key.split(" ");
  for (const entry of LEXICON) {
    if (entry.phrase === key) return entry.key;
  }
  for (const entry of LEXICON) {
    if (entry.words.length !== parts.length) continue;
    const close = entry.words.every((w, i) => {
      const p = parts[i] as string;
      return w === p || (w.length >= 6 && p.length >= 6 && editDistance(w, p) <= 1);
    });
    if (close) return entry.key;
  }
  return null;
}

function headNounKey(text: string): SectionKey | null {
  const key = normalizeKey(text.replace(/\//g, " & "));
  for (const [re, section] of HEAD_NOUNS) if (re.test(key)) return section;
  return null;
}

interface Style {
  caps: boolean;
  bold: boolean;
  size: number | null;
}

function styleOf(line: LogicalLine, text: string): Style {
  return { caps: isAllCaps(text), bold: line.bold, size: line.fontSize === null ? null : Math.round(line.fontSize * 2) / 2 };
}

function sameStyle(a: Style, b: Style): boolean {
  return a.caps === b.caps && a.bold === b.bold && (a.size === null || b.size === null ? a.size === b.size : Math.abs(a.size - b.size) <= 0.5);
}

interface Candidate {
  text: string;
  words: number;
}

/** Shape checks every heading must pass: short, no digits, no sentence punctuation, one cell. */
function candidateOf(line: LogicalLine): Candidate | null {
  const raw = line.text.trim();
  if (raw.length === 0 || raw.length > 60) return null;
  if (isBulletLine(raw)) return null;
  if (raw.includes("\t")) return null;
  if (/:\s*\S/.test(raw)) return null;
  const text = headingText(raw);
  const words = wordCount(text);
  if (words === 0 || words > 6) return null;
  if (/\d/.test(text)) return null;
  if (/[.,;!?]$/.test(text) || /[@\\]/.test(text)) return null;
  return { text, words };
}

function hasCue(line: LogicalLine, text: string, body: number | null): boolean {
  return (
    isAllCaps(text) ||
    line.bold ||
    (body !== null && line.fontSize !== null && line.fontSize >= 1.15 * body) ||
    /:\s*$/.test(line.text) ||
    line.underlined ||
    line.markdownHeading ||
    line.blankBefore
  );
}

interface HeadingHit {
  key: SectionKey;
  heading: string;
}

function lexiconHeading(line: LogicalLine, body: number | null): HeadingHit | null {
  const c = candidateOf(line);
  if (!c) return null;
  const key = lexiconKey(c.text);
  if (!key) return null;
  if (AMBIGUOUS_HEADINGS.has(normalizeKey(c.text)) && !hasCue(line, c.text, body)) return null;
  return { key, heading: c.text };
}

/**
 * Splits logical lines into the profile and sections. Two passes: the first finds lexicon
 * headings and learns their style, the second accepts head-noun and style-only headings.
 */
export function splitSections(lines: readonly LogicalLine[], bodyFontSize: number | null): Sectioned {
  const firstLine = lines[0]?.index ?? -1;
  const lexical = new Map<number, HeadingHit>();
  const styles: Style[] = [];
  for (const line of lines) {
    const hit = lexiconHeading(line, bodyFontSize);
    if (!hit) continue;
    lexical.set(line.index, hit);
    styles.push(styleOf(line, hit.heading));
  }
  const headingStyle = mostCommonStyle(styles);

  const headingAt = (line: LogicalLine): HeadingHit | null => {
    const lex = lexical.get(line.index);
    if (lex) return lex;
    if (line.index === firstLine) return null;
    const c = candidateOf(line);
    if (!c || c.words > 5) return null;
    // A role or organization word means an entry title such as "Research Assistant" or "Robotics Club".
    if (hasRoleWord(c.text) || hasOrgWord(c.text)) return null;
    const noun = headNounKey(c.text);
    const style = styleOf(line, c.text);
    if (noun && hasCue(line, c.text, bodyFontSize) && (style.caps || style.bold || line.underlined || line.markdownHeading || /:\s*$/.test(line.text) || isLarger(line, bodyFontSize))) {
      return { key: noun, heading: c.text };
    }
    if (!noun && headingStyle && style.caps && c.words <= 4 && sameStyle(style, headingStyle) && (style.bold || isLarger(line, bodyFontSize))) {
      return { key: "other", heading: c.text };
    }
    return null;
  };

  const profile: LogicalLine[] = [];
  const sections: DetectedSection[] = [];
  for (const line of lines) {
    const hit = headingAt(line);
    if (hit) {
      sections.push({ key: hit.key, heading: hit.heading, headingLine: line.index, lines: [] });
      continue;
    }
    const current = sections[sections.length - 1];
    if (current) current.lines.push(line);
    else profile.push(line);
  }
  return { profile, sections, noHeadings: sections.length === 0 };
}

function isLarger(line: LogicalLine, body: number | null): boolean {
  return body !== null && line.fontSize !== null && line.fontSize >= 1.15 * body;
}

function mostCommonStyle(styles: readonly Style[]): Style | null {
  let best: { style: Style; count: number } | null = null;
  for (const s of styles) {
    const count = styles.filter((o) => sameStyle(o, s)).length;
    if (!best || count > best.count) best = { style: s, count };
  }
  return best && best.count >= 2 ? best.style : null;
}
