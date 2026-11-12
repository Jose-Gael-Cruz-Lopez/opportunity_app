import type { ProgramCard, Requirement } from "../contracts/registry";
import type { StudentProfile } from "../contracts/student";
import {
  CLASS_YEAR_LABELS,
  MAJOR_FAMILY_LABELS,
  cipMatchesPrefix,
  getOpportunityType,
  majorFamilyForCip,
  type MajorFamily,
} from "../taxonomy";
import { foldText, joinLabels } from "./text";

/**
 * Fit without a number: one entry per facet, each with a status and a sentence. There is no
 * aggregate, no count of matched facets and no percentage, because "matches 4 of 5" is a score
 * by another name (rule 4). The UI renders the list as a checklist.
 */

export const FACETS = ["standing", "major", "interest", "opportunity_type", "material"] as const;
export type Facet = (typeof FACETS)[number];

export const FACET_STATUSES = ["matches", "open_to_all", "missing", "unknown"] as const;
export type FacetStatus = (typeof FACET_STATUSES)[number];

export interface FacetMatch {
  readonly facet: Facet;
  readonly status: FacetStatus;
  readonly detail: string;
}

/** The confirmed, non-sensitive profile facts matching reads. Every field is optional (anonymous visitors). */
export type MatchingProfile = Partial<
  Pick<StudentProfile, "classYear" | "majorFamily" | "majorCip" | "minorCip" | "interestTags" | "preferredOpportunityTypes" | "timeZone">
>;

/** Materials the student has said they have; device or profile state, never a document. */
export interface MaterialsState {
  readonly resume: "none" | "draft" | "reviewed" | null;
  readonly recommendersIdentified: number | null;
  readonly transcriptAccess: boolean | null;
}

/** Optional extras: lazily loaded Requirements for one cycle, and the student's materials. */
export interface FacetExtras {
  readonly requirements?: readonly Pick<Requirement, "kind" | "quantity">[];
  readonly materials?: MaterialsState | null;
}

function familyLabel(f: MajorFamily): string {
  return MAJOR_FAMILY_LABELS[f];
}

export function standingFacet(card: ProgramCard, profile: MatchingProfile): FacetMatch {
  if (card.classYears.length === 0) return { facet: "standing", status: "open_to_all", detail: "Open to every class year." };
  const listed = joinLabels(card.classYears.map((y) => CLASS_YEAR_LABELS[y].toLowerCase()));
  const year = profile.classYear ?? null;
  if (!year) return { facet: "standing", status: "unknown", detail: `Lists ${listed} students. Add your class year to check.` };
  const label = CLASS_YEAR_LABELS[year].toLowerCase();
  return card.classYears.includes(year)
    ? { facet: "standing", status: "matches", detail: `Open to ${label} students.` }
    : { facet: "standing", status: "missing", detail: `Lists ${listed} students; you are a ${label} student.` };
}

/** The student's family, from the stated family or else the CIP code; undeclared counts as none. */
export function studentFamily(profile: MatchingProfile): MajorFamily | null {
  if (profile.majorFamily && profile.majorFamily !== "undeclared") return profile.majorFamily;
  return profile.majorCip ? majorFamilyForCip(profile.majorCip) : null;
}

/** True when the student's major (or minor) falls in one of the card's families or CIP prefixes. */
export function majorMatches(card: ProgramCard, profile: MatchingProfile): "major" | "minor" | null {
  const family = studentFamily(profile);
  if (family && card.majorFamilies.includes(family)) return "major";
  if (profile.majorCip && card.cipPrefixes.some((p) => cipMatchesPrefix(profile.majorCip as string, p))) return "major";
  if (profile.minorCip && card.cipPrefixes.some((p) => cipMatchesPrefix(profile.minorCip as string, p))) return "minor";
  return null;
}

export function isOpenToAllMajors(card: ProgramCard): boolean {
  return card.majorFamilies.length === 0 && card.cipPrefixes.length === 0;
}

