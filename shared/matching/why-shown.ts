import type { EligibilityDimension } from "../contracts/eligibility";
import { DIMENSION_LABELS } from "../eligibility/reasons";
import { CLASS_YEAR_LABELS, MAJOR_FAMILY_LABELS, type ClassYear, type MajorFamily } from "../taxonomy";
import { joinLabels, shortDate } from "./text";
import type { CampusUncertainty } from "./timing";

/**
 * Why-shown codes (plan 6.6.1, catalogue shared with s07): short, categorical reasons a card is
 * where it is. Each code carries typed parameters about the program or the calendar, never a
 * number about the student. explainWhyShown turns them into plain sentences; the API sends the
 * compact string form (encodeWhyShown), at most 60 characters each.
 */
export type WhyShown =
  | { readonly code: "ELIGIBLE_STANDING"; readonly classYear: ClassYear | null }
  | { readonly code: "ELIGIBLE_IF"; readonly items: readonly string[] }
  | { readonly code: "NOT_FULLY_CHECKED"; readonly dimensions: readonly EligibilityDimension[] }
  | { readonly code: "START_BY"; readonly date: string; readonly deadline: string }
  | { readonly code: "DEADLINE"; readonly date: string }
  | { readonly code: "TIGHT_TIMELINE"; readonly prepDays: number; readonly deadline: string }
  | { readonly code: "CAMPUS_DATE_UNCERTAIN"; readonly step: CampusUncertainty; readonly date: string; readonly nationalDate: string | null }
  | { readonly code: "CAMPUS_DATE"; readonly date: string }
  | { readonly code: "MAJOR_MATCH"; readonly family: MajorFamily }
  | { readonly code: "OPEN_TO_ALL_MAJORS" }
  | { readonly code: "PREDICTED_WINDOW"; readonly p10: string; readonly p90: string }
  | { readonly code: "OPENS_SOON"; readonly date: string }
  | { readonly code: "ROLLING" }
  | { readonly code: "NAME_MATCH" }
  | { readonly code: "ALIAS_MATCH" }
  | { readonly code: "ORG_MATCH" }
  | { readonly code: "TOPIC_MATCH" }
  /** Hybrid search only: the embeddings leg found it, no typed word matched (plan 6.5, Phase 3). */
  | { readonly code: "MEANING_MATCH" };

export type WhyShownCode = WhyShown["code"];

export const WHY_SHOWN_CODES = [
  "ELIGIBLE_STANDING",
  "ELIGIBLE_IF",
  "NOT_FULLY_CHECKED",
  "START_BY",
  "DEADLINE",
  "TIGHT_TIMELINE",
  "CAMPUS_DATE_UNCERTAIN",
  "CAMPUS_DATE",
  "MAJOR_MATCH",
  "OPEN_TO_ALL_MAJORS",
  "PREDICTED_WINDOW",
  "OPENS_SOON",
  "ROLLING",
  "NAME_MATCH",
  "ALIAS_MATCH",
  "ORG_MATCH",
  "TOPIC_MATCH",
  "MEANING_MATCH",
] as const satisfies readonly WhyShownCode[];

export interface WhyShownLine {
  readonly code: WhyShownCode;
  readonly text: string;
}

function eligibleIfText(items: readonly string[]): string {
  if (items.length === 0) return "Eligible if you confirm a few rules on the program page.";
  const first = items[0] ?? "";
  if (items.length === 1) return first;
  return `${first} Check ${items.length - 1 === 1 ? "one more rule" : "the other rules"} on the program page.`;
}

function campusText(w: Extract<WhyShown, { code: "CAMPUS_DATE_UNCERTAIN" }>): string {
  switch (w.step) {
    case "e1":
      return `Needs a campus nomination. Estimated campus deadline around ${shortDate(w.date)}: confirm with your campus representative.`;
    case "e2":
      return "Your campus deadline may be soon or may have passed: confirm with your campus representative.";
    case "national":
      return w.nationalDate
        ? `The campus deadline may have passed. Ask your fellowship office whether you can still be considered before the national deadline on ${shortDate(w.nationalDate)}.`
        : "The campus deadline may have passed. Ask your fellowship office whether you can still be considered.";
  }
}

