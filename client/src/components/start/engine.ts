import * as Onboarding from "@shared/onboarding";
import type { ProgramBundle } from "./catalog";
import {
  normalizeFirstDoor,
  normalizeMatchSet,
  normalizePlan,
  normalizePlanMeta,
  normalizeQuestion,
  normalizeQuizSpec,
  type DoorOptionView,
  type MatchView,
  type PlanMetaView,
  type PlanStepView,
  type QuestionView,
} from "./normalize";
import { toEngineSignals, type SignalsView } from "./resume-view";
import type { QuizAnswerValue } from "./storage";

/**
 * The seam between the onboarding UI and @shared/onboarding (quiz, matching, first door,
 * plan). The resume side lives in resume-engine.ts, so each can be tested on its own. Everything the UI renders goes through the tolerant readers in
 * normalize.ts and resume-view.ts, so if an output field is renamed at integration only this
 * file and those readers change.
 *
 * All of these run in the browser. None of them sends anything anywhere.
 */

type QuizState = ReturnType<typeof Onboarding.createQuizState>;
type Preferences = ReturnType<typeof Onboarding.toPreferences>;
type MatchSet = ReturnType<typeof Onboarding.findMatches>;

/* ---------- quiz ---------- */

export function quizQuestions(): QuestionView[] {
  return normalizeQuizSpec(Onboarding.QUIZ);
}

export interface ReplayOptions {
  /** The programs on the device, so the adaptive "this or that" pairs split what is open. */
  bundles: readonly ProgramBundle[];
  /** Resume signals from this session (memory only), applied as confirmable suggestions. */
  signals: SignalsView | null;
  timeZone: string | null;
  now: Date;
}

/** The quiz's resume sources; the no-resume builder counts as pasted text. */
function quizResumeSource(value: QuizAnswerValue | undefined): "pdf" | "docx" | "paste" | "none" | undefined {
  if (value === "builder") return "paste";
  return value === "pdf" || value === "docx" || value === "paste" || value === "none" ? value : undefined;
}

/**
 * Rebuilds the quiz state from saved answers in their original order. Replaying through
 * answerQuiz keeps the module's adaptive logic (skips, pairs) authoritative. The resume
 * answer goes through applyResumeSignals so later questions become confirmations.
 */
export function replayQuiz(answers: Record<string, QuizAnswerValue>, order: readonly string[], opts: ReplayOptions): QuizState {
  let state = Onboarding.createQuizState({
    programs: opts.bundles.map((b) => b.card),
    timeZone: opts.timeZone,
    now: opts.now,
  });
  for (const id of order) {
    if (!(id in answers)) continue;
    try {
      if (id === "resume") {
        const source = quizResumeSource(answers[id]);
        state = source
          ? Onboarding.applyResumeSignals(state, opts.signals ? toEngineSignals(opts.signals) : null, source)
          : Onboarding.answerQuiz(state, "resume", null);
      } else {
        state = Onboarding.answerQuiz(state, id as never, answers[id] as never);
      }
    } catch {
      // An answer the current quiz no longer accepts is dropped, not fatal.
    }
  }
  return state;
}

/** Throws (QuizAnswerError) when the quiz would reject the value; used to validate first. */
export function answer(state: QuizState, id: string, value: QuizAnswerValue): QuizState {
  if (id === "resume") {
    const source = quizResumeSource(value);
    return source ? Onboarding.applyResumeSignals(state, null, source) : Onboarding.answerQuiz(state, "resume", null);
  }
  return Onboarding.answerQuiz(state, id as never, value as never);
}

export function nextQuestionView(state: QuizState): QuestionView | null {
  return normalizeQuestion(Onboarding.nextQuestion(state));
}

export function preferencesOf(state: QuizState): Preferences {
  return Onboarding.toPreferences(state);
}

/* ---------- matching ---------- */

/**
 * Bundles in the shape findMatches reads: a client-core ProgramCard plus optional extras the
 * card does not carry yet (format, compact requirements, listed skills). Unknown extras are
 * left out, which the engine treats as "unknown", never as a mismatch.
 */
export function onboardingProgramsOf(bundles: readonly ProgramBundle[]) {
  return bundles.map((b) => ({
    ...b.card,
    extras: {
      ...(b.meta.place ? { format: [b.meta.remote ? "remote" : "in_person"] as const } : {}),
      requirements: b.requirements.map((r) => ({
        id: r.id,
        kind: r.kind,
        label: r.label,
        quantity: r.quantity,
        effortHours: r.effortHours,
        leadTimeDays: r.leadTimeDays,
      })),
      skills: b.card.interestTags,
    },
  }));
}

export interface MatchRun {
  raw: MatchSet;
  views: MatchView[];
}

/**
 * Matching on the device. `eligibility` is the on-device adapter (device-eligibility.ts) that
 * also reads the student's private answers from memory; omitted, the shared server-safe default
 * applies and private rules stay "Eligible if ..." checks.
 */
export function runMatches(
  preferences: Preferences,
  signals: SignalsView | null,
  bundles: readonly ProgramBundle[],
  now: Date,
  k = 10,
  eligibility?: Onboarding.EligibilityAdapter,
): MatchRun {
  const raw = Onboarding.findMatches({
    preferences,
    signals: signals ? toEngineSignals(signals) : null,
    programs: onboardingProgramsOf(bundles),
    now,
    k,
    ...(eligibility ? { eligibility } : {}),
  });
  return { raw, views: normalizeMatchSet(raw) };
}

export function firstDoors(raw: MatchSet, preferences: Preferences, now: Date): DoorOptionView[] {
  return normalizeFirstDoor(Onboarding.pickFirstDoor(raw, preferences, now));
}

export interface PlanRun {
  steps: PlanStepView[];
  meta: PlanMetaView;
}

export function planFor(bundle: ProgramBundle, signals: SignalsView | null, now: Date, preferences: Preferences | null, aiAvailable: boolean): PlanRun {
  const [program] = onboardingProgramsOf([bundle]);
  const raw = Onboarding.planFirstApplication({
    program,
    cycle: bundle.cycle,
    requirements: bundle.requirements,
    signals: signals ? toEngineSignals(signals) : null,
    now,
    preferences,
    // AI drafting help is offered only when the server has a key; consent is asked separately.
    ai: { available: aiAvailable, consented: false },
  });
  return { steps: normalizePlan(raw), meta: normalizePlanMeta(raw) };
}

/** Interest topic label for the practice draft ("Climate and environment"), or null. */
export function interestLabel(id: string | undefined): string | null {
  if (!id) return null;
  try {
    return Onboarding.INTEREST_TOPICS.find((t) => t.id === id)?.label ?? null;
  } catch {
    return null;
  }
}

/**
 * Preferences for the server in the one shared vocabulary (ServerPreferencesSchema): the
 * device-only free-text target is removed by the engine's own toServerPreferences.
 */
export function serverPreferencesOf(preferences: Preferences): Onboarding.ServerPreferences {
  return Onboarding.toServerPreferences(preferences);
}

/**
 * The confirmed resume signals as the server stores them (MatchSignalsSchema): closed
 * vocabularies, skill references, short coursework keywords. No names, sentences or text.
 */
export function serverSignalsOf(signals: SignalsView | null): Onboarding.MatchSignals | null {
  return signals ? Onboarding.toMatchSignals(toEngineSignals(signals)) : null;
}
