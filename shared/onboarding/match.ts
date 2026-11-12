import type { StudentProfile } from "../contracts/student";
import { isoWeekKey, rotationKey } from "../matching/text";
import { type ClassYear, type OpportunityCategory } from "../taxonomy";
import { parseCycleKey } from "../time/terms";
import { resolveZone, todayIn, toEpochMs, type NowInput } from "./dates";
import { defaultEligibility, toChecks, type EligibilityAdapter, type EligibilityOutcome } from "./eligibility";
import { computeFeasibility, onOffer, type FeasibilityResult } from "./feasibility";
import type MiniSearch from "minisearch";
import { buildLexicalIndex, lexicalSearch, type LexicalDoc } from "./lexical";
import { preferencesToProfile } from "./quiz";
import {
  cosine,
  exposureBoost,
  LIST_DEPTH,
  median,
  mmrSelect,
  ranksWithTies,
  reciprocalRankFusion,
  type MmrCandidate,
} from "./rank";
import { pickReasons, reason, type Reason } from "./reasons";
import type { PrepModel } from "./schedule";
import { courseworkSkills, toMatchSignals } from "./signals";
import { normalizeSkillRefs, programSkills, skillById, skillLabel, skillPhrase, UNLISTED_SKILL_PREFIX } from "./skills";
import { compareStrings, hasPhrase, normalizeForMatch } from "./text";
import type {
  MatchItem,
  MatchSet,
  MatchSignals,
  OnboardingProgram,
  ServerPreferences,
  SignalsInput,
  StudentPreferences,
  Tier,
} from "./types";
import {
  categoriesForTypes,
  ENTRY_LEVEL_TYPES,
  interestTopic,
  PAIRS,
  pairSide,
  type InterestTopic,
} from "./vocab";

/**
 * findMatches: a transparent hybrid pipeline that runs on the device (or in the Worker with
 * non-sensitive inputs only).
 *
 *  1. Hard filters: hidden ("Not for me"), status-defined programs unless the device opts in,
 *     closed or far-off cycles, every deadline passed or start-by more than 30 days gone,
 *     eligibility "not eligible" (shared/eligibility's engine on the non-sensitive profile),
 *     "must be paid" against known-unpaid programs, "remote only" against known in-person
 *     programs. Missing data never excludes.
 *  2. Ranked lists over the survivors (top 50 each): lexical BM25+ over program text, skill
 *     coverage |S∩R|/|R|, satisfied preference facets, feasibility slack, and an optional
 *     on-device semantic list when the server supplies program vectors.
 *  3. Reciprocal Rank Fusion, k = 60, equal weights. Internal only.
 *  4. Tiers by rules, not thresholds on the fused value (strong / good / stretch).
 *  5. Exposure boost for programs seen less than their merit warrants (plan 06), within tiers;
 *     exact ties break by plan 06's weekly rotation, so no program wins every tie by its name.
 *  6. MMR (lambda 0.7) inside each tier, at most two programs per organization, and when the
 *     student asked for several kinds, at least two of them among a tier's first six.
 *  7. Never an empty screen: too few of the asked-for types and other types with real content
 *     evidence fill in as stretches; a student who told us too little to match on (everything
 *     skipped, "not sure") gets open, feasible programs that need no experience or welcome
 *     their year, labelled as picks to explore.
 *
 * Output: tiers, plain reasons, feasibility and requirement counts. No score, percentage or
 * fused value is ever returned.
 */

export const ALGO_VERSION = "onboarding-match-2026.11.2";
export const DEFAULT_K = 10;
export const MAX_K = 30;
export const MMR_LAMBDA = 0.7;
export const MMR_POOL = 30;
export const ORG_CAP = 2;
/** Below this many matches, other types fill in as stretches so the screen is never empty. */
export const MIN_RESULTS = 3;
/** Feasibility slack beyond this many days counts as equally comfortable. */
const SLACK_CAP_DAYS = 60;
/** The years Novus is built for; a program that lists one welcomes a student who skipped the year question. */
const EARLY_YEARS: readonly ClassYear[] = ["first_year", "second_year", "incoming_first_year"];

/** Optional semantic list. Program vectors are computed offline; the student vector only on the device. */
export interface SemanticHook {
  readonly studentVector: ArrayLike<number>;
  readonly programVectors: Readonly<Record<string, ArrayLike<number>>>;
}

export interface FindMatchesInput {
  readonly preferences: StudentPreferences | ServerPreferences;
  readonly signals?: SignalsInput | MatchSignals | null;
  readonly programs: readonly OnboardingProgram[];
  readonly now: NowInput;
  readonly k?: number;
  /**
   * Eligibility evaluator; defaults to shared/eligibility's engine on the non-sensitive profile.
   * A browser may pass a wrapper that also reads the student's private answers on the device.
   */
  readonly eligibility?: EligibilityAdapter;
  /** Merit-normalized exposure per programId, from the server (plan 06 6.6.2). Absent: no boost. */
  readonly exposure?: Readonly<Record<string, number>>;
  readonly semantic?: SemanticHook | null;
  /** Program ids the student hid with "Not for me" (kept on the device for 90 days). */
  readonly hidden?: readonly string[];
  /** Device-only opt-in to status-defined programs (sensitiveAudience); never set on a server. */
  readonly includeSensitiveAudience?: boolean;
  readonly prepModel?: PrepModel;
}

