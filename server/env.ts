import type { SessionUser as AuthSessionUser } from "./auth/types";

/**
 * Worker bindings, vars and secrets. infra/wrangler/wrangler.toml declares the bindings; secrets
 * come from `wrangler secret put` remotely and `.dev.vars` locally, never from the repository.
 */
export interface Env {
  // ---- Bindings ------------------------------------------------------------------------------
  /** D1 novus-main: registry, accounts, jobs, outbox, audit. */
  readonly DB: D1Database;
  /** D1 novus-events: analytics events, LLM ledger, email ledger. */
  readonly EVENTS_DB: D1Database;
  /** R2 novus-store with prefixes snapshots/, releases/, cards/, ledger/, backups/. */
  readonly STORE: R2Bucket;
  /** The static client build (dist/public). */
  readonly ASSETS: Fetcher;
  /** Cloudflare Email Sending. */
  readonly EMAIL: SendEmail;

  // ---- Optional Workers rate-limit bindings (absent locally; server/lib/rate-limit falls back) --
  /** Anonymous public API traffic, keyed by client IP. */
  readonly RATE_LIMIT_PUBLIC?: RateLimit;
  /** Endpoints that send mail (codes, Remind me), keyed by client IP. */
  readonly RATE_LIMIT_SEND?: RateLimit;
  /** Assistant endpoints, keyed by internal user id. */
  readonly RATE_LIMIT_AI?: RateLimit;
  /** Onboarding resume extraction (server/api/v1/onboarding reads it by this name). */
  readonly ONBOARDING_AI_RATE_LIMITER?: RateLimit;
  /** Anonymous MCP traffic, keyed by client IP (server/mcp reads it by this name). */
  readonly MCP_RATE_LIMITER?: RateLimit;

  // ---- Vars ----------------------------------------------------------------------------------
  /** Public origin, e.g. https://novus.example.org (no trailing slash). */
  readonly APP_ORIGIN: string;
  readonly ENVIRONMENT: "local" | "staging" | "production";
  /** Gemini model id for the readiness assistant; server/ai has an allowlisted default. */
  readonly GEMINI_MODEL?: string;
  /** "true" stops every model call; responses degrade to deterministic output. */
  readonly AI_DISABLED?: string;
  /** Optional sender override for outgoing mail, e.g. `Novus <notify@notify.example.org>`. */
  readonly EMAIL_FROM?: string;
  /**
   * The client build id (the VITE_RELEASE the deployed SPA was built with). When set, crash
   * reports from any other release are not stored (server/api/v1/events).
   */
  readonly RELEASE_ID?: string;

  // ---- Secrets -------------------------------------------------------------------------------
  /** Optional: with no key the assistant answers with deterministic fallbacks. */
  readonly GEMINI_API_KEY?: string;
  readonly BETTER_AUTH_SECRET: string;
  /** JSON object keyId -> secret for HMAC-signed /internal/v1 calls. */
  readonly INTERNAL_HMAC_KEYS: string;
  readonly SENTRY_DSN?: string;
  /** Turnstile server secret (sign-in, Remind me, error reports). */
  readonly TURNSTILE_SECRET_KEY?: string;
  /** Public Turnstile site key ([vars]); sent to the browser by GET /api/v1/turnstile. */
  readonly TURNSTILE_SITE_KEY?: string;
}

/**
 * The signed-in user as the server sees it (defined by server/auth): a superset of the public
 * SessionUser contract with the internal id, role grants and session state. The internal id never
 * leaves the server; responses use `publicId`.
 */
export type SessionUser = AuthSessionUser;

export type AppEnv = {
  Bindings: Env;
  Variables: {
    user?: SessionUser;
    requestId: string;
    /** Set by server/internal after an HMAC signature verifies. */
    internalKeyId?: string;
  };
};
