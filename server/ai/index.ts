import type { AskResponse, ReadinessExplainResponse, StatementFeedbackResponse } from "@shared/contracts";
import { checkAiAccess, type AiAccessDecision, type AiViewer } from "./age";
import { AI_MIN_AGE, DEFAULT_MODEL, FALLBACK_MODEL, isAllowlistedModel, ROUTES, type AiRouteId, type RouteConfig } from "./config";
import type { FetchLike, GeminiTransport } from "./gemini";
import { D1Ledger, hashUserKey, MemoryLedger, utcDay, type D1Like, type SpendLedger } from "./ledger";
import { CircuitBreaker, createDisabledProvider, createGeminiProvider, realSleep, systemClock } from "./provider";
import {
  askRoute,
  readinessExplainRoute,
  requirementsExtractRoute,
  resumeExtractRoute,
  statementFeedbackRoute,
  type AskInput,
  type ReadinessExplainInput,
  type RequirementsExtractInput,
  type RequirementsExtractResult,
  type ResumeExtractResult,
  type StatementFeedbackInput,
} from "./prompts";
import { runRoute, type RunDeps } from "./run";
import type { AiLog, AiProvider, Clock } from "./types";

/**
 * server/ai: the only place TypeScript talks to an LLM (Google Gemini, REST over fetch).
 *
 *   const ai = createAi(c.env);
 *   const gate = ai.checkAccess(viewer);           // routes check this first (18+ only)
 *   const res = await ai.explainReadiness({ viewer, report, profile, request, programSources });
 *
 * Every method returns a contract-valid response. With no GEMINI_API_KEY, under the age gate, over
 * a cap or on any provider or validation failure, the response is the deterministic fallback with
 * meta.status "unavailable" or "degraded", so routes never need an error branch for AI.
 */

/**
 * The bindings this module reads. server/env.ts's Env satisfies it structurally, which keeps this
 * module compilable and testable on its own.
 */
export interface AiEnv {
  readonly GEMINI_API_KEY?: string;
  readonly GEMINI_MODEL?: string;
  readonly ENVIRONMENT?: string;
  readonly EVENTS_DB?: D1Like;
  /** Optional kill switch: "1" or "true" disables every model call (deterministic output only). */
  readonly AI_DISABLED?: string;
}

export interface AiOptions {
  readonly provider?: AiProvider;
  readonly ledger?: SpendLedger;
  readonly fetch?: FetchLike;
  readonly clock?: Clock;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly log?: AiLog;
  readonly nonce?: () => string;
  readonly transport?: GeminiTransport;
  readonly routes?: Partial<Record<AiRouteId, Partial<RouteConfig>>>;
}

export interface Ai {
  /** True when a model may be called (a key is set and the kill switch is off). */
  readonly available: boolean;
  /** The primary model id, or null when no model is called. */
  readonly model: string | null;
  /** Minimum age for any Gemini-backed feature (Gemini API Additional Terms). */
  readonly minAge: number;
  checkAccess(viewer: AiViewer): AiAccessDecision;
  explainReadiness(args: ReadinessExplainInput & { readonly viewer: AiViewer }): Promise<ReadinessExplainResponse>;
  statementFeedback(args: StatementFeedbackInput & { readonly viewer: AiViewer }): Promise<StatementFeedbackResponse>;
  ask(args: AskInput & { readonly viewer: AiViewer }): Promise<AskResponse>;
  /** Staff and pipeline use only (public page text); no student data, no age gate. */
  extractRequirements(args: RequirementsExtractInput): Promise<RequirementsExtractResult>;
  /**
   * Onboarding: closed-vocabulary signals from resume text that the student redacted, previewed
   * and approved. The text must already pass @shared/resume's scanAiText and the onboarding
   * route's guard; it is checked again here and never sent on a hit. With no key, under the age
   * gate or on any failure, the deterministic parser answers instead (`source: "deterministic"`).
   */
  extractResumeProfile(redactedText: string, opts?: { readonly viewer?: AiViewer }): Promise<ResumeExtractResult>;
}

/** Content-free JSON log line; fields are codes and counts only. */
const consoleLog: AiLog = (event, fields) => {
  console.log(JSON.stringify({ level: "info", scope: "ai", event, ...fields }));
};

