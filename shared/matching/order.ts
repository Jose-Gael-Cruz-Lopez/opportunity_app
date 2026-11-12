import type { EligibilityDimension, EligibilityPending, EligibilityRuleResult, EligibilityStatus } from "../contracts/eligibility";
import type { ProgramCard } from "../contracts/registry";
import { MATCHING_CONFIG } from "./config";
import { facetMatches, isOpenToAllMajors, majorMatches, studentFamily, type FacetExtras, type FacetMatch, type MatchingProfile, type MaterialsState } from "./facets";
import { foldText, isoWeekKey, rotationKey } from "./text";
import { computeTiming, timingContext, type Section, type TimingBucketName, type TimingInfo } from "./timing";
import type { WhyShown } from "./why-shown";

/**
 * Order v0 (plan 6.6.1): a lexicographic comparator over published, categorical keys.
 *
 *   [timingBucket, displayRank, fitBand, startByDays, fnv1a(slug | isoWeek), slug]
 *
 * then a greedy diversity pass inside each (bucket, eligibility) segment. Not-eligible cycles are
 * set aside (optionally appended in their own section). Clients receive the position as an integer
 * `rankKey`, why-shown codes and the facet list; nothing here is a score, and nothing is added up.
 *
 * Runs unchanged in the browser (with SensitiveAnswers already folded into the eligibility
 * results it is given) and in the Worker (with results computed without them).
 */

/** The parts of an eligibility result ordering reads. Both browser and server results fit. */
export interface EligibilityLike {
  readonly status: EligibilityStatus;
  readonly rules?: readonly Pick<EligibilityRuleResult, "dimension" | "verdict">[];
  readonly pending?: readonly Pick<EligibilityPending, "dimension" | "resolver" | "selfCheckText">[];
}

export type EligibilityLookup = ReadonlyMap<string, EligibilityLike> | Readonly<Record<string, EligibilityLike>>;

export const FIT_BANDS = ["major_match", "open_to_all", "other"] as const;
export type FitBand = (typeof FIT_BANDS)[number];

export interface DiversityOptions {
  readonly window: number;
  readonly orgCap: number;
  readonly typeCap: number;
}

export interface RankOptions {
  /** Epoch milliseconds; pass it in so tests and parity checks are deterministic. */
  readonly now: number;
  /** Overrides profile.timeZone (for example, the browser's zone for an anonymous visitor). */
  readonly timeZone?: string | null;
  /** ISO week for the rotating tie-break; defaults to the week of `now` in the student's zone. */
  readonly isoWeek?: string;
  /** Known campus dates per programCycleId (the student's private date, verified campus rows). */
  readonly campusDates?: ReadonlyMap<string, readonly string[]>;
  /** "Not interested" ids (programId or programCycleId), held on the device. */
  readonly hidden?: ReadonlySet<string>;
  /** Append not-eligible cycles in a final `not_eligible` section (the "show anyway" toggle). */
  readonly includeNotEligible?: boolean;
  /** false turns the diversity pass off; an object overrides its caps. */
  readonly diversity?: boolean | Partial<DiversityOptions>;
  /** Lazily loaded Requirements per programCycleId, for the materials facets. */
  readonly requirements?: ReadonlyMap<string, FacetExtras["requirements"]>;
  readonly materials?: MaterialsState | null;
}

/** Public timing fields (the internal sort key stays inside this module). */
export type RankedTiming = Omit<TimingInfo, "sortDays" | "bucket">;

export interface RankedItem {
  readonly programCycleId: string;
  readonly programId: string;
  readonly slug: string;
  /** 0-based position in this ordering; an integer rank key, never a score. */
  readonly rankKey: number;
  readonly section: Section;
  readonly timingBucket: TimingBucketName;
  readonly eligibility: EligibilityStatus;
  readonly fitBand: FitBand;
  readonly timing: RankedTiming;
  readonly whyShown: readonly WhyShown[];
  readonly facets: readonly FacetMatch[];
}

const DISPLAY_RANK: Record<Exclude<EligibilityStatus, "not_eligible">, number> = { eligible: 0, conditional: 1, unknown: 2 };
const FIT_RANK: Record<FitBand, number> = { major_match: 0, open_to_all: 1, other: 2 };

function lookup(evals: EligibilityLookup, id: string): EligibilityLike | undefined {
  if (evals instanceof Map) return evals.get(id);
  return Object.prototype.hasOwnProperty.call(evals, id) ? (evals as Readonly<Record<string, EligibilityLike>>)[id] : undefined;
}

