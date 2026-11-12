import type { Context } from "hono";
import { isSensitiveKey } from "@shared/contracts/sensitive";

/**
 * Structured logs without content (plan 02 2.3.12). Workers Logs keeps lines for 7 days and
 * records whatever we print, so a line holds an event name, route templates, codes, counts and
 * timings, never bodies, query strings, URLs, emails, tokens, prompts or model output.
 *
 * Enforcement is structural rather than by convention:
 * - event names are fixed identifiers (`request`, `flags_unavailable`), not free text;
 * - values are primitives, strings are truncated, and emails and URLs are redacted;
 * - keys that name content (`body`, `email`, `token`, ...) or look like a status or identity
 *   answer (the shared sensitive stems) are dropped and only counted.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";
export type LogValue = string | number | boolean | null;
export type LogFields = Readonly<Record<string, LogValue | undefined>>;

export interface Logger {
  debug(event: string, fields?: LogFields): void;
  info(event: string, fields?: LogFields): void;
  warn(event: string, fields?: LogFields): void;
  error(event: string, fields?: LogFields): void;
  /** A logger whose lines all carry these fields (already sanitized once). */
  child(fields: LogFields): Logger;
}

export type LogSink = (level: LogLevel, line: string) => void;

const EVENT_PATTERN = /^[a-z][a-z0-9_.:-]{0,63}$/;
const MAX_STRING = 160;
const MAX_FIELDS = 32;

/** Words that mark a key as carrying content; matched against the key's camelCase words. */
const CONTENT_WORDS: ReadonlySet<string> = new Set([
  "body",
  "query",
  "search",
  "url",
  "href",
  "uri",
  "header",
  "headers",
  "cookie",
  "cookies",
  "authorization",
  "password",
  "secret",
  "token",
  "email",
  "phone",
  "address",
  "prompt",
  "content",
  "text",
  "message",
  "answer",
  "answers",
  "essay",
  "ip",
  "otp",
  "code",
]);

/** Keys that contain a content word but are safe by construction. */
const SAFE_KEYS: ReadonlySet<string> = new Set(["errorCode", "problemCode", "statusCode", "httpStatus", "code"]);

function keyWords(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

export function isContentKey(key: string): boolean {
  if (SAFE_KEYS.has(key)) return false;
  return keyWords(key).some((w) => CONTENT_WORDS.has(w)) || isSensitiveKey(key);
}

const EMAIL_LIKE = /[^\s@]+@[^\s@]+\.[^\s@]+/;
const URL_LIKE = /[a-z][a-z0-9+.-]*:\/\/|\?[^\s]*=/i;

/** Cleans one value: primitives only, short strings, emails and URLs redacted. */
export function sanitizeValue(value: unknown): LogValue | undefined {
  if (value === null) return null;
  switch (typeof value) {
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : null;
    case "string": {
      if (EMAIL_LIKE.test(value) || URL_LIKE.test(value)) return "[redacted]";
      // Control characters could forge extra log lines in plain-text viewers.
      const clean = value.replace(/[\u0000-\u001f\u007f]/g, " ");
      return clean.length > MAX_STRING ? `${clean.slice(0, MAX_STRING)}…` : clean;
    }
    default:
      return undefined;
  }
}

export function sanitizeFields(fields: LogFields | undefined): Record<string, LogValue> {
  const out: Record<string, LogValue> = {};
  if (!fields) return out;
  let dropped = 0;
  let kept = 0;
  for (const [key, raw] of Object.entries(fields)) {
    if (raw === undefined) continue;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(key) || isContentKey(key) || kept >= MAX_FIELDS) {
      dropped++;
      continue;
    }
    const value = sanitizeValue(raw);
    if (value === undefined) {
      dropped++;
      continue;
    }
    out[key] = value;
    kept++;
  }
  if (dropped > 0) out.droppedFields = dropped;
  return out;
}

const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export const consoleSink: LogSink = (level, line) => {
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
};

export interface LoggerOptions {
  readonly sink?: LogSink;
  readonly minLevel?: LogLevel;
  readonly base?: LogFields;
  readonly now?: () => number;
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const sink = options.sink ?? consoleSink;
  const min = RANK[options.minLevel ?? "info"];
  const base = sanitizeFields(options.base);
  const now = options.now ?? Date.now;

  const write = (level: LogLevel, event: string, fields?: LogFields): void => {
    if (RANK[level] < min) return;
    const name = EVENT_PATTERN.test(event) ? event : "invalid_event_name";
    const line = { level, event: name, ts: new Date(now()).toISOString(), ...base, ...sanitizeFields(fields) };
    try {
      sink(level, JSON.stringify(line));
    } catch {
      // Logging must never break a request.
    }
  };

  return {
    debug: (e, f) => write("debug", e, f),
    info: (e, f) => write("info", e, f),
    warn: (e, f) => write("warn", e, f),
    error: (e, f) => write("error", e, f),
    child: (fields) => createLogger({ ...options, base: { ...base, ...fields } }),
  };
}

/** The process-wide logger; tests swap the sink with setRootLogger. */
let root: Logger = createLogger();

export function rootLogger(): Logger {
  return root;
}

export function setRootLogger(logger: Logger): void {
  root = logger;
}

/** A logger tagged with the request id. Works even where the request-id middleware did not run. */
export function logFor(c: Context): Logger {
  const requestId = c.get("requestId") as string | undefined;
  return requestId ? root.child({ requestId }) : root;
}