interface Ctx {
  readonly prefs: StudentPreferences | ServerPreferences;
  readonly target: string | null;
  readonly nowMs: number;
  readonly tz: string;
  readonly today: string;
  /** ISO week of today, for the rotating tie-break. */
  readonly week: string;
  readonly skills: ReadonlySet<string>;
  readonly fromResume: ReadonlySet<string>;
  readonly categories: ReadonlySet<OpportunityCategory>;
  readonly interests: readonly { topic: InterestTopic; terms: readonly string[] }[];
  readonly profile: StudentProfile;
  readonly eligibility: EligibilityAdapter;
  readonly nextSummerYear: number;
  readonly queryTerms: readonly string[];
  /** True when the student gave anything about content: interests, a declared major, skills or a named program. */
  readonly hasContent: boolean;
  /** True when the student said what kind of opportunity they want (categories or a this-or-that leaning). */
  readonly hasKind: boolean;
}

interface Candidate {
  readonly p: OnboardingProgram;
  readonly id: string;
  readonly org: string;
  /** Rotation key then slug: the deterministic tie-break that changes weekly (plan 06). */
  readonly tieKey: string;
  readonly categories: OpportunityCategory[];
  readonly typeOk: boolean;
  readonly elig: EligibilityOutcome;
  readonly feas: FeasibilityResult;
  readonly required: string[];
  readonly matched: string[];
  readonly missingSkills: string[];
  readonly coverage: number | null;
  readonly interestIds: string[];
  readonly majorMatch: boolean;
  readonly fieldMatch: boolean;
  readonly needsNoExperience: boolean;
  /** The program lists the student's class year (or, when they skipped it, a first- or second-year one). */
  readonly openToStudent: boolean;
  readonly leaningTexts: string[];
  readonly facetCount: number;
  readonly facetTexts: string[];
  readonly target: boolean;
  readonly met: number;
  readonly total: number;
  readonly missing: string[];
  readonly features: ReadonlySet<string>;
  /** Unlisted skills from the resume (x: labels) that the program's text names as whole words. */
  readonly mentioned: string[];
}

// ---------------------------------------------------------------------------------------------

export function findMatches(input: FindMatchesInput): MatchSet {
  const ctx = buildContext(input);
  const k = Math.max(1, Math.min(MAX_K, Math.floor(input.k ?? DEFAULT_K)));
  const hidden = new Set(input.hidden ?? []);
  // Sort first so nothing depends on the order the caller passed programs in.
  const programs = sortedPrograms(input.programs);

  const assessed: Candidate[] = [];
  for (const p of programs) {
    if (hidden.has(p.programId)) continue;
    const c = assess(p, ctx, input);
    if (c) assessed.push(c);
  }

  const strict = assessed.filter((c) => c.typeOk);
  const ranked = rankPool(strict, ctx, input);
  const tiers: Record<Tier, RankedCandidate[]> = { strong: [], good: [], stretch: [] };
  for (const r of ranked) {
    const t = tierOf(r.c, ctx);
    if (t) tiers[t].push(r);
  }
  const included = new Set([...tiers.strong, ...tiers.good, ...tiers.stretch].map((r) => r.c.id));

  // Too few of the asked-for types: other types fill in after every strict match, as stretches,
  // and only with real content evidence (never on a lexical hit alone).
  let extra: RankedCandidate[] = [];
  if (included.size < Math.min(MIN_RESULTS, k) && ctx.categories.size > 0) {
    const others = assessed.filter((c) => !c.typeOk);
    extra = rankPool(others, ctx, input)
      .filter((r) => r.c.fieldMatch || r.c.matched.length > 0 || r.c.mentioned.length > 0 || r.c.target)
      .map((r) => ({ ...r, relaxed: true }));
    for (const r of extra) included.add(r.c.id);
  }

  // Still too few, usually because the student told us too little to match on: open, feasible
  // programs that need no experience or welcome their year, labelled as picks to explore. A
  // student who gave nothing at all gets a full list; anyone else only enough to fill the screen.
  // Programs whose rules Novus has checked come before ones it has not. Programs for a specific
  // community are left out: knowing nothing about the student, Novus does not guess at that.
  const exploreTarget = !ctx.hasContent && !ctx.hasKind ? k : Math.min(MIN_RESULTS, k);
  let exploreChecked: RankedCandidate[] = [];
  let exploreUnchecked: RankedCandidate[] = [];
  if (included.size < exploreTarget) {
    const pool = assessed.filter(
      (c) => !included.has(c.id) && c.feas.enoughTime && (c.needsNoExperience || c.openToStudent) && !c.p.flags.identityAudience,
    );
    const explore = rankPool(pool, ctx, input).map((r) => ({
      ...r,
      explore: true,
      relaxed: ctx.categories.size > 0 && !r.c.typeOk,
    }));
    exploreChecked = explore.filter((r) => r.c.elig.status !== "unknown");
    exploreUnchecked = explore.filter((r) => r.c.elig.status === "unknown");
  }

  const orgCount = new Map<string, number>();
  const ordered: { r: RankedCandidate; tier: Tier }[] = [];
  const groups: readonly [Tier, readonly RankedCandidate[], number][] = [
    ["strong", tiers.strong, k],
    ["good", tiers.good, k],
    ["stretch", tiers.stretch, k],
    ["stretch", extra, k],
    ["stretch", exploreChecked, exploreTarget],
    ["stretch", exploreUnchecked, exploreTarget],
  ];
  for (const [tier, list, upTo] of groups) {
    const room = Math.min(k, upTo) - ordered.length;
    if (room <= 0) continue;
    const selected = diversify(list, room, orgCount, ctx.categories);
    ordered.push(...selected.map((r) => ({ r, tier })));
  }
  const widened = ordered.some(({ r }) => r.relaxed === true || r.explore === true);

  const items = ordered.slice(0, k).map(({ r, tier }) => toItem(r, tier, ctx));
  return {
    v: 1,
    algoVersion: ALGO_VERSION,
    asOf: ctx.today,
    timeZone: ctx.tz,
    items,
    counts: {
      strong: tiers.strong.length,
      good: tiers.good.length,
      stretch: tiers.stretch.length + extra.length + exploreChecked.length + exploreUnchecked.length,
      considered: input.programs.length,
      shown: items.length,
    },
    relaxed: widened,
    containsSample: items.some((i) => i.isSample),
  };
}

