import { US_STATES } from "../taxonomy";
import { COMMON_WORD_SURNAMES, NAME_NOISE, STOP_FIRST_NAMES } from "./lexicon/names";
import { cityStateRegex } from "./lexicon/places";
import { escapeRegExp, foldForMatch } from "./text";
import type { PiiHit, PiiKind, RedactionItem } from "./types";

/**
 * Deterministic detectors for contact details, identifiers and names, modelled on Microsoft
 * Presidio's recognizers (MIT): pattern plus validator, and context words where a pattern is
 * weak. Presidio scores each match and keeps those above a threshold; Novus redacts on any
 * match, because here recall matters more than precision. The patterns are written for this
 * module; Presidio is a design reference only.
 *
 * Names come from seeds the document itself provides (the name line, the PDF author, the
 * account name, the email address), plus honorific and role patterns ("Dr. Rivera",
 * "Supervisor: Ana Ruiz") for other people. No NER model runs on the device.
 */

/** Typed placeholders; none of them names a sensitive category. */
export const PII_PLACEHOLDERS: Record<PiiKind, string> = {
  email: "[email]",
  phone: "[phone]",
  link: "[link]",
  address: "[address]",
  id: "[id]",
  birthdate: "[id]",
  name: "[name]",
};

const PII_REASONS: Record<PiiKind, string> = {
  email: "Email address. It stays on this device.",
  phone: "Phone number. It stays on this device.",
  link: "Link or profile handle. It stays on this device.",
  address: "Address or home location. It stays on this device.",
  id: "ID number. It stays on this device.",
  birthdate: "Birth date or age. It stays on this device.",
  name: "A person's name. It stays on this device.",
};

export function piiReason(kind: PiiKind): string {
  return PII_REASONS[kind];
}

export interface PiiOptions {
  /** Name seeds: the student's name, aliases, the account name. */
  names?: readonly string[];
}

// -------------------------------------------------------------------------------------------
// Patterns
// -------------------------------------------------------------------------------------------

const EMAIL = /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9._%+-]{0,63}@(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,24}(?![\w-])/g;
const AT_TOKEN = "(?:\\[\\s*at\\s*\\]|\\(\\s*at\\s*\\)|\\{\\s*at\\s*\\}|<\\s*at\\s*>)";
const DOT_TOKEN = "(?:\\[\\s*dot\\s*\\]|\\(\\s*dot\\s*\\)|\\{\\s*dot\\s*\\}|<\\s*dot\\s*>)";
/** "jane [at] school [dot] edu", "jane(at)example.edu". */
const EMAIL_BRACKETED = new RegExp(`[\\w.+-]+\\s*${AT_TOKEN}\\s*[\\w-]+(?:\\s*(?:${DOT_TOKEN}|\\s+dot\\s+|\\.)\\s*[\\w-]+)+`, "gi");
/**
 * "mlopez06 @gmail.com", "jane . doe @ gmail . com", "jane＠example.edu": an address with spaces
 * around "@" or the dots, or a full-width at sign. Students type these to dodge scrapers; the
 * unbroken EMAIL pattern misses them, and the domain alone would leave the local part behind.
 */
const EMAIL_SPACED = /(?<![\w.+-])[A-Za-z0-9][A-Za-z0-9_%+-]*(?:\s*\.\s*[A-Za-z0-9_%+-]+)*\s*[@＠]\s*(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\s*\.\s*)+[A-Za-z]{2,24}(?![\w-])/g;
/** "jane at gmail dot com": both words spelled out and a real-looking ending. */
const EMAIL_SPELLED = /[\w.+-]+\s+at\s+[\w-]+(?:\s+dot\s+[\w-]+)*\s+dot\s+(?:com|edu|org|net|io|me|co|us|gov|info|dev)\b/gi;

