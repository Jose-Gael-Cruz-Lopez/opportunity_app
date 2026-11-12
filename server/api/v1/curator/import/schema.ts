import { z } from "zod";
import {
  DEADLINE_KINDS,
  IDENTITY_CATEGORIES,
  OPPORTUNITY_TYPES,
  ORGANIZATION_KINDS,
  RECURRENCES,
  type OpportunityTypeSlug,
} from "../../../../../shared/taxonomy";
import { isIsoDate } from "../../../../../shared/time/iso";
import { canonicalUrl, cleanLine, cleanText, normalizeName } from "./normalize";

/**
 * The candidate shape: one row per program a researcher found, written as JSON (an array, or an
 * object with a `candidates` array) or as a CSV sheet with one row per candidate. Keys are
 * matched loosely: `Official URL`, `official_url` and `officialUrl` are the same column, and a
 * few common aliases are accepted (`url`, `org`, `type`, `deadline`). docs/registry-import.md
 * lists every column.
 *
 * Everything a researcher writes is UNVERIFIED. The importer stores only what a draft Program
 * needs (name, Organization, official URL, types, the two audience flags) and carries the rest
 * (term, deadlines, eligibility notes, quotes) to the Curator as a proposal on the review task.
 * Nothing here becomes a FieldEvidence row or a verified fact.
 */

// ---- Key normalization ----------------------------------------------------------------------

