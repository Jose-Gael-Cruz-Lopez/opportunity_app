import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv, Env } from "../env";
import { logFor } from "../lib/log";
import { problemFor } from "../lib/problem";
import { WindowLimiter, checkBinding, clientIp, type RateLimitBindingLike, type WindowRule } from "../lib/rate-limit";

/**
 * Per-route rate limiting:
 *
 *   app.post("/remind-me", rateLimit({ name: "remind_me", key: byIp, rules: [{ limit: 2, windowMs: 60_000 }],
 *     binding: (env) => env.RATE_LIMIT_SEND }), handler);
 *
 * The binding (when configured) is checked first, then the in-isolate window. Refusals answer
 * 429 `rate_limited` with Retry-After and log the limiter name only, never the key.
 */

export interface RateLimitOptions {
  /** Short identifier for logs and key namespacing, e.g. "public_api". */
  readonly name: string;
  readonly rules: readonly WindowRule[];
  /** The key for this request; null skips limiting (e.g. no user on a public route). */
  readonly key: (c: Context<AppEnv>) => string | null;
  readonly binding?: (env: Env) => RateLimitBindingLike | undefined;
  /** The binding's configured period, for Retry-After. */
  readonly bindingPeriodSeconds?: number;
  readonly now?: () => number;
}

export const byIp = (c: Context<AppEnv>): string => clientIp(c.req.raw.headers);
export const byUser = (c: Context<AppEnv>): string | null => c.get("user")?.id ?? null;
export const byUserOrIp = (c: Context<AppEnv>): string => byUser(c) ?? `ip:${byIp(c)}`;

export function rateLimit(options: RateLimitOptions): MiddlewareHandler<AppEnv> {
  const limiter = new WindowLimiter(options.rules);
  const now = options.now ?? Date.now;
  return async (c, next) => {
    const key = options.key(c);
    if (key === null) return next();
    const namespaced = `${options.name}:${key}`;

    const fromBinding = await checkBinding(options.binding?.(c.env), namespaced, options.bindingPeriodSeconds ?? 60);
    const decision = fromBinding.allowed ? limiter.check(namespaced, now()) : fromBinding;
    if (!decision.allowed) {
      logFor(c).warn("rate_limited", { limiter: options.name });
      return problemFor(c, "rate_limited", {}, { retryAfter: decision.retryAfterSeconds });
    }
    await next();
  };
}
