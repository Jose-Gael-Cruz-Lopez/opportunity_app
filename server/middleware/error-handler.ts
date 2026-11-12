import type { Context, ErrorHandler, NotFoundHandler } from "hono";
import { HTTPException } from "hono/http-exception";
import { routePath } from "hono/route";
import { ZodError } from "zod";
import type { ApiErrorCode } from "@shared/contracts/common";
import type { AppEnv } from "../env";
import { getConfig } from "../config";
import { logFor } from "../lib/log";
import { isApiError, problemFor } from "../lib/problem";
import { sendErrorReport, type ErrorReport } from "../lib/sentry";
import { safeIssues } from "../lib/validation";
import { fetchStaticAsset } from "./spa";

/**
 * The app's error and not-found handlers. Responses are problem+json with a request id and no
 * internal message; logs and Sentry get the error class and route template only.
 */

const STATUS_CODES: Record<number, ApiErrorCode> = {
  400: "bad_request",
  401: "unauthenticated",
  403: "forbidden",
  404: "not_found",
  409: "conflict",
  412: "precondition_failed",
  413: "payload_too_large",
  429: "rate_limited",
  503: "unavailable",
};

export function codeForStatus(status: number): ApiErrorCode {
  return STATUS_CODES[status] ?? (status >= 500 ? "internal" : "bad_request");
}

/**
 * A content-free class for an error: its name, or for D1's plain Errors the `D1_*` prefix of the
 * message (which names the failure kind, never the data).
 */
export function errorClassOf(err: unknown): string {
  if (!(err instanceof Error)) return typeof err;
  if (err.name && err.name !== "Error") return err.name.slice(0, 60);
  const d1 = /^(D1_[A-Z_]+)/.exec(err.message);
  return d1 ? d1[1]! : "Error";
}

export type Reporter = (c: Context<AppEnv>, report: ErrorReport) => void;

/** Sends the report after the response, through waitUntil when the runtime offers it. */
export const sentryReporter: Reporter = (c, report) => {
  const dsn = getConfig(c.env ?? {}).sentryDsn;
  if (!dsn) return;
  const task = sendErrorReport(dsn, report);
  try {
    c.executionCtx.waitUntil(task);
  } catch {
    // No execution context (tests): the promise still runs and never rejects.
  }
};

export function errorHandler(report: Reporter = sentryReporter): ErrorHandler<AppEnv> {
  return (err, c) => {
    if (isApiError(err)) return problemFor(c, err.code, err.extra, err.options);
    if (err instanceof ZodError) return problemFor(c, "validation_failed", { errors: safeIssues(err) });
    if (err instanceof HTTPException) {
      // A handler-built response (e.g. from a library) is passed through as is.
      if (err.res) return err.getResponse();
      return problemFor(c, codeForStatus(err.status));
    }

    const errorClass = errorClassOf(err);
    const route = routePath(c) || "(unmatched)";
    const config = getConfig(c.env ?? {});
    logFor(c).error("unhandled_error", {
      errorClass,
      route,
      method: c.req.method,
      // Local development only: messages can quote data, so they never leave a developer's machine.
      errorDetail: config.isLocal ? String((err as Error).message ?? "").slice(0, 160) : undefined,
    });
    report(c, {
      errorClass,
      route,
      method: c.req.method,
      requestId: (c.get("requestId") as string | undefined) ?? "none",
      environment: config.environment,
    });
    return problemFor(c, "internal");
  };
}

const PROBLEM_PREFIXES = ["/api/", "/internal/", "/mcp", "/cal/", "/data/"];

const NOT_FOUND_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Not found · Novus</title></head><body><main><h1>Page not found</h1><p><a href="/">Explore opportunities</a></p></main></body></html>`;

export function isProblemPath(pathname: string): boolean {
  return PROBLEM_PREFIXES.some((p) => pathname.startsWith(p) || pathname === p.replace(/\/$/, ""));
}

/**
 * API-like prefixes answer problem+json. Anything else first tries a static file from ASSETS
 * (the Worker runs before assets for every path but /assets/*), then the HTML 404 page.
 */
export const notFoundHandler: NotFoundHandler<AppEnv> = async (c) => {
  const pathname = new URL(c.req.url).pathname;
  if (isProblemPath(pathname)) return problemFor(c, "not_found");
  const asset = await fetchStaticAsset(c.env?.ASSETS, c.req.raw);
  if (asset) return asset;
  return c.html(NOT_FOUND_HTML, 404);
};