/** `Official URL`, `official-url`, `official_url` -> `officialUrl`. */
export function camelKey(key: string): string {
  const words = cleanLine(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  return words.map((w, i) => (i === 0 ? w : w[0]!.toUpperCase() + w.slice(1))).join("");
}

const ALIASES: Readonly<Record<string, string>> = {
  program: "name",
  programName: "name",
  title: "name",
  org: "organization",
  orgName: "organization",
  organizationName: "organization",
  sponsor: "organization",
  organizer: "organization",
  provider: "organization",
  orgKind: "organizationKind",
  orgType: "organizationKind",
  organizationType: "organizationKind",
  country: "organizationCountry",
  orgCountry: "organizationCountry",
  orgUrl: "organizationUrl",
  orgWebsite: "organizationUrl",
  organizationWebsite: "organizationUrl",
  url: "officialUrl",
  link: "officialUrl",
  officialLink: "officialUrl",
  programUrl: "officialUrl",
  website: "officialUrl",
  sourceUrl: "officialUrl",
  applyUrl: "applicationUrl",
  applyLink: "applicationUrl",
  applicationLink: "applicationUrl",
  portalUrl: "applicationUrl",
  type: "types",
  opportunityType: "types",
  opportunityTypes: "types",
  category: "types",
  cycle: "term",
  termLabel: "term",
  season: "term",
  deadline: "deadlines",
  eligibilityNotes: "eligibility",
  whoCanApply: "eligibility",
  quotes: "evidence",
  evidenceQuotes: "evidence",
  summary: "notes",
  description: "notes",
  comments: "notes",
  note: "notes",
  researchedBy: "researcher",
  addedBy: "researcher",
  checkedAt: "checkedOn",
  verifiedOn: "checkedOn",
  lastChecked: "checkedOn",
  researchedOn: "checkedOn",
  foundOn: "checkedOn",
  id: "externalId",
  listId: "externalId",
  sourceId: "externalId",
  tag: "tags",
};

/** Columns a CSV row may use for its one deadline and one quote (see `fromCsvRecord`). */
const CSV_ONLY = new Set(["deadlineDate", "deadlineKind", "deadlineTime", "deadlineTimeZone", "deadlineLabel", "deadlineQuote", "deadlineUrl", "quote", "quoteField", "quoteUrl", "quotePage"]);

export const CANDIDATE_KEYS = [
  "name",
  "organization",
  "organizationKind",
  "organizationUrl",
  "organizationCountry",
  "officialUrl",
  "applicationUrl",
  "types",
  "recurrence",
  "term",
  "deadlines",
  "eligibility",
  "evidence",
  "sensitiveAudience",
  "identityAudience",
  "tags",
  "notes",
  "researcher",
  "checkedOn",
  "externalId",
] as const;
const KNOWN = new Set<string>(CANDIDATE_KEYS);

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function isBlank(v: unknown): boolean {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

/** Renames keys to camelCase and canonical names; blank values are dropped. Unknown keys are reported, never kept. */
export function normalizeKeys(raw: Record<string, unknown>, aliases = ALIASES, known: ReadonlySet<string> | null = KNOWN): { record: Record<string, unknown>; ignored: string[] } {
  const record: Record<string, unknown> = {};
  const ignored: string[] = [];
  for (const [k, v] of Object.entries(raw)) {
    if (isBlank(v)) continue;
    const camel = camelKey(k);
    const key = aliases[camel] ?? camel;
    if (known && !known.has(key) && !CSV_ONLY.has(key)) {
      // Only identifier-shaped names are reported back; anything else could be free text.
      ignored.push(/^[A-Za-z0-9 _-]{1,60}$/.test(k) ? k : "(column)");
      continue;
    }
    if (key in record) continue; // first spelling wins
    record[key] = v;
  }
  return { record, ignored };
}

// ---- Field schemas ------------------------------------------------------------------------------

const line = (max: number) =>
  z
    .string({ invalid_type_error: "Must be text" })
    .transform(cleanLine)
    .pipe(z.string().min(1, "Must not be empty").max(max, `At most ${max} characters`));

const prose = (max: number) =>
  z
    .string({ invalid_type_error: "Must be text" })
    .transform(cleanText)
    .pipe(z.string().min(1, "Must not be empty").max(max, `At most ${max} characters`));

/** An http(s) URL on a public host, returned in canonical form. */
export const HttpUrlSchema = z.string({ invalid_type_error: "Must be a URL" }).transform((v, ctx) => {
  const c = canonicalUrl(v);
  if (!c.ok) {
    const message =
      c.problem === "scheme" ? "Must start with http:// or https://" : c.problem === "credentials" ? "Must not contain a user name or password" : c.problem === "private_host" ? "Must be a public domain name" : "Not a valid URL";
    ctx.addIssue({ code: z.ZodIssueCode.custom, message });
    return z.NEVER;
  }
  return c.url;
});

/** A list from an array, or from text split on `;`, `|` or new lines (CSV cells). */
function listOf<T extends z.ZodTypeAny>(item: T, max: number) {
  return z.preprocess(
    (v) =>
      typeof v === "string"
        ? v
            .split(/[;|\n]/)
            .map((s) => s.trim())
            .filter(Boolean)
        : v,
    z.array(item).max(max, `At most ${max} entries`),
  );
}

const TRUE_WORDS = new Set(["true", "yes", "y", "1", "x"]);
const FALSE_WORDS = new Set(["false", "no", "n", "0"]);
const BoolSchema = z.preprocess((v) => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v === 1 ? true : v === 0 ? false : v;
  if (typeof v === "string") {
    const w = v.trim().toLowerCase();
    if (TRUE_WORDS.has(w)) return true;
    if (FALSE_WORDS.has(w)) return false;
  }
  return v;
}, z.boolean({ invalid_type_error: "Must be yes or no" }));

/**
 * The broad one-word types researchers write (seen in the first candidate files, 2026-11-11),
 * each read as the closest taxonomy slug. A broad word is a starting point: the Curator confirms
 * or changes the type when reviewing the draft (docs/registry-import.md).
 */
export const RESEARCHER_TYPE_WORDS: Readonly<Record<string, OpportunityTypeSlug>> = {
  research: "research_program",
  internship: "summer_internship",
  fellowship: "undergraduate_fellowship",
  scholarship: "private_scholarship",
  sprint: "sprinternship",
  conference: "conference_travel",
  insight_week: "early_career_exposure",
  insight: "early_career_exposure",
  spring_week: "uk_spring_week",
  hackathon: "competition",
};

const TYPE_BY_KEY: ReadonlyMap<string, (typeof OPPORTUNITY_TYPES)[number]> = (() => {
  const m = new Map<string, (typeof OPPORTUNITY_TYPES)[number]>();
  for (const t of OPPORTUNITY_TYPES) {
    m.set(t.slug, t);
    m.set(normalizeName(t.slug.replace(/_/g, " ")), t);
    m.set(normalizeName(t.label), t);
  }
  for (const [word, slug] of Object.entries(RESEARCHER_TYPE_WORDS)) {
    const t = OPPORTUNITY_TYPES.find((x) => x.slug === slug);
    if (!t) throw new Error(`researcher type word ${word} names unknown slug ${slug}`);
    if (!m.has(word)) m.set(word, t);
    const spaced = normalizeName(word.replace(/_/g, " "));
    if (!m.has(spaced)) m.set(spaced, t);
  }
  return m;
})();

/** An opportunity type by slug (`research_program`) or by its label ("Research programs (REU, SURF, labs)"). */
export const OpportunityTypeRefSchema = z.string({ invalid_type_error: "Must be text" }).transform((v, ctx): OpportunityTypeSlug => {
  const found = TYPE_BY_KEY.get(cleanLine(v).toLowerCase()) ?? TYPE_BY_KEY.get(normalizeName(v));
  if (!found) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Unknown opportunity type: use a slug from shared/taxonomy" });
    return z.NEVER;
  }
  if (!found.inScope) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: "This opportunity type is out of scope" });
    return z.NEVER;
  }
  return found.slug;
});

