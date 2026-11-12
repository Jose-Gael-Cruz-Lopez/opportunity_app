import type { Requirement } from "@shared/contracts";
import type { PlanStepView } from "./normalize";

/**
 * Rules for the first-door screen: which inline widget a plan step gets, a fallback plan if
 * the planner is unavailable, and progress counts for the celebration. Pure and tested.
 */

export type StepWidget = "tracker" | "eligibility" | "draft" | "letters" | "reminder" | "resume" | "open" | "submit" | "plain";

/**
 * Plan step kinds come from @shared/onboarding; matching on kind first and title second keeps
 * the UI working if a kind is renamed.
 */
export function widgetFor(step: Pick<PlanStepView, "kind" | "title" | "id">): StepWidget {
  const k = `${step.kind} ${step.id}`.toLowerCase();
  const t = step.title.toLowerCase();
  const test = (re: RegExp) => re.test(k) || re.test(t);
  if (test(/open_application|official application/)) return "open";
  if (test(/track|save/)) return "tracker";
  if (test(/eligib|confirm/)) return "eligibility";
  if (test(/practi|draft|essay|why|short.?answer|rep\b/)) return "draft";
  if (test(/letter|recommend|referee/)) return "letters";
  if (test(/intention|remind|schedule|calendar/)) return "reminder";
  if (test(/resume|tailor|keyword/)) return "resume";
  if (test(/submit/)) return "submit";
  return "plain";
}

function addDays(iso: string, n: number): string {
  return new Date(Date.parse(`${iso}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
}

/**
 * A minimal plan when planFirstApplication is not available: the same seven-step shape the
 * study notes describe, scheduled backward from the deadline (submit at T-2, letters asked
 * 21 days out, resume tailored within 3 days).
 */
export function fallbackPlan(requirements: readonly Requirement[], deadline: string | null, today: string): PlanStepView[] {
  const letters = requirements.filter((r) => r.kind === "recommendation").reduce((n, r) => n + r.quantity, 0);
  const steps: PlanStepView[] = [
    { id: "save", title: "Save to your Tracker", kind: "tracker", minutes: 1, due: null, doneDuringOnboarding: true },
    { id: "confirm-eligibility", title: "Confirm you're eligible", kind: "eligibility", minutes: 1, due: null, doneDuringOnboarding: true },
    { id: "practice", title: "Draft two opening sentences for 'Why this program?'", kind: "practice", minutes: 2, due: null, doneDuringOnboarding: true },
    { id: "tailor-resume", title: "Tailor your resume to this program", kind: "resume", minutes: 30, due: addDays(today, 3), doneDuringOnboarding: false },
  ];
  if (letters > 0) {
    steps.push({
      id: "ask-letters",
      title: letters === 1 ? "Ask one person for a letter" : `Ask ${letters} people for letters`,
      kind: "letters",
      minutes: 10,
      due: deadline ? maxDate(today, addDays(deadline, -21)) : null,
      doneDuringOnboarding: false,
    });
  }
  // Optional now, dated for later: only save, eligibility and two sentences fit the quick budget.
  steps.push({ id: "intention", title: "Pick when you'll do the next step", kind: "intention", minutes: 1, due: addDays(today, 1), doneDuringOnboarding: false });
  steps.push({ id: "submit", title: "Submit your application", kind: "submit", minutes: 15, due: deadline ? maxDate(today, addDays(deadline, -2)) : null, doneDuringOnboarding: false });
  return steps;
}

function maxDate(a: string, b: string): string {
  return a > b ? a : b;
}

export function doneCount(steps: readonly PlanStepView[], done: ReadonlySet<string>): number {
  return steps.filter((s) => done.has(s.id)).length;
}

/** The first step not yet done, for "Next: ... by Thu 3 Dec" on the celebration. */
export function nextOpenStep(steps: readonly PlanStepView[], done: ReadonlySet<string>): PlanStepView | null {
  return steps.find((s) => !done.has(s.id)) ?? null;
}

const STEP_ID = /^[a-z0-9_-]{1,40}$/;

/** Step ids the server accepts (schemas.ts STEP_PATTERN), at most ten. */
export function serverStepIds(ids: Iterable<string>): string[] {
  return [...ids].filter((id) => STEP_ID.test(id)).slice(0, 10);
}

/**
 * The step a reminder is about: the first open step outside the quick ones, never the
 * "pick a time" step itself (a reminder to set a reminder helps no one).
 */
export function reminderTarget(steps: readonly PlanStepView[], done: ReadonlySet<string>): PlanStepView | null {
  const candidates = steps.filter((s) => widgetFor(s) !== "reminder");
  return candidates.find((s) => !done.has(s.id) && !s.doneDuringOnboarding) ?? nextOpenStep(candidates, done);
}

const FALLBACK_RATIONALES = ["Best match for your answers", "Another strong option", "Worth a stretch"];

/**
 * Three doors when pickFirstDoor is unavailable: the first matches that still have enough
 * time, in the engine's order. The student still chooses; nothing is auto-picked.
 */
export function fallbackDoors(matches: ReadonlyArray<{ programId: string; enoughTime: boolean; tier: string }>): Array<{ programId: string; rationale: string }> {
  return matches
    .filter((m) => m.enoughTime && m.tier !== "stretch")
    .concat(matches.filter((m) => m.enoughTime && m.tier === "stretch"))
    .slice(0, 3)
    .map((m, i) => ({ programId: m.programId, rationale: FALLBACK_RATIONALES[i] }));
}
