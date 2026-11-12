/**
 * Server-side recheck for resume text the student approved for AI reading.
 *
 * The browser redacts before sending (shared/resume redactForAi). This module is defence in depth:
 * the server never trusts the client, so it re-runs deterministic detectors on the received text
 * and refuses the request on any hit. scanOutgoingText takes the UNION of two detectors: this
 * file's own lexicon and contact patterns, and `@shared/resume`'s scanAiText (the same detectors
 * the browser redacts with, which are the larger lexicon). A modified or buggy client therefore
 * cannot send text the shared detector would refuse, and a gap in either list is covered by the
 * other.
 *
 * Design notes:
 * - Recall beats precision. A false positive costs the student one edit; a false negative sends
 *   an identity or status statement to a model.
 * - Detectors return spans and coarse kinds only. A SensitiveHit carries its category for tests
 *   and for this process, but no category ever leaves the server (responses say "sensitive").
 * - The typed placeholders the client inserts ([email], [phone], [link], [address], [id], [name],
 *   [removed]) never match any detector.
 * - Patterns are written from the public lists in the study notes, modelled on Microsoft
 *   Presidio's recognizer ideas (MIT) and NegEx-style context windows. No code is copied.
 */

import { scanAiText } from "@shared/resume/redact";

export const SENSITIVE_CATEGORIES = [
  "citizenship_immigration",
  "income",
  "disability",
  "race_ethnicity",
  "gender",
  "sexual_orientation",
  "religion",
  "first_generation",
  "veteran",
  "foster_care",
  "health",
] as const;
export type SensitiveCategory = (typeof SENSITIVE_CATEGORIES)[number];

export interface SensitiveHit {
  readonly category: SensitiveCategory;
  readonly start: number;
  readonly end: number;
  /** "contextual" hits are still treated as hits; the label exists for evaluation only. */
  readonly strength: "definite" | "contextual";
}

interface LexiconEntry {
  readonly category: SensitiveCategory;
  readonly pattern: RegExp;
  /** At least one must appear within the context window around the match. */
  readonly requires?: RegExp;
  /** A match overlapping any of these is cancelled (benign confounders such as Old Navy). */
  readonly excludes?: readonly RegExp[];
  readonly strength?: "definite" | "contextual";
}

const CONTEXT_TOKENS = 8;

