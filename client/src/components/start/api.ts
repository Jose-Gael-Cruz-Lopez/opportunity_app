/**
 * Calls to /api/v1/onboarding/*. Every call has a short timeout and returns a typed result
 * instead of throwing, because onboarding must keep working when the API is unreachable or
 * the student has not signed up yet (the routes require a session; matches come before an
 * account). Request and response bodies are never logged, and error results carry codes only.
 *
 * The request shapes are @shared/onboarding's schemas, which server/api/v1/onboarding/schemas.ts
 * uses as is.
 */

import type { MatchSignals, ServerPreferences } from "@shared/onboarding";

export const API_BASE = "/api/v1/onboarding";
const TIMEOUT_MS = 8_000;

export type ApiFailure =
  | { ok: false; reason: "offline" }
  | { ok: false; reason: "signed_out" }
  | { ok: false; reason: "unredacted"; kinds: string[] }
  | { ok: false; reason: "consent_required" }
  | { ok: false; reason: "rejected"; status: number };

export type ApiResult<T> = { ok: true; data: T; status: number } | ApiFailure;

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Maps an HTTP status and problem body to a failure; separated out so it is unit-testable. */
export function failureFor(status: number, body: unknown): ApiFailure {
  const b = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
  if (status === 401) return { ok: false, reason: "signed_out" };
  if (status === 422 && (b.code === "unredacted_content" || b.type === "unredacted_content")) {
    const kinds = Array.isArray(b.kinds) ? b.kinds.filter((k): k is string => typeof k === "string") : [];
    return { ok: false, reason: "unredacted", kinds };
  }
  if (b.code === "consent_required") return { ok: false, reason: "consent_required" };
  if (status === 404 || status === 503 || status === 502 || status === 504) return { ok: false, reason: "offline" };
  return { ok: false, reason: "rejected", status };
}

export async function request<T>(
  path: string,
  init: { method: "GET" | "POST"; body?: unknown },
  fetcher: FetchLike = (i, r) => fetch(i, r),
): Promise<ApiResult<T>> {
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  const timer = ctrl ? setTimeout(() => ctrl.abort(), TIMEOUT_MS) : null;
  try {
    const res = await fetcher(`${API_BASE}${path}`, {
      method: init.method,
      credentials: "include",
      headers: init.body === undefined ? { accept: "application/json" } : { "content-type": "application/json", accept: "application/json" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      signal: ctrl?.signal,
    });
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      body = null;
    }
    if (!res.ok) return failureFor(res.status, body);
    return { ok: true, data: body as T, status: res.status };
  } catch {
    return { ok: false, reason: "offline" };
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/* ---------- typed routes ---------- */

export interface StateResponse {
  ai: { enabled: boolean };
}

export function getState(fetcher?: FetchLike) {
  return request<StateResponse>("/state", { method: "GET" }, fetcher);
}

/**
 * Preferences and signals in the one shared vocabulary (@shared/onboarding's
 * ServerPreferencesSchema and MatchSignalsSchema, which the server validates and stores as is).
 * No PII, no status answers, no device-only answer.
 */
export interface QuizBody {
  preferences: ServerPreferences;
  signals: MatchSignals | null;
  step: string | null;
  completed: boolean;
}

export function postQuiz(body: QuizBody, fetcher?: FetchLike) {
  return request<unknown>("/quiz", { method: "POST", body }, fetcher);
}

export type ExtractResponse =
  | { ai: "off" }
  | { ai: "unavailable" }
  | { ai: "on"; profile: { skills: string[]; fields: string[]; courseworkKeywords: string[]; experienceKinds: string[] } };

/**
 * Sends the redacted text the student saw on the preview. `consent` is a literal true: the
 * caller can only reach this after the student pressed "Send this text".
 */
export function postResumeExtract(redactedText: string, consent: true, fetcher?: FetchLike) {
  return request<ExtractResponse>("/resume/extract", { method: "POST", body: { redactedText, consent } }, fetcher);
}

export interface FirstDoorBody {
  programId: string;
  programCycleId: string;
  completedStepIds: string[];
  intention: { stepId: string; on: string; at: string } | null;
  timeZone: string | null;
}

export function postFirstDoor(body: FirstDoorBody, fetcher?: FetchLike) {
  return request<unknown>("/first-door", { method: "POST", body }, fetcher);
}

/** The browser's IANA zone, or null where Intl cannot say. */
export function browserTimeZone(): string | null {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}
