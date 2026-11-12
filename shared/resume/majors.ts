import type { MajorFamily } from "../taxonomy";
import { MAJORS, type MajorDef } from "./lexicon/majors";
import { escapeRegExp, normalizeKey } from "./text";

/**
 * Finds a known major in free text. Whole-string matches win; otherwise the longest alias
 * found inside the text. Short aliases ("CS", "EE", "IT") match only in capitals, so the
 * pronoun "it" is never Information Technology.
 */

interface MajorForm {
  def: MajorDef;
  key: string;
  re: RegExp;
  length: number;
}

const FORMS: readonly MajorForm[] = MAJORS.flatMap((def) =>
  [def.name, ...(def.aliases ?? [])].map((form): MajorForm => {
    const key = normalizeKey(form);
    const short = key.replace(/\s/g, "").length <= 3;
    const source = short
      ? `(?<![\\p{L}])${escapeRegExp(form.toUpperCase())}(?![\\p{L}])`
      : `(?<![\\p{L}])${key.split(" ").filter((w) => w !== "and").map(escapeRegExp).join("(?:[\\s,&/'-]+|\\s+and\\s+)+")}(?![\\p{L}])`;
    return { def, key, re: new RegExp(source, short ? "u" : "iu"), length: key.length };
  }),
);

const BY_KEY: ReadonlyMap<string, MajorDef> = new Map(FORMS.map((f) => [f.key, f.def]));

export interface MajorMatch {
  name: string;
  family: MajorFamily;
  matchedText: string;
}

export function matchMajor(text: string): MajorMatch | null {
  if (!text) return null;
  const whole = BY_KEY.get(normalizeKey(text));
  if (whole) return { name: whole.name, family: whole.family, matchedText: text.trim() };
  let best: { form: MajorForm; text: string } | null = null;
  for (const form of FORMS) {
    const m = form.re.exec(text);
    if (m && (!best || form.length > best.form.length)) best = { form, text: m[0] };
  }
  return best ? { name: best.form.def.name, family: best.form.def.family, matchedText: best.text } : null;
}

/** Every distinct major named in a string such as "Computer Science and Mathematics". */
export function matchMajors(text: string): MajorMatch[] {
  const out: MajorMatch[] = [];
  const whole = matchMajor(text);
  if (whole && normalizeKey(whole.matchedText) === normalizeKey(text)) return [whole];
  for (const part of text.split(/\s*(?:,|;|\/|&|\band\b|\bwith\b|\bplus\b)\s*/i)) {
    const m = part.trim() ? matchMajor(part.trim()) : null;
    if (m && !out.some((o) => o.name === m.name)) out.push(m);
  }
  if (out.length === 0 && whole) out.push(whole);
  return out;
}

export function isKnownMajorName(name: string): boolean {
  return MAJORS.some((m) => m.name === name);
}
