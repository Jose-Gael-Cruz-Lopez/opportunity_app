import type { OutcomePrivateConfig } from "./config";
import { isSelected, STAGE_RANK } from "./stages";
import type { OutcomeFacts } from "./vocab";
import { inDecisionWindow, isCalendarDate, type DecisionWindowCycle } from "./window";

/**
 * Deterministic Outcome validators (plan 7.8, Phase 2).
 *
 * Two kinds of result:
 * - **Refusals** are reports that cannot be true as entered (stages out of order, a date in the
 *   future, a decision without a date). The route answers 400 with field paths and these fixed
 *   messages; nothing is stored. Messages never quote what the student typed.
 * - **Flags** are reports that may be true but need a look (an award without a campus nomination,
 *   a decision before the round closed). The report is stored with `quality_state = 'flagged'`
 *   and its codes; it still counts toward the report goal but not toward displayed aggregates,
 *   calibration or bands until a Curator clears it.
 *
 * Refusing a Sponsor-affiliated reporter and refusing status-defined programs happen in the route,
 * before these run.
 */

export const OUTCOME_FLAG_CODES = [
  "award_without_nomination",
  "decision_before_round_close",
  "decision_outside_window",
  "class_standing_not_admitted",
  "seasonal_cap",
  "decision_week_outlier",
] as const;
export type OutcomeFlagCode = (typeof OUTCOME_FLAG_CODES)[number];

export interface OutcomeIssue {
  readonly path: string;
  readonly message: string;
}

export interface ValidationCycle extends DecisionWindowCycle {
  /** Cycles flagged rolling_decisions skip the before-round-close check. */
  readonly rollingDecisions: boolean;
  /** Class years the verified rules admit (empty = not stated). */
  readonly classYears: readonly string[];
}

export interface ValidationContext {
  readonly today: string;
  readonly cycle: ValidationCycle;
  /** The round the student applied in (TrackerItem's round), else the earliest round deadline. */
  readonly roundDeadline: string | null;
  /** True when the program has a NominationProcess (a campus nomination precedes the award). */
  readonly nominationRequired: boolean;
  /** Class year in the report's snapshot. */
  readonly snapshotClassYear: string | null;
  /** The account's other reports this season (for the private seasonal cap). */
  readonly otherReportsThisSeason: number;
  readonly privateConfig: OutcomePrivateConfig;
}

export type ValidationResult =
  | { readonly ok: true; readonly flags: readonly OutcomeFlagCode[] }
  | { readonly ok: false; readonly errors: readonly OutcomeIssue[] };

const MSG = {
  submittedMissing: "Start with when you submitted",
  duplicateStage: "Each step can be listed once",
  badDate: "Use a real date",
  futureDate: "That date is still in the future",
  bothCampus: "Choose nominated or not nominated, not both",
  afterNotNominated: "Later steps cannot follow a campus decision not to nominate",
  outOfOrder: "This step is dated before an earlier step",
  decisionDateMissing: "Add the date you heard back",
  dateWithoutDecision: "Choose what you heard before adding its date",
  decisionBeforeStage: "The decision is dated before an earlier step",
} as const;

/** Refusals only (no context needed beyond today): what the route checks before anything else. */
export function structuralIssues(facts: OutcomeFacts, today: string): OutcomeIssue[] {
  const issues: OutcomeIssue[] = [];
  const seen = new Set<string>();
  facts.stages.forEach((s, i) => {
    if (seen.has(s.stage)) issues.push({ path: `stages.${i}.stage`, message: MSG.duplicateStage });
    seen.add(s.stage);
    if (s.on !== null && !isCalendarDate(s.on)) issues.push({ path: `stages.${i}.on`, message: MSG.badDate });
    else if (s.on !== null && s.on > today) issues.push({ path: `stages.${i}.on`, message: MSG.futureDate });
  });
  if (!seen.has("submitted")) issues.push({ path: "stages", message: MSG.submittedMissing });
  if (seen.has("campus_nominated") && seen.has("not_nominated")) issues.push({ path: "stages", message: MSG.bothCampus });
  if (seen.has("not_nominated")) {
    const later = facts.stages.some((s) => STAGE_RANK[s.stage] > STAGE_RANK.not_nominated);
    if (later || isSelected(facts.decision)) issues.push({ path: "stages", message: MSG.afterNotNominated });
  }
  // Dates must not go backwards along the stage order.
  const dated = facts.stages
    .map((s, i) => ({ ...s, i }))
    .filter((s): s is { stage: (typeof s)["stage"]; on: string; i: number } => s.on !== null && isCalendarDate(s.on));
  for (const a of dated) {
    for (const b of dated) {
      if (STAGE_RANK[b.stage] > STAGE_RANK[a.stage] && b.on < a.on) issues.push({ path: `stages.${b.i}.on`, message: MSG.outOfOrder });
    }
  }
  if (facts.decision !== null && facts.decision !== "no_response" && facts.decidedOn === null) {
    issues.push({ path: "decidedOn", message: MSG.decisionDateMissing });
  }
  if (facts.decision === null && facts.decidedOn !== null) issues.push({ path: "decidedOn", message: MSG.dateWithoutDecision });
  if (facts.decidedOn !== null) {
    if (!isCalendarDate(facts.decidedOn)) issues.push({ path: "decidedOn", message: MSG.badDate });
    else if (facts.decidedOn > today) issues.push({ path: "decidedOn", message: MSG.futureDate });
    else if (dated.some((s) => s.on > facts.decidedOn!)) issues.push({ path: "decidedOn", message: MSG.decisionBeforeStage });
  }
  // One issue per path is enough for the form; keep the first.
  const byPath = new Map<string, OutcomeIssue>();
  for (const issue of issues) if (!byPath.has(issue.path)) byPath.set(issue.path, issue);
  return [...byPath.values()];
}

/** Soft checks that flag a report for review (it is still stored). */
export function qualityFlags(facts: OutcomeFacts, ctx: ValidationContext): OutcomeFlagCode[] {
  const flags = new Set<OutcomeFlagCode>();
  const nominated = facts.stages.some((s) => s.stage === "campus_nominated");
  if (ctx.nominationRequired && isSelected(facts.decision) && !nominated) flags.add("award_without_nomination");
  if (facts.decidedOn && isCalendarDate(facts.decidedOn)) {
    if (!ctx.cycle.rollingDecisions && ctx.roundDeadline && isCalendarDate(ctx.roundDeadline) && facts.decidedOn < ctx.roundDeadline) {
      flags.add("decision_before_round_close");
    }
    const window = inDecisionWindow(ctx.cycle, facts.decidedOn, ctx.today, ctx.roundDeadline);
    if (window.basis === "curated" && !window.ok && window.reason !== "future") flags.add("decision_outside_window");
  }
  if (ctx.cycle.classYears.length > 0 && ctx.snapshotClassYear && !ctx.cycle.classYears.includes(ctx.snapshotClassYear)) {
    flags.add("class_standing_not_admitted");
  }
  const cap = ctx.privateConfig.seasonalCap;
  if (cap !== null && Number.isFinite(cap) && ctx.otherReportsThisSeason >= cap) flags.add("seasonal_cap");
  return [...flags].sort();
}

/** Refusals first; a structurally sound report gets its flags. */
export function validateOutcomeReport(facts: OutcomeFacts, ctx: ValidationContext): ValidationResult {
  const errors = structuralIssues(facts, ctx.today);
  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, flags: qualityFlags(facts, ctx) };
}
