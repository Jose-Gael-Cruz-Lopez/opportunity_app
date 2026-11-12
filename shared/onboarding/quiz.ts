import { EMPTY_STUDENT_PROFILE, type StudentProfile } from "../contracts/student";
import {
  CLASS_YEARS,
  CLASS_YEAR_LABELS,
  EXPERIENCE_KINDS,
  MAJOR_FAMILIES,
  MAJOR_FAMILY_LABELS,
  OPPORTUNITY_CATEGORY_KEYS,
  type ClassYear,
  type ExperienceKind,
  type MajorFamily,
  type OpportunityCategory,
} from "../taxonomy";
import { resolveZone, todayIn, toEpochMs, type NowInput } from "./dates";
import { onOffer } from "./feasibility";
import { binaryEntropy } from "./rank";
import { classYearFromGraduation, courseworkSkills, toMatchSignals } from "./signals";
import { SKILLS, skillById, skillLabel, skillsForFamilies, UNLISTED_SKILL_PREFIX } from "./skills";
import { cleanShortText, looksLikeContactDetail } from "./text";
import type { MatchSignals, ServerPreferences, SignalsInput, StudentPreferences } from "./types";
import {
  CATEGORY_LABELS,
  INTEREST_TOPICS,
  PAIR_EITHER,
  PAIRS,
  pairDef,
  pairSide,
  typesForCategories,
  type GoalValue,
  type InterestTopicId,
  type LocationValue,
  type PairDef,
  type PairId,
  type PayValue,
  type ResumeSource,
  type TimingValue,
} from "./vocab";

/**
 * The onboarding quiz: a data-driven spec plus a small immutable state machine.
 *
 * Design (study notes, plan 01 F-04):
 * - Value first, identity light: what the student wants comes before who they are.
 * - The resume step comes third, so it can prefill the questions after it; prefilled questions
 *   show as "Is this right?" confirmations, the main lever for staying under five minutes.
 * - Two adaptive "this or that" pairs at most, each chosen because it best splits the programs
 *   still in play (a greedy decision-tree interview after Golbandi, Koren and Lempel 2011), and
 *   skipped when the split is worse than 20/80.
 * - Questions that cannot change the result are skipped (no timing or pay question for a
 *   student who only wants scholarships).
 * - No question asks about citizenship or immigration status, income, disability, race or
 *   ethnicity, gender, sexual orientation, religion, first-generation status, military
 *   service, foster care or health. Those stay on the optional private screen, never here.
 */

export type QuestionId =
  | "looking_for"
  | "interests"
  | "resume"
  | "skills"
  | "class_year"
  | "major"
  | PairId
  | "timing"
  | "location"
  | "pay"
  | "weekly_hours"
  | "experience"
  | "goal"
  | "target";

export type QuestionKind = "single" | "multi" | "slider" | "short_text" | "this_or_that" | "resume";
export type AnswerValue = string | readonly string[] | number;

export interface QuizOption {
  readonly value: string;
  readonly label: string;
  readonly hint?: string;
}

export interface SliderSpec {
  readonly min: number;
  readonly max: number;
  readonly step: number;
  readonly defaultValue: number;
  readonly unit: string;
  /** Label for the top value ("10+"). */
  readonly maxLabel?: string;
}

export interface QuizQuestion {
  readonly id: QuestionId;
  readonly kind: QuestionKind;
  readonly prompt: string;
  readonly help?: string;
  readonly options?: readonly QuizOption[];
  readonly maxSelections?: number;
  /** An option that cannot be combined with others ("Not sure", "None yet"). */
  readonly exclusiveOption?: string;
  readonly slider?: SliderSpec;
  readonly maxLength?: number;
  readonly placeholder?: string;
  /** Optional questions show "Skip"; every question here is optional, and "Not sure" is always offered where it makes sense. */
  readonly optional: boolean;
  /** Typical seconds to answer (study budget: about 15-20 s per tap question, 60 s for the resume). */
  readonly seconds: number;
  /** Seconds when shown as a confirmation of a resume prefill. */
  readonly confirmSeconds?: number;
  readonly prefill?: "skills" | "classYear" | "majorFamily" | "experience";
  /** The answer never leaves the device (it is not part of ServerPreferences). */
  readonly deviceOnly?: boolean;
}

