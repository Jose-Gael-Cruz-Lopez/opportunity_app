import { OUTCOMES_CONFIG } from "./config";
import { addDaysIso, isCalendarDate } from "./window";

/**
 * Give-to-get (plan 9.5.2, the one rule s01 and s07 cite). Anyone sees eligibility, verified
 * deadlines, official counts and stage odds, cycle history, banded report counts and decision
 * timelines. Contributors also see applicant-context breakdowns (once released) for 12 months
 * after a contribution: any Outcome (including "submitted, waiting"), an approved
 * InterviewReport or an accepted error report. A pledge at Track time unlocks access until 30
 * days after that cycle's decision window ends.
 *
 * Access never depends on what a report says (no decision, stage or tier is an input here), so
 * it is not an incentive conditioned on a particular sentiment.
 */

export interface GiveToGetInput {
  readonly today: string;
  /** Dates of contributions (an Outcome's creation, an approved InterviewReport, an accepted error report). */
  readonly contributedOn: readonly string[];
  /** Pledges: the pledged cycle's decision-window end (curated, else the p90 prediction). */
  readonly pledgedWindowEnds: readonly (string | null)[];
}

export interface GiveToGetAccess {
  readonly unlocked: boolean;
  /** Last day of access (inclusive), or null when locked. */
  readonly until: string | null;
  readonly basis: "contribution" | "pledge" | null;
}

/** Same month and day a year later; 29 Feb becomes 28 Feb. */
export function addMonthsIso(date: string, months: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const total = y * 12 + (m - 1) + months;
  const year = Math.floor(total / 12);
  const month = (total % 12) + 1;
  const mm = String(month).padStart(2, "0");
  for (let day = d; day >= 28; day--) {
    const candidate = `${String(year).padStart(4, "0")}-${mm}-${String(day).padStart(2, "0")}`;
    if (isCalendarDate(candidate)) return candidate;
  }
  return `${String(year).padStart(4, "0")}-${mm}-${String(d).padStart(2, "0")}`;
}

export function giveToGetAccess(input: GiveToGetInput): GiveToGetAccess {
  let best: GiveToGetAccess = { unlocked: false, until: null, basis: null };
  const consider = (until: string, basis: "contribution" | "pledge") => {
    if (until >= input.today && (best.until === null || until > best.until)) best = { unlocked: true, until, basis };
  };
  for (const on of input.contributedOn) {
    if (isCalendarDate(on) && on <= input.today) consider(addMonthsIso(on, OUTCOMES_CONFIG.giveToGet.contributionMonths), "contribution");
  }
  for (const end of input.pledgedWindowEnds) {
    if (end && isCalendarDate(end)) consider(addDaysIso(end, OUTCOMES_CONFIG.giveToGet.pledgeDaysAfterWindow), "pledge");
  }
  return best;
}
