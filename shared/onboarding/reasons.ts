import { CLASS_YEAR_LABELS, MAJOR_FAMILY_LABELS, type ClassYear, type MajorFamily, type OpportunityCategory } from "../taxonomy";
import { joinLabels } from "./text";
import { CATEGORY_NOUNS, interestTopic } from "./vocab";

/**
 * Why-shown reasons. Codes extend plan 06's catalogue (MAJOR_MATCH, START_BY, TIGHT_TIMELINE,
 * ELIGIBLE_IF, NOT_FULLY_CHECKED, CAMPUS_DATE_UNCERTAIN) with onboarding codes. Every reason
 * is a fixed template filled with evidence the student can check on the card; none is a
 * number about the student. Reasons never rest on a status or identity answer.
 */
export const REASON_CODES = [
  "TARGET_MATCH",
  "SKILL_MATCH",
  "INTEREST_MATCH",
  "MAJOR_MATCH",
  "FIRST_YEAR_OPEN",
  "NO_EXPERIENCE_NEEDED",
  "LEANING_MATCH",
  "PREFERENCE_MATCH",
  "TYPE_MATCH",
  "START_BY",
  "ELIGIBLE_IF",
  "NOT_FULLY_CHECKED",
  "TIGHT_TIMELINE",
  "DUE_VERY_SOON",
  "CAMPUS_DATE_UNCERTAIN",
  "EXPLORE",
  "DIFFERENT_TYPE",
  "SKILLS_TO_BUILD",
  "COMMUNITY_PROGRAM",
] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface Reason {
  readonly code: ReasonCode;
  readonly text: string;
  /** Positive evidence for fit, versus a caveat the student should know. */
  readonly kind: "fit" | "caveat";
}

export const reason = {
  target: (): Reason => ({ code: "TARGET_MATCH", text: "You mentioned this one", kind: "fit" }),
  skills: (labels: readonly string[], fromResume: boolean): Reason => ({
    code: "SKILL_MATCH",
    text: `Uses ${joinLabels(labels.slice(0, 2))} ${fromResume ? "from your resume" : "you already have"}`,
    kind: "fit",
  }),
  /** An unlisted resume skill the program's own text names ("Mentions Kotlin, which is on your resume"). */
  mentions: (labels: readonly string[], fromResume: boolean): Reason => {
    const shown = labels.slice(0, 2).map((l) => l.charAt(0).toUpperCase() + l.slice(1));
    const where = fromResume ? "on your resume" : "in your skills";
    return { code: "SKILL_MATCH", text: `Mentions ${joinLabels(shown)}, which ${shown.length > 1 ? "are" : "is"} ${where}`, kind: "fit" };
  },
  interest: (topicId: string): Reason => ({
    code: "INTEREST_MATCH",
    text: `Matches your interest in ${interestTopic(topicId)?.phrase ?? topicId.replace(/_/g, " ")}`,
    kind: "fit",
  }),
  major: (family: MajorFamily): Reason => ({
    code: "MAJOR_MATCH",
    text: `Fits your ${MAJOR_FAMILY_LABELS[family].toLowerCase()} major`,
    kind: "fit",
  }),
  openToYear: (year: ClassYear): Reason => ({
    code: "FIRST_YEAR_OPEN",
    text: `Open to ${CLASS_YEAR_LABELS[year].toLowerCase()} students`,
    kind: "fit",
  }),
  noExperience: (): Reason => ({ code: "NO_EXPERIENCE_NEEDED", text: "No experience needed", kind: "fit" }),
  leaning: (text: string): Reason => ({ code: "LEANING_MATCH", text, kind: "fit" }),
  preferences: (facets: readonly string[]): Reason => ({ code: "PREFERENCE_MATCH", text: facets.join(" · "), kind: "fit" }),
  type: (category: OpportunityCategory): Reason => ({
    code: "TYPE_MATCH",
    text: `One of the ${CATEGORY_NOUNS[category]} you asked for`,
    kind: "fit",
  }),
  eligibleIf: (text: string): Reason => ({ code: "ELIGIBLE_IF", text: clip(text, 160), kind: "caveat" }),
  privateCheck: (count: number): Reason => ({
    code: "ELIGIBLE_IF",
    text: count === 1 ? "Has one eligibility rule to check privately" : `Has ${count} eligibility rules to check privately`,
    kind: "caveat",
  }),
  notFullyChecked: (): Reason => ({ code: "NOT_FULLY_CHECKED", text: "Novus hasn't checked every rule yet: see the official page", kind: "caveat" }),
  tight: (label: string): Reason => ({ code: "TIGHT_TIMELINE", text: clip(label, 160), kind: "caveat" }),
  dueSoon: (label: string): Reason => ({ code: "DUE_VERY_SOON", text: clip(label, 160), kind: "caveat" }),
  campusUncertain: (): Reason => ({
    code: "CAMPUS_DATE_UNCERTAIN",
    text: "Your campus deadline may come first: confirm it with your fellowship office",
    kind: "caveat",
  }),
  differentType: (): Reason => ({ code: "DIFFERENT_TYPE", text: "A different kind of opportunity worth a look", kind: "caveat" }),
  /** Shown to help the student explore, not matched on their answers; says so, and how to get closer matches. */
  explore: (hasContent: boolean): Reason => ({
    code: "EXPLORE",
    text: hasContent ? "Picked to help you explore beyond your answers" : "Picked to help you explore: add an interest for closer matches",
    kind: "caveat",
  }),
  skillsToBuild: (labels: readonly string[]): Reason => ({
    code: "SKILLS_TO_BUILD",
    text: `A chance to build ${joinLabels(labels.slice(0, 2))}`,
    kind: "caveat",
  }),
  community: (): Reason => ({
    code: "COMMUNITY_PROGRAM",
    text: "Serves a specific community: check the official rules privately",
    kind: "caveat",
  }),
};

function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`;
}

/**
 * Caveats a card must always show, whatever else it says: a program for a specific community
 * needs the student's own private check, and three good fit reasons must not hide that.
 */
const MUST_SHOW: ReadonlySet<ReasonCode> = new Set<ReasonCode>(["COMMUNITY_PROGRAM"]);

/**
 * Picks what the card shows: up to three reasons, fit evidence first. A stretch always keeps
 * one caveat so the student sees why it is a stretch, and a must-show caveat replaces the
 * weakest fit reason when the card is full.
 */
export function pickReasons(all: readonly Reason[], wantCaveat: boolean): Reason[] {
  const fits = all.filter((r) => r.kind === "fit");
  const caveats = all.filter((r) => r.kind === "caveat");
  let out: Reason[];
  if (wantCaveat && caveats.length > 0) {
    out = [...fits.slice(0, 2), caveats[0] as Reason];
  } else {
    out = fits.slice(0, 3);
    if (out.length < 2) out.push(...caveats.slice(0, 2 - out.length));
    if (out.length === 0 && caveats.length > 0) out.push(caveats[0] as Reason);
  }
  for (const pinned of caveats.filter((r) => MUST_SHOW.has(r.code) && !out.includes(r))) {
    if (out.length >= 3) {
      const lastFit = out.map((r) => r.kind).lastIndexOf("fit");
      out.splice(lastFit >= 0 ? lastFit : out.length - 1, 1);
    }
    out.push(pinned);
  }
  return out;
}