export interface QuizSpec {
  readonly version: 1;
  /** Five minutes including the resume step. */
  readonly budgetSeconds: number;
  readonly maxPairs: number;
  /** Skip a pair when fewer than this share of candidates fall on one side. */
  readonly minPairSplit: number;
  readonly questions: readonly QuizQuestion[];
}

const pairQuestion = (p: PairDef): QuizQuestion => ({
  id: p.id,
  kind: "this_or_that",
  prompt: p.prompt,
  options: [
    { value: p.a.value, label: p.a.label },
    { value: p.b.value, label: p.b.label },
    { value: PAIR_EITHER, label: "Both sound good" },
  ],
  optional: true,
  seconds: 8,
});

export const QUIZ: QuizSpec = {
  version: 1,
  budgetSeconds: 300,
  maxPairs: 2,
  minPairSplit: 0.2,
  questions: [
    {
      id: "looking_for",
      kind: "multi",
      prompt: "What are you looking for?",
      help: "Pick up to three.",
      options: [
        ...OPPORTUNITY_CATEGORY_KEYS.map((c) => ({ value: c, label: CATEGORY_LABELS[c] })),
        { value: "not_sure", label: "Not sure yet" },
      ],
      maxSelections: 3,
      exclusiveOption: "not_sure",
      optional: true,
      seconds: 15,
    },
    {
      id: "interests",
      kind: "multi",
      prompt: "What are you curious about?",
      help: "Pick up to five.",
      options: INTEREST_TOPICS.map((t) => ({ value: t.id, label: t.label })),
      maxSelections: 5,
      optional: true,
      seconds: 20,
    },
    {
      id: "resume",
      kind: "resume",
      prompt: "Add your resume to skip some questions",
      help: "We read it here, on your device, to suggest answers. The file is never uploaded.",
      options: [
        { value: "pdf", label: "Upload a PDF" },
        { value: "docx", label: "Upload a Word file" },
        { value: "paste", label: "Paste the text" },
        { value: "none", label: "I don't have one yet" },
      ],
      optional: true,
      seconds: 60,
    },
    {
      id: "skills",
      kind: "multi",
      prompt: "Which skills have you used?",
      help: "In a class, club, job or project. Remove any that don't fit.",
      options: SKILLS.map((s) => ({ value: s.id, label: s.label })),
      maxSelections: 12,
      optional: true,
      seconds: 20,
      confirmSeconds: 12,
      prefill: "skills",
    },
    {
      id: "class_year",
      kind: "single",
      prompt: "What year are you in?",
      options: CLASS_YEARS.map((y) => ({ value: y, label: CLASS_YEAR_LABELS[y] })),
      optional: true,
      seconds: 8,
      confirmSeconds: 4,
      prefill: "classYear",
    },
    {
      id: "major",
      kind: "single",
      prompt: "What do you study, or plan to?",
      options: MAJOR_FAMILIES.map((f) => ({ value: f, label: MAJOR_FAMILY_LABELS[f] })),
      optional: true,
      seconds: 12,
      confirmSeconds: 4,
      prefill: "majorFamily",
    },
    ...PAIRS.map(pairQuestion),
    {
      id: "timing",
      kind: "multi",
      prompt: "When could you do it?",
      options: [
        { value: "next_summer", label: "Next summer" },
        { value: "during_term", label: "During the school year" },
        { value: "winter_break", label: "Over winter break" },
        { value: "anytime", label: "Any time" },
      ],
      maxSelections: 3,
      exclusiveOption: "anytime",
      optional: true,
      seconds: 10,
    },
    {
      id: "location",
      kind: "single",
      prompt: "Where could you be?",
      options: [
        { value: "remote", label: "Remote only" },
        { value: "nearby", label: "Near school or home" },
        { value: "travel", label: "Happy to travel" },
      ],
      optional: true,
      seconds: 8,
    },
    {
      id: "pay",
      kind: "single",
      prompt: "Does it need to pay you?",
      options: [
        { value: "must", label: "Yes, it has to pay" },
        { value: "prefer", label: "Paid would be nice" },
        { value: "any", label: "Doesn't matter" },
      ],
      optional: true,
      seconds: 8,
    },
    {
      id: "weekly_hours",
      kind: "slider",
      prompt: "How many hours a week can you spend on applications?",
      help: "We use this to plan, not to judge.",
      slider: { min: 1, max: 10, step: 1, defaultValue: 3, unit: "h a week", maxLabel: "10+" },
      optional: true,
      seconds: 10,
    },
    {
      id: "experience",
      kind: "multi",
      prompt: "What have you done so far?",
      options: [
        { value: "none_yet", label: "Nothing yet, and that's fine" },
        { value: "independent_project", label: "Projects (class or personal)" },
        { value: "leadership", label: "Club or team leadership" },
        { value: "paid_work", label: "A job" },
        { value: "research", label: "Research" },
        { value: "internship", label: "An internship" },
        { value: "community_service", label: "Volunteering" },
        { value: "competition", label: "Competitions or hackathons" },
        { value: "teaching_or_tutoring", label: "Tutoring or teaching" },
        { value: "insight_program", label: "An insight or discovery program" },
      ],
      maxSelections: 9,
      exclusiveOption: "none_yet",
      optional: true,
      seconds: 15,
      confirmSeconds: 6,
      prefill: "experience",
    },
    {
      id: "goal",
      kind: "single",
      prompt: "What would make this a win?",
      options: [
        { value: "first_yes", label: "Get my first yes" },
        { value: "explore", label: "See what's out there" },
        { value: "funding", label: "Help pay for school" },
        { value: "specific", label: "Get into something I have in mind" },
      ],
      optional: true,
      seconds: 8,
    },
    {
      id: "target",
      kind: "short_text",
      prompt: "Which program or organization do you have in mind?",
      help: "Optional. This stays on your device.",
      placeholder: "A program or organization",
      maxLength: 80,
      optional: true,
      seconds: 20,
      deviceOnly: true,
    },
  ],
};

