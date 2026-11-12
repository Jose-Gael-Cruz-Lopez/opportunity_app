import type { Program, ProgramCycle, RoadmapItem } from "@shared/contracts";
import { addDays, compareIsoDates, isIsoDate } from "@shared/time/iso";
import { termKeyForDate } from "@shared/time/terms";
import type { CatalogEntry, FirstApplicationPlan, PlanStep, ReminderDraft } from "./ports";

/**
 * Pure builders for POST /onboarding/first-door. The route turns the student's chosen program
 * and the plan from shared/onboarding into a TrackerItem, student-sourced RoadmapItems and
 * reminders. Keeping this logic pure makes the privacy rules (consent, neutral copy) testable.
 */

export type TrackingConsentKind = "sensitive_tracking" | "identity_tracking" | "health_tracking";

/**
 * Which consent links a student to this program on the server. Programs open only to a status,
 * Pell recipients or a health condition reveal the student's answer just by being tracked
 * (plan 09), so the server needs an explicit consent first; otherwise the client keeps the
 * first door on the device.
 */
export function trackingConsentKind(program: Pick<Program, "sensitiveAudience" | "identityAudience">): TrackingConsentKind | null {
  if (program.identityAudience.includes("health")) return "health_tracking";
  if (program.sensitiveAudience) return "sensitive_tracking";
  if (program.identityAudience.length > 0) return "identity_tracking";
  return null;
}

/** Identity- and sensitive-audience programs default to reminders that do not name them. */
export function defaultNameInMessages(program: Pick<Program, "sensitiveAudience" | "identityAudience">): boolean {
  return trackingConsentKind(program) === null;
}

const APPLYABLE_STATUSES: ReadonlySet<ProgramCycle["status"]> = new Set(["open", "expected", "relaunched"]);

/** The requested cycle when it belongs to the program, is published and can still be applied to. */
export function selectCycle(entry: CatalogEntry, programCycleId: string): ProgramCycle | null {
  if (!entry.program.isPublished || entry.program.lifecycle !== "active") return null;
  const cycle = entry.cycles.find((c) => c.id === programCycleId && c.programId === entry.program.id);
  return cycle && APPLYABLE_STATUSES.has(cycle.status) ? cycle : null;
}

/** True when the cycle's effective deadline is known and already behind the student's today. */
export function deadlinePassed(entry: CatalogEntry, cycleId: string, today: string): boolean {
  const deadline = entry.deadlines?.[cycleId] ?? null;
  return deadline !== null && compareIsoDates(deadline, today) < 0;
}

const isSubmitStep = (step: PlanStep): boolean => step.kind === "submit";

const validDue = (step: PlanStep): string | null => (step.due && isIsoDate(step.due) ? step.due : null);

/**
 * A step counts as done only when the student finished it in the session (completedStepIds), or
 * when it is the save step this very request performs by creating the TrackerItem. The plan's
 * doneDuringOnboarding flag means "can be done in onboarding", never "was done": a student who
 * skipped the nomination email must still get its roadmap item and reminder.
 */
export function isStepDone(step: PlanStep, completedStepIds: readonly string[]): boolean {
  return step.kind === "save" || completedStepIds.includes(step.id);
}

export interface RoadmapBuildInput {
  readonly program: Program;
  readonly cycle: ProgramCycle;
  readonly plan: FirstApplicationPlan;
  readonly completedStepIds: readonly string[];
  /** The student's today (YYYY-MM-DD in their zone); the term fallback for undated steps. */
  readonly today: string;
}

/**
 * One RoadmapItem per plan step. The submit step becomes the cycle's `apply:` item (the key the
 * roadmap already uses), other steps become `prep:` items scoped to the program and cycle, so a
 * retry upserts the same keys instead of adding rows.
 */
export function buildRoadmapItems(input: RoadmapBuildInput): RoadmapItem[] {
  const { program, cycle, plan, completedStepIds, today } = input;
  return plan.steps.map((step): RoadmapItem => {
    const due = validDue(step);
    const submit = isSubmitStep(step);
    return {
      itemKey: submit ? `apply:${program.id}:${cycle.cycleKey}` : `prep:${program.id}:${cycle.cycleKey}:${step.id}`,
      kind: submit ? "apply" : "prepare",
      term: termKeyForDate(due ?? today),
      title: step.title.slice(0, 200),
      detail: null,
      programId: program.id,
      programSlug: program.slug,
      programCycleId: cycle.id,
      cycleKey: cycle.cycleKey,
      dueOn: due,
      startBy: null,
      // Prep dates are scheduled backward from the deadline, so they are estimates; the submit
      // date follows the cycle (an expected cycle's dates are predictions).
      dateConfidence: submit ? (cycle.status === "expected" ? "expected" : "official") : "estimated",
      state: isStepDone(step, completedStepIds) ? "done" : "open",
      pinned: submit,
      reasonCodes: ["FIRST_DOOR"],
      source: "student",
    };
  });
}

export interface ReminderBuildInput {
  readonly trackerItemId: string;
  readonly plan: FirstApplicationPlan;
  readonly completedStepIds: readonly string[];
  readonly intention: { readonly stepId: string; readonly on: string; readonly at: string } | null;
  readonly today: string;
  readonly timeZone: string;
  readonly neutral: boolean;
}

/** Morning reminders keep the send inside waking hours in every US zone. */
export const DEFAULT_REMINDER_TIME = "09:00";
export const MAX_REMINDERS = 8;

/**
 * Reminders for open dated steps (the day before each due date, never in the past) and one for
 * the student's implementation intention. The intention must name a step in the plan and a day
 * from today on; otherwise it is ignored rather than failing the whole first door.
 */
export function buildReminders(input: ReminderBuildInput): ReminderDraft[] {
  const { trackerItemId, plan, completedStepIds, intention, today, timeZone, neutral } = input;
  const steps: ReminderDraft[] = [];
  for (const step of plan.steps) {
    const due = validDue(step);
    if (!due || isStepDone(step, completedStepIds) || compareIsoDates(due, today) < 0) continue;
    const dayBefore = addDays(due, -1);
    steps.push({
      key: `fd:${trackerItemId}:${step.id}`,
      trackerItemId,
      kind: isSubmitStep(step) ? "submit_buffer" : "step_due",
      stepId: step.id,
      sendOn: compareIsoDates(dayBefore, today) < 0 ? today : dayBefore,
      at: DEFAULT_REMINDER_TIME,
      timeZone,
      neutral,
    });
  }
  const byDate = (a: ReminderDraft, b: ReminderDraft): number => compareIsoDates(a.sendOn, b.sendOn);
  const intentionValid =
    intention !== null && plan.steps.some((s) => s.id === intention.stepId) && compareIsoDates(intention.on, today) >= 0;
  if (!intention || !intentionValid) return steps.sort(byDate).slice(0, MAX_REMINDERS);
  // The intention is the student's own commitment, so it always keeps its slot under the cap.
  return [
    ...steps.sort(byDate).slice(0, MAX_REMINDERS - 1),
    {
      key: `fd:${trackerItemId}:intention:${intention.stepId}`,
      trackerItemId,
      kind: "intention" as const,
      stepId: intention.stepId,
      sendOn: intention.on,
      at: intention.at.slice(0, 5),
      timeZone,
      neutral,
    },
  ].sort(byDate);
}
