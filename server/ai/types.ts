import type { JsonSchema } from "@shared/contracts";
import type { AiRouteId, ThinkingLevel } from "./config";

/**
 * Provider-neutral types. Everything above the transport (runner, prompts, validation, ledger)
 * talks in these terms, so swapping the Interactions API for generateContent, or Gemini for a
 * mock, touches one module.
 */

/** One structured-output request, already assembled by a prompt template. */
export interface GenerateRequest {
  readonly route: AiRouteId;
  /** Static instructions; the stable prefix for implicit caching. */
  readonly systemInstruction: string;
  /** Sources first, then deterministic facts, then the per-student request (prefix-stable). */
  readonly input: string;
  readonly responseSchema: JsonSchema;
  readonly thinking: ThinkingLevel | null;
  readonly maxOutputTokens: number;
  /** Wall-clock budget for the whole call, retries and fallback included. */
  readonly budgetMs: number;
}

export interface TokenUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  readonly thoughtTokens: number;
  readonly cachedTokens: number;
}

export const ZERO_USAGE: TokenUsage = { inputTokens: 0, outputTokens: 0, thoughtTokens: 0, cachedTokens: 0 };

/**
 * Error kinds. Only `timeout`, `rate_limited`, `server_error` and `network` are retried on the
 * same model; `quota_exceeded`, `model_not_found` and exhausted retryable kinds move to the
 * fallback model; everything else stops at once.
 */
export const AI_ERROR_KINDS = [
  "no_api_key",
  "timeout",
  "network",
  "rate_limited",
  "quota_exceeded",
  "server_error",
  "safety_blocked",
  "invalid_request",
  "auth",
  "model_not_found",
  "location_unsupported",
  "incomplete",
  "empty_output",
  "circuit_open",
] as const;
export type AiErrorKind = (typeof AI_ERROR_KINDS)[number];

/** One HTTP attempt, kept for the spend ledger (thinking tokens are billed even on failure). */
export interface AttemptRecord {
  readonly model: string;
  readonly ok: boolean;
  readonly httpStatus: number | null;
  readonly errorKind: AiErrorKind | null;
  /** Provider error code such as "rate_limit_exceeded" or "safety"; never message text. */
  readonly errorCode: string | null;
  readonly usage: TokenUsage | null;
  readonly latencyMs: number;
}

export type GenerateResult =
  | {
      readonly ok: true;
      readonly text: string;
      readonly model: string;
      readonly responseId: string | null;
      readonly attempts: readonly AttemptRecord[];
    }
  | {
      readonly ok: false;
      readonly errorKind: AiErrorKind;
      readonly attempts: readonly AttemptRecord[];
    };

/** Anything that can answer a GenerateRequest: the Gemini client, the mock, or the no-key stub. */
export interface AiProvider {
  readonly name: "gemini" | "mock" | "none";
  /** The primary model id, or null when the provider never calls a model. */
  readonly model: string | null;
  generate(req: GenerateRequest): Promise<GenerateResult>;
}

/** Structured, content-free log sink. Fields must never carry prompt or output text. */
export type AiLogFields = Readonly<Record<string, string | number | boolean | null>>;
export type AiLog = (event: string, fields: AiLogFields) => void;

export interface Clock {
  now(): number;
}