// ---------------------------------------------------------------------------------------------
// Context
// ---------------------------------------------------------------------------------------------

function buildContext(input: FindMatchesInput): Ctx {
  const prefs = input.preferences;
  const nowMs = toEpochMs(input.now);
  const tz = resolveZone(prefs.timeZone);
  const today = todayIn(nowMs, tz);
  const signals = toMatchSignals(input.signals ?? null);
  const signalSkills = new Set([...signals.skills, ...courseworkSkills(signals)]);
  const prefSkills = normalizeSkillRefs(prefs.skills);
  const skills = new Set(prefs.skillsConfirmed ? prefSkills : [...prefSkills, ...signalSkills]);
  const fromResume = new Set([...skills].filter((s) => signalSkills.has(s)));
  const interests = prefs.interests
    .map((id) => interestTopic(id))
    .filter((t): t is InterestTopic => t !== undefined)
    .map((topic) => ({ topic, terms: topic.terms.map((t) => normalizeForMatch(t)) }));
  const target = "target" in prefs && typeof prefs.target === "string" && prefs.target.trim() ? prefs.target.trim() : null;
  const month = Number(today.slice(5, 7));
  const year = Number(today.slice(0, 4));
  const declaredMajor = prefs.majorFamily !== null && prefs.majorFamily !== "undeclared";

  // The lexical query is OR-combined words, so a multi-word phrase would match its words one by
  // one ("clean energy" would find "clean data"); phrases are matched exactly elsewhere (skill
  // detection, interest terms), and only single-word aliases and terms go into the query.
  const singleWords = (xs: readonly string[]): string[] => xs.filter((x) => !x.trim().includes(" "));
  const queryTerms: string[] = [];
  for (const s of skills) {
    queryTerms.push(skillLabel(s));
    const def = skillById(s);
    if (def) queryTerms.push(...singleWords(def.aliases).slice(0, 2));
  }
  for (const { topic } of interests) queryTerms.push(topic.label, ...singleWords(topic.terms));
  if (declaredMajor && prefs.majorFamily) queryTerms.push(prefs.majorFamily.replace(/_/g, " "));
  queryTerms.push(...signals.coursework);

  const { style, length, value } = prefs.leanings;
  return {
    prefs,
    target,
    nowMs,
    tz,
    today,
    week: isoWeekKey(today),
    skills,
    fromResume,
    categories: new Set(prefs.categories),
    interests,
    profile: preferencesToProfile(prefs),
    eligibility: input.eligibility ?? defaultEligibility,
    nextSummerYear: month >= 6 ? year + 1 : year,
    queryTerms,
    hasContent: interests.length > 0 || declaredMajor || skills.size > 0 || signals.coursework.length > 0 || target !== null,
    hasKind: prefs.categories.length > 0 || style !== null || length !== null || value !== null,
  };
}

// ---------------------------------------------------------------------------------------------
// Per-program assessment (hard filters plus the evidence each list and reason needs)
// ---------------------------------------------------------------------------------------------

const PAY_KINDS: ReadonlySet<string> = new Set(["stipend", "salary_hourly", "award", "tuition"]);

function isPaid(p: OnboardingProgram): boolean {
  return p.flags.paid || (p.compensation !== null && PAY_KINDS.has(p.compensation.kind));
}

/** Known not to pay: no compensation, or travel costs only. Unknown compensation is not "unpaid". */
function knownUnpaid(p: OnboardingProgram): boolean {
  return p.compensation !== null && (p.compensation.kind === "none" || p.compensation.kind === "travel") && !p.flags.paid;
}

/**
 * Unlisted resume skills that are also everyday English words ("Students go from idea to
 * prototype", "build it from scratch", "Model UN General Assembly"). A bare whole-word hit on
 * these is not evidence, so they count only in a programming phrase or a known alias.
 */
const COMMON_WORD_SKILLS: ReadonlySet<string> = new Set([
  "go", "scratch", "assembly", "swift", "rust", "ruby", "dart", "julia", "crystal", "elm", "pascal", "ada",
  "basic", "logo", "spark", "flask", "express", "rails", "ember", "meteor", "unity", "ant", "processing",
  "shell", "bash", "chef", "puppet", "salt", "sage", "pandas", "access", "word", "teams", "slack", "notion",
  "outlook", "excel", "keynote", "pages", "numbers", "r", "c", "d",
]);

