import type { ProgramCard } from "@shared/contracts/registry";
import type { StudentProfile } from "@shared/contracts/student";
import { CLASS_YEAR_LABELS, MAJOR_FAMILY_LABELS } from "@shared/taxonomy";
import { addDays, compareIsoDates, daysBetween } from "@shared/time";
import { nextDeadline, viewerToday } from "./deadlines";
import { formatShortDate } from "./format";

/**
 * Why-shown reasons: short, factual codes with plain wording, never a score. The codes follow
 * the plan's catalogue (ELIGIBLE_STANDING, START_BY, TIGHT_TIMELINE, CAMPUS_DATE_UNCERTAIN,
 * MAJOR_MATCH, PREDICTED_WINDOW); when shared/matching ships explainWhyShown, cards should use
 * it and this module becomes the fallback.
 */

export type WhyShownCode =
  | "ELIGIBLE_STANDING"
  | "MAJOR_MATCH"
  | "START_BY"
  | "TIGHT_TIMELINE"
  | "CAMPUS_DATE_FIRST"
  | "PREDICTED_WINDOW"
  | "OPENS_SOON"
  | "ROLLING";

export interface WhyShownReason {
  readonly code: WhyShownCode;
  readonly text: string;
}

/** Start-by dates inside this many days are worth saying out loud. */
const START_BY_HORIZON_DAYS = 21;

export function whyShownReasons(
  card: ProgramCard,
  profile: Pick<StudentProfile, "classYear" | "majorFamily" | "timeZone"> | null | undefined,
  now: number,
): WhyShownReason[] {
  const reasons: WhyShownReason[] = [];
  const zone = profile?.timeZone ?? null;
  const today = viewerToday(now, zone);
  const next = nextDeadline(card, now, zone);

  if (card.flags.nominationRequired && next?.deadline.scope === "campus") {
    reasons.push({ code: "CAMPUS_DATE_FIRST", text: `Needs a campus nomination; the campus deadline is ${formatShortDate(next.date)}.` });
  }

  if (next && card.prepDays !== null && card.prepDays > 0) {
    const startBy = addDays(next.date, -card.prepDays);
    if (compareIsoDates(startBy, today) <= 0) {
      reasons.push({ code: "TIGHT_TIMELINE", text: `Tight timeline: preparing usually takes ${card.prepDays} days and ${next.daysLeft} are left.` });
    } else if (daysBetween(today, startBy) <= START_BY_HORIZON_DAYS) {
      reasons.push({ code: "START_BY", text: `Start by ${formatShortDate(startBy)}: preparing usually takes ${card.prepDays} days.` });
    }
  }

  const year = profile?.classYear ?? null;
  if (year && card.classYears.includes(year)) {
    reasons.push({ code: "ELIGIBLE_STANDING", text: `Takes ${CLASS_YEAR_LABELS[year].toLowerCase()} students.` });
  }
  const major = profile?.majorFamily ?? null;
  if (major && card.majorFamilies.includes(major)) {
    reasons.push({ code: "MAJOR_MATCH", text: `Fits ${MAJOR_FAMILY_LABELS[major].toLowerCase()}.` });
  }

  if (card.status === "expected") {
    if (card.opensOn && compareIsoDates(card.opensOn, today) > 0) {
      reasons.push({ code: "OPENS_SOON", text: `Opens ${formatShortDate(card.opensOn)}.` });
    } else if (card.prediction) {
      reasons.push({
        code: "PREDICTED_WINDOW",
        text: `Expected to open between ${formatShortDate(card.prediction.p10)} and ${formatShortDate(card.prediction.p90)}, based on past cycles.`,
      });
    }
  } else if (card.status === "open" && card.deadlines.length === 0) {
    reasons.push({ code: "ROLLING", text: "Rolling admissions: apply any time." });
  }

  return reasons;
}

/** One line for a card: the two most useful reasons, or the program summary when none apply. */
export function whyShownLine(card: ProgramCard, profile: Parameters<typeof whyShownReasons>[1], now: number): string {
  const reasons = whyShownReasons(card, profile, now);
  if (reasons.length === 0) return card.summary ?? "";
  return reasons
    .slice(0, 2)
    .map((r) => r.text)
    .join(" ");
}