/** fitBand at major-family level (plan 6.6.1): 0 match, 1 open to all majors, 2 other. */
export function fitBandFor(card: ProgramCard, profile: MatchingProfile): FitBand {
  if (majorMatches(card, profile) === "major") return "major_match";
  return isOpenToAllMajors(card) ? "open_to_all" : "other";
}

function timingCodes(t: TimingInfo): WhyShown[] {
  if (t.campusUncertain && t.effectiveDate) {
    return [{ code: "CAMPUS_DATE_UNCERTAIN", step: t.campusUncertain, date: t.effectiveDate, nationalDate: t.nationalDate }];
  }
  const out: WhyShown[] = [];
  if (t.step === "campus" && t.effectiveDate) out.push({ code: "CAMPUS_DATE", date: t.effectiveDate });
  if (t.effectiveDate) {
    if (t.tight && t.prepDays !== null) out.push({ code: "TIGHT_TIMELINE", prepDays: t.prepDays, deadline: t.effectiveDate });
    else if (t.startBy) out.push({ code: "START_BY", date: t.startBy, deadline: t.effectiveDate });
    else if (t.step !== "campus") out.push({ code: "DEADLINE", date: t.effectiveDate });
  } else if (t.rolling) {
    out.push({ code: "ROLLING" });
  } else if (t.opening) {
    if (!t.opening.predicted) out.push({ code: "OPENS_SOON", date: t.opening.date });
    else if (t.opening.p10 && t.opening.p90) out.push({ code: "PREDICTED_WINDOW", p10: t.opening.p10, p90: t.opening.p90 });
  }
  return out;
}

function eligibilityCodes(card: ProgramCard, profile: MatchingProfile, e: EligibilityLike | undefined): WhyShown[] {
  const out: WhyShown[] = [];
  const status = e?.status ?? "unknown";
  const year = profile.classYear ?? null;
  const standingMet = e?.rules?.some((r) => r.dimension === "standing" && r.verdict === "met") ?? false;
  if (status !== "not_eligible" && (standingMet || (year !== null && card.classYears.includes(year)))) {
    out.push({ code: "ELIGIBLE_STANDING", classYear: year });
  }
  const pending = e?.pending ?? [];
  if (status === "conditional") {
    const items = pending.filter((p) => p.resolver === "student").map((p) => p.selfCheckText);
    out.push({ code: "ELIGIBLE_IF", items });
  }
  const novusDims = [...new Set(pending.filter((p) => p.resolver === "novus" && p.dimension).map((p) => p.dimension as EligibilityDimension))];
  if (status === "unknown" || novusDims.length > 0) out.push({ code: "NOT_FULLY_CHECKED", dimensions: novusDims });
  return out;
}

function fitCodes(card: ProgramCard, profile: MatchingProfile, band: FitBand): WhyShown[] {
  const family = studentFamily(profile);
  if (band === "major_match" && family) return [{ code: "MAJOR_MATCH", family }];
  return [];
}

interface Candidate {
  readonly card: ProgramCard;
  readonly status: EligibilityStatus;
  readonly timing: TimingInfo;
  readonly fitBand: FitBand;
  readonly rotation: number;
  readonly whyShown: WhyShown[];
  readonly facets: FacetMatch[];
}

function compareCandidates(a: Candidate, b: Candidate): number {
  const keysA = [a.timing.bucket, DISPLAY_RANK[a.status as keyof typeof DISPLAY_RANK] ?? 3, FIT_RANK[a.fitBand], a.timing.sortDays, a.rotation];
  const keysB = [b.timing.bucket, DISPLAY_RANK[b.status as keyof typeof DISPLAY_RANK] ?? 3, FIT_RANK[b.fitBand], b.timing.sortDays, b.rotation];
  for (let i = 0; i < keysA.length; i++) {
    const d = (keysA[i] as number) - (keysB[i] as number);
    if (d !== 0) return d;
  }
  return a.card.slug < b.card.slug ? -1 : a.card.slug > b.card.slug ? 1 : 0;
}

function resolveDiversity(opt: RankOptions["diversity"]): DiversityOptions | null {
  if (opt === false) return null;
  const base = MATCHING_CONFIG.diversity;
  if (opt === undefined || opt === true) return base;
  return { window: opt.window ?? base.window, orgCap: opt.orgCap ?? base.orgCap, typeCap: opt.typeCap ?? base.typeCap };
}

function orgKey(card: Pick<ProgramCard, "organizationName">): string {
  return foldText(card.organizationName).trim();
}