const BY_ID: ReadonlyMap<QuestionId, QuizQuestion> = new Map(QUIZ.questions.map((q) => [q.id, q]));
const ORDER: ReadonlyMap<QuestionId, number> = new Map(QUIZ.questions.map((q, i) => [q.id, i]));
const PAIR_ID_SET: ReadonlySet<string> = new Set(PAIRS.map((p) => p.id));
const LAST_PAIR_INDEX = Math.max(...PAIRS.map((p) => ORDER.get(p.id) ?? -1));

export function quizQuestion(id: QuestionId): QuizQuestion {
  const q = BY_ID.get(id);
  if (!q) throw new RangeError(`unknown quiz question: ${id}`);
  return q;
}

// ---------------------------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------------------------

/** Compact view of one candidate program: only what the adaptive pairs need. */
export interface PoolItem {
  readonly types: readonly string[];
}

export interface QuizState {
  readonly v: 1;
  readonly answers: Readonly<Partial<Record<QuestionId, AnswerValue>>>;
  readonly skipped: readonly QuestionId[];
  /** Suggestions from the resume, shown as confirmations; never treated as answers until confirmed. */
  readonly prefill: Readonly<Partial<Record<QuestionId, AnswerValue>>>;
  /** Signals from the resume (PII-free), kept so matching can use unconfirmed skills. */
  readonly signals: MatchSignals | null;
  readonly pool: readonly PoolItem[] | null;
  readonly timeZone: string | null;
  /** The student's date when the quiz started, for class-year suggestions. */
  readonly today: string;
}

export interface CreateQuizOptions {
  /**
   * Release cards (or anything with opportunity types), so the pairs adapt to what is on offer.
   * Cards that carry a status count only while matching could show them (open, or opening soon).
   */
  readonly programs?: readonly {
    readonly opportunityTypes: readonly string[];
    readonly status?: string;
    readonly opensOn?: string | null;
    readonly prediction?: { readonly p10: string } | null;
  }[];
  /** The browser's IANA zone (Intl.DateTimeFormat().resolvedOptions().timeZone), so dates match the student's clock. */
  readonly timeZone?: string | null;
  readonly now?: NowInput;
}

export function createQuizState(opts: CreateQuizOptions = {}): QuizState {
  const timeZone = opts.timeZone ?? null;
  const today = todayIn(toEpochMs(opts.now ?? Date.now()), resolveZone(timeZone));
  return {
    v: 1,
    answers: {},
    skipped: [],
    prefill: {},
    signals: null,
    pool: opts.programs ? opts.programs.filter((p) => onOffer(p, today)).map((p) => ({ types: [...p.opportunityTypes] })) : null,
    timeZone,
    today,
  };
}

