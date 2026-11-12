import type { MajorFamily } from "../taxonomy";
import { compareStrings, looksLikeContactDetail, normalizeForMatch } from "./text";

/**
 * The onboarding skill vocabulary: the chips the quiz offers and the skills findMatches can
 * recognise in program text. It is a short list written by Novus for first- and second-year
 * students, not a copy or subset of ESCO, O*NET or Lightcast; the whole-entry synonyms below
 * (frameworks, lab methods, languages) are Novus's own mapping too, so no attribution applies.
 * shared/resume owns the larger alias table used to read resumes; whatever it produces is folded
 * into these ids where they overlap and otherwise kept as a plain label (`x:{label}`), which
 * counts when a program's text names it.
 *
 * Matching is whole-word and case-insensitive. Single-letter languages ("R", "C") are case
 * sensitive and count only next to other programming words, because "grade C" or "vitamin C"
 * would otherwise become false skills; the student still confirms every extracted skill.
 */

export interface SkillDef {
  readonly id: string;
  readonly label: string;
  /** How a reason names the skill mid-sentence ("Uses Python and data analysis"); defaults to the label. */
  readonly phrase?: string;
  /** Lowercase phrases matched as whole words. */
  readonly aliases: readonly string[];
  /** Case-sensitive tokens (matched on the original text). */
  readonly exactTokens?: readonly string[];
  /** True when an exact token counts only if the text also shows programming context. */
  readonly needsContext?: boolean;
  readonly families: readonly MajorFamily[];
}

