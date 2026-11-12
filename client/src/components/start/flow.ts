/**
 * The onboarding flow as data: five stages, each with a time budget. The page shows a
 * progress bar and "about N min left" from these numbers, so the promises on the welcome
 * screen (five minutes to matches, a few more to start one application) are checked against
 * the same table the UI uses.
 *
 * Budgets follow the study notes: about 15-20 s per tap question, about 60 s for the resume,
 * and the rest split between matches and the first door. They are estimates for the copy, not
 * measurements of the student.
 */

export const STAGES = ["welcome", "quiz", "resume", "matches", "door", "done"] as const;
export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  welcome: "Welcome",
  quiz: "A few questions",
  resume: "Your resume",
  matches: "Your matches",
  door: "Your first door",
  done: "Done",
};

/**
 * Seconds each stage is expected to take. `done` costs nothing; it is the celebration.
 * The resume step sits inside the quiz (third question, so it can prefill the rest), so its
 * minute is budgeted under "quiz" and the page reports quiz progress during it.
 *
 * The promise is "about five minutes to your matches" (welcome + quiz + matches = 255 s), then
 * the first door's quick steps. The door budget is the sum of the planner's quick-step minutes
 * (save 1 + eligibility 1 + two sentences 2), so the header's "min left" and the "Now · about N
 * min" labels under it come from the same numbers (flow.test.ts checks this).
 */
export const DOOR_QUICK_MINUTES = 4;

export const STAGE_BUDGET_SECONDS: Record<Stage, number> = {
  welcome: 15,
  quiz: 210,
  resume: 0,
  matches: 30,
  door: DOOR_QUICK_MINUTES * 60,
  done: 0,
};

/** Seconds from the welcome screen to the matches reveal: the "five minutes" on the welcome screen. */
export const TO_MATCHES_SECONDS = STAGE_BUDGET_SECONDS.welcome + STAGE_BUDGET_SECONDS.quiz + STAGE_BUDGET_SECONDS.resume + STAGE_BUDGET_SECONDS.matches;

export const TOTAL_BUDGET_SECONDS = STAGES.reduce((sum, s) => sum + STAGE_BUDGET_SECONDS[s], 0);

/** Endowed progress (Nunes and Drèze 2006): the bar starts a little filled, never at zero. */
export const ENDOWED_START = 0.06;

export function stageIndex(stage: Stage): number {
  return STAGES.indexOf(stage);
}

export function nextStage(stage: Stage): Stage {
  const i = stageIndex(stage);
  return STAGES[Math.min(i + 1, STAGES.length - 1)];
}

export function previousStage(stage: Stage): Stage {
  const i = stageIndex(stage);
  return STAGES[Math.max(i - 1, 0)];
}

export function isStage(value: unknown): value is Stage {
  return typeof value === "string" && (STAGES as readonly string[]).includes(value);
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

/**
 * Overall progress between 0 and 1. `within` is how far the student is through the current
 * stage (0..1), for example answered questions over total questions.
 */
export function progressFraction(stage: Stage, within = 0): number {
  if (stage === "done") return 1;
  const before = STAGES.slice(0, stageIndex(stage)).reduce((s, x) => s + STAGE_BUDGET_SECONDS[x], 0);
  const spent = before + STAGE_BUDGET_SECONDS[stage] * clamp01(within);
  const raw = spent / TOTAL_BUDGET_SECONDS;
  return ENDOWED_START + (1 - ENDOWED_START) * clamp01(raw);
}

/**
 * Whole minutes left, rounded up so the copy never promises less time than the table says.
 * Returns 0 only at the end.
 */
export function minutesLeft(stage: Stage, within = 0): number {
  if (stage === "done") return 0;
  const after = STAGES.slice(stageIndex(stage) + 1).reduce((s, x) => s + STAGE_BUDGET_SECONDS[x], 0);
  const remainingHere = STAGE_BUDGET_SECONDS[stage] * (1 - clamp01(within));
  return Math.max(1, Math.ceil((after + remainingHere) / 60));
}

/** "About 4 min left" style copy; one place so tests pin the wording. */
export function timeLeftLabel(stage: Stage, within = 0): string {
  if (stage === "done") return "All done";
  const m = minutesLeft(stage, within);
  return m <= 1 ? "Under a minute left" : `About ${m} min left`;
}