const SKILL_ALIASES: Readonly<Record<string, readonly string[]>> = {
  go: ["golang"],
  swift: ["swiftui"],
  rust: ["rustlang"],
  ruby: ["ruby on rails"],
  rails: ["ruby on rails"],
  assembly: ["x86", "arm assembly", "mips"],
  r: ["rstudio", "r studio"],
};

const SKILL_CONTEXT_AFTER = ["programming", "language", "lang", "developer", "developers", "development", "code", "coding", "programmer"];
const SKILL_CONTEXT_BEFORE = ["programming in", "coding in", "written in", "write in", "experience with", "knowledge of"];

/** True when the program text names an unlisted resume skill as a skill, not as a common word. */
export function mentionsUnlistedSkill(normalizedText: string, label: string): boolean {
  const key = normalizeForMatch(label).trim();
  if (!COMMON_WORD_SKILLS.has(key)) return hasPhrase(normalizedText, label);
  if ((SKILL_ALIASES[key] ?? []).some((a) => hasPhrase(normalizedText, a))) return true;
  return SKILL_CONTEXT_AFTER.some((w) => hasPhrase(normalizedText, `${key} ${w}`)) || SKILL_CONTEXT_BEFORE.some((w) => hasPhrase(normalizedText, `${w} ${key}`));
}

function programText(p: OnboardingProgram): string {
  return [p.name, ...p.aliases, ...p.interestTags.map((t) => t.replace(/[_-]+/g, " ")), p.summary ?? ""].join(" . ");
}

/** What never changes for a card: computed once per card object and reused across calls. */
interface ProgramStatic {
  readonly text: string;
  /** Name, aliases and interest tags only: the curated fields, without the free summary. */
  readonly tagText: string;
  readonly categories: OpportunityCategory[];
  readonly required: string[];
  readonly org: string;
  readonly features: ReadonlySet<string>;
}

const STATIC = new WeakMap<OnboardingProgram, ProgramStatic>();

function staticOf(p: OnboardingProgram): ProgramStatic {
  const hit = STATIC.get(p);
  if (hit) return hit;
  const raw = programText(p);
  const org = normalizeForMatch(p.organizationName).trim();
  const value: ProgramStatic = {
    text: normalizeForMatch(raw),
    tagText: normalizeForMatch([p.name, ...p.aliases, ...p.interestTags.map((t) => t.replace(/[_-]+/g, " "))].join(" . ")),
    categories: categoriesForTypes(p.opportunityTypes),
    required: programSkills(p.extras?.skills, raw),
    org,
    features: new Set<string>([
      `org:${org}`,
      ...p.opportunityTypes.map((t) => `type:${t}`),
      ...p.interestTags.slice(0, 5).map((t) => `tag:${normalizeForMatch(t).trim()}`),
    ]),
  };
  STATIC.set(p, value);
  return value;
}

/** Cards sorted by slug and cycle, one per cycle id, so nothing depends on input order. */
function sortedPrograms(input: readonly OnboardingProgram[]): OnboardingProgram[] {
  const seen = new Set<string>();
  return [...input]
    .sort((a, b) => compareStrings(a.slug, b.slug) || compareStrings(a.programCycleId, b.programCycleId))
    .filter((p) => (seen.has(p.programCycleId) ? false : (seen.add(p.programCycleId), true)));
}

/**
 * One BM25+ index per catalogue (the array the caller passes, usually the release's cards),
 * built over every card so term statistics describe the catalogue, not the filtered pool.
 */
const INDEXES = new WeakMap<readonly OnboardingProgram[], MiniSearch<LexicalDoc>>();

function lexicalIndexFor(programs: readonly OnboardingProgram[]): MiniSearch<LexicalDoc> {
  const hit = INDEXES.get(programs);
  // Rebuild if the caller changed the array in place since it was indexed.
  if (hit && hit.documentCount === new Set(programs.map((p) => p.programCycleId)).size && programs.every((p) => hit.has(p.programCycleId))) {
    return hit;
  }
  const index = buildLexicalIndex(
    sortedPrograms(programs).map((p) => ({
      id: p.programCycleId,
      name: p.name,
      aliases: p.aliases.join(" "),
      organization: p.organizationName,
      tags: [...p.interestTags.map((t) => t.replace(/[_-]+/g, " ")), ...staticOf(p).required.map(skillLabel)].join(" "),
      summary: p.summary ?? "",
    })),
  );
  INDEXES.set(programs, index);
  return index;
}

function targetMatches(target: string | null, p: OnboardingProgram): boolean {
  if (!target) return false;
  const words = normalizeForMatch(target)
    .trim()
    .split(" ")
    .filter((w) => w.length >= 3 && !["the", "and", "for", "program", "programs"].includes(w));
  if (words.length === 0) return false;
  const hay = normalizeForMatch([p.name, ...p.aliases, p.organizationName].join(" "));
  return words.every((w) => hay.includes(` ${w} `));
}

function timingFacet(p: OnboardingProgram, ctx: Ctx): string | null {
  if (ctx.prefs.timing.length === 0) return null;
  const parsed = parseCycleKey(p.cycleKey);
  if (!parsed) return null;
  for (const t of ctx.prefs.timing) {
    if (t === "next_summer" && parsed.term === "summer" && parsed.year === ctx.nextSummerYear) return `Summer ${parsed.year}`;
    if (t === "during_term" && (parsed.term === "fall" || parsed.term === "spring" || parsed.term === "ay")) return "During the school year";
    if (t === "winter_break" && parsed.term === "winter") return "Over winter break";
  }
  return null;
}