/** A date as written. ISO dates are kept as `isoDate` too, for ordering the review queue. */
const DateTextSchema = line(60);

const DeadlineProposalSchema = z.preprocess(
  (v) => (typeof v === "string" ? { date: v } : isRecord(v) ? normalizeKeys(v, { dueDate: "date", deadline: "date", type: "kind", tz: "timeZone", zone: "timeZone", round: "label", url: "evidenceUrl", source: "evidenceUrl", sourceUrl: "evidenceUrl" }, null).record : v),
  z
    .object({
      kind: z.enum(DEADLINE_KINDS, { errorMap: () => ({ message: "Unknown deadline kind" }) }).default("application"),
      date: DateTextSchema,
      time: line(20).optional(),
      timeZone: line(60).optional(),
      label: line(120).optional(),
      quote: prose(1000).optional(),
      evidenceUrl: HttpUrlSchema.optional(),
    })
    .strip()
    .transform((d) => ({ ...d, isoDate: isIsoDate(d.date) ? d.date : null })),
);
export type DeadlineProposal = z.output<typeof DeadlineProposalSchema>;

const EvidenceProposalSchema = z.preprocess(
  (v) => (isRecord(v) ? normalizeKeys(v, { source: "url", sourceUrl: "url", evidenceUrl: "url", text: "quote" }, null).record : v),
  z
    .object({
      field: line(60).default("general"),
      url: HttpUrlSchema,
      quote: prose(1000),
      page: z.coerce.number().int().min(1).max(10_000).optional(),
    })
    .strip(),
);
export type EvidenceProposal = z.output<typeof EvidenceProposalSchema>;

/** A Curator or researcher handle such as "Novus Curator AB". Never an email address or a person's full contact. */
const HandleSchema = z
  .string({ invalid_type_error: "Must be text" })
  .transform(cleanLine)
  .pipe(z.string().regex(/^[A-Za-z0-9][A-Za-z0-9 ._-]{0,59}$/, "Use a public handle (letters, digits, spaces, . _ -), never an email address"));

