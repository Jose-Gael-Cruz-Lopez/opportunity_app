import type { Context } from "hono";
import { problem, type ApiErrorCode, type ProblemDetails } from "@shared/contracts/common";

/**
 * RFC 9457 problem+json responses in the contract shape. Bodies carry a code, a fixed title and
 * optional field paths, never submitted values or internal messages.
 */

export const PROBLEM_CONTENT_TYPE = "application/problem+json";

export type ProblemExtra = Partial<Omit<ProblemDetails, "code" | "status">>;

export interface ProblemOptions {
  /** Seconds, for 429 and 503. */
  readonly retryAfter?: number;
  readonly headers?: Record<string, string>;
}

/** Builds a problem Response without a Hono context (for code outside handlers). */
export function problemResponse(
  code: ApiErrorCode,
  extra: ProblemExtra = {},
  options: ProblemOptions = {},
): Response {
  const body = problem(code, extra);
  const headers = new Headers({ "content-type": PROBLEM_CONTENT_TYPE, "cache-control": "no-store", ...options.headers });
  if (options.retryAfter !== undefined) headers.set("retry-after", String(Math.max(0, Math.ceil(options.retryAfter))));
  return new Response(JSON.stringify(body), { status: body.status, headers });
}

/** Problem response that carries the request id, so a student can quote it to support. */
export function problemFor(c: Context, code: ApiErrorCode, extra: ProblemExtra = {}, options: ProblemOptions = {}): Response {
  const requestId = c.get("requestId") as string | undefined;
  return problemResponse(code, requestId ? { requestId, ...extra } : extra, options);
}

/**
 * A throwable carrying a contract error code. Handlers and repos can `throw new ApiError(...)`
 * and the app's error handler answers with the matching problem document.
 */
export class ApiError extends Error {
  readonly code: ApiErrorCode;
  readonly extra: ProblemExtra;
  readonly options: ProblemOptions;

  constructor(code: ApiErrorCode, extra: ProblemExtra = {}, options: ProblemOptions = {}) {
    // The message is the code only: it may reach logs, so it must never hold request content.
    super(code);
    this.name = "ApiError";
    this.code = code;
    this.extra = extra;
    this.options = options;
  }
}

export function isApiError(err: unknown): err is ApiError {
  return err instanceof ApiError;
}
