/**
 * shared/onboarding: the five-minute onboarding engine.
 *
 *   QUIZ, createQuizState, answerQuiz, skipQuestion, applyResumeSignals, nextQuestion,
 *   toPreferences            -> what the student wants (no status or identity questions)
 *   findMatches              -> tiers (strong / good / stretch) with reasons, never a score;
 *                               never an empty screen (labelled picks to explore)
 *   pickFirstDoor            -> three feasible options; the student picks one
 *   planFirstApplication     -> micro-steps for now plus dated steps scheduled backward
 *                               (takes a ProgramCard or the contract's Program + ProgramCycle)
 *   planToRoadmapItems, planReminders -> what POST /onboarding/first-door saves
 *
 * Everything is pure and runs in the browser and the Worker. Resume files and raw text never
 * reach this module: only shared/resume's PII-free signals do. Sample data lives in
 * `@shared/onboarding/sample` and is labelled as sample; test builders in `./testing`.
 *
 * Eligibility uses shared/eligibility's server-safe engine by default (`defaultEligibility`); a
 * browser may pass a wrapper that also reads the student's private answers on the device.
 *
 * Optional integration points (the module works without them):
 *   findMatches({ prepModel })     -> shared/readiness's leadDaysFor / effortHoursFor (same table)
 *   findMatches({ exposure })      -> server-computed merit-normalized exposure per programId
 *   findMatches({ semantic })      -> on-device student vector + offline program vectors
 *   planFirstApplication({ resolvedDeadline, nominationRequired, prepModel }) -> server callers
 * One vocabulary: server routes accept and store exactly ServerPreferencesSchema and
 * MatchSignalsSchema (strict; no status or identity keys), which the browser builds with
 * toServerPreferences and toMatchSignals.
 */
export {
  QUIZ,
  QuizAnswerError,
  answerQuiz,
  applyResumeSignals,
  choosePair,
  createQuizState,
  estimateSeconds,
  informativePairs,
  isQuizComplete,
  nextQuestion,
  plannedQuestions,
  preferencesToProfile,
  quizProgress,
  quizQuestion,
  skipQuestion,
  toPreferences,
  toServerPreferences,
  type AnswerValue,
  type CreateQuizOptions,
  type NextQuestion,
  type PoolItem,
  type QuestionId,
  type QuestionKind,
  type QuizOption,
  type QuizProgress,
  type QuizQuestion,
  type QuizSpec,
  type QuizState,
  type SliderSpec,
} from "./quiz";
export {
  ALGO_VERSION,
  DEFAULT_K,
  MAX_K,
  MIN_RESULTS,
  MMR_LAMBDA,
  ORG_CAP,
  findMatches,
  type FindMatchesInput,
  type SemanticHook,
} from "./match";
export {
  FirstDoorClosedError,
  firstStepFor,
  pickFirstDoor,
  planFirstApplication,
  planReminders,
  planToRoadmapItems,
  type FirstApplicationInput,
  type PlanCycle,
  type PlanPreferences,
  type PlanProgram,
  type PlanReminder,
} from "./first-door";
export {
  defaultEligibility,
  eligibilityAdapterFrom,
  engineEligibility,
  facetEligibility,
  toChecks,
  type ContextDeadline,
  type EligibilityAdapter,
  type EligibilityOutcome,
} from "./eligibility";
export {
  CAMPUS_LEAD_L50_DAYS,
  CAMPUS_LEAD_L80_DAYS,
  OPENING_SOON_DAYS,
  ROLLING_TARGET_DAYS,
  computeFeasibility,
  effectiveDeadline,
  onOffer,
  type EffectiveDeadline,
  type FeasibilityResult,
} from "./feasibility";
export {
  DEFAULT_PREP_MODEL,
  GUIDANCE_TABLE,
  SUBMIT_BUFFER_DAYS,
  latestStart,
  requirementPrepDays,
  summarizeRequirements,
  type PrepModel,
  type PrepSummary,
  type RequirementLike,
} from "./schedule";
export {
  EXPOSURE_BOOST_MAX,
  RRF_K,
  binaryEntropy,
  cosine,
  exposureBoost,
  jaccard,
  mmrSelect,
  ranksWithTies,
  reciprocalRankFusion,
  type MmrCandidate,
} from "./rank";
export { REASON_CODES, type ReasonCode } from "./reasons";
export { EMPTY_SIGNALS, classYearFromGraduation, toMatchSignals } from "./signals";
export {
  SKILLS,
  SKILL_IDS,
  detectSkills,
  normalizeSkillRefs,
  programSkills,
  skillById,
  skillLabel,
  skillPhrase,
  skillsForName,
  type SkillDef,
  type SkillId,
  type SkillLike,
} from "./skills";
export {
  CATEGORY_LABELS,
  INTEREST_TOPICS,
  INTEREST_TOPIC_IDS,
  PAIRS,
  categoriesForTypes,
  typesForCategories,
  type InterestTopic,
  type InterestTopicId,
  type PairDef,
  type PairId,
  type ResumeSource,
} from "./vocab";
export { ONBOARDING_FUNNEL, onboardingEvent, type OnboardingEvent, type OnboardingEventData, type OnboardingFunnelStep } from "./analytics";
export * from "./types";