function locationFacet(p: OnboardingProgram, ctx: Ctx): string | null {
  const format = p.extras?.format;
  const pref = ctx.prefs.location;
  if (!format || !pref) return null;
  if ((pref === "remote" || pref === "nearby") && format.includes("remote")) return "Remote OK";
  if (pref === "travel" && format.includes("in_person")) return "In person";
  if (pref === "travel" && format.includes("hybrid")) return "Hybrid";
  return null;
}

/** The program welcomes the student's year; for a student who skipped the year, a first- or second-year one. */
function opensToStudent(p: OnboardingProgram, year: ClassYear | null): boolean {
  if (p.classYears.length === 0) return false;
  return year !== null ? p.classYears.includes(year) : p.classYears.some((y) => EARLY_YEARS.includes(y));
}

function assess(p: OnboardingProgram, ctx: Ctx, input: FindMatchesInput): Candidate | null {
  if (p.flags.sensitiveAudience && !input.includeSensitiveAudience) return null;
  if (!onOffer(p, ctx.today)) return null;
  if (ctx.prefs.pay === "must" && knownUnpaid(p)) return null;
  if (ctx.prefs.location === "remote" && p.extras?.format && !p.extras.format.includes("remote")) return null;

  const elig = ctx.eligibility(p, ctx.profile, ctx.today);
  if (elig.status === "not_eligible") return null;
  const feas = computeFeasibility({
    program: p,
    nowMs: ctx.nowMs,
    timeZone: ctx.tz,
    today: ctx.today,
    weeklyHours: ctx.prefs.weeklyHours,
    ...(input.prepModel ? { prepModel: input.prepModel } : {}),
  });
  if (feas === null) return null;

  const st = staticOf(p);
  const { categories, text } = st;
  const typeOk = ctx.categories.size === 0 || categories.some((c) => ctx.categories.has(c));

  // Interest evidence comes from the curated tags, name and aliases. The free summary counts only
  // for a program with no tags, because boilerplate ("a supportive work environment", "mental
  // health benefits") would otherwise sell a finance internship as a climate program.
  const interestText = p.interestTags.length > 0 ? st.tagText : text;
  const interestIds = ctx.interests.filter(({ terms }) => terms.some((t) => interestText.includes(t))).map(({ topic }) => topic.id);
  const family = ctx.prefs.majorFamily;
  const majorMatch = family !== null && family !== "undeclared" && p.majorFamilies.includes(family);
  const fieldMatch = majorMatch || interestIds.length > 0;

  const required = st.required;
  const matched = required.filter((s) => ctx.skills.has(s));
  const missingSkills = required.filter((s) => !ctx.skills.has(s));
  const coverage = required.length > 0 ? matched.length / required.length : null;
  const mentioned = [...ctx.skills].filter((s) => s.startsWith(UNLISTED_SKILL_PREFIX) && mentionsUnlistedSkill(text, skillLabel(s)));
  const firstYearOpen = p.classYears.some((y) => y === "first_year" || y === "incoming_first_year");
  const needsNoExperience = required.length === 0 && (firstYearOpen || p.opportunityTypes.some((t) => ENTRY_LEVEL_TYPES.has(t)));
  const year: ClassYear | null = ctx.prefs.classYear;

  const leaningTexts: string[] = [];
  for (const pair of PAIRS) {
    const choice = pair.id === "pair_style" ? ctx.prefs.leanings.style : pair.id === "pair_length" ? ctx.prefs.leanings.length : ctx.prefs.leanings.value;
    if (!choice) continue;
    const side = pairSide(pair, p.opportunityTypes);
    if (side && (side === "a" ? pair.a.value : pair.b.value) === choice) leaningTexts.push((side === "a" ? pair.a : pair.b).reason);
  }

  const facetTexts: string[] = [];
  let facetCount = 0;
  if (ctx.categories.size > 0 && typeOk) facetCount++;
  const timing = timingFacet(p, ctx);
  if (timing) {
    facetCount++;
    facetTexts.push(timing);
  }
  const location = locationFacet(p, ctx);
  if (location) {
    facetCount++;
    facetTexts.push(location);
  }
  if (ctx.prefs.pay !== "any" && isPaid(p)) {
    facetCount++;
    facetTexts.unshift("Paid");
  }
  if (fieldMatch) facetCount++;
  // Class-year fit: the student's year when given; otherwise a first- or second-year listing,
  // since those are the students Novus is for.
  const openToStudent = opensToStudent(p, year);
  if (year !== null ? p.classYears.length === 0 || p.classYears.includes(year) : openToStudent) facetCount++;
  // "Nothing yet" (or no answer) to the experience question: programs that need none fit it.
  if (ctx.prefs.experience.length === 0 && needsNoExperience) facetCount++;
  if (leaningTexts.length > 0) facetCount++;

  // "You meet N of M listed requirements": the class-year facet, listed skills and a resume.
  let met = 0;
  let total = 0;
  const missing: string[] = [];
  if (p.classYears.length > 0) {
    total++;
    if (year !== null && p.classYears.includes(year)) met++;
    else missing.push("Your class year (tell us to check)");
  }
  total += required.length;
  met += matched.length;
  missing.push(...missingSkills.map(skillLabel));
  if (p.extras?.requirements?.some((r) => r.kind === "resume")) {
    total++;
    if (ctx.prefs.hasResume) met++;
    else missing.push("A resume");
  }

  return {
    p,
    id: p.programCycleId,
    org: st.org,
    tieKey: `${rotationKey(p.slug, ctx.week).toString(16).padStart(8, "0")}|${p.slug}`,
    categories,
    typeOk,
    elig,
    feas,
    required,
    matched,
    missingSkills,
    coverage,
    interestIds,
    majorMatch,
    fieldMatch,
    needsNoExperience,
    openToStudent,
    leaningTexts,
    facetCount,
    facetTexts,
    target: targetMatches(ctx.target, p),
    met,
    total,
    missing,
    features: st.features,
    mentioned,
  };
}

