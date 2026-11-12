import type { Env } from "../env";
import { consoleOriginFor } from "../auth/config";
import { LOCAL_DEV_ORIGINS } from "./security";

export * from "./flags";
export * from "./security";

/**
 * Typed view of the Worker's vars and secrets, parsed once per env object. Parsing never throws
 * and never logs a secret: problems are listed in `issues` by name only, and the affected
 * feature degrades (no internal keys means every internal call answers 401).
 */
export type Environment = Env["ENVIRONMENT"];

export interface AppConfig {
  readonly environment: Environment;
  readonly isLocal: boolean;
  readonly isProduction: boolean;
  /** Canonical public origin without a trailing slash. */
  readonly appOrigin: string;
  /** Origins whose browsers may make credentialed requests (the app origin, plus Vite locally). */
  readonly trustedOrigins: readonly string[];
  /** The staff console origin (`curate.` + app host). Writes on that host are trusted only from it. */
  readonly consoleOrigin: string;
  readonly geminiModel: string | null;
  readonly hasGeminiKey: boolean;
  readonly aiDisabled: boolean;
  /** keyId -> secret for /internal/v1 HMAC verification. */
  readonly internalKeys: ReadonlyMap<string, string>;
  readonly sentryDsn: string | null;
  /** Names of misconfigured settings; never values. */
  readonly issues: readonly string[];
}

const ENVIRONMENTS: readonly Environment[] = ["local", "staging", "production"];

/** Accepts only an http(s) origin; returns it normalised without path or trailing slash. */
export function parseOrigin(value: string | undefined): string | null {
  if (!value) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    return url.origin;
  } catch {
    return null;
  }
}

/**
 * Parses INTERNAL_HMAC_KEYS ({"fetch": "secret", ...}). Secrets shorter than 32 characters are
 * refused, because an HMAC key is only as strong as its entropy.
 */
/** Key ids name a family plus an optional rotation suffix (`fetch`, `fetch.2026q4`), as server/internal expects. */
const INTERNAL_KEY_ID = /^[a-z][a-z0-9_]{1,30}(?:[.:][A-Za-z0-9_-]{1,40})?$/;

export function parseInternalKeys(raw: string | undefined): { keys: Map<string, string>; ok: boolean } {
  const keys = new Map<string, string>();
  if (!raw) return { keys, ok: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { keys, ok: false };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return { keys, ok: false };
  let ok = true;
  for (const [keyId, secret] of Object.entries(parsed as Record<string, unknown>)) {
    if (INTERNAL_KEY_ID.test(keyId) && typeof secret === "string" && secret.length >= 32) keys.set(keyId, secret);
    else ok = false;
  }
  return { keys, ok };
}

export function buildConfig(env: Partial<Env>): AppConfig {
  const issues: string[] = [];
  const environment: Environment = ENVIRONMENTS.includes(env.ENVIRONMENT as Environment)
    ? (env.ENVIRONMENT as Environment)
    : "production";
  if (environment !== env.ENVIRONMENT) issues.push("ENVIRONMENT");

  const isLocal = environment === "local";
  const parsedOrigin = parseOrigin(env.APP_ORIGIN);
  if (!parsedOrigin) issues.push("APP_ORIGIN");
  // Outside local development an http origin would leak session cookies over plain text.
  if (parsedOrigin && !isLocal && !parsedOrigin.startsWith("https://")) issues.push("APP_ORIGIN");
  const appOrigin = parsedOrigin ?? "http://localhost:8787";

  const { keys, ok } = parseInternalKeys(env.INTERNAL_HMAC_KEYS);
  if (env.INTERNAL_HMAC_KEYS !== undefined && !ok) issues.push("INTERNAL_HMAC_KEYS");
  if (!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length < 32) issues.push("BETTER_AUTH_SECRET");

  const trusted = new Set<string>([appOrigin]);
  if (isLocal) LOCAL_DEV_ORIGINS.forEach((o) => trusted.add(o));

  return {
    environment,
    isLocal,
    isProduction: environment === "production",
    appOrigin,
    trustedOrigins: [...trusted],
    consoleOrigin: consoleOriginFor(appOrigin),
    geminiModel: env.GEMINI_MODEL?.trim() || null,
    hasGeminiKey: Boolean(env.GEMINI_API_KEY && env.GEMINI_API_KEY.trim()),
    aiDisabled: env.AI_DISABLED === "true" || env.AI_DISABLED === "1",
    internalKeys: keys,
    sentryDsn: env.SENTRY_DSN?.trim() || null,
    issues: [...new Set(issues)],
  };
}

/**
 * Origins trusted for a write to `requestUrl`, by surface: a request to the console host
 * (`curate.*`) is trusted only from the console origin, and one to any other host only from the
 * app origins. This mirrors sameOrigin() in server/auth/routes.ts, so neither surface can drive
 * the other's cookie-authenticated endpoints.
 */
export function trustedOriginsFor(config: AppConfig, requestUrl: string): readonly string[] {
  return new URL(requestUrl).hostname.startsWith("curate.") ? [config.consoleOrigin] : config.trustedOrigins;
}

// Bindings objects are stable for an isolate's lifetime, so a WeakMap parses each one once.
const cache = new WeakMap<object, AppConfig>();

export function getConfig(env: Partial<Env>): AppConfig {
  const hit = cache.get(env);
  if (hit) return hit;
  const config = buildConfig(env);
  cache.set(env, config);
  return config;
}
