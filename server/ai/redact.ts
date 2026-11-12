/**
 * Free-text redaction for anything a student typed (statements, questions, interest tags).
 *
 * Rule 3: status and identity information never reaches an LLM prompt. Structured answers cannot
 * (no server schema accepts them), but free text can carry them ("as a DACA recipient..."), so
 * every student string is masked here before it is placed in a prompt. This is a deny-list, so it
 * over-masks rather than under-masks; the list is a starting point for the privacy owner (s09) to
 * review, and it errs toward masking common words like "women" because gender is protected too.
 */

export const REDACTION_TOKENS = {
  sensitive: "[status or identity detail]",
  email: "[email]",
  phone: "[phone]",
  link: "[link]",
  idNumber: "[id number]",
  address: "[address]",
} as const;

/**
 * Status and identity vocabulary, as regex sources matched case-insensitively at word boundaries.
 * Grouped by the SensitiveAnswers areas (citizenship, income/Pell, first-generation, identity
 * categories) plus life circumstances that imply them.
 */
const SENSITIVE_TERMS: readonly string[] = [
  // Citizenship and immigration
  "u\\.?\\s?s\\.? citizens?(?:hip)?",
  "citizens?(?:hip)?",
  "non-?citizens?",
  "permanent residen(?:t|ts|cy|ce)",
  "green[- ]?cards?",
  "undocumented",
  "daca",
  "dreamers?",
  "tps",
  "temporary protected status",
  "asylum(?:[- ]seekers?)?",
  "asylees?",
  "refugees?",
  "visas?",
  "[fjh]-?1b?\\s?(?:visa|status|student)s?",
  "international students?",
  "immigra(?:nt|nts|tion|ted|te)",
  "deport(?:ed|ation)?",
  "my (?:parents|family|mother|father|mom|dad) (?:came|moved|immigrated|emigrated)",
  "(?:came|moved) to (?:the )?(?:u\\.?s\\.?a?|united states|america|this country)",
  "born in [A-Z][a-z]+",
  // Income, Pell and financial need
  "pell(?: grants?| eligible| recipients?)?",
  "low[- ]income",
  "(?:household|family|parents'?) income",
  "income",
  "financial need",
  "financial aid",
  "fafsa",
  "free (?:or reduced )?lunch",
  "poverty",
  "homeless(?:ness)?",
  // First-generation
  "first[- ]?gen(?:eration)?(?: college)?(?: students?)?",
  "first in my family",
  "first (?:person )?in my family to (?:attend|go to)",
  // Race and ethnicity
  "race",
  "racial",
  "ethnic(?:ity|ities)?",
  "black",
  "african[- ]americans?",
  "latin[oaxe]s?",
  "hispanic",
  "chican[oa]s?",
  "asian(?:[- ]americans?)?",
  "native americans?",
  "american indians?",
  "alaska natives?",
  "indigenous",
  "pacific islanders?",
  "native hawaiians?",
  "middle eastern",
  "north african",
  "white (?:student|woman|man|person|people|male|female)s?",
  "people of colou?r",
  "poc|bipoc",
  "minorit(?:y|ies)",
  "underrepresented minorit(?:y|ies)",
  // Gender and sexual orientation
  "gender(?: identity)?",
  "transgender|trans (?:woman|man|student|person)",
  "non-?binary",
  "genderqueer",
  "pronouns?",
  "(?:she|he|they)/(?:her|him|them)",
  "wom[ae]n",
  "girls?",
  "females?",
  "males?",
  "as a (?:man|boy|guy)",
  "sexual orientation",
  "lgbtq?i?a?\\+?",
  "gay",
  "lesbians?",
  "bisexual",
  "queer",
  "asexual",
  "pansexual",
  "coming out|came out",
  // Disability and health
  "disabilit(?:y|ies)",
  "disabled",
  "adhd",
  "autis(?:m|tic)",
  "dyslexi[ac]",
  "deaf",
  "blind(?:ness)?",
  "chronic (?:illness|pain|condition)",
  "mental health",
  "depression",
  "anxiety",
  "wheelchair",
  "504 plan",
  "iep",
  // Religion
  "religio(?:n|us|ns)",
  "faith",
  "muslims?",
  "christians?",
  "jewish|jews?",
  "hindus?",
  "buddhists?",
  "sikhs?",
  "catholics?",
  "mormons?",
  "church|mosque|synagogue",
  // Tribal affiliation
  "tribes?|tribal",
  "enrolled member",
  // Military
  "veterans?",
  "military",
  "armed forces",
  "active duty",
  "army|navy|marine corps|u\\.?s\\.? marines|the marines|air force|national guard|coast guard",
  // Foster care, victimisation, parenting
  "foster(?: care| youth| home)?",
  "ward of the (?:state|court)",
  "victims? of",
  "survivors? of",
  "domestic violence",
  "sexual (?:assault|abuse)",
  "abuse",
  "single (?:mother|father|parent)",
  "student parents?",
  "pregnan(?:t|cy)",
  "my (?:son|daughter|child|children|kids?)",
];