export const SKILLS = [
  { id: "python", label: "Python", aliases: ["python", "pandas", "numpy", "jupyter", "scipy"], families: ["computing", "math_statistics", "physical_sciences"] },
  { id: "java", label: "Java", aliases: ["java"], families: ["computing"] },
  { id: "javascript", label: "JavaScript", aliases: ["javascript", "typescript", "node js", "nodejs", "reactjs", "react js"], families: ["computing"] },
  { id: "c_cpp", label: "C or C++", aliases: ["c++", "cpp"], exactTokens: ["C"], needsContext: true, families: ["computing", "engineering_technology"] },
  { id: "sql", label: "SQL", aliases: ["sql", "mysql", "postgresql", "postgres", "sqlite", "database", "databases"], families: ["computing", "business"] },
  { id: "r_lang", label: "R", aliases: ["rstudio", "tidyverse", "ggplot2", "r programming"], exactTokens: ["R"], needsContext: true, families: ["math_statistics", "life_sciences", "social_sciences"] },
  { id: "matlab", label: "MATLAB", aliases: ["matlab", "simulink"], families: ["engineering_technology", "physical_sciences", "math_statistics"] },
  { id: "excel", label: "Excel", aliases: ["microsoft excel", "spreadsheet", "spreadsheets", "google sheets", "pivot tables", "vlookup"], exactTokens: ["Excel"], families: ["business", "social_sciences", "math_statistics"] },
  { id: "data_analysis", label: "Data analysis", phrase: "data analysis", aliases: ["data analysis", "data analytics", "data visualization", "tableau", "power bi", "analytics"], families: ["computing", "math_statistics", "business", "social_sciences"] },
  { id: "statistics", label: "Statistics", phrase: "statistics", aliases: ["statistics", "statistical", "regression", "spss", "stata", "biostatistics"], families: ["math_statistics", "social_sciences", "life_sciences", "health"] },
  { id: "machine_learning", label: "Machine learning", phrase: "machine learning", aliases: ["machine learning", "deep learning", "neural networks", "neural network", "pytorch", "tensorflow", "scikit learn", "computer vision", "natural language processing", "nlp"], families: ["computing", "math_statistics"] },
  { id: "web_development", label: "Web development", phrase: "web development", aliases: ["web development", "html", "css", "frontend", "front end", "full stack", "web apps"], families: ["computing", "arts_design"] },
  { id: "mobile_development", label: "Mobile apps", phrase: "mobile app development", aliases: ["ios", "android", "mobile app", "mobile apps", "flutter", "swiftui", "react native"], families: ["computing"] },
  { id: "git", label: "Git", aliases: ["git", "github", "version control"], families: ["computing"] },
  { id: "cybersecurity", label: "Cybersecurity", phrase: "cybersecurity", aliases: ["cybersecurity", "cyber security", "network security", "capture the flag", "penetration testing"], families: ["computing"] },
  { id: "cad", label: "CAD", aliases: ["cad", "solidworks", "autocad", "fusion 360", "onshape", "3d modeling", "3d printing"], families: ["engineering_technology", "arts_design"] },
  { id: "circuits", label: "Electronics", phrase: "electronics", aliases: ["circuits", "circuit design", "arduino", "raspberry pi", "electronics", "soldering", "pcb"], families: ["engineering_technology", "physical_sciences"] },
  { id: "lab_techniques", label: "Lab techniques", phrase: "lab techniques", aliases: ["pcr", "cell culture", "gel electrophoresis", "microscopy", "pipetting", "wet lab", "lab techniques", "laboratory techniques", "titration", "spectroscopy"], families: ["life_sciences", "physical_sciences", "health"] },
  { id: "field_research", label: "Field research", phrase: "field research", aliases: ["fieldwork", "field work", "field research", "field data", "field sampling", "data collection"], families: ["agriculture_environment", "life_sciences", "social_sciences"] },
  { id: "gis", label: "GIS", aliases: ["gis", "arcgis", "qgis", "remote sensing", "geospatial"], families: ["agriculture_environment", "social_sciences", "physical_sciences"] },
  { id: "research_methods", label: "Research methods", phrase: "research methods", aliases: ["literature review", "research methods", "experimental design", "qualitative research", "survey design", "research design"], families: ["social_sciences", "life_sciences", "health", "humanities_languages"] },
  { id: "writing", label: "Writing", phrase: "writing", aliases: ["writing", "technical writing", "copywriting", "creative writing", "journalism", "blogging", "grant writing"], families: ["humanities_languages", "communication_media", "law_policy_service"] },
  { id: "editing", label: "Editing", phrase: "editing", aliases: ["editing", "proofreading", "copyediting"], families: ["humanities_languages", "communication_media"] },
  { id: "public_speaking", label: "Public speaking", phrase: "public speaking", aliases: ["public speaking", "presentations", "presenting", "debate", "speech"], families: ["communication_media", "law_policy_service", "business"] },
  { id: "graphic_design", label: "Graphic design", phrase: "graphic design", aliases: ["graphic design", "photoshop", "illustrator", "canva", "indesign", "adobe creative suite"], families: ["arts_design", "communication_media"] },
  { id: "ux_design", label: "UX design", aliases: ["ux", "user experience", "user research", "wireframing", "prototyping", "figma"], families: ["arts_design", "computing"] },
  { id: "video", label: "Video", phrase: "video editing", aliases: ["video editing", "premiere pro", "final cut", "videography", "filmmaking", "video production"], families: ["arts_design", "communication_media"] },
  { id: "social_media", label: "Social media", phrase: "social media", aliases: ["social media", "content creation", "tiktok", "instagram"], families: ["communication_media", "business"] },
  { id: "marketing", label: "Marketing", phrase: "marketing", aliases: ["marketing", "seo", "market research", "branding", "advertising"], families: ["business", "communication_media"] },
  { id: "financial_modeling", label: "Financial modeling", phrase: "financial modeling", aliases: ["financial modeling", "financial modelling", "valuation", "dcf", "financial analysis"], families: ["business", "math_statistics"] },
  { id: "accounting", label: "Accounting", phrase: "accounting", aliases: ["accounting", "bookkeeping", "quickbooks"], families: ["business"] },
  { id: "project_management", label: "Project management", phrase: "project management", aliases: ["project management", "scrum", "agile", "jira", "trello"], families: ["business", "computing", "engineering_technology"] },
  { id: "leadership", label: "Leadership", phrase: "leadership", aliases: ["leadership", "team lead", "team leader", "student government"], families: ["business", "law_policy_service", "education"] },
  // "Mentor" is left out on purpose: program pages promise mentors, which is not a skill they ask for.
  { id: "tutoring", label: "Tutoring", phrase: "tutoring", aliases: ["tutoring", "tutor", "teaching assistant", "peer tutoring"], families: ["education", "humanities_languages"] },
  { id: "customer_service", label: "Customer service", phrase: "customer service", aliases: ["customer service", "retail", "front desk", "cashier", "hospitality"], families: ["business", "trades_applied"] },
  { id: "event_planning", label: "Event planning", phrase: "event planning", aliases: ["event planning", "event coordination", "fundraising"], families: ["business", "communication_media"] },
  { id: "policy_analysis", label: "Policy analysis", phrase: "policy analysis", aliases: ["policy analysis", "policy research", "legislative research", "policy memo", "policy writing"], families: ["law_policy_service", "social_sciences"] },
  { id: "languages", label: "A second language", phrase: "a second language", aliases: ["bilingual", "multilingual", "second language", "translation", "interpreting"], families: ["humanities_languages", "education"] },
] as const satisfies readonly SkillDef[];

