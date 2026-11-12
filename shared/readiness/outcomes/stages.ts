import { FUNNEL_STAGE_CODES, OUTCOME_STAGE_ORDER, type CountStageCode, type OutcomeDecisionCode, type OutcomeFacts, type OutcomeStageCode } from "./vocab";

/**
 * Mapping official count stages onto Outcome stages (plan 7.5.1). Validators, the King-Zeng ȳ,
 * calibration, applicant bounds and band fits all read reports through these functions.
 *
 * - campus_applicants and applicants map to submitted, nominees to campus_nominated, finalists to
 *   interview_invited and alternates to waitlisted.
 * - Awards are selections, so a selected student who declines still counts:
 *   selected = accepted or declined_offer; not selected = rejected, or no_response once the
 *   decision window has passed; withdrew leaves both numerator and denominator.
 */

/** Rank used for ordering checks; campus_nominated and not_nominated are alternatives at one rank. */
export const STAGE_RANK: Readonly<Record<OutcomeStageCode, number>> = {
  submitted: 0,
  campus_nominated: 1,
  not_nominated: 1,
  interview_invited: 2,
  interviewed: 3,
  waitlisted: 4,
};

export function isSelected(decision: OutcomeDecisionCode | null): boolean {
  return decision === "accepted" || decision === "declined_offer";
}

export function isNotSelected(decision: OutcomeDecisionCode | null, windowClosed: boolean): boolean {
  return decision === "rejected" || (decision === "no_response" && windowClosed);
}

/** Excluded from every rate: withdrew, undecided, and no_response before the window closes. */
export function isExcludedDecision(decision: OutcomeDecisionCode | null, windowClosed: boolean): boolean {
  return decision === null || decision === "withdrew" || (decision === "no_response" && !windowClosed);
}

function has(facts: OutcomeFacts, stage: OutcomeStageCode): boolean {
  return facts.stages.some((s) => s.stage === stage);
}

/** The furthest stage the report reached, by rank (not_nominated counts as the campus round). */
export function furthestStage(facts: OutcomeFacts): OutcomeStageCode | null {
  let best: OutcomeStageCode | null = null;
  for (const stage of OUTCOME_STAGE_ORDER) if (has(facts, stage) && (best === null || STAGE_RANK[stage] >= STAGE_RANK[best])) best = stage;
  return best;
}

/** True when the report shows the student reached this official count stage. */
export function reachedCountStage(facts: OutcomeFacts, stage: CountStageCode): boolean {
  switch (stage) {
    case "campus_applicants":
    case "applicants":
      // Any later stage or a decision implies an application was submitted.
      return facts.stages.length > 0 || facts.decision !== null;
    case "nominees":
      return has(facts, "campus_nominated");
    case "finalists":
      return has(facts, "interview_invited") || has(facts, "interviewed");
    case "alternates":
      return has(facts, "waitlisted");
    case "awards":
      return isSelected(facts.decision);
  }
}

/** True when the report shows the student did not reach this stage. */
function knownNotReached(facts: OutcomeFacts, stage: CountStageCode, windowClosed: boolean): boolean {
  switch (stage) {
    case "nominees":
      return has(facts, "not_nominated");
    case "finalists":
      return has(facts, "not_nominated") || (isNotSelected(facts.decision, windowClosed) && !reachedCountStage(facts, "finalists"));
    case "awards":
      return has(facts, "not_nominated") || isNotSelected(facts.decision, windowClosed);
    default:
      return false;
  }
}

/**
 * Whether the report passed the transition `from → to`: "pass", "fail", or null when the report
 * does not bear on it (never reached `from`, withdrew, or still undecided).
 */
export function transitionResult(facts: OutcomeFacts, from: CountStageCode, to: CountStageCode, windowClosed: boolean): "pass" | "fail" | null {
  if (facts.decision === "withdrew") return null;
  if (!reachedCountStage(facts, from)) return null;
  if (reachedCountStage(facts, to)) return "pass";
  if (knownNotReached(facts, to, windowClosed)) return "fail";
  return null;
}

/** Consecutive funnel transitions present in a set of stages (e.g. nominees → awards). */
export function consecutiveTransitions(stages: readonly CountStageCode[]): { from: CountStageCode; to: CountStageCode }[] {
  const present = FUNNEL_STAGE_CODES.filter((s) => stages.includes(s));
  const out: { from: CountStageCode; to: CountStageCode }[] = [];
  for (let i = 0; i + 1 < present.length; i++) out.push({ from: present[i]!, to: present[i + 1]! });
  return out;
}