const CheckedOnSchema = z
  .string({ invalid_type_error: "Must be a date" })
  .transform((v) => cleanLine(v).slice(0, 10))
  .refine(isIsoDate, "Use YYYY-MM-DD");

export const CandidateSchema = z
  .object({
    name: line(200),
    organization: line(200),
    organizationKind: z.enum(ORGANIZATION_KINDS, { errorMap: () => ({ message: "Unknown organization kind" }) }).optional(),
    organizationUrl: HttpUrlSchema.optional(),
    organizationCountry: z
      .string({ invalid_type_error: "Must be text" })
      .transform((v) => cleanLine(v).toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}$/, "Use a two-letter country code such as US or GB"))
      .optional(),
    officialUrl: HttpUrlSchema,
    applicationUrl: HttpUrlSchema.optional(),
    types: listOf(OpportunityTypeRefSchema, 5).pipe(z.array(z.string()).min(1, "Give at least one opportunity type")),
    recurrence: z.enum(RECURRENCES, { errorMap: () => ({ message: "Unknown recurrence" }) }).optional(),
    term: line(60).optional(),
    deadlines: z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(DeadlineProposalSchema).max(10, "At most 10 deadlines")).default([]),
    eligibility: listOf(prose(500), 20).default([]),
    evidence: z.preprocess((v) => (v === undefined || Array.isArray(v) ? v : [v]), z.array(EvidenceProposalSchema).max(30, "At most 30 quotes")).default([]),
    sensitiveAudience: BoolSchema.optional(),
    identityAudience: listOf(z.enum(IDENTITY_CATEGORIES, { errorMap: () => ({ message: "Unknown identity category" }) }), 10).optional(),
    tags: listOf(line(40), 20).default([]),
    notes: prose(2000).optional(),
    researcher: HandleSchema.optional(),
    checkedOn: CheckedOnSchema.optional(),
    externalId: z
      .union([z.string(), z.number()])
      .transform((v) => cleanLine(String(v)))
      .pipe(z.string().regex(/^[A-Za-z0-9._:-]{1,80}$/, "Use letters, digits and . _ : - (at most 80)"))
      .optional(),
  })
  .strip();
export type Candidate = Omit<z.output<typeof CandidateSchema>, "types"> & { types: OpportunityTypeSlug[] };

// ---- Flat (CSV) columns -------------------------------------------------------------------------

/**
 * Folds the flat deadline and quote columns into lists. A CSV row carries at most one deadline (`deadline`, `deadline_kind`, `deadline_time`,
 * `deadline_time_zone`, `deadline_label`, `deadline_quote`, `deadline_url`) and one quote
 * (`quote`, `quote_field`, `quote_url`, `quote_page`); a second deadline goes in another
 * row of a JSON file. List cells (`types`, `tags`, `eligibility`) split on `;` or `|`.
 */
export function fromFlatColumns(record: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(record)) if (!CSV_ONLY.has(k)) out[k] = v;
  const date = record.deadlineDate ?? (typeof record.deadlines === "string" ? record.deadlines : undefined);
  // A structured `deadlines` list or `evidence` list (JSON) wins over the flat columns.
  if (date !== undefined && (record.deadlines === undefined || typeof record.deadlines === "string")) {
    out.deadlines = [
      {
        date,
        kind: record.deadlineKind,
        time: record.deadlineTime,
        timeZone: record.deadlineTimeZone,
        label: record.deadlineLabel,
        quote: record.deadlineQuote,
        evidenceUrl: record.deadlineUrl,
      },
    ].map((d) => Object.fromEntries(Object.entries(d).filter(([, x]) => !isBlank(x))));
  }
  if (record.quote !== undefined && record.evidence === undefined) {
    out.evidence = [Object.fromEntries(Object.entries({ quote: record.quote, field: record.quoteField, url: record.quoteUrl ?? record.officialUrl, page: record.quotePage }).filter(([, x]) => !isBlank(x)))];
  }
  return out;
}