function typeKey(card: Pick<ProgramCard, "opportunityTypes">): string {
  return card.opportunityTypes[0] ?? "none";
}

/**
 * Greedy diversity re-rank of one already-ordered segment: take the first remaining item that
 * keeps its Organization under orgCap and its primary type under typeCap among the last
 * window - 1 placed items; if none qualifies, take the first remaining so nothing is dropped.
 * Deterministic and input-order stable; uses no engagement or popularity signal.
 */
export function diversify<T extends { readonly card: Pick<ProgramCard, "organizationName" | "opportunityTypes"> }>(
  ordered: readonly T[],
  opts: DiversityOptions = MATCHING_CONFIG.diversity,
): T[] {
  const remaining = [...ordered];
  const placed: T[] = [];
  while (remaining.length > 0) {
    const recent = placed.slice(-(opts.window - 1));
    const idx = remaining.findIndex((c) => {
      const org = orgKey(c.card);
      const type = typeKey(c.card);
      return recent.filter((p) => orgKey(p.card) === org).length < opts.orgCap && recent.filter((p) => typeKey(p.card) === type).length < opts.typeCap;
    });
    placed.push(remaining.splice(Math.max(0, idx), 1)[0] as T);
  }
  return placed;
}

/** Splits an ordered list into runs of equal (bucket, eligibility) and diversifies each run alone. */
function diversifySegments(ordered: readonly Candidate[], opts: DiversityOptions): Candidate[] {
  const out: Candidate[] = [];
  let start = 0;
  for (let i = 1; i <= ordered.length; i++) {
    const prev = ordered[i - 1] as Candidate;
    const cur = ordered[i];
    if (cur && cur.timing.bucket === prev.timing.bucket && cur.status === prev.status) continue;
    out.push(...diversify(ordered.slice(start, i), opts));
    start = i;
  }
  return out;
}

function toItem(c: Candidate, rankKey: number, section: Section): RankedItem {
  // The internal sort key and numeric bucket stay here; clients get the bucket name.
  const { sortDays: _sortDays, bucket: _bucket, ...timing } = c.timing;
  return {
    programCycleId: c.card.programCycleId,
    programId: c.card.programId,
    slug: c.card.slug,
    rankKey,
    section,
    timingBucket: c.timing.bucketName,
    eligibility: c.status,
    fitBand: c.fitBand,
    timing,
    whyShown: c.whyShown,
    facets: c.facets,
  };
}

/**
 * Orders cards for one student. `evals` maps programCycleId to that cycle's eligibility result;
 * a cycle without one is treated as unknown, never as eligible (plan rule 1).
 */
export function rankForStudent(
  cards: readonly ProgramCard[],
  profile: MatchingProfile | null | undefined,
  evals: EligibilityLookup,
  opts: RankOptions,
): RankedItem[] {
  const p: MatchingProfile = profile ?? {};
  const base = timingContext(opts.now, opts.timeZone ?? p.timeZone ?? null);
  const isoWeek = opts.isoWeek ?? isoWeekKey(base.today);
  const hidden = opts.hidden ?? new Set<string>();

  const kept: Candidate[] = [];
  const setAside: Candidate[] = [];
  for (const card of cards) {
    if (hidden.has(card.programId) || hidden.has(card.programCycleId)) continue;
    const e = lookup(evals, card.programCycleId);
    const status: EligibilityStatus = e?.status ?? "unknown";
    const campusDates = opts.campusDates?.get(card.programCycleId);
    const timing = computeTiming(card, campusDates ? { ...base, campusDates } : base);
    const fitBand = fitBandFor(card, p);
    const requirements = opts.requirements?.get(card.programCycleId);
    const candidate: Candidate = {
      card,
      status,
      timing,
      fitBand,
      rotation: rotationKey(card.slug, isoWeek),
      whyShown: [...timingCodes(timing), ...eligibilityCodes(card, p, e), ...fitCodes(card, p, fitBand)],
      facets: facetMatches(card, p, { ...(requirements ? { requirements } : {}), materials: opts.materials ?? null }),
    };
    (status === "not_eligible" ? setAside : kept).push(candidate);
  }

  kept.sort(compareCandidates);
  const diversity = resolveDiversity(opts.diversity);
  const ordered = diversity ? diversifySegments(kept, diversity) : kept;
  const items = ordered.map((c, i) => toItem(c, i, c.timing.section));
  if (!opts.includeNotEligible) return items;
  setAside.sort(compareCandidates);
  return [...items, ...setAside.map((c, i) => toItem(c, items.length + i, "not_eligible"))];
}