export type SkillId = (typeof SKILLS)[number]["id"];
export const SKILL_IDS = SKILLS.map((s) => s.id) as [SkillId, ...SkillId[]];

const BY_ID: ReadonlyMap<string, SkillDef> = new Map(SKILLS.map((s) => [s.id, s]));

/** Lowercased chip labels to ids ("c or c++", "mobile apps", "a second language"). */
const LABEL_INDEX: ReadonlyMap<string, SkillId> = new Map(SKILLS.map((s) => [s.label.toLowerCase(), s.id]));

export function skillById(id: string): SkillDef | undefined {
  return BY_ID.get(id);
}

/** Prefix for skills the resume found that the onboarding vocabulary does not list. */
export const UNLISTED_SKILL_PREFIX = "x:";

/** Characters allowed in an unlisted skill label: enough for "node.js" or "c#", nothing more. */
const UNLISTED_LABEL = /^[a-z0-9][a-z0-9 +#./-]{0,38}[a-z0-9+#]$/;

/**
 * An unlisted label worth keeping: short, plain characters, and nothing shaped like a phone or
 * ID number, an email or a link. Upstream (shared/resume) already emits only curated names; this
 * is the second lock, because these labels can reach a server inside MatchSignals.
 */
function isPlainLabel(label: string): boolean {
  return UNLISTED_LABEL.test(label) && !looksLikeContactDetail(label);
}

/** A skill reference is a vocabulary id or `x:{label}` for an unlisted skill. */
export const SKILL_REF_PATTERN = /^(?:[a-z_]{2,40}|x:[a-z0-9][a-z0-9 +#./-]{0,38}[a-z0-9+#])$/;

/** Display label for a skill reference (chips and "What's missing" lists). */
export function skillLabel(ref: string): string {
  const def = BY_ID.get(ref);
  if (def) return def.label;
  return ref.startsWith(UNLISTED_SKILL_PREFIX) ? ref.slice(UNLISTED_SKILL_PREFIX.length) : ref;
}

/** The skill as a reason names it mid-sentence: "Uses Python and data analysis from your resume". */
export function skillPhrase(ref: string): string {
  const def = BY_ID.get(ref);
  return def?.phrase ?? skillLabel(ref);
}

/**
 * Whole skill entries that name a vocabulary skill without containing one of its aliases. They
 * apply only when an entry IS the name (a resume's skills list, a program's listed skills),
 * never to sentences, because most would misfire in prose: "react to feedback", "Latin
 * America", "a Chinese history course". Single letters are safe here for the same reason: in a
 * skills list, "R" and "C" are languages.
 *
 * Every language other than English becomes the one "A second language" skill. That keeps
 * matching working (programs ask for "bilingual" students) and drops a detail that can hint at
 * national origin, ethnicity, religion or deafness, which matching never needs.
 */
const LANGUAGE_NAMES = [
  "spanish", "french", "mandarin", "cantonese", "chinese", "japanese", "korean", "german", "italian", "portuguese",
  "arabic", "hindi", "urdu", "bengali", "russian", "vietnamese", "tagalog", "filipino", "hebrew", "turkish", "persian",
  "farsi", "polish", "greek", "swahili", "haitian creole", "creole", "latin", "punjabi", "gujarati", "tamil", "telugu",
  "somali", "amharic", "ukrainian", "dutch", "swedish", "norwegian", "danish", "yoruba", "igbo", "hmong", "thai",
  "indonesian", "malay", "nepali", "marathi", "kannada", "malayalam", "khmer", "lao", "burmese", "pashto", "dari",
  "american sign language", "asl", "sign language",
] as const;

const NAME_SYNONYMS: Readonly<Record<string, readonly SkillId[]>> = {
  c: ["c_cpp"],
  r: ["r_lang"],
  react: ["javascript", "web_development"],
  "react.js": ["javascript", "web_development"],
  "next.js": ["javascript", "web_development"],
  "vue.js": ["javascript", "web_development"],
  vue: ["javascript", "web_development"],
  angular: ["javascript", "web_development"],
  svelte: ["javascript", "web_development"],
  jquery: ["javascript", "web_development"],
  "express.js": ["javascript", "web_development"],
  express: ["javascript", "web_development"],
  redux: ["javascript", "web_development"],
  "three.js": ["javascript"],
  "d3.js": ["javascript", "data_analysis"],
  expo: ["javascript", "mobile_development"],
  bootstrap: ["web_development"],
  sass: ["web_development"],
  wordpress: ["web_development"],
  webflow: ["web_development"],
  graphql: ["web_development"],
  "rest apis": ["web_development"],
  "asp.net": ["web_development"],
  django: ["python", "web_development"],
  flask: ["python", "web_development"],
  fastapi: ["python", "web_development"],
  matplotlib: ["python", "data_analysis"],
  seaborn: ["python", "data_analysis"],
  plotly: ["data_analysis"],
  "apache spark": ["data_analysis"],
  hadoop: ["data_analysis"],
  airflow: ["data_analysis"],
  dbt: ["data_analysis"],
  etl: ["data_analysis"],
  looker: ["data_analysis"],
  bioinformatics: ["data_analysis"],
  snowflake: ["sql"],
  bigquery: ["sql"],
  sas: ["statistics"],
  keras: ["machine_learning"],
  opencv: ["machine_learning"],
  "hugging face": ["machine_learning"],
  "large language models": ["machine_learning"],
  "reinforcement learning": ["machine_learning"],
  gitlab: ["git"],
  bitbucket: ["git"],
  qpcr: ["lab_techniques"],
  "western blot": ["lab_techniques"],
  chromatography: ["lab_techniques"],
  elisa: ["lab_techniques"],
  crispr: ["lab_techniques"],
  "flow cytometry": ["lab_techniques"],
  "dna extraction": ["lab_techniques"],
  "mass spectrometry": ["lab_techniques"],
  nmr: ["lab_techniques"],
  "lab safety": ["lab_techniques"],
  catia: ["cad"],
  revit: ["cad"],
  sketchup: ["cad"],
  "cnc machining": ["cad"],
  labview: ["circuits"],
  "embedded systems": ["circuits"],
  "adobe xd": ["ux_design"],
  sketch: ["ux_design"],
  "ui design": ["ux_design"],
  "adobe after effects": ["video"],
  "after effects": ["video"],
  "davinci resolve": ["video"],
  qualtrics: ["research_methods"],
  redcap: ["research_methods"],
  nvivo: ["research_methods"],
  "product management": ["project_management"],
  "public relations": ["marketing"],
  salesforce: ["marketing"],
  hubspot: ["marketing"],
  budgeting: ["accounting"],
  "bloomberg terminal": ["financial_modeling"],
  "capital iq": ["financial_modeling"],
  factset: ["financial_modeling"],
  pitchbook: ["financial_modeling"],
  mentoring: ["tutoring"],
  ...Object.fromEntries(LANGUAGE_NAMES.map((name) => [name, ["languages"] as const])),
};

/** Lowercased, whitespace-collapsed entry with a trailing qualifier dropped: "Spanish (fluent)" -> "spanish". */
function entryKey(entry: string): string {
  return entry
    .toLowerCase()
    .replace(/\s*\([^)]*\)\s*$/, "")
    .replace(/\s*[-:–]\s*(?:native|fluent|proficient|conversational|intermediate|beginner|basic|advanced)\b.*$/, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** Vocabulary ids for an entry that is exactly a skill's name, label or synonym; empty otherwise. */
export function skillsForName(entry: string): SkillId[] {
  const key = entryKey(entry);
  if (!key) return [];
  const synonyms = NAME_SYNONYMS[key];
  if (synonyms) return [...synonyms];
  const byLabel = LABEL_INDEX.get(key);
  return byLabel ? [byLabel] : [];
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Aliases normalized once to space-joined words. Detection then builds the set of 1..N-word
 * phrases in a text (N = the longest alias) and looks each alias up, which keeps scanning a
 * whole catalogue cheap on a phone.
 */
const NORMALIZED_ALIASES: ReadonlyMap<string, readonly string[]> = new Map(
  SKILLS.map((s) => [s.id, (s.aliases as readonly string[]).map((a) => normalizeForMatch(a).trim()).filter((a) => a.length > 0)]),
);
const MAX_ALIAS_WORDS = Math.max(...[...NORMALIZED_ALIASES.values()].flat().map((a) => a.split(" ").length));

function phraseSet(normalized: string): Set<string> {
  const words = normalized.trim().split(" ").filter(Boolean);
  const out = new Set<string>();
  for (let i = 0; i < words.length; i++) {
    let phrase = "";
    for (let n = 0; n < MAX_ALIAS_WORDS && i + n < words.length; n++) {
      phrase = n === 0 ? (words[i] as string) : `${phrase} ${words[i + n]}`;
      out.add(phrase);
    }
  }
  return out;
}

/** Case-sensitive token patterns, compiled once. */
const EXACT_PATTERNS: ReadonlyMap<string, readonly RegExp[]> = new Map(
  (SKILLS as readonly SkillDef[]).map((s) => [s.id, (s.exactTokens ?? []).map((t) => new RegExp(`(^|[^A-Za-z0-9+#])${escapeRegExp(t)}(?![A-Za-z0-9+#])`))]),
);

const PROGRAMMING_CONTEXT = /\b(?:python|java|javascript|sql|matlab|programming|programs?|languages?|coding|code|software|statistics|rstudio|c\+\+|linux|computer)\b/i;

/** Skill ids whose aliases or tokens occur in `text`, in vocabulary order. */
export function detectSkills(text: string): SkillId[] {
  if (!text) return [];
  const phrases = phraseSet(normalizeForMatch(text));
  let context: boolean | null = null;
  const found: SkillId[] = [];
  for (const skill of SKILLS as readonly (SkillDef & { id: SkillId })[]) {
    let hit = (NORMALIZED_ALIASES.get(skill.id) ?? []).some((alias) => phrases.has(alias));
    if (!hit && skill.exactTokens) {
      context ??= PROGRAMMING_CONTEXT.test(text);
      if (!skill.needsContext || context) hit = (EXACT_PATTERNS.get(skill.id) ?? []).some((re) => re.test(text));
    }
    if (hit) found.push(skill.id);
  }
  return found;
}


/** Something that names a skill: a plain string or an object from shared/resume's normalizer. */
export type SkillLike =
  | string
  | {
      readonly id?: unknown;
      readonly canonical?: unknown;
      readonly label?: unknown;
      readonly name?: unknown;
      readonly confirmed?: unknown;
    };

function candidates(entry: SkillLike): string[] {
  if (typeof entry === "string") return [entry];
  const out: string[] = [];
  for (const v of [entry.id, entry.canonical, entry.label, entry.name]) if (typeof v === "string" && v.trim()) out.push(v);
  return out;
}

/**
 * Folds whatever shape the resume module or the quiz produced into skill references:
 * vocabulary ids where a label or alias matches, `x:{label}` for other short, plain labels,
 * and nothing for anything else (long strings, odd characters). Entries explicitly marked
 * `confirmed: false` are dropped, because the student rejected them.
 */
export function normalizeSkillRefs(raw: readonly SkillLike[] | undefined | null, max = 30): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (ref: string): void => {
    if (!seen.has(ref) && out.length < max) {
      seen.add(ref);
      out.push(ref);
    }
  };
  for (const entry of raw ?? []) {
    if (typeof entry === "object" && entry !== null && entry.confirmed === false) continue;
    const texts = candidates(entry);
    let matched = false;
    for (const t of texts) {
      const trimmed = t.trim();
      if (BY_ID.has(trimmed)) {
        push(trimmed);
        matched = true;
        break;
      }
      if (trimmed.startsWith(UNLISTED_SKILL_PREFIX) && isPlainLabel(trimmed.slice(UNLISTED_SKILL_PREFIX.length))) {
        const label = trimmed.slice(UNLISTED_SKILL_PREFIX.length);
        const ids = skillsForName(label);
        const found = ids.length > 0 ? ids : detectSkills(label);
        if (found.length > 0) for (const id of found) push(id);
        else push(trimmed);
        matched = true;
        break;
      }
      // An entry that is a skill's name ("R", "React", "Spanish") before scanning it as prose.
      const named = skillsForName(trimmed);
      if (named.length > 0) {
        for (const id of named) push(id);
        matched = true;
        break;
      }
      const ids = detectSkills(trimmed);
      if (ids.length > 0) {
        for (const id of ids) push(id);
        matched = true;
        break;
      }
    }
    if (matched) continue;
    // Not in the vocabulary: keep a short, plain label for lexical search only.
    const label = (texts[texts.length - 1] ?? "").toLowerCase().replace(/\s+/g, " ").trim();
    if (isPlainLabel(label)) push(`${UNLISTED_SKILL_PREFIX}${label}`);
  }
  return out;
}

/** Vocabulary skills ordered for a chip list: preferred families first, then the rest. */
export function skillsForFamilies(families: readonly string[]): SkillId[] {
  const wanted = new Set(families);
  const scored = (SKILLS as readonly (SkillDef & { id: SkillId })[]).map((s, index) => ({
    id: s.id,
    hits: s.families.filter((f) => wanted.has(f)).length,
    index,
  }));
  scored.sort((a, b) => b.hits - a.hits || a.index - b.index || compareStrings(a.id, b.id));
  return scored.map((s) => s.id);
}

/**
 * Skills a program asks for: its listed skills and those its text names, vocabulary ids only.
 * Unlisted labels are dropped on the program side, because a tag such as "civic tech" passed in
 * as a skill would otherwise show up in the student's "What's missing" list.
 */
export function programSkills(listed: readonly string[] | undefined, text: string): SkillId[] {
  const ids = new Set<string>(normalizeSkillRefs(listed ?? []).filter((r) => BY_ID.has(r)));
  for (const id of detectSkills(text)) ids.add(id);
  return SKILL_IDS.filter((id) => ids.has(id));
}