export class QuizAnswerError extends Error {
  constructor(
    readonly questionId: string,
    readonly reason: string,
  ) {
    super(`invalid answer for ${questionId}: ${reason}`);
    this.name = "QuizAnswerError";
  }
}

/**
 * Records the resume's signals as suggestions. The file and its text never reach this
 * function: only the PII-free signals do. Prefilled questions are then asked as confirmations.
 */
export function applyResumeSignals(state: QuizState, input: SignalsInput | MatchSignals | null, source?: ResumeSource): QuizState {
  // "I don't have one yet" means no suggestions, whatever else was passed along with it.
  if (source === "none") return answerQuiz(state, "resume", "none");
  const signals = toMatchSignals(input);
  // Suggestions come only from the resume, so a new resume replaces them all.
  const prefill: Partial<Record<QuestionId, AnswerValue>> = {};
  const skills = [...new Set([...signals.skills, ...courseworkSkills(signals)])].slice(0, QUIZ.questions.find((q) => q.id === "skills")?.maxSelections ?? 12);
  if (skills.length > 0) prefill.skills = skills;
  // shared/resume may already infer a class year; otherwise infer it from the graduation year.
  const given = input && "classYear" in input && typeof input.classYear === "string" && (CLASS_YEARS as readonly string[]).includes(input.classYear) ? (input.classYear as ClassYear) : null;
  const classYear = given ?? (signals.graduationYear !== null ? classYearFromGraduation(signals.graduationYear, state.today) : null);
  if (classYear) prefill.class_year = classYear;
  const major = signals.fields[0];
  if (major) prefill.major = major;
  if (signals.experience.length > 0) prefill.experience = signals.experience;
  const answers: Partial<Record<QuestionId, AnswerValue>> = { ...state.answers };
  if (source) answers.resume = source;
  return {
    ...state,
    answers,
    skipped: source ? state.skipped.filter((id) => id !== "resume") : state.skipped,
    prefill,
    signals,
  };
}

function allowedValues(state: QuizState, q: QuizQuestion): ReadonlySet<string> {
  const values = new Set((q.options ?? []).map((o) => o.value));
  if (q.id === "skills") {
    const pre = state.prefill.skills;
    if (Array.isArray(pre)) for (const v of pre) values.add(v);
  }
  return values;
}

function validate(state: QuizState, q: QuizQuestion, value: AnswerValue): AnswerValue | null {
  switch (q.kind) {
    case "single":
    case "this_or_that":
    case "resume": {
      if (typeof value !== "string" || !allowedValues(state, q).has(value)) throw new QuizAnswerError(q.id, "not one of the options");
      return value;
    }
    case "multi": {
      if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) throw new QuizAnswerError(q.id, "expected a list");
      const allowed = allowedValues(state, q);
      const unique = [...new Set(value as readonly string[])];
      for (const v of unique) if (!allowed.has(v)) throw new QuizAnswerError(q.id, "not one of the options");
      // A real pick overrides "Not sure" / "None yet" when both are sent.
      const picked = q.exclusiveOption && unique.length > 1 ? unique.filter((v) => v !== q.exclusiveOption) : unique;
      if (q.maxSelections !== undefined && picked.length > q.maxSelections) throw new QuizAnswerError(q.id, `pick at most ${q.maxSelections}`);
      return picked;
    }
    case "slider": {
      const s = q.slider;
      if (!s || typeof value !== "number" || !Number.isFinite(value)) throw new QuizAnswerError(q.id, "expected a number");
      if (value < s.min || value > s.max) throw new QuizAnswerError(q.id, "out of range");
      return Math.round((value - s.min) / s.step) * s.step + s.min;
    }
    case "short_text": {
      if (typeof value !== "string") throw new QuizAnswerError(q.id, "expected text");
      const cleaned = cleanShortText(value, q.maxLength ?? 80);
      // Contact details or ID-like numbers are never needed here, so the answer is dropped.
      if (!cleaned || looksLikeContactDetail(cleaned)) return null;
      return cleaned;
    }
  }
}