const URL_SCHEME = /\b(?:https?|ftp):\/\/[^\s<>"'`]+/gi;
const URL_WWW = /(?<![\w.@-])www\.[^\s<>"'`]+/gi;
const URL_MAILTO = /\b(?:mailto|tel):[^\s<>"'`]+/gi;
const URL_KNOWN_HOSTS = /(?<![\w.@-])(?:[a-z0-9-]+\.)*(?:linkedin\.com|github\.com|github\.io|gitlab\.com|bitbucket\.org|behance\.net|dribbble\.com|medium\.com|substack\.com|twitter\.com|x\.com|instagram\.com|facebook\.com|tiktok\.com|youtube\.com|youtu\.be|kaggle\.com|leetcode\.com|devpost\.com|codepen\.io|replit\.com|huggingface\.co|scholar\.google\.com|orcid\.org|researchgate\.net|vercel\.app|netlify\.app|herokuapp\.com|pages\.dev|wixsite\.com|squarespace\.com|carrd\.co|linktr\.ee|about\.me|notion\.site|calendly\.com)(?:\/[^\s<>"'`]*)?/gi;
const URL_BARE = /(?<![\w.@/-])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:com|org|net|edu|io|dev|ai|app|me|co|us|info|xyz|tech|site|page|online|blog|design|ly|gg|tv|codes)(?![\w-])(?:\/[^\s<>"'`]*)?/gi;
/** Product names that look like domains. */
const NOT_A_DOMAIN = /^(?:asp|vb|ado)\.net$|^socket\.io$|^draw\.io$|^chart\.io$/i;
const HANDLE = /(?<![\w@.])@[A-Za-z0-9_](?:[A-Za-z0-9_.]{0,28}[A-Za-z0-9_])?(?![\w@])/g;
/**
 * A handle after a platform label: "github: janedoe", "linkedin/janedoe", "IG - jane.doe",
 * "Discord: maria#1234". Only the handle is matched (the label stays readable), and the whole
 * handle including a Discord tag goes, so no "#1234" is left behind. Platform names after the
 * label ("GitHub/GitLab CI") are skills, not handles.
 */
const HANDLE_LABELLED = /(?<=\b(?:linkedin|github|gitlab|bitbucket|discord|instagram|insta|IG|twitter|tiktok|snapchat|snap|telegram|whatsapp|signal|threads|bluesky|mastodon|reddit|youtube|twitch|kaggle|leetcode|hackerrank|codeforces|devpost|medium|substack|behance|dribbble|portfolio)\s*(?::|\/|\s[-–]\s)\s*)(?!(?:gitlab|github|bitbucket|actions|copilot|pages|ci|desktop|api|codespaces|enterprise|projects?)\b)@?[A-Za-z0-9_](?:[A-Za-z0-9_.\-]{0,38}[A-Za-z0-9_])?(?:#\d{4})?/gi;

/**
 * North American numbers: ten digits with optional +1, separators (spaces allowed around them:
 * "555 - 867 - 5309") and extension.
 */
const SEP = "(?:\\s*[.\\-–]\\s*|\\s+)?";
const PHONE_NANP = new RegExp(
  `(?<![\\w+])(?:\\+?1${SEP})?(?:\\(\\d{3}\\)|\\d{3})${SEP}\\d{3}${SEP}\\d{4}(?:\\s*(?:x|ext\\.?|extension)\\s*\\d{1,5})?(?![\\w])`,
  "gi",
);
/**
 * Any other grouping of 10 or 11 digits ("555 867 53 09", "555.86.75.309"), the same shape the
 * server's recheck uses. Dates and year ranges are rejected by the validator below.
 */
const PHONE_LOOSE = /(?<![\w+])\d[\d\s().\-–]{8,18}\d(?![\w])/g;
/** International numbers with a leading +; 8 to 15 digits. */
const PHONE_INTL = /(?<![\w+])\+\d{1,3}(?:[\s.-]?\(?\d{1,5}\)?){1,5}(?![\w])/g;
/** Seven-digit local numbers count only right after a phone label. */
const PHONE_LABELLED = /\b(?:phone|tel|cell|mobile|ph|call|text)\.?\s*(?:#|no\.?|number)?\s*[:-]?\s*(\d{3}[\s.-]\d{4})(?!\d)/gi;

/** US Social Security numbers with Presidio's validity rules (no 000, 666 or 9xx area; no zero groups). */
const SSN = /(?<!\d)(?!000|666|9\d\d)\d{3}([- ]?)(?!00)\d{2}\1(?!0000)\d{4}(?!\d)/g;
const LABELLED_ID = /\b(?:student\s*(?:id|number|no\.?|#)|id\s*(?:#|no\.?|number)|employee\s*(?:id|#|no\.?)|banner\s*id|emplid|matric(?:ulation)?\s*(?:no\.?|number))\s*[:#]?\s*[A-Za-z0-9-]*\d[A-Za-z0-9-]*/gi;
/** Short labels ("ID:", "NetID:", "PID:") only with a colon or "#", so "PID controller" survives. */
const ID_COLON = /\b(?:id|uid|pid|sid|ucid|net\s?id)\s*[:#]\s*[A-Za-z0-9-]{3,}/gi;
const PASSPORT_LICENSE = /\b(?:passport|driver'?s?\s+licen[cs]e|licen[cs]e\s+(?:no\.?|number|#))\s*(?:no\.?|number|#)?\s*[:#]?\s*[A-Z0-9-]*\d[A-Z0-9-]{4,}/gi;
const A_NUMBER = /\bA-?#?\s?\d{8,9}\b/g;

const MONTHS = "(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\\.?";
const BIRTHDATE = new RegExp(
  `\\b(?:DOB|D\\.O\\.B\\.?|date\\s+of\\s+birth|birth\\s*date|birthday|born(?:\\s+on)?)\\s*[:-]?\\s*(?:\\d{1,2}[\\/.-]\\d{1,2}[\\/.-]\\d{2,4}|${MONTHS}\\s+\\d{1,2},?\\s+\\d{4}|\\d{1,2}\\s+${MONTHS}\\s+\\d{4}|\\d{4}-\\d{2}-\\d{2})`,
  "gi",
);
/** "Age: 19", "Age 19", "19 years old", "19-year-old". */
const AGE = /\bage\s*[:-]?\s*\d{1,2}\b|\b\d{1,2}[\s-]+years?[\s-]+old\b/gi;
/** "Born 2006", "born in 2005": a birth year alone is a birth date for this purpose. */
const BORN_YEAR = /\bborn\s+(?:in\s+)?(?:19|20)\d\d\b/gi;

const STREET_SUFFIX = "(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Drive|Dr|Lane|Ln|Court|Ct|Way|Place|Pl|Terrace|Ter|Parkway|Pkwy|Highway|Hwy|Circle|Cir|Square|Sq)";
const UNIT = "(?:Apt|Apartment|Unit|Suite|Ste|Rm|Room|Fl|Floor|#)\\.?\\s*#?\\s*[\\w-]+";
const STREET = new RegExp(
  `(?<![\\w])(\\d{1,6})[A-Za-z]?\\s+(?:[NSEW]\\.?\\s+|North\\s+|South\\s+|East\\s+|West\\s+)?(?:[A-Z0-9][\\w'.-]*\\s+){1,4}${STREET_SUFFIX}\\b\\.?(?:\\s+(?:NE|NW|SE|SW|N|S|E|W)\\b\\.?)?(?:,?\\s*${UNIT})?`,
  "g",
);
/**
 * An apartment or suite number on its own ("Apt 5", "Suite 210"). "Unit" and "Room" count only
 * after a comma, so "taught Unit 3" in a bullet survives.
 */
const UNIT_ALONE = /\b(?:Suite|Ste)\.?\s*#?\s*\d+[A-Za-z]?\b|\b(?:[Aa]pt|APT|[Aa]partment|APARTMENT)\.?\s*#?\s*\d+[A-Za-z]?\b|(?<=,\s*)(?:Unit|Rm|Room)\s*#?\s*\d+[A-Za-z]?\b/g;
/**
 * Lowercase street addresses ("42 elm street apt 3"). Only the unambiguous suffixes count here,
 * because "led 5 people on the way" or "3 teams to drive" would otherwise read as addresses.
 */
const STREET_LOWER = new RegExp(
  `(?<![\\w])(\\d{1,6})[a-z]?\\s+(?:[a-z0-9][\\w'.-]*\\s+){1,3}(?:street|st|avenue|ave|boulevard|blvd|road|rd|terrace|parkway|pkwy)\\b\\.?(?:,?\\s*(?:apt|apartment|unit|suite|ste|#)\\.?\\s*#?\\s*[\\w-]+)?`,
  "gi",
);
const PO_BOX = /\bP\.?\s?O\.?\s*Box\s+\d+\b/gi;
const STATE_ZIP = new RegExp(`\\b(?:${US_STATES.join("|")})\\s+\\d{5}(?:-\\d{4})?\\b`, "g");

const HONORIFIC = /\b(?:Dr|Prof|Mr|Mrs|Ms|Mx|Professor|Doctor)\.?\s+((?:\p{Lu}[\p{L}'-]*\.?\s+){0,2}\p{Lu}[\p{L}'-]+)/gu;
const ROLE_LABEL = /\b(?:Supervisor|Reference|Advisor|Adviser|Mentor|PI|Principal\s+Investigator|Manager|Contact|Referee|Faculty\s+(?:Advisor|Adviser|Mentor|Sponsor)|Research\s+(?:Advisor|Adviser|Mentor)|Coach|Reports?\s+to)\s*[:-]\s*((?:(?:Dr|Prof|Mr|Mrs|Ms|Mx)\.?\s+)?\p{Lu}[\p{L}'.-]*(?:\s+\p{Lu}[\p{L}'.-]*){0,2})/gu;
/** "E. Vasquez", "J. R. Smith": an initial and a surname, as in author lists. */
const INITIAL_SURNAME = /(?<![\p{L}.])\p{Lu}\.\s?(?:\p{Lu}\.\s?)?\p{Lu}[\p{Ll}'-]+(?:-\p{Lu}[\p{Ll}'-]+)?/gu;
const SUPERVISION = /\b(?:supervision\s+of|supervised\s+by|mentored\s+by|advised\s+by|guidance\s+of|direction\s+of|lab\s+of)\s+((?:\p{Lu}[\p{L}'-]+\s+){1,2}\p{Lu}[\p{L}'-]+)/gu;

// -------------------------------------------------------------------------------------------
// Recognizers
// -------------------------------------------------------------------------------------------

function collect(text: string, re: RegExp, kind: PiiKind, out: PiiHit[], accept: (m: RegExpMatchArray) => boolean = () => true): void {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    if (m[0].length === 0 || !accept(m)) continue;
    const start = m.index ?? 0;
    out.push({ kind, start, end: start + m[0].length, match: m[0] });
  }
}

/** Collects only the last capture group of each match (the name after "Dr." or "Supervisor:"). */
function collectGroup(text: string, re: RegExp, kind: PiiKind, out: PiiHit[]): void {
  re.lastIndex = 0;
  for (const m of text.matchAll(re)) {
    const group = m[m.length - 1];
    if (!group) continue;
    const start = (m.index ?? 0) + m[0].length - group.length;
    out.push({ kind, start, end: start + group.length, match: group });
  }
}

const digits = (s: string): number => (s.match(/\d/g) ?? []).length;

/** Drops trailing punctuation a URL pattern swallowed ("example.com." at a sentence end). */
function trimUrl(hit: PiiHit): PiiHit {
  const trimmed = hit.match.replace(/[.,;:!?)\]}'"]+$/, "");
  return { ...hit, match: trimmed, end: hit.start + trimmed.length };
}

function emailHits(text: string, out: PiiHit[]): void {
  collect(text, EMAIL, "email", out);
  collect(text, EMAIL_SPACED, "email", out, (m) => /\s|＠/.test(m[0]));
  collect(text, EMAIL_BRACKETED, "email", out);
  collect(text, EMAIL_SPELLED, "email", out);
}

function linkHits(text: string, out: PiiHit[]): void {
  const links: PiiHit[] = [];
  for (const re of [URL_SCHEME, URL_WWW, URL_MAILTO, URL_KNOWN_HOSTS]) collect(text, re, "link", links);
  collect(text, URL_BARE, "link", links, (m) => !NOT_A_DOMAIN.test(m[0].replace(/[.,;:!?)\]}'"]+$/, "")));
  collect(text, HANDLE, "link", links);
  collect(text, HANDLE_LABELLED, "link", links);
  out.push(...links.map(trimUrl).filter((h) => h.end > h.start).map((h) => emailFromAtDomain(text, h)));
}

/**
 * "mlopez06 @gmail.com" when only "@gmail.com" was recognized (as a handle or domain): the token
 * just before it is the address's local part, so the hit grows to cover it as an email.
 */
function emailFromAtDomain(text: string, hit: PiiHit): PiiHit {
  if (!/^[@＠][\w-]+(?:\s*\.\s*[\w-]+)+$/.test(hit.match)) return hit;
  const before = /([A-Za-z0-9][A-Za-z0-9._%+-]*)\s*$/.exec(text.slice(0, hit.start));
  if (!before) return hit;
  const start = hit.start - before[0].length;
  return { kind: "email", start, end: hit.end, match: text.slice(start, hit.end) };
}

/** Dates ("01.02.2005", "2024-05-01") and year ranges are never phone numbers. */
const DATE_LIKE = /\b\d{4}\s*[-./–]\s*\d{1,2}\s*[-./–]\s*\d{1,2}\b|\b\d{1,2}\s*[-./]\s*\d{1,2}\s*[-./]\s*\d{2,4}\b|\b(?:19|20)\d{2}\s*[-–]\s*(?:19|20)\d{2}\b/;

function phoneHits(text: string, out: PiiHit[]): void {
  collect(text, PHONE_NANP, "phone", out, (m) => {
    const n = digits(m[0].replace(/(?:x|ext\.?|extension)\s*\d+$/i, ""));
    return n === 10 || n === 11;
  });
  collect(text, PHONE_LOOSE, "phone", out, (m) => {
    const n = digits(m[0]);
    return (n === 10 || n === 11) && !DATE_LIKE.test(m[0]);
  });
  collect(text, PHONE_INTL, "phone", out, (m) => {
    const n = digits(m[0]);
    return n >= 8 && n <= 15;
  });
  PHONE_LABELLED.lastIndex = 0;
  for (const m of text.matchAll(PHONE_LABELLED)) {
    const num = m[1];
    if (!num) continue;
    const start = (m.index ?? 0) + m[0].lastIndexOf(num);
    out.push({ kind: "phone", start, end: start + num.length, match: num });
  }
}

function idHits(text: string, out: PiiHit[]): void {
  collect(text, SSN, "id", out);
  collect(text, LABELLED_ID, "id", out);
  collect(text, ID_COLON, "id", out);
  collect(text, PASSPORT_LICENSE, "id", out);
  collect(text, A_NUMBER, "id", out);
  collect(text, BIRTHDATE, "birthdate", out);
  collect(text, AGE, "birthdate", out);
  collect(text, BORN_YEAR, "birthdate", out);
}

function addressHits(text: string, out: PiiHit[]): void {
  collect(text, STREET, "address", out, (m) => {
    // "2025 Research Assistant Dr. Kim" is a year and a title, not a street number.
    const n = Number(m[1]);
    return !(n >= 1950 && n <= 2035 && (m[1] ?? "").length === 4);
  });
  collect(text, STREET_LOWER, "address", out, (m) => {
    const n = Number(m[1]);
    return !(n >= 1950 && n <= 2035 && (m[1] ?? "").length === 4);
  });
  collect(text, PO_BOX, "address", out);
  collect(text, UNIT_ALONE, "address", out);
  collect(text, cityStateRegex(), "address", out);
  collect(text, STATE_ZIP, "address", out);
}

// -------------------------------------------------------------------------------------------
// Names
// -------------------------------------------------------------------------------------------

function seedTokens(seed: string): string[] {
  return seed
    .split(/[\s,]+/)
    .map((t) => t.replace(/^[^\p{L}]+/u, "").replace(/[^\p{L}'-]+$/u, ""))
    .filter((t) => /\p{L}/u.test(t) && !NAME_NOISE.has(foldForMatch(t).replace(/\./g, "")));
}

const B = "(?<![\\p{L}\\p{N}])";
const E = "(?![\\p{L}\\p{N}])";

interface NamePattern {
  re: RegExp;
  /** Match against the original text (case-sensitive) instead of the folded copy. */
  exactCase: boolean;
}

/** Patterns for one seed: full name, "Last, First", "F. Last", "First L.", last name, safe first name. */
export function namePatterns(seed: string): NamePattern[] {
  const tokens = seedTokens(seed);
  if (tokens.length === 0) return [];
  const folded = tokens.map((t) => escapeRegExp(foldForMatch(t).replace(/\.$/, "")));
  const pats: NamePattern[] = [];
  const add = (source: string, exactCase = false): void => {
    pats.push({ re: new RegExp(`${B}${source}${E}`, exactCase ? "gu" : "gu"), exactCase });
  };
  if (tokens.length === 1) {
    const only = folded[0] as string;
    if (only.length >= 4 && !STOP_FIRST_NAMES.has(only) && !COMMON_WORD_SURNAMES.has(only)) add(only);
    return pats;
  }
  const first = folded[0] as string;
  const last = folded[folded.length - 1] as string;
  const middles = folded.slice(1, -1);
  const middle = middles.length > 0 ? `(?:\\s+(?:${middles.join("|")}|\\p{L}\\.?))*` : "(?:\\s+\\p{L}\\.?)?";
  add(`${first}${middle}\\s+${last}`);
  add(`${last}\\s*,\\s*${first}(?:\\s+\\p{L}\\.?)?`);
  if (first.length > 1) add(`${first[0]}\\.?\\s+${last}`);
  if (last.length > 1) add(`${first}\\s+${last[0]}\\.`);
  const lastParts = [last, ...last.split("-").filter((p) => p.length >= 3 && p !== last)];
  for (const part of lastParts) {
    if (part.length < 2) continue;
    // A surname that is also a month or an everyday capitalized word ("May", "Grant", "Hope")
    // is redacted only inside the full-name forms above: alone it would erase "May 2025".
    if (COMMON_WORD_SURNAMES.has(part) && STOP_FIRST_NAMES.has(part)) continue;
    if (COMMON_WORD_SURNAMES.has(part)) {
      const original = (tokens[tokens.length - 1] as string).split("-").find((p) => foldForMatch(p) === part) ?? part;
      const cap = original.charAt(0).toUpperCase() + original.slice(1).toLowerCase();
      add(`(?:${escapeRegExp(cap)}|${escapeRegExp(cap.toUpperCase())})`, true);
    } else {
      add(part);
    }
  }
  if (first.length >= 3 && !STOP_FIRST_NAMES.has(first)) add(first);
  return pats;
}

function linesWithOffsets(text: string): Array<{ text: string; offset: number }> {
  const out: Array<{ text: string; offset: number }> = [];
  let offset = 0;
  for (const line of text.split("\n")) {
    out.push({ text: line, offset });
    offset += line.length + 1;
  }
  return out;
}

function nameHits(text: string, seeds: readonly string[], out: PiiHit[]): void {
  const folded = foldForMatch(text);
  const seen = new Set<string>();
  for (const seed of seeds) {
    const key = foldForMatch(seed).trim();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    for (const p of namePatterns(seed)) collect(p.exactCase ? text : folded, p.re, "name", out);
  }
  // Author lists ("E. Vasquez, A. Mehta, and K. Osei") name other people. A lone "B.S. Computer"
  // is a degree, so the pattern counts only when it occurs at least twice on one line.
  for (const line of linesWithOffsets(text)) {
    const found: PiiHit[] = [];
    collect(line.text, INITIAL_SURNAME, "name", found);
    if (found.length >= 2) for (const h of found) out.push({ ...h, start: h.start + line.offset, end: h.end + line.offset });
  }
  collectGroup(text, HONORIFIC, "name", out);
  collectGroup(text, ROLE_LABEL, "name", out);
  collectGroup(text, SUPERVISION, "name", out);
  // Spans from the folded copy line up with the original; report the original's characters.
  for (const h of out) if (h.kind === "name") h.match = text.slice(h.start, h.end);
}

// -------------------------------------------------------------------------------------------
// Public API
// -------------------------------------------------------------------------------------------

/**
 * Finds contact details, identifiers and names. Overlaps resolve to the longest span, so an
 * email address wins over the domain and the name inside it.
 */
export function detectPii(text: string, options: PiiOptions = {}): PiiHit[] {
  if (typeof text !== "string" || text.length === 0) return [];
  const hits: PiiHit[] = [];
  emailHits(text, hits);
  linkHits(text, hits);
  phoneHits(text, hits);
  idHits(text, hits);
  addressHits(text, hits);
  nameHits(text, options.names ?? [], hits);
  // Placeholders the redactor left are never hits themselves, so redaction is idempotent even
  // for a seed such as "Name" or "Link".
  const placeholders = [...text.matchAll(PLACEHOLDER_RE)].map((m) => [m.index ?? 0, (m.index ?? 0) + m[0].length] as const);
  const outside = placeholders.length === 0 ? hits : hits.filter((h) => !placeholders.some(([a, b]) => h.start < b && h.end > a));
  return resolveOverlaps(outside);
}

const PLACEHOLDER_RE = /\[(?:email|phone|link|address|id|name|removed)\]/g;

function resolveOverlaps(hits: readonly PiiHit[]): PiiHit[] {
  const byLength = [...hits].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
  const kept: PiiHit[] = [];
  for (const h of byLength) {
    if (h.end <= h.start) continue;
    if (kept.some((k) => h.start < k.end && h.end > k.start)) continue;
    kept.push(h);
  }
  return kept.sort((a, b) => a.start - b.start);
}

/** Replaces every hit with its typed placeholder and lists what was removed. */
export function redactPii(text: string, options: PiiOptions = {}): { text: string; removed: RedactionItem[] } {
  const hits = detectPii(text, options);
  let out = text;
  for (let i = hits.length - 1; i >= 0; i--) {
    const h = hits[i] as PiiHit;
    out = out.slice(0, h.start) + PII_PLACEHOLDERS[h.kind] + out.slice(h.end);
  }
  const removed = hits.map((h): RedactionItem => ({ kind: h.kind, reason: PII_REASONS[h.kind], original: h.match, placeholder: PII_PLACEHOLDERS[h.kind] }));
  return { text: out, removed };
}
