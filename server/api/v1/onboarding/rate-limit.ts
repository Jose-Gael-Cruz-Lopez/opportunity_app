import type { RateLimitBinding } from "./ports";

/**
 * Rate limits for the AI extract route. Each call costs model tokens, and a student needs only one
 * or two extractions during onboarding, so the limits are tight.
 *
 * Two layers, because neither is enough alone:
 * - The Workers rate-limit binding (when configured) counts per location over 10 or 60 seconds.
 * - A per-isolate window here adds a daily ceiling the binding cannot express. It is approximate
 *   (isolates do not share memory), which is acceptable for a cost guard; it is not a security
 *   boundary.
 * Keys are internal user ids; nothing about the request body is part of a key.
 */

export interface WindowRule {
  readonly limit: number;
  readonly windowMs: number;
}

export const AI_EXTRACT_RULES: readonly WindowRule[] = [
  { limit: 3, windowMs: 60_000 },
  { limit: 10, windowMs: 86_400_000 },
];

export interface RateDecision {
  readonly allowed: boolean;
  /** Seconds until the tightest exhausted window frees a slot (0 when allowed). */
  readonly retryAfterSeconds: number;
}

/** A fixed-window counter keyed by string. Pure apart from its own map; `now` is injected. */
export class WindowLimiter {
  private readonly hits = new Map<string, number[]>();
  /** Bounds memory in a long-lived isolate. */
  private static readonly MAX_KEYS = 5_000;

  constructor(private readonly rules: readonly WindowRule[]) {}

  check(key: string, now: number): RateDecision {
    const longest = Math.max(...this.rules.map((r) => r.windowMs));
    const recent = (this.hits.get(key) ?? []).filter((t) => now - t < longest);
    let retry = 0;
    for (const rule of this.rules) {
      const inWindow = recent.filter((t) => now - t < rule.windowMs);
      if (inWindow.length >= rule.limit) {
        const oldest = inWindow[0] ?? now;
        retry = Math.max(retry, Math.ceil((oldest + rule.windowMs - now) / 1000));
      }
    }
    if (retry > 0) {
      this.hits.set(key, recent);
      return { allowed: false, retryAfterSeconds: retry };
    }
    recent.push(now);
    if (!this.hits.has(key) && this.hits.size >= WindowLimiter.MAX_KEYS) {
      const first = this.hits.keys().next().value;
      if (first !== undefined) this.hits.delete(first);
    }
    this.hits.set(key, recent);
    return { allowed: true, retryAfterSeconds: 0 };
  }
}

/** Module-level so the window survives across requests in one isolate. */
const aiLimiter = new WindowLimiter(AI_EXTRACT_RULES);

/**
 * Checks both layers. A binding error fails closed for this route: the AI step is optional, and
 * the client keeps its deterministic parse when told to retry later.
 */
export async function checkAiRateLimit(
  userId: string,
  now: number,
  binding: RateLimitBinding | undefined,
  limiter: WindowLimiter = aiLimiter,
): Promise<RateDecision> {
  if (binding) {
    try {
      const { success } = await binding.limit({ key: `onboarding-ai:${userId}` });
      if (!success) return { allowed: false, retryAfterSeconds: 60 };
    } catch {
      return { allowed: false, retryAfterSeconds: 60 };
    }
  }
  return limiter.check(userId, now);
}
