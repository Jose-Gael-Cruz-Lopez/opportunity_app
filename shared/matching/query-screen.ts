import { SENSITIVE_KEY_STEMS } from "../taxonomy/sensitive";
import { MATCHING_CONFIG } from "./config";
import { normalizeQueryText } from "./embeddings";
import { foldText } from "./text";

/**
 * The query screen in front of the embeddings leg. A search query is student text, so before it
 * may be sent to an embedding model it must be short, carry no contact or id details, no
 * first-person disclosure and no status or identity vocabulary. Anything the screen refuses is
 * searched lexically only, on the same terms as before: refusing costs recall, never privacy.
 *
 * This is the shared first pass (browser and Worker run the same code). The Worker route also
 * runs server/ai's `mentionsSensitiveTerm` and `redactStudentText` and refuses when either fires,
 * so both deny-lists must pass. The query is never logged, stored or cached by either.
 */

export type QueryScreenReason = "empty" | "too_short" | "too_long" | "too_many_words" | "contact_or_id" | "first_person" | "sensitive_term";

export type QueryScreenResult = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: QueryScreenReason };

const CONTACT_OR_ID: readonly RegExp[] = [
  /@/u, // email or handle
  /\b(?:https?:\/\/|www\.)/iu,
  /\d[\d\s().-]{5,}\d/u, // phone, SSN, A-number, student id: seven or more digits with separators
  /\d{4,}/u, // any run of four or more digits (zip, id, year-of-birth pairs are not needed to search)
];

/** First-person words: a query that talks about the student is not sent ("my visa", "i'm a junior"). */
const FIRST_PERSON: ReadonlySet<string> = new Set(["i", "im", "i'm", "ive", "i've", "id", "i'd", "me", "my", "mine", "myself"]);

/**
 * Status and identity vocabulary beyond SENSITIVE_KEY_STEMS (which are key stems such as "pell" or
 * "immigra", matched here as word prefixes). Whole words only; errs toward refusing.
 */
const SENSITIVE_WORDS: ReadonlySet<string> = new Set([
  "undocumented", "dreamer", "dreamers", "asylum", "deported", "deportation", "greencard", "fafsa", "lowincome", "poverty",
  "homeless", "black", "african", "latino", "latina", "latinx", "latine", "chicano", "chicana", "asian", "indigenous", "native",
  "hawaiian", "islander", "white", "women", "woman", "female", "male", "men", "nonbinary", "trans", "transgender", "queer", "gay",
  "lesbian", "bisexual", "lgbtq", "lgbtqia", "disabled", "disability", "deaf", "blind", "autistic", "adhd", "pregnant", "parenting",
  "parent", "mother", "father", "religious", "christian", "muslim", "jewish", "catholic", "hindu", "sikh", "tribe", "tribal",
  "veteran", "veterans", "foster", "orphan", "survivor", "victim", "convicted", "incarcerated", "felony", "firstgen", "minority",
  "minorities", "underrepresented", "urm", "diverse", "diversity", "international", "f1", "j1", "h1b", "opt", "cpt", "ssn", "itin",
]); // fmt: keep one word list, reviewed by the privacy owner (s09)

/** Two-word phrases checked after joining neighbours ("first gen", "low income", "green card"). */
const SENSITIVE_PHRASES: ReadonlySet<string> = new Set(["first gen", "first generation", "low income", "green card", "financial need", "financial aid"]);

function words(text: string): string[] {
  return foldText(text)
    .split(/[^\p{L}\p{N}']+/u)
    .map((w) => w.replace(/^'+|'+$/g, ""))
    .filter(Boolean);
}

function hasSensitive(ws: readonly string[]): boolean {
  for (let i = 0; i < ws.length; i++) {
    const w = ws[i] as string;
    const bare = w.replace(/'/g, "");
    if (SENSITIVE_WORDS.has(bare)) return true;
    if (SENSITIVE_KEY_STEMS.some((stem) => !stem.includes("_") && bare.startsWith(stem))) return true;
    const next = ws[i + 1];
    if (next !== undefined && SENSITIVE_PHRASES.has(`${bare} ${next.replace(/'/g, "")}`)) return true;
  }
  return false;
}

/**
 * Decides whether a query may be embedded. Returns the normalized text to embed, or a categorical
 * reason (never the query) that callers may count.
 */
export function screenQueryForEmbedding(query: string): QueryScreenResult {
  const cfg = MATCHING_CONFIG.dense;
  const text = normalizeQueryText(query);
  if (!text) return { ok: false, reason: "empty" };
  if (text.length < cfg.minQueryChars) return { ok: false, reason: "too_short" };
  if (text.length > cfg.maxQueryChars) return { ok: false, reason: "too_long" };
  const ws = words(text);
  if (ws.length > cfg.maxQueryWords) return { ok: false, reason: "too_many_words" };
  if (CONTACT_OR_ID.some((re) => re.test(text))) return { ok: false, reason: "contact_or_id" };
  if (ws.some((w) => FIRST_PERSON.has(w))) return { ok: false, reason: "first_person" };
  if (hasSensitive(ws)) return { ok: false, reason: "sensitive_term" };
  return { ok: true, text };
}
