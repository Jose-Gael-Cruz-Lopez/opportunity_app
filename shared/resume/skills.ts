import { SKILLS, type SkillDef } from "./lexicon/skills";
import { escapeRegExp, foldForMatch, slugify, splitList, stripBullet, trimPunctuation, wordCount } from "./text";
import type { NormalizedSkill } from "./types";

/**
 * Skill normalization against the curated list in lexicon/skills.ts: "js", "JavaScript" and
 * "javascript" all become JavaScript. Unknown skills are kept for the student's own review but
 * marked `known: false`, and only known skills ever become ProfileSignals.
 */

function lookupKey(s: string): string {
  return foldForMatch(s).replace(/\s+/g, " ").replace(/[.,;:]+$/, "").trim();
}

const BY_KEY: ReadonlyMap<string, SkillDef> = (() => {
  const map = new Map<string, SkillDef>();
  for (const def of SKILLS) {
    for (const form of [def.name, ...(def.aliases ?? [])]) {
      const key = lookupKey(form);
      if (!map.has(key)) map.set(key, def);
    }
  }
  return map;
})();

const CANONICAL_NAMES: ReadonlySet<string> = new Set(SKILLS.map((s) => s.name));

/** The curated entry for a spelling, or null. */
export function lookupSkill(text: string): SkillDef | null {
  return BY_KEY.get(lookupKey(text)) ?? null;
}

/** True for a canonical name from the curated list (what ProfileSignals may carry). */
export function isKnownSkillName(name: string): boolean {
  return CANONICAL_NAMES.has(name);
}

/** "(proficient)", "(3 years)", "(native)": qualifiers, not part of the skill. */
const QUALIFIER = /\(\s*(?:proficient|proficiency|advanced|intermediate|basic|beginner|novice|familiar|expert|fluent|fluency|native|native speaker|heritage(?: speaker)?|bilingual|conversational|limited(?: working)?(?: proficiency)?|professional(?: working)?(?: proficiency)?|elementary(?: proficiency)?|working knowledge|learning|in progress|certified|currently learning|exposure|some|\d+\+?\s*(?:years?|yrs?|months?|mos?)(?:\s+experience)?)\s*\)/gi;
const TRAILING_QUALIFIER = /\s*[-:,]\s*(?:proficient|advanced|intermediate|basic|beginner|familiar|expert|fluent|native|conversational|bilingual)\s*$/i;

function cleanSkillText(raw: string): string {
  let t = stripBullet(raw).replace(QUALIFIER, " ").replace(TRAILING_QUALIFIER, "");
  t = trimPunctuation(t.replace(/\s+/g, " "));
  return t.replace(/^(?:and|&)\s+/i, "").trim();
}

/**
 * Splits compounds when every part is a known skill: "HTML/CSS", "C/C++", "HTML and CSS",
 * "Python (NumPy, pandas)". "Research and Development" stays whole.
 */
function expandCompound(t: string): string[] {
  if (!t) return [];
  if (lookupSkill(t)) return [t];
  const paren = /^(.*?)\s*\((.+)\)\s*$/.exec(t);
  if (paren && paren[1] && paren[2]) {
    const inner = splitList(paren[2], /[,;/]/);
    if (inner.length > 0 && inner.every((p) => lookupSkill(p))) return [...expandCompound(paren[1].trim()), ...inner];
  }
  for (const sep of [/\s*\/\s*/, /\s+(?:and|&)\s+/i]) {
    const parts = t.split(sep).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1 && parts.every((p) => lookupSkill(p))) return parts;
  }
  return [t];
}

export function normalizeSkills(raw: readonly string[]): NormalizedSkill[] {
  const out: NormalizedSkill[] = [];
  const seen = new Set<string>();
  for (const r of raw) {
    if (typeof r !== "string") continue;
    for (const piece of expandCompound(cleanSkillText(r))) {
      if (!piece || piece.length > 60 || wordCount(piece) > 6) continue;
      const def = lookupSkill(piece);
      const skill: NormalizedSkill = def
        ? { id: slugify(def.name), name: def.name, category: def.category, known: true, raw: r }
        : { id: slugify(piece), name: piece, category: "other", known: false, raw: r };
      if (!skill.id || seen.has(skill.id)) continue;
      seen.add(skill.id);
      out.push(skill);
    }
  }
  return out;
}

// -------------------------------------------------------------------------------------------
// Mining skills from sentences (bullets, project descriptions)
// -------------------------------------------------------------------------------------------

interface ProseForm {
  def: SkillDef;
  re: RegExp;
}

/**
 * Forms safe to look for inside a sentence. A canonical single word matches with its exact
 * case ("React", not the verb "react"); multi-word names and aliases with a symbol, digit or
 * space match in any case ("machine learning", "node.js"); lowercase one-word aliases are read
 * from skills lists only.
 */
const PROSE_FORMS: readonly ProseForm[] = (() => {
  const forms: ProseForm[] = [];
  for (const def of SKILLS) {
    if (def.prose === false) continue;
    const add = (form: string, insensitive: boolean): void => {
      const re = new RegExp(`(?<![\\p{L}\\p{N}_+#.])${escapeRegExp(form)}(?![\\p{L}\\p{N}_+#])`, insensitive ? "giu" : "gu");
      forms.push({ def, re });
    };
    add(def.name, /\s/.test(def.name));
    for (const alias of def.aliases ?? []) {
      if (/[^A-Za-z]/.test(alias)) add(alias, true);
      else if (/[A-Z]/.test(alias)) add(alias, false);
    }
  }
  return forms;
})();

/**
 * Known skills named inside free text, as canonical names in order of appearance. The longest
 * match wins where two overlap, so "React Native" does not also count as "React".
 */
export function mineSkills(text: string): string[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const spans: Array<{ start: number; end: number; name: string }> = [];
  for (const { def, re } of PROSE_FORMS) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      const start = m.index ?? 0;
      spans.push({ start, end: start + m[0].length, name: def.name });
    }
  }
  spans.sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: typeof spans = [];
  for (const sp of spans) {
    if (kept.some((k) => sp.start < k.end && sp.end > k.start)) continue;
    kept.push(sp);
  }
  kept.sort((a, b) => a.start - b.start);
  return [...new Set(kept.map((k) => k.name))];
}