/** Records an answer (validated and normalized). A null answer, or text that had to be dropped, counts as a skip. */
export function answerQuiz(state: QuizState, questionId: QuestionId, value: AnswerValue | null): QuizState {
  const q = quizQuestion(questionId);
  const normalized = value === null ? null : validate(state, q, value);
  if (normalized === null) return skipQuestion(state, questionId);
  const next: QuizState = {
    ...state,
    answers: { ...state.answers, [questionId]: normalized },
    skipped: state.skipped.filter((id) => id !== questionId),
  };
  // "I don't have one yet" withdraws any earlier resume and its suggestions.
  return questionId === "resume" && normalized === "none" ? { ...next, prefill: {}, signals: null } : next;
}

export function skipQuestion(state: QuizState, questionId: QuestionId): QuizState {
  const q = quizQuestion(questionId);
  if (!q.optional) throw new QuizAnswerError(questionId, "this question cannot be skipped");
  const answers = { ...state.answers };
  delete answers[questionId];
  return {
    ...state,
    answers,
    skipped: state.skipped.includes(questionId) ? state.skipped : [...state.skipped, questionId],
  };
}

// ---------------------------------------------------------------------------------------------
// Adaptive flow
// ---------------------------------------------------------------------------------------------

function chosenCategories(state: QuizState): OpportunityCategory[] {
  const v = state.answers.looking_for;
  return Array.isArray(v) ? (v.filter((x) => x !== "not_sure") as OpportunityCategory[]) : [];
}

function scholarshipsOnly(state: QuizState): boolean {
  const cats = chosenCategories(state);
  return cats.length === 1 && cats[0] === "scholarships";
}

function handled(state: QuizState, id: QuestionId): boolean {
  return state.answers[id] !== undefined || state.skipped.includes(id);
}

/** True once the student has moved past the pair slot (a later question answered or skipped). */
function pairSlotClosed(state: QuizState): boolean {
  return QUIZ.questions.some((q, i) => i > LAST_PAIR_INDEX && handled(state, q.id));
}

/** Candidates still in play: the pool narrowed by the asked-for categories and the pair answers. */
function candidatePool(state: QuizState): PoolItem[] {
  const cats = chosenCategories(state);
  const wanted = new Set<string>(typesForCategories(cats.length > 0 ? cats : OPPORTUNITY_CATEGORY_KEYS));
  let pool: PoolItem[] = state.pool
    ? state.pool.filter((p) => cats.length === 0 || p.types.some((t) => wanted.has(t)))
    : [...wanted].map((t) => ({ types: [t] })); // no programs given: one pseudo-candidate per type
  for (const pair of PAIRS) {
    const answer = state.answers[pair.id];
    if (answer !== pair.a.value && answer !== pair.b.value) continue;
    const side = answer === pair.a.value ? "a" : "b";
    pool = pool.filter((p) => {
      const s = pairSide(pair, p.types);
      return s === null || s === side;
    });
  }
  return pool;
}

/**
 * Unasked pairs whose split of the remaining candidates is at least 20/80, most informative
 * (highest entropy) first; ties keep spec order.
 */
export function informativePairs(state: QuizState): PairId[] {
  const pool = candidatePool(state);
  const scored: { id: PairId; h: number; order: number }[] = [];
  PAIRS.forEach((pair, order) => {
    if (handled(state, pair.id)) return;
    let a = 0;
    let b = 0;
    for (const item of pool) {
      const side = pairSide(pair, item.types);
      if (side === "a") a++;
      else if (side === "b") b++;
    }
    const n = a + b;
    if (n < 2) return;
    const p = a / n;
    if (Math.min(p, 1 - p) < QUIZ.minPairSplit) return;
    scored.push({ id: pair.id, h: binaryEntropy(p), order });
  });
  scored.sort((x, y) => y.h - x.h || x.order - y.order);
  return scored.map((s) => s.id);
}

/** The unasked pair that best splits the candidates, or null when none splits at least 20/80. */
export function choosePair(state: QuizState): PairId | null {
  return informativePairs(state)[0] ?? null;
}

function pairsHandled(state: QuizState): number {
  return PAIRS.filter((p) => handled(state, p.id)).length;
}