export function majorFacet(card: ProgramCard, profile: MatchingProfile): FacetMatch {
  if (isOpenToAllMajors(card)) return { facet: "major", status: "open_to_all", detail: "Open to all majors." };
  const listed = card.majorFamilies.length ? joinLabels(card.majorFamilies.map(familyLabel)) : "specific fields of study";
  const match = majorMatches(card, profile);
  const family = studentFamily(profile);
  if (match === "major") {
    return { facet: "major", status: "matches", detail: family ? `Matches your major family (${familyLabel(family)}).` : "Matches your major." };
  }
  if (match === "minor") return { facet: "major", status: "matches", detail: "Matches your minor; check whether the program accepts minors." };
  if (!family && !profile.majorCip) return { facet: "major", status: "unknown", detail: `Lists ${listed}. Add your major to check.` };
  return {
    facet: "major",
    status: "missing",
    detail: family ? `Lists ${listed}; your major family is ${familyLabel(family)}.` : `Lists ${listed}; your major is outside them.`,
  };
}

/** Interest overlap is reported only when there is one; "not one of your interests" adds nothing. */
export function interestFacet(card: ProgramCard, profile: MatchingProfile): FacetMatch | null {
  const mine = new Set((profile.interestTags ?? []).map(foldText));
  if (mine.size === 0) return null;
  const shared = card.interestTags.filter((t) => mine.has(foldText(t)));
  if (shared.length === 0) return null;
  const labels = shared.map((t) => (t in MAJOR_FAMILY_LABELS ? familyLabel(t as MajorFamily) : t).toLowerCase());
  return { facet: "interest", status: "matches", detail: `Matches your interests: ${joinLabels(labels)}.` };
}

export function opportunityTypeFacet(card: ProgramCard, profile: MatchingProfile): FacetMatch | null {
  const wanted = profile.preferredOpportunityTypes ?? [];
  const hit = card.opportunityTypes.find((t) => wanted.includes(t));
  if (!hit) return null;
  const label = getOpportunityType(hit)?.label ?? hit;
  return { facet: "opportunity_type", status: "matches", detail: `A type you picked: ${label.toLowerCase()}.` };
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/** Materials facets, one per material Requirement kind the program lists. */
export function materialFacets(extras: FacetExtras): FacetMatch[] {
  const reqs = extras.requirements ?? [];
  const m = extras.materials ?? null;
  const out: FacetMatch[] = [];
  const letters = reqs.filter((r) => r.kind === "recommendation").reduce((n, r) => n + r.quantity, 0);
  if (letters > 0) {
    const asks = `Asks for ${plural(letters, "letter", "letters")}`;
    const have = m?.recommendersIdentified ?? null;
    out.push(
      have === null
        ? { facet: "material", status: "unknown", detail: `${asks}. Add how many recommenders you have in mind.` }
        : have >= letters
          ? { facet: "material", status: "matches", detail: `${asks}; you listed ${plural(have, "recommender", "recommenders")}.` }
          : { facet: "material", status: "missing", detail: `${asks}; you listed ${plural(have, "recommender", "recommenders")}.` },
    );
  }
  if (reqs.some((r) => r.kind === "resume")) {
    const state = m?.resume ?? null;
    out.push(
      state === null
        ? { facet: "material", status: "unknown", detail: "Asks for a résumé. Add where yours stands." }
        : state === "reviewed"
          ? { facet: "material", status: "matches", detail: "Asks for a résumé; yours has been reviewed." }
          : { facet: "material", status: "missing", detail: state === "draft" ? "Asks for a résumé; yours is a draft." : "Asks for a résumé; you have not started one." },
    );
  }
  if (reqs.some((r) => r.kind === "transcript")) {
    const access = m?.transcriptAccess ?? null;
    out.push(
      access === null
        ? { facet: "material", status: "unknown", detail: "Asks for a transcript. Add whether you can request one." }
        : access
          ? { facet: "material", status: "matches", detail: "Asks for a transcript; you can request one." }
          : { facet: "material", status: "missing", detail: "Asks for a transcript; find out how to request one." },
    );
  }
  return out;
}

/** The full facet list for one card, in a fixed order. */
export function facetMatches(card: ProgramCard, profile: MatchingProfile, extras: FacetExtras = {}): FacetMatch[] {
  const out: FacetMatch[] = [standingFacet(card, profile), majorFacet(card, profile)];
  const interest = interestFacet(card, profile);
  if (interest) out.push(interest);
  const type = opportunityTypeFacet(card, profile);
  if (type) out.push(type);
  out.push(...materialFacets(extras));
  return out;
}
