import type { Db, EventsDb } from "@server/db/client";
import type { Budget } from "./budget";

/**
 * The bindings server/jobs, server/internal and the notify services read. server/env.ts's Env
 * satisfies this structurally, so these modules compile and test on their own.
 */
export interface WorkerBindings {
  readonly DB: D1Database;
  readonly EVENTS_DB?: D1Database;
  readonly STORE?: R2Bucket;
  readonly EMAIL?: SendEmail;
  readonly APP_ORIGIN?: string;
  readonly ENVIRONMENT?: string;
  /** JSON object of key id -> secret for the internal API. */
  readonly INTERNAL_HMAC_KEYS?: string;
  /** Root secret; email tokens and audit subject keys use purpose-bound sub-keys of it. */
  readonly BETTER_AUTH_SECRET?: string;
  /** Optional sender override, e.g. `Novus <notify@notify.example.org>`. */
  readonly EMAIL_FROM?: string;
}

export type Trigger = "tick" | "hourly" | "daily";
export type RunTrigger = Trigger | "catch_up" | "manual";

export type LogLevel = "info" | "warn" | "error" | "alert";

/**
 * Structured log lines (Workers observability). Fields carry ids, counts and error classes only:
 * never request bodies, email addresses or student answers.
 */
export type Logger = (level: LogLevel, event: string, fields?: Record<string, string | number | boolean | null>) => void;

export const consoleLogger: Logger = (level, event, fields = {}) => {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error" || level === "alert") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export const silentLogger: Logger = () => {};

export interface JobContext {
  readonly env: WorkerBindings;
  readonly db: Db;
  readonly edb: EventsDb | null;
  readonly now: () => number;
  readonly budget: Budget;
  readonly log: Logger;
  readonly trigger: RunTrigger;
  /** `YYYY-MM-DDTHH` for hourly kinds, `YYYY-MM-DD` for daily kinds, null on the tick. */
  readonly slot: string | null;
}

export interface HandlerResult {
  readonly processed: number;
  /** partial: stopped on the budget with work left; deferred: a dependency was unavailable. */
  readonly outcome: "ok" | "partial" | "deferred";
  readonly detail?: Record<string, string | number | boolean | null>;
}

export type JobHandler = (ctx: JobContext) => Promise<HandlerResult>;

/** The error class of a thrown value: its name only, so messages with data never reach D1. */
export function errorClassOf(err: unknown): string {
  if (err instanceof Error) return (err.name || "Error").slice(0, 80);
  return typeof err === "string" ? "StringError" : "UnknownError";
}