// Patterns are global so every occurrence is found. Acronyms are case-sensitive on purpose:
// "OPT" the visa programme versus "opt in", "TRIO" versus "trio".
const LEXICON: readonly LexiconEntry[] = [
  // Citizenship or immigration status.
  {
    category: "citizenship_immigration",
    pattern:
      /\b(?:u\.?s\.? citizen(?:ship)?|citizenship|permanent resident|green card|naturali[sz]ed|undocumented|asylum|asylee|refugees?|work authori[sz]ation|requires? (?:visa )?sponsorship|visa sponsorship|international student|immigrant|immigration status)\b/gi,
  },
  { category: "citizenship_immigration", pattern: /\bDACA\b|\bDREAMers?\b/g },
  { category: "citizenship_immigration", pattern: /\bTPS\b/g, requires: /status|protected|temporary/i },
  {
    category: "citizenship_immigration",
    pattern: /\b(?:F-?1|J-?1|OPT|CPT|H-?1B)\b/g,
    requires: /visa|status|student|authori[sz]ation|sponsor|permit/i,
    excludes: [/\bF-?1[- ]score\b/gi, /\bformula (?:1|one)\b/gi],
    strength: "contextual",
  },

  // Income or Pell.
  {
    category: "income",
    pattern:
      /\b(?:low[- ]income|pell(?:[- ]eligible| grant| recipient)?|fafsa|free (?:or|and) reduced(?:[- ]price)? lunch|(?:federal )?work[- ]study|questbridge|jack kent cooke|dell scholars?|upward bound|posse (?:scholar|foundation)|financial need|need[- ]based)\b/gi,
  },
  { category: "income", pattern: /\b(?:TRIO|EOPS?)\b/g },

  // Disability.
  {
    category: "disability",
    pattern:
      /\b(?:disabilit(?:y|ies)|disabled|adhd|autis(?:m|tic)|dyslexi(?:a|c)|deaf|hard of hearing|wheelchair|504 plan|neurodivergent|visually impaired)\b/gi,
  },
  { category: "disability", pattern: /\bIEP\b/g },
  {
    category: "disability",
    pattern: /\bblind\b/gi,
    excludes: [/\b(?:double|single|triple)[- ]blind\b/gi, /\bblind (?:review|study|studies|audition|tasting|spots?)\b/gi],
  },
  {
    category: "disability",
    pattern: /\baccommodations?\b/gi,
    requires: /disabilit|office|\bADA\b|access/i,
    strength: "contextual",
  },

  // Race or ethnicity (organisation names carry most of it on student resumes).
  {
    category: "race_ethnicity",
    pattern:
      /\b(?:black student union|hispanic|latin[oax]s?|latine|latinx|african[- ]american|asian[- ]american|native (?:american|hawaiian|student|community|nations?)|alaska native|pacific islander|first nations|indigenous|tribal|people of color|hispanic scholarship fund)\b/gi,
  },
  { category: "race_ethnicity", pattern: /\b(?:NSBE|SHPE|SACNAS|AISES|MAES|HBCU|UNCF|BSU|POC)\b/g },
  {
    category: "race_ethnicity",
    pattern: /\bBlack\b/g,
    excludes: [/\bBlack (?:Belt|Friday|Hat|Box|Mirror|Swan|Diamond|Hills|Rock|board)\b/g, /\bBlack-Scholes\b/g],
    strength: "contextual",
  },

  // Gender.
  {
    category: "gender",
    pattern:
      /\b(?:society of women engineers|women in [a-z]+|women's (?:college|center|leadership|team|club|society)|girls who code|anitab(?:\.org)?|grace hopper|sororit(?:y|ies)|fraternit(?:y|ies)|pronouns|he\/him|she\/her|they\/them)\b/gi,
  },
  { category: "gender", pattern: /\bWiCS\b/g },
  { category: "gender", pattern: /\bSWE\b/g, requires: /society|women/i, strength: "contextual" },

  // Sexual orientation.
  {
    category: "sexual_orientation",
    pattern: /\b(?:lgbt[a-z]*\+?|queer|gay|lesbian|bisexual|transgender|non-?binary|out in tech|point foundation|gay-straight alliance)\b/gi,
  },
  { category: "sexual_orientation", pattern: /\boSTEM\b/g },
  { category: "sexual_orientation", pattern: /\bGSA\b/g, requires: /alliance|lgbt|queer|pride/i },
  { category: "sexual_orientation", pattern: /\bpride\b/gi, requires: /lgbt|club|alliance|queer|month/i, strength: "contextual" },

  // Religion.
  {
    category: "religion",
    pattern:
      /\b(?:hillel|chabad|muslim|islamic|intervarsity|newman (?:center|club)|church|mosque|synagogue|youth ministry|bible|mission trip|lds mission|catholic|christian|jewish|hindu|sikh|buddhist|evangelical|quran|torah|faith[- ]based)\b/gi,
  },
  { category: "religion", pattern: /\btemple\b/gi, excludes: [/\btemple university\b/gi] },
  { category: "religion", pattern: /\bCru\b/g },

  // First-generation.
  {
    category: "first_generation",
    pattern: /\b(?:first[- ]gen(?:eration)?|first in (?:my|their|his|her) family to (?:attend|go to|graduate from) college|first scholars|mcnair scholars?)\b/gi,
  },
  { category: "first_generation", pattern: /\bFGLI\b/g },

  // Veteran or military service.
  {
    category: "veteran",
    pattern:
      /\b(?:veterans?|gi bill|active duty|dd-?214|marine corps|air force|coast guard|space force|national guard|marines|military service|reservist|rotc)\b/gi,
  },
  { category: "veteran", pattern: /\barmy\b/gi, excludes: [/\bsalvation army\b/gi] },
  { category: "veteran", pattern: /\bnavy\b/gi, excludes: [/\bold navy\b/gi, /\bnavy[- ]blue\b/gi] },
  {
    category: "veteran",
    // "Deployed to AWS" is the common case for CS students, so deployment needs military context.
    pattern: /\bdeploy(?:ed|ment)\b/gi,
    requires: /military|army|navy|overseas|troops|battalion|platoon|tour of duty/i,
    strength: "contextual",
  },

  // Foster care.
  {
    category: "foster_care",
    pattern: /\b(?:foster (?:care|youth|home|family|families)|ward of the (?:state|court)|guardian scholars|aged out|chafee|kinship care)\b/gi,
  },

  // Health.
  {
    category: "health",
    // "Diagnosed network issues" is common on IT resumes, so only "diagnosed with" counts.
    pattern:
      /\b(?:cancer survivor|diagnosed with|chronic (?:illness|pain|condition)|diabetes|diabetic|anxiety disorder|medical leave|hospitali[sz]ed|pregnan(?:t|cy)|bipolar|eating disorder|mental illness|epilepsy)\b/gi,
  },
  { category: "health", pattern: /\bdepression\b/gi, excludes: [/\bgreat depression\b/gi] },
  { category: "health", pattern: /\b(?:HIV|PTSD)\b/g },
];

/** Index of the character `count` whitespace-separated tokens before/after a span. */
function contextWindow(text: string, start: number, end: number, tokens: number): string {
  let left = start;
  for (let seen = 0; left > 0 && seen <= tokens; left--) {
    if (/\s/.test(text[left - 1] ?? "") && !/\s/.test(text[left] ?? "")) seen++;
  }
  let right = end;
  for (let seen = 0; right < text.length && seen <= tokens; right++) {
    if (/\s/.test(text[right] ?? "") && !/\s/.test(text[right - 1] ?? "")) seen++;
  }
  return text.slice(left, right);
}

function overlapsAny(text: string, patterns: readonly RegExp[] | undefined, start: number, end: number): boolean {
  if (!patterns) return false;
  for (const p of patterns) {
    for (const m of text.matchAll(p)) {
      const s = m.index ?? 0;
      if (s < end && s + m[0].length > start) return true;
    }
  }
  return false;
}

/**
 * Finds statements that reveal any of the eleven SensitiveAnswers categories. Returns spans
 * sorted by start. Never logs and never throws on odd input.
 */
export function detectSensitive(text: string): SensitiveHit[] {
  const hits: SensitiveHit[] = [];
  for (const entry of LEXICON) {
    for (const m of text.matchAll(entry.pattern)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (overlapsAny(text, entry.excludes, start, end)) continue;
      if (entry.requires && !entry.requires.test(contextWindow(text, start, end, CONTEXT_TOKENS))) continue;
      hits.push({ category: entry.category, start, end, strength: entry.strength ?? "definite" });
    }
  }
  return hits.sort((a, b) => a.start - b.start || a.end - b.end);
}

// ---------------------------------------------------------------------------------------------
// Contact details, links, addresses, identifiers and third-party names.
// ---------------------------------------------------------------------------------------------

export const CONTACT_KINDS = ["email", "phone", "link", "address", "id", "name"] as const;
export type ContactKind = (typeof CONTACT_KINDS)[number];

export interface ContactHit {
  readonly kind: ContactKind;
  readonly start: number;
  readonly end: number;
}

const US_STATE_CODES =
  "AL|AK|AZ|AR|CA|CO|CT|DE|DC|FL|GA|HI|ID|IL|IN|IA|KS|KY|LA|ME|MD|MA|MI|MN|MS|MO|MT|NE|NV|NH|NJ|NM|NY|NC|ND|OH|OK|OR|PA|RI|SC|SD|TN|TX|UT|VT|VA|WA|WV|WI|WY|PR";

/** Tech names that look like domains; they are skills, not links. */
const DOMAIN_LIKE_SKILLS = /^(?:asp\.net|vb\.net|ado\.net|socket\.io|chart\.io|ml\.net)$/i;

interface ContactPattern {
  readonly kind: ContactKind;
  readonly pattern: RegExp;
  /** Extra validation on the matched string (digit counts, skill-name exclusions). */
  readonly accept?: (match: string) => boolean;
}

const digitCount = (s: string): number => (s.match(/\d/g) ?? []).length;

const CONTACT_PATTERNS: readonly ContactPattern[] = [
  { kind: "email", pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
  // Obfuscated addresses: "jane [at] school [dot] edu", "jane at gmail dot com".
  {
    kind: "email",
    pattern: /\b[\w.+-]+\s*(?:\[at\]|\(at\)|\{at\}|\s+at\s+)\s*[\w-]+\s*(?:\[dot\]|\(dot\)|\{dot\}|\s+dot\s+)\s*[a-z]{2,6}\b/gi,
  },
  { kind: "email", pattern: /\bmailto:\S+/gi },
  // Phones: require 10+ digits, or 8+ with a leading +, so year ranges and GPAs never match.
  {
    kind: "phone",
    pattern: /\+?\d[\d\s().-]{6,}\d/g,
    accept: (m) => {
      const digits = digitCount(m);
      if (m.trim().startsWith("+")) return digits >= 8 && digits <= 15;
      // "2023-2024" style ranges are 8 digits; a bare 4-4 split never reaches 10.
      return digits >= 10 && digits <= 13 && !/^\s*(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\s*$/.test(m);
    },
  },
  { kind: "phone", pattern: /\btel:\S+/gi },
  { kind: "link", pattern: /\b(?:https?:\/\/|www\.)\S+/gi },
  {
    kind: "link",
    pattern:
      /\b[a-z0-9][a-z0-9-]*(?:\.[a-z0-9-]+)*\.(?:com|org|net|io|dev|me|edu|app|ai|co|us|gov|xyz|tech|site|page|info|link|bio)\b(?:\/\S*)?/gi,
    accept: (m) => !DOMAIN_LIKE_SKILLS.test(m),
  },
  // Social handles ("@janedoe"); emails were matched above and are skipped by overlap.
  { kind: "link", pattern: /(?<![\w.])@[A-Za-z0-9_]{2,30}\b/g },
  {
    kind: "address",
    pattern:
      /\b\d{1,6}\s+(?:[A-Z][a-z]+\.?\s+){1,4}(?:St|Street|Ave|Avenue|Rd|Road|Blvd|Boulevard|Dr|Drive|Ln|Lane|Ct|Court|Way|Pl|Place|Ter|Terrace|Pkwy|Parkway|Hwy|Highway|Cir|Circle)\b\.?/g,
  },
  { kind: "address", pattern: /\b(?:Apt\.?|Apartment|Unit|Suite|Ste\.?)\s*#?\s*\d+[A-Za-z]?\b/g },
  { kind: "address", pattern: /\bP\.?\s?O\.?\s*Box\s+\d+/gi },
  { kind: "address", pattern: new RegExp(`\\b(?:${US_STATE_CODES})\\s+\\d{5}(?:-\\d{4})?\\b`, "g") },
  // US SSN with Presidio-style validity rules (no 000/666/9xx area, no 00 group, no 0000 serial).
  { kind: "id", pattern: /\b(?!000|666|9\d\d)\d{3}([- ]?)(?!00)\d{2}\1(?!0000)\d{4}\b/g },
  {
    kind: "id",
    pattern: /\b(?:student\s*(?:id|number|no\.?)|id\s*#|uid|net\s?id|pid)\s*[:#]?\s*[A-Za-z0-9-]{3,}/gi,
  },
  { kind: "id", pattern: /\b(?:passport|driver'?s licen[cs]e)\b[^\n]{0,20}?[A-Z0-9]{5,}/gi },
  { kind: "id", pattern: /\b(?:dob|d\.o\.b\.|date of birth|born on)\b/gi },
  // Third-party names after honorifics or role labels ("Supervisor: Jane Doe", "Dr. Smith").
  { kind: "name", pattern: /\b(?:Mr|Ms|Mrs|Mx|Dr|Prof)\.?\s+[A-Z][A-Za-z'-]+/g },
  { kind: "name", pattern: /\bProfessor\s+[A-Z][A-Za-z'-]+/g },
  {
    kind: "name",
    pattern: /\b(?:Supervisor|Reference|References|Advisor|Mentor|PI|Manager|Contact)\s*:\s*[A-Z][A-Za-z'-]+/g,
  },
];

/** Finds contact details, links, addresses, identifiers and third-party names. */
export function detectContact(text: string): ContactHit[] {
  const hits: ContactHit[] = [];
  for (const { kind, pattern, accept } of CONTACT_PATTERNS) {
    for (const m of text.matchAll(pattern)) {
      if (accept && !accept(m[0])) continue;
      const start = m.index ?? 0;
      hits.push({ kind, start, end: start + m[0].length });
    }
  }
  // An email's domain also matches the bare-domain link pattern; report it once, as an email.
  const emails = hits.filter((h) => h.kind === "email");
  return hits
    .filter((h) => h.kind !== "link" || !emails.some((e) => e.start <= h.start && h.end <= e.end))
    .sort((a, b) => a.start - b.start || a.end - b.end);
}

export type UnredactedKind = ContactKind | "sensitive";

export interface OutgoingScan {
  readonly ok: boolean;
  /** Coarse kinds only, deduplicated. Sensitive hits collapse to one neutral "sensitive" kind. */
  readonly kinds: readonly UnredactedKind[];
}

/**
 * The server's single check on student text before it may reach a model. `ok` is false on any
 * hit. The result never carries the matched text or a sensitive category.
 */
export function scanOutgoingText(text: string): OutgoingScan {
  const kinds = new Set<UnredactedKind>();
  for (const hit of detectContact(text)) kinds.add(hit.kind);
  if (detectSensitive(text).length > 0) kinds.add("sensitive");
  for (const issue of sharedIssues(text)) kinds.add(issue);
  const ordered = [...CONTACT_KINDS, "sensitive" as const].filter((k) => kinds.has(k));
  return { ok: ordered.length === 0, kinds: ordered };
}

/**
 * The shared on-device detectors, re-run here. Length is the route schema's job, so "too_long"
 * is ignored; a birth date or age reports as the coarse "id" kind, like this file's own DOB rule.
 */
function sharedIssues(text: string): UnredactedKind[] {
  const out: UnredactedKind[] = [];
  for (const issue of scanAiText(text, Number.MAX_SAFE_INTEGER).issues) {
    if (issue === "too_long") continue;
    out.push(issue === "birthdate" ? "id" : issue);
  }
  return out;
}

/** True when a short string (a skill, a field name, a model-returned term) is safe to store or return. */
export function isCleanTerm(term: string): boolean {
  return scanOutgoingText(term).ok;
}