/** Whether a non-pair question should be asked at all, given earlier answers. */
function relevant(state: QuizState, q: QuizQuestion): boolean {
  switch (q.id) {
    case "target":
      return state.answers.goal === "specific";
    case "timing":
    case "location":
    case "pay":
      // Scholarships have no dates to fit, no place to be and pay by definition.
      return !scholarshipsOnly(state);
    default:
      return true;
  }
}

export interface QuizProgress {
  /** 1-based; starts at 2 because finishing the welcome screen counts (endowed progress). */
  readonly step: number;
  readonly of: number;
}

export interface NextQuestion {
  readonly question: QuizQuestion;
  readonly mode: "ask" | "confirm";
  /** The resume's suggestion when mode is "confirm". */
  readonly suggested?: AnswerValue;
  /** Options to render, ordered for this student (skills: suggested first, then their fields). */
  readonly options?: readonly QuizOption[];
  readonly progress: QuizProgress;
}

function resolvedOptions(state: QuizState, q: QuizQuestion): readonly QuizOption[] | undefined {
  if (q.id !== "skills") return q.options;
  const suggested = Array.isArray(state.prefill.skills) ? (state.prefill.skills as readonly string[]) : [];
  const families: string[] = [];
  const major = state.answers.major ?? state.prefill.major;
  if (typeof major === "string") families.push(major);
  const interests = state.answers.interests;
  if (Array.isArray(interests)) {
    for (const id of interests) for (const f of INTEREST_TOPICS.find((t) => t.id === id)?.families ?? []) families.push(f);
  }
  const ordered: QuizOption[] = [];
  const seen = new Set<string>();
  for (const ref of [...suggested, ...skillsForFamilies(families)]) {
    if (seen.has(ref)) continue;
    seen.add(ref);
    ordered.push({ value: ref, label: skillLabel(ref), ...(suggested.includes(ref) ? { hint: "From your resume" } : {}) });
  }
  return ordered;
}

/**
 * The ids the student will see, in order, given what is known now (answered, skipped or still
 * to ask). Future pairs are an estimate: the pairs informative right now, up to the cap.
 */
export function plannedQuestions(state: QuizState): QuestionId[] {
  const out: QuestionId[] = [];
  const future =
    pairSlotClosed(state) ? [] : informativePairs(state).slice(0, Math.max(0, QUIZ.maxPairs - pairsHandled(state)));
  let pairsPushed = false;
  for (const q of QUIZ.questions) {
    if (PAIR_ID_SET.has(q.id)) {
      if (pairsPushed) continue;
      pairsPushed = true;
      for (const p of PAIRS) if (handled(state, p.id)) out.push(p.id);
      out.push(...future);
      continue;
    }
    if (handled(state, q.id) || relevant(state, q)) out.push(q.id);
  }
  return out;
}

export function quizProgress(state: QuizState): QuizProgress {
  const planned = plannedQuestions(state);
  const done = planned.filter((id) => handled(state, id)).length;
  return { step: Math.min(done + 2, planned.length + 1), of: planned.length + 1 };
}

/** The next question to show, or null when the quiz is complete. Pure: it never changes the state. */
export function nextQuestion(state: QuizState): NextQuestion | null {
  for (const q of QUIZ.questions) {
    if (handled(state, q.id)) continue;
    if (PAIR_ID_SET.has(q.id)) {
      if (pairSlotClosed(state) || pairsHandled(state) >= QUIZ.maxPairs) continue;
      const pick = choosePair(state);
      if (pick === null) continue;
      const pq = quizQuestion(pick);
      return { question: pq, mode: "ask", options: pq.options, progress: quizProgress(state) };
    }
    if (!relevant(state, q)) continue;
    const suggested = state.prefill[q.id];
    const options = resolvedOptions(state, q);
    if (suggested !== undefined) {
      return { question: q, mode: "confirm", suggested, ...(options ? { options } : {}), progress: quizProgress(state) };
    }
    return { question: q, mode: "ask", ...(options ? { options } : {}), progress: quizProgress(state) };
  }
  return null;
}

export function isQuizComplete(state: QuizState): boolean {
  return nextQuestion(state) === null;
}