// ---------------------------------------------------------------------------------------------
// Lists, fusion and exposure
// ---------------------------------------------------------------------------------------------

interface RankedCandidate {
  readonly c: Candidate;
  /** Fused rank value normalized to [0, 1], plus the exposure boost. Internal only. */
  readonly rel: number;
  /** Another type, shown because too few of the asked-for types matched. */
  readonly relaxed?: boolean;
  /** Shown to help a student explore, not because it matched what they told us. */
  readonly explore?: boolean;
}

function rankPool(pool: readonly Candidate[], ctx: Ctx, input: FindMatchesInput): RankedCandidate[] {
  if (pool.length === 0) return [];
  const byId = new Map(pool.map((c) => [c.id, c]));
  const lists: Map<string, number>[] = [];

  // (a) Lexical BM25+ over public program text.
  const hits = lexicalSearch(lexicalIndexFor(input.programs), ctx.queryTerms, new Set(byId.keys()), LIST_DEPTH, ctx.target ? [ctx.target] : []);
  lists.push(ranksWithTies(hits, (h) => h.id, (a, b) => a.value === b.value));

  // (b) Skill coverage |S∩R| / |R|, ties broken by |S∩R|.
  const skillList = pool
    .filter((c) => c.matched.length > 0)
    .sort((a, b) => (b.coverage ?? 0) - (a.coverage ?? 0) || b.matched.length - a.matched.length || compareStrings(a.tieKey, b.tieKey))
    .slice(0, LIST_DEPTH);
  lists.push(ranksWithTies(skillList, (c) => c.id, (a, b) => a.coverage === b.coverage && a.matched.length === b.matched.length));

  // (c) Satisfied preference facets.
  const facetList = pool
    .filter((c) => c.facetCount > 0)
    .sort((a, b) => b.facetCount - a.facetCount || compareStrings(a.tieKey, b.tieKey))
    .slice(0, LIST_DEPTH);
  lists.push(ranksWithTies(facetList, (c) => c.id, (a, b) => a.facetCount === b.facetCount));

  // (d) Feasibility slack: comfortable first (capped), then sooner deadlines among equals.
  const slack = (c: Candidate): number => Math.min(SLACK_CAP_DAYS, c.feas.daysLeft - (c.feas.prepDays ?? 0));
  const feasList = pool
    .filter((c) => c.feas.enoughTime)
    .sort((a, b) => slack(b) - slack(a) || a.feas.daysLeft - b.feas.daysLeft || compareStrings(a.tieKey, b.tieKey))
    .slice(0, LIST_DEPTH);
  lists.push(ranksWithTies(feasList, (c) => c.id, (a, b) => slack(a) === slack(b) && a.feas.daysLeft === b.feas.daysLeft));

  // (e) Optional semantic list: cosine between an on-device student vector and offline program vectors.
  if (input.semantic) {
    const { studentVector, programVectors } = input.semantic;
    const sem = pool
      .map((c) => {
        const v = programVectors[c.p.programId];
        return { c, sim: v ? cosine(studentVector, v) : 0 };
      })
      .filter((x) => x.sim > 0)
      .sort((a, b) => b.sim - a.sim || compareStrings(a.c.tieKey, b.c.tieKey))
      .slice(0, LIST_DEPTH);
    lists.push(ranksWithTies(sem, (x) => x.c.id, (a, b) => a.sim === b.sim));
  }

  const fused = reciprocalRankFusion(lists);
  const max = Math.max(0, ...pool.map((c) => fused.get(c.id) ?? 0));
  const relNorm = new Map(pool.map((c) => [c.id, max > 0 ? (fused.get(c.id) ?? 0) / max : 0]));

  // Exposure boost (plan 06): only with server-supplied exposure, only above the slate median.
  const boost = new Map<string, number>();
  if (input.exposure) {
    const eps = pool.map((c) => Math.max(0, input.exposure?.[c.p.programId] ?? 0));
    const medEps = median(eps);
    const medRel = median([...relNorm.values()]);
    pool.forEach((c, i) => {
      const r = relNorm.get(c.id) ?? 0;
      if (r > medRel) boost.set(c.id, exposureBoost(eps[i] as number, medEps));
    });
  }

  return pool.map((c) => ({ c, rel: (relNorm.get(c.id) ?? 0) + (boost.get(c.id) ?? 0) }));
}

// ---------------------------------------------------------------------------------------------
// Tiers and diversity
// ---------------------------------------------------------------------------------------------