function randomNonce(): string {
  const bytes = new Uint8Array(12); // 96 bits
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** One breaker and one memory ledger per isolate, so they outlive a single request. */
const isolateBreaker = new CircuitBreaker(systemClock);
const isolateLedger = new MemoryLedger();

function resolveModel(env: AiEnv, log: AiLog): string {
  const requested = env.GEMINI_MODEL?.trim();
  if (!requested) return DEFAULT_MODEL;
  if (isAllowlistedModel(requested)) return requested;
  log("ai.model_not_allowlisted", { fallbackTo: DEFAULT_MODEL });
  return DEFAULT_MODEL;
}

function mergeRoutes(overrides: AiOptions["routes"]): Record<AiRouteId, RouteConfig> {
  const out = { ...ROUTES } as Record<AiRouteId, RouteConfig>;
  for (const [id, patch] of Object.entries(overrides ?? {}) as [AiRouteId, Partial<RouteConfig>][]) {
    out[id] = { ...ROUTES[id], ...patch };
  }
  return out;
}

export function createAi(env: AiEnv, options: AiOptions = {}): Ai {
  const log = options.log ?? consoleLog;
  const clock = options.clock ?? systemClock;
  const killed = env.AI_DISABLED === "1" || env.AI_DISABLED?.toLowerCase() === "true";
  const apiKey = env.GEMINI_API_KEY?.trim() ?? "";
  const model = resolveModel(env, log);
  const fallbackModel = model === FALLBACK_MODEL ? null : FALLBACK_MODEL;

  const provider: AiProvider =
    options.provider ??
    (apiKey
      ? createGeminiProvider({
          apiKey,
          model,
          fallbackModel,
          transport: options.transport ?? "interactions",
          fetch: options.fetch ?? ((input, init) => fetch(input, init)),
          clock,
          sleep: options.sleep ?? realSleep,
          random: options.random ?? Math.random,
          breaker: options.clock ? new CircuitBreaker(clock) : isolateBreaker,
          log,
        })
      : createDisabledProvider("no_api_key"));

  const ledger =
    options.ledger ?? (env.EVENTS_DB ? new D1Ledger(env.EVENTS_DB, isolateLedger, log) : isolateLedger);

  const unavailable: RunDeps["unavailable"] = killed ? "disabled" : provider.name === "none" ? "no_api_key" : null;

  const deps: RunDeps = {
    provider,
    fallbackModel: options.provider ? null : fallbackModel,
    ledger,
    clock,
    log,
    nonce: options.nonce ?? randomNonce,
    routes: mergeRoutes(options.routes),
    unavailable,
  };

  const today = (): string => utcDay(clock.now());
  const checkAccess = (viewer: AiViewer): AiAccessDecision => checkAiAccess(viewer, today(), AI_MIN_AGE);
  const userKey = async (viewer: AiViewer): Promise<string | null> => (viewer.userId ? hashUserKey(viewer.userId) : null);

  return {
    available: unavailable === null,
    model: unavailable === null ? provider.model : null,
    minAge: AI_MIN_AGE,
    checkAccess,
    async explainReadiness({ viewer, ...input }) {
      return runRoute(readinessExplainRoute, input, deps, { userKey: await userKey(viewer), access: checkAccess(viewer) });
    },
    async statementFeedback({ viewer, ...input }) {
      return runRoute(statementFeedbackRoute, input, deps, { userKey: await userKey(viewer), access: checkAccess(viewer) });
    },
    async ask({ viewer, ...input }) {
      return runRoute(askRoute, input, deps, { userKey: await userKey(viewer), access: checkAccess(viewer) });
    },
    async extractRequirements(input) {
      return runRoute(requirementsExtractRoute, input, deps, { userKey: null });
    },
    async extractResumeProfile(redactedText, opts = {}) {
      // No viewer means nobody vouched for the student's age, so the age gate closes the model.
      const viewer: AiViewer = opts.viewer ?? { userId: null, birthYearMonth: null };
      return runRoute(resumeExtractRoute, { redactedText }, deps, { userKey: await userKey(viewer), access: checkAccess(viewer) });
    },
  };
}

export { AI_MIN_AGE, DEFAULT_MODEL, FALLBACK_MODEL } from "./config";
export type { AiRouteId } from "./config";
export { checkAiAccess, type AiAccessDecision, type AiViewer } from "./age";
export { createMockProvider, type MockProvider, type MockStep } from "./mock";
export { MemoryLedger, AI_LEDGER_DDL, pruneUserDailySql, type SpendLedger } from "./ledger";
export { redactStudentText, isSensitiveEligibilityQuestion } from "./redact";
export { selectPromptProfile, PROMPT_PROFILE_FIELDS } from "./allowlist";
export type { AiSourceInput } from "./prompts/common";
export type {
  AskInput,
  ReadinessExplainInput,
  RequirementsExtractInput,
  RequirementsExtractResult,
  ResumeExtractInput,
  ResumeExtractResult,
  ResumeProfile,
  StatementFeedbackInput,
} from "./prompts";
export { deterministicResumeProfile, resumeTextIsClean } from "./prompts/resume-extract";