/** Seconds the questions in `ids` take, using the confirmation time where a prefill exists. */
export function estimateSeconds(state: QuizState, ids: readonly QuestionId[] = plannedQuestions(state)): number {
  return ids.reduce((sum, id) => {
    const q = quizQuestion(id);
    return sum + (state.prefill[id] !== undefined && q.confirmSeconds !== undefined ? q.confirmSeconds : q.seconds);
  }, 0);
}

// ---------------------------------------------------------------------------------------------
// Preferences
// ---------------------------------------------------------------------------------------------

const DEFAULT_WEEKLY_HOURS = quizQuestion("weekly_hours").slider?.defaultValue ?? 3;

function stringAnswer(state: QuizState, id: QuestionId): string | null {
  const v = state.answers[id];
  return typeof v === "string" ? v : null;
}

function listAnswer(state: QuizState, id: QuestionId): string[] {
  const v = state.answers[id];
  return Array.isArray(v) ? [...(v as readonly string[])] : [];
}

function leaning<T extends string>(state: QuizState, id: PairId): T | null {
  const v = stringAnswer(state, id);
  const pair = pairDef(id);
  return pair && (v === pair.a.value || v === pair.b.value) ? (v as T) : null;
}

/**
 * The student's preferences. Unanswered questions mean "no preference", never a guess; resume
 * suggestions the student did not confirm are not copied into the profile fields.
 */
export function toPreferences(state: QuizState): StudentPreferences {
  const categories = chosenCategories(state);
  const skillsAnswered = state.answers.skills !== undefined;
  const skills = skillsAnswered
    ? listAnswer(state, "skills")
    : Array.isArray(state.prefill.skills)
      ? [...(state.prefill.skills as readonly string[])]
      : [];
  const resume = stringAnswer(state, "resume");
  const target = stringAnswer(state, "target");
  const classYear = stringAnswer(state, "class_year");
  const major = stringAnswer(state, "major");
  const location = stringAnswer(state, "location");
  const pay = stringAnswer(state, "pay");
  const goal = stringAnswer(state, "goal");
  const hours = state.answers.weekly_hours;
  return {
    v: 1,
    categories,
    opportunityTypes: typesForCategories(categories),
    interests: listAnswer(state, "interests") as InterestTopicId[],
    skills: skills.filter((s) => skillById(s) !== undefined || s.startsWith(UNLISTED_SKILL_PREFIX)).slice(0, 30),
    skillsConfirmed: skillsAnswered,
    classYear: classYear && (CLASS_YEARS as readonly string[]).includes(classYear) ? (classYear as ClassYear) : null,
    majorFamily: major && (MAJOR_FAMILIES as readonly string[]).includes(major) ? (major as MajorFamily) : null,
    leanings: {
      style: leaning(state, "pair_style"),
      length: leaning(state, "pair_length"),
      value: leaning(state, "pair_value"),
    },
    timing: listAnswer(state, "timing").filter((t) => t !== "anytime") as TimingValue[],
    location: (location as LocationValue | null) ?? null,
    pay: (pay as PayValue | null) ?? "any",
    weeklyHours: typeof hours === "number" ? hours : DEFAULT_WEEKLY_HOURS,
    experience: listAnswer(state, "experience").filter((e): e is ExperienceKind => (EXPERIENCE_KINDS as readonly string[]).includes(e)),
    goal: (goal as GoalValue | null) ?? null,
    hasResume: resume === "pdf" || resume === "docx" || resume === "paste" || (resume === null && state.signals !== null),
    timeZone: state.timeZone,
    target: target ?? null,
  };
}

/** Preferences without device-only answers, for any server route. */
export function toServerPreferences(prefs: StudentPreferences): ServerPreferences {
  const { target: _deviceOnly, ...rest } = prefs;
  return rest;
}

/** The non-sensitive StudentProfile fields the quiz can fill (everything else stays empty). */
export function preferencesToProfile(prefs: ServerPreferences | StudentPreferences): StudentProfile {
  return {
    ...EMPTY_STUDENT_PROFILE,
    classYear: prefs.classYear,
    majorFamily: prefs.majorFamily,
    interestTags: [...prefs.interests],
    preferredOpportunityTypes: [...prefs.opportunityTypes],
    priorExperience: [...prefs.experience],
    weeklyPrepHours: prefs.weeklyHours,
    timeZone: prefs.timeZone,
  };
}