/**
 * A program is shown only for evidence its card can state in plain words: a field or interest
 * match, a skill (listed, or an unlisted resume skill the text names), the asked-for kind, a
 * this-or-that leaning or the program the student named. A lexical hit alone orders programs
 * but never qualifies one, because "matched a word" is not a reason a student can check.
 */
function isRelevant(c: Candidate, ctx: Ctx): boolean {
  const typeSignal = ctx.categories.size > 0 && c.typeOk;
  return c.fieldMatch || c.matched.length > 0 || c.mentioned.length > 0 || typeSignal || c.leaningTexts.length > 0 || c.target;
}

/**
 * Rules, in order:
 * - strong: eligible or "eligible if" with student-checkable items, enough time, a field or
 *   interest match, skill evidence (two matched skills, half the listed skills, or nothing
 *   listed for an entry-level program), the asked-for type, and not a community-specific
 *   program (those need the student's private check first).
 * - good: not ruled out, enough time, and a field, interest, skill or named-program match. A
 *   student who named only the kind of opportunity (no interests, major or skills) also gets
 *   "good" for that kind when the program needs no experience or welcomes their year: the kind
 *   is all they told us, and the access fact is evidence they can check on the card.
 * - stretch: anything else relevant: tight timelines, the right type without a content match,
 *   or (only when too few matched) a different type with a content match.
 */
function tierOf(c: Candidate, ctx: Ctx): Tier | null {
  if (!isRelevant(c, ctx)) return null;
  if (!c.typeOk) return "stretch";
  const st = c.elig.status;
  const eligibleLike = st === "eligible" || st === "conditional";
  const enough = c.feas.enoughTime;
  const skillMatch = c.matched.length > 0 || c.mentioned.length > 0;
  const skillEvidence = c.matched.length >= 2 || (c.coverage !== null && c.coverage >= 0.5) || c.needsNoExperience;
  if (eligibleLike && enough && c.fieldMatch && skillEvidence && !c.p.flags.identityAudience) return "strong";
  // The asked-for type alone is not evidence of fit (every survivor of the type filter has it),
  // so "good" needs a field, interest, skill or named-program match, except for the kind-only
  // student described above.
  const kindPreferred = (ctx.categories.size > 0 && c.typeOk) || c.leaningTexts.length > 0;
  const kindOnly = !ctx.hasContent && kindPreferred && (c.needsNoExperience || c.openToStudent);
  if ((eligibleLike || st === "unknown") && enough && (c.fieldMatch || skillMatch || c.target || kindOnly)) return "good";
  return "stretch";
}

/** The study's rule: when the student asked for several kinds, a tier's first six show at least two. */
const MIX_WINDOW = 6;

function ensureCategoryMix(
  picked: RankedCandidate[],
  sorted: readonly RankedCandidate[],
  asked: ReadonlySet<OpportunityCategory>,
  orgCount: Map<string, number>,
): RankedCandidate[] {
  if (asked.size < 2 || picked.length < 2) return picked;
  const window = picked.slice(0, MIX_WINDOW);
  const covered = new Set(window.flatMap((r) => r.c.categories.filter((c) => asked.has(c))));
  if (covered.size !== 1) return picked;
  const isNew = (r: RankedCandidate): boolean => r.c.categories.some((c) => asked.has(c) && !covered.has(c));
  const slot = Math.min(MIX_WINDOW, picked.length) - 1;
  // Prefer one already picked further down; otherwise swap in the best unpicked one the org cap allows.
  const later = picked.findIndex((r, i) => i > slot && isNew(r));
  if (later >= 0) {
    const out = [...picked];
    const [moved] = out.splice(later, 1);
    out.splice(slot, 0, moved as RankedCandidate);
    return out;
  }
  const pickedIds = new Set(picked.map((r) => r.c.id));
  const dropped = picked[slot] as RankedCandidate;
  const alt = sorted.find(
    (r) => !pickedIds.has(r.c.id) && isNew(r) && (orgCount.get(r.c.org) ?? 0) - (r.c.org === dropped.c.org ? 1 : 0) < ORG_CAP,
  );
  if (!alt) return picked;
  orgCount.set(dropped.c.org, (orgCount.get(dropped.c.org) ?? 1) - 1);
  orgCount.set(alt.c.org, (orgCount.get(alt.c.org) ?? 0) + 1);
  const out = [...picked];
  out[slot] = alt;
  return out;
}

function diversify(
  list: readonly RankedCandidate[],
  limit: number,
  orgCount: Map<string, number>,
  asked: ReadonlySet<OpportunityCategory> = new Set(),
): RankedCandidate[] {
  if (limit <= 0 || list.length === 0) return [];
  const sorted = [...list].sort((a, b) => b.rel - a.rel || compareStrings(a.c.tieKey, b.c.tieKey));
  const top = Math.max(...sorted.map((r) => r.rel), 0);
  const byId = new Map(sorted.map((r) => [r.c.id, r]));
  const candidates: MmrCandidate[] = sorted.slice(0, MMR_POOL).map((r) => ({
    id: r.c.id,
    rel: top > 0 ? r.rel / top : 0,
    features: r.c.features,
    key: r.c.tieKey,
  }));
  const picked = mmrSelect(candidates, {
    lambda: MMR_LAMBDA,
    limit,
    accept: (m) => (orgCount.get(byId.get(m.id)?.c.org ?? "") ?? 0) < ORG_CAP,
    onTake: (m) => {
      const org = byId.get(m.id)?.c.org ?? "";
      orgCount.set(org, (orgCount.get(org) ?? 0) + 1);
    },
  });
  return ensureCategoryMix(
    picked.map((m) => byId.get(m.id) as RankedCandidate),
    sorted,
    asked,
    orgCount,
  );
}

