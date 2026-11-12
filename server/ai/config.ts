import { PRODUCT } from "@shared/config/product";

/**
 * Static configuration for the Gemini-backed AI layer: model allowlist and capabilities, prices
 * for the spend ledger, per-route limits, retry and timeout policy, and the minimum user age.
 *
 * Model facts were checked against the Gemini docs (aistudio.google.com/docs/models and /pricing)
 * on 2026-11-11. Prices change on known dates, so each model carries a dated price list.
 */

export type ThinkingLevel = "minimal" | "low" | "medium" | "high";
const THINKING_ORDER: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high"];

/** Prices in micro-USD per 1M tokens, effective from `from` (inclusive, YYYY-MM-DD, UTC). */
export interface ModelPrice {
  readonly from: string;
  readonly inputPerM: number;
  readonly outputPerM: number;
}

export interface ModelInfo {
  /** Thinking levels the model accepts; empty means "send no thinking config at all". */
  readonly thinkingLevels: readonly ThinkingLevel[];
  readonly prices: readonly ModelPrice[];
}

/** Stable, cheapest current model with structured output and thinking (study default). */
export const DEFAULT_MODEL = "gemini-3.5-flash-lite";
/** A different stable model, so one model's capacity problem does not take both down. */
export const FALLBACK_MODEL = "gemini-3.1-flash-lite";

/**
 * Allowlist. Deprecated 2.5 ids (rerouted 2026-12-01), preview ids and Gemini 4 (no free tier,
 * price doubling) are deliberately absent, so a mistyped or risky GEMINI_MODEL falls back to the
 * default instead of being sent.
 */
export const MODELS: Readonly<Record<string, ModelInfo>> = {
  "gemini-3.5-flash-lite": {
    thinkingLevels: ["minimal", "low", "medium", "high"],
    prices: [{ from: "2026-07-01", inputPerM: 300_000, outputPerM: 2_500_000 }],
  },
  "gemini-3.1-flash-lite": {
    // Not in the thinking table: never send thinking_level to it.
    thinkingLevels: [],
    prices: [{ from: "2026-01-01", inputPerM: 250_000, outputPerM: 1_500_000 }],
  },
  "gemini-3.8-flash": {
    // "minimal" returns an error on 3.8 Flash.
    thinkingLevels: ["low", "medium", "high"],
    prices: [
      { from: "2026-01-01", inputPerM: 750_000, outputPerM: 3_750_000 },
      { from: "2027-01-01", inputPerM: 1_500_000, outputPerM: 7_500_000 },
    ],
  },
  "gemini-3.6-flash": {
    thinkingLevels: ["low", "medium", "high"],
    prices: [
      { from: "2026-01-01", inputPerM: 750_000, outputPerM: 3_750_000 },
      { from: "2027-01-01", inputPerM: 1_500_000, outputPerM: 7_500_000 },
    ],
  },
};

/** Used to price an unknown model conservatively (never cheaper than the dearest allowlisted). */
const CONSERVATIVE_PRICE: ModelPrice = { from: "1970-01-01", inputPerM: 1_500_000, outputPerM: 7_500_000 };

export function isAllowlistedModel(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(MODELS, model);
}

/** The price in force on `isoDate` for `model`. */
export function priceFor(model: string, isoDate: string): ModelPrice {
  const info = MODELS[model];
  if (!info) return CONSERVATIVE_PRICE;
  let current = info.prices[0] ?? CONSERVATIVE_PRICE;
  for (const p of info.prices) if (p.from <= isoDate) current = p;
  return current;
}

/**
 * The thinking level to send, or null to send none. A requested level the model does not accept
 * moves up to the nearest accepted level (3.8 Flash rejects "minimal", so it gets "low").
 */
export function thinkingFor(model: string, requested: ThinkingLevel | null): ThinkingLevel | null {
  if (requested === null) return null;
  const levels = MODELS[model]?.thinkingLevels ?? [];
  if (levels.length === 0) return null;
  if (levels.includes(requested)) return requested;
  const start = THINKING_ORDER.indexOf(requested);
  for (let i = start; i < THINKING_ORDER.length; i++) {
    const level = THINKING_ORDER[i];
    if (level && levels.includes(level)) return level;
  }
  return levels[levels.length - 1] ?? null;
}