const SENSITIVE_RE = new RegExp(`(?<![\\p{L}\\p{N}])(?:${SENSITIVE_TERMS.join("|")})(?![\\p{L}\\p{N}])`, "giu");

const EMAIL_RE = /[\p{L}\p{N}._%+-]+@[\p{L}\p{N}.-]+\.[\p{L}]{2,}/gu;
const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"')\]]+/giu;
const PHONE_RE = /(?<!\w)(?:\+?1[\s.-]?)?\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}(?!\w)/g;
const SSN_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const A_NUMBER_RE = /\bA[-\s]?\d{8,9}\b/gi;
const ADDRESS_RE =
  /\b\d{1,6}\s+(?:[A-Z][\p{L}]+\s){1,4}(?:Street|St|Avenue|Ave|Road|Rd|Boulevard|Blvd|Lane|Ln|Drive|Dr|Court|Ct|Way|Place|Pl)\b\.?/gu;
// Case-sensitive on the name itself, so "my name is Jordan and I" masks only "Jordan".
const NAME_INTRO_RE = /\b([Mm]y name is|I am called|I'm called)\s+[A-Z][\p{L}'-]+(?:\s+[A-Z][\p{L}'-]+)?/gu;

export interface RedactionResult {
  readonly text: string;
  /** Number of spans masked, by category; counts only, never the masked words. */
  readonly counts: Readonly<Record<keyof typeof REDACTION_TOKENS | "name", number>>;
  readonly applied: boolean;
}

/**
 * Masks contact details, government ids, addresses, self-introductions and status or identity
 * vocabulary. Order matters: links and emails go first so their parts are not re-matched.
 */
export function redactStudentText(input: string): RedactionResult {
  const counts = { sensitive: 0, email: 0, phone: 0, link: 0, idNumber: 0, address: 0, name: 0 };
  let text = input.normalize("NFKC");
  const mask = (re: RegExp, key: keyof typeof counts, token: string | ((m: string, ...g: string[]) => string)): void => {
    text = text.replace(re, (...args: unknown[]) => {
      counts[key]++;
      const groups = args.slice(0, -2).map(String);
      return typeof token === "string" ? token : token(groups[0] ?? "", ...groups.slice(1));
    });
  };
  mask(URL_RE, "link", REDACTION_TOKENS.link);
  mask(EMAIL_RE, "email", REDACTION_TOKENS.email);
  mask(SSN_RE, "idNumber", REDACTION_TOKENS.idNumber);
  mask(A_NUMBER_RE, "idNumber", REDACTION_TOKENS.idNumber);
  mask(PHONE_RE, "phone", REDACTION_TOKENS.phone);
  mask(ADDRESS_RE, "address", REDACTION_TOKENS.address);
  mask(NAME_INTRO_RE, "name", (_m, intro) => `${intro} [name]`);
  mask(SENSITIVE_RE, "sensitive", REDACTION_TOKENS.sensitive);
  const applied = Object.values(counts).some((n) => n > 0);
  return { text, counts, applied };
}

/** True when the text mentions any status or identity term. */
export function mentionsSensitiveTerm(text: string): boolean {
  SENSITIVE_RE.lastIndex = 0;
  const hit = SENSITIVE_RE.test(text.normalize("NFKC"));
  SENSITIVE_RE.lastIndex = 0;
  return hit;
}

const ELIGIBILITY_CUE_RE =
  /\b(?:eligib\w*|qualif\w*|can i|could i|am i|may i|allowed|accept\w*|admit\w*|require\w*|apply|count as|considered)\b/i;

/**
 * A question that asks Novus to judge a status or identity criterion ("Can I apply if I'm on
 * DACA?"). Such questions are never sent to the model: the answer points to the on-device check
 * and the official rule instead (AskResponse answerType "declined_sensitive").
 */
export function isSensitiveEligibilityQuestion(question: string): boolean {
  return mentionsSensitiveTerm(question) && ELIGIBILITY_CUE_RE.test(question);
}