// ---------------------------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------------------------

/** The year a card names for a student who skipped the year question: the earliest one it lists. */
function earlyYearListed(p: OnboardingProgram): ClassYear | null {
  for (const y of ["first_year", "second_year", "incoming_first_year"] as const) if (p.classYears.includes(y)) return y;
  return null;
}

function reasonsFor(r: RankedCandidate, tier: Tier, ctx: Ctx): Reason[] {
  const { c } = r;
  const out: Reason[] = [];
  if (c.target) out.push(reason.target());
  if (c.matched.length > 0) {
    const fromResume = c.matched.some((s) => ctx.fromResume.has(s));
    out.push(reason.skills(c.matched.map(skillPhrase), fromResume));
  } else if (c.mentioned.length > 0) {
    out.push(reason.mentions(c.mentioned.map(skillLabel), c.mentioned.some((s) => ctx.fromResume.has(s))));
  }
  if (c.interestIds.length > 0) out.push(reason.interest(c.interestIds[0] as string));
  if (c.majorMatch && ctx.prefs.majorFamily) out.push(reason.major(ctx.prefs.majorFamily));
  const year = ctx.prefs.classYear;
  const named = year !== null ? (c.p.classYears.includes(year) && EARLY_YEARS.includes(year) ? year : null) : earlyYearListed(c.p);
  if (named !== null) out.push(reason.openToYear(named));
  if (c.needsNoExperience && c.matched.length === 0) out.push(reason.noExperience());
  if (c.leaningTexts.length > 0) out.push(reason.leaning(c.leaningTexts[0] as string));
  if (c.facetTexts.length > 0) out.push(reason.preferences(c.facetTexts));
  if (ctx.categories.size > 0 && c.typeOk) {
    const cat = c.categories.find((x) => ctx.categories.has(x));
    if (cat) out.push(reason.type(cat));
  }

  // Caveats, the one explaining the tier first.
  if (!c.feas.enoughTime) out.push(c.feas.prepDays === null ? reason.dueSoon(c.feas.label) : reason.tight(c.feas.label));
  if (r.explore) out.push(reason.explore(ctx.hasContent));
  if (r.relaxed) out.push(reason.differentType());
  if (tier === "stretch" && c.missingSkills.length > 0 && c.matched.length < 2) out.push(reason.skillsToBuild(c.missingSkills.map(skillPhrase)));
  if (c.feas.basis === "campus_estimate" || c.feas.campusStep !== null) out.push(reason.campusUncertain());
  if (c.p.flags.identityAudience) out.push(reason.community());
  if (c.elig.status === "unknown") out.push(reason.notFullyChecked());
  else if (c.elig.status === "conditional") {
    const open = c.elig.pending.filter((p) => !p.sensitive && p.resolver === "student");
    const privateCount = c.elig.pending.filter((p) => p.sensitive).length;
    if (open[0]) out.push(reason.eligibleIf(open[0].selfCheckText));
    if (privateCount > 0) out.push(reason.privateCheck(privateCount));
  }
  return out;
}

function toItem(r: RankedCandidate, tier: Tier, ctx: Ctx): MatchItem {
  const { c } = r;
  const all = reasonsFor(r, tier, ctx);
  const shown = pickReasons(all, tier === "stretch");
  const codes = [...new Set(all.map((x) => x.code))];
  if (c.feas.deadline !== null && c.feas.prepDays !== null && c.feas.enoughTime) codes.push("START_BY");
  const prep = c.feas.prep;
  const status = c.elig.status === "not_eligible" ? "unknown" : c.elig.status;
  return {
    programId: c.p.programId,
    programCycleId: c.p.programCycleId,
    slug: c.p.slug,
    name: c.p.name,
    organizationName: c.p.organizationName,
    categories: c.categories,
    tier,
    reasons: shown.length > 0 ? shown.map((x) => x.text) : [c.feas.label],
    reasonCodes: codes.slice(0, 16),
    evidence: [...new Set(all.map((x) => x.text))].slice(0, 12),
    feasibility: {
      startBy: c.feas.startBy,
      daysLeft: c.feas.daysLeft,
      enoughTime: c.feas.enoughTime,
      deadline: c.feas.deadline,
      basis: c.feas.basis,
      prepDays: c.feas.prepDays,
      prepHours: c.feas.prepHours,
      tight: c.feas.tight,
      label: c.feas.label,
    },
    requirementsMet: { met: c.met, total: c.total },
    missing: c.missing.slice(0, 12),
    skills: { matched: c.matched.map(skillLabel).slice(0, 20), missing: c.missingSkills.map(skillLabel).slice(0, 20) },
    eligibility: { status, checks: toChecks(c.elig) },
    prep: {
      checked: c.feas.checked,
      letters: prep ? prep.letters : null,
      essays: prep ? prep.essays : null,
      hours: prep ? prep.hours : null,
    },
    audience: { identity: c.p.flags.identityAudience, nominationRequired: c.p.flags.nominationRequired },
    isSample: c.p.isSample,
  };
}