// ---------------------------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------------------------

export const AI_ROUTE_IDS = ["readiness.explain", "statement.feedback", "ask.answer", "requirements.extract", "resume.extract"] as const;
export type AiRouteId = (typeof AI_ROUTE_IDS)[number];

export interface RouteConfig {
  /** Immutable prompt version, reported in AiMeta.promptVersion. */
  readonly version: string;
  readonly thinking: ThinkingLevel | null;
  /** Includes thinking tokens, so it is set with room for them. */
  readonly maxOutputTokens: number;
  /** Monthly spend cap for the route, micro-USD (judgment; revisit after a month of real data). */
  readonly monthlyCapMicros: number;
  /** Per-user daily request cap; null for staff or pipeline routes. */
  readonly dailyPerUser: number | null;
  /** Whole-call budget including retries and the fallback model, ms. */
  readonly totalBudgetMs: number;
  /** Whether the route can carry student-originated content (gated by age and redaction). */
  readonly studentContent: boolean;
}

const caps = PRODUCT.ai.dailyRequestsPerStudent;

export const ROUTES: Readonly<Record<AiRouteId, RouteConfig>> = {
  "readiness.explain": {
    version: "readiness.explain.v1",
    thinking: "minimal",
    maxOutputTokens: 1_500,
    monthlyCapMicros: 15_000_000,
    dailyPerUser: caps.explain,
    totalBudgetMs: 9_000,
    studentContent: true,
  },
  "statement.feedback": {
    version: "statement.feedback.v1",
    thinking: "low",
    maxOutputTokens: 3_000,
    monthlyCapMicros: 15_000_000,
    dailyPerUser: caps.statementFeedback,
    totalBudgetMs: 15_000,
    studentContent: true,
  },
  "ask.answer": {
    version: "ask.answer.v1",
    thinking: "minimal",
    maxOutputTokens: 1_200,
    monthlyCapMicros: 15_000_000,
    dailyPerUser: caps.ask,
    totalBudgetMs: 9_000,
    studentContent: true,
  },
  "requirements.extract": {
    version: "requirements.extract.v1",
    thinking: "low",
    maxOutputTokens: 6_000,
    monthlyCapMicros: 10_000_000,
    dailyPerUser: null,
    totalBudgetMs: 25_000,
    studentContent: false,
  },
  // Onboarding: redacted, student-approved resume text in, closed-vocabulary signals out.
  "resume.extract": {
    version: "resume.extract.v1",
    thinking: "minimal",
    maxOutputTokens: 1_500,
    monthlyCapMicros: 5_000_000,
    dailyPerUser: caps.resumeExtract,
    totalBudgetMs: 9_000,
    studentContent: true,
  },
};

// ---------------------------------------------------------------------------------------------
// Transport policy
// ---------------------------------------------------------------------------------------------

export const GEMINI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
/** Pins the Interactions steps schema; harmless on generateContent. */
export const GEMINI_API_REVISION = "2026-05-20";

export const RETRY_POLICY = {
  /** Retries after the first attempt, per model. */
  maxRetries: 2,
  baseDelayMs: 1_000,
  capDelayMs: 4_000,
  /** Each delay is multiplied by a factor drawn from [jitterMin, jitterMax). */
  jitterMin: 0.5,
  jitterMax: 1.5,
  /** Upper bound on one HTTP attempt; also bounded by what remains of the route budget. */
  attemptTimeoutMs: 8_000,
  /** Do not start an attempt with less time than this left. */
  minAttemptMs: 1_500,
} as const;

export const CIRCUIT_POLICY = { failureThreshold: 5, openMs: 60_000 } as const;

/**
 * Gemini API Additional Terms (effective 2026-03-23): users must be 18 or older. Every AI method
 * checks this; routes should also call `ai.checkAccess` first so they can show the right copy.
 */
export const AI_MIN_AGE = 18;

/** Characters per token used for pre-call estimates (Google: about 4), padded by 10%. */
export const CHARS_PER_TOKEN = 4;
export const ESTIMATE_PADDING = 1.1;

/** Hard limits on what one prompt may carry. */
export const PROMPT_LIMITS = {
  maxSources: 8,
  maxSourceChars: 8_000,
  maxPageChars: 60_000,
} as const;