/** Plain-language sentence for one code. */
export function whyShownText(w: WhyShown): string {
  switch (w.code) {
    case "ELIGIBLE_STANDING":
      return w.classYear ? `Open to ${CLASS_YEAR_LABELS[w.classYear].toLowerCase()} students.` : "Open to your class year.";
    case "ELIGIBLE_IF":
      return eligibleIfText(w.items);
    case "NOT_FULLY_CHECKED":
      return w.dimensions.length
        ? `Novus has not fully checked the ${joinLabels(w.dimensions.map((d) => DIMENSION_LABELS[d]))} rules yet.`
        : "Novus has not fully checked every rule yet.";
    case "START_BY":
      return `Start by ${shortDate(w.date)} to be ready for the ${shortDate(w.deadline)} deadline.`;
    case "DEADLINE":
      return `Deadline ${shortDate(w.date)}.`;
    case "TIGHT_TIMELINE":
      return `Tight timeline: preparing usually takes about ${w.prepDays} days before the ${shortDate(w.deadline)} deadline.`;
    case "CAMPUS_DATE_UNCERTAIN":
      return campusText(w);
    case "CAMPUS_DATE":
      return `Your campus deadline is ${shortDate(w.date)}.`;
    case "MAJOR_MATCH":
      return `Fits your major family (${MAJOR_FAMILY_LABELS[w.family]}).`;
    case "OPEN_TO_ALL_MAJORS":
      return "Open to all majors.";
    case "PREDICTED_WINDOW":
      return `Expected to open between ${shortDate(w.p10)} and ${shortDate(w.p90)}, based on past cycles.`;
    case "OPENS_SOON":
      return `Opens ${shortDate(w.date)}.`;
    case "ROLLING":
      return "Rolling admissions: apply any time while it is open.";
    case "NAME_MATCH":
      return "Matches the program name.";
    case "ALIAS_MATCH":
      return "Matches a name the program is also known by.";
    case "ORG_MATCH":
      return "Matches the organization.";
    case "TOPIC_MATCH":
      return "Matches the program's topics.";
    case "MEANING_MATCH":
      return "Close in meaning to your search, though none of your words appear in it.";
  }
}

/**
 * Maps an item's codes (or a bare list of codes) to plain-language lines, in the order given.
 * Accepts anything carrying `whyShown`, so ranked items and search results both work.
 */
export function explainWhyShown(item: { readonly whyShown: readonly WhyShown[] } | readonly WhyShown[]): WhyShownLine[] {
  const list: readonly WhyShown[] = Array.isArray(item) ? item : (item as { readonly whyShown: readonly WhyShown[] }).whyShown;
  return list.map((w) => ({ code: w.code, text: whyShownText(w) }));
}

const MAX_WIRE = 60;

function clip(value: string): string {
  return value.length <= MAX_WIRE ? value : value.slice(0, MAX_WIRE);
}

/**
 * Compact wire form for API and MCP responses (`SearchHit.whyShown`): `CODE` or `CODE:arg,arg`.
 * ELIGIBLE_IF drops its texts (they are long and the client re-derives them from eligibility).
 */
export function encodeWhyShown(w: WhyShown): string {
  switch (w.code) {
    case "ELIGIBLE_STANDING":
      return w.classYear ? `${w.code}:${w.classYear}` : w.code;
    case "NOT_FULLY_CHECKED":
      return clip(w.dimensions.length ? `${w.code}:${w.dimensions.join(",")}` : w.code);
    case "START_BY":
      return `${w.code}:${w.date},${w.deadline}`;
    case "DEADLINE":
    case "OPENS_SOON":
    case "CAMPUS_DATE":
      return `${w.code}:${w.date}`;
    case "TIGHT_TIMELINE":
      return `${w.code}:${w.prepDays},${w.deadline}`;
    case "CAMPUS_DATE_UNCERTAIN":
      return `${w.code}:${w.step},${w.date}`;
    case "MAJOR_MATCH":
      return `${w.code}:${w.family}`;
    case "PREDICTED_WINDOW":
      return `${w.code}:${w.p10},${w.p90}`;
    default:
      return w.code;
  }
}
