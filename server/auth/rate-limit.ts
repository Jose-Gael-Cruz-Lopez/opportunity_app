/**
 * Better Auth's rate-limit storage on D1, with two changes from the built-in "database" storage:
 * - Keys are stored as an HMAC, because Better Auth's key embeds the client IP and plan 9.10.5
 *   keeps raw addresses out of D1 (and so out of Time Travel and exports).
 * - Each request is one atomic upsert, so concurrent requests cannot all pass a stale read.
 *
 * The window is fixed: `last_request` holds the start of the current window.
 */
import { hmacHex } from "./crypto";

export interface RateLimitRule {
  window: number;
  max: number;
}

export interface RateLimitDecision {
  allowed: boolean;
  retryAfter: number | null;
}

/** Rows older than this are deleted now and then; longer than any configured window. */
const PRUNE_AFTER_MS = 24 * 60 * 60 * 1000;
const PRUNE_PROBABILITY = 0.02;

const CONSUME_SQL = `
INSERT INTO rate_limits (id, key, count, last_request) VALUES (?1, ?2, 1, ?3)
ON CONFLICT(key) DO UPDATE SET
  count = CASE WHEN ?3 - rate_limits.last_request >= ?4 THEN 1 ELSE rate_limits.count + 1 END,
  last_request = CASE WHEN ?3 - rate_limits.last_request >= ?4 THEN ?3 ELSE rate_limits.last_request END
RETURNING count, last_request`;

export function d1RateLimitStorage(d1: D1Database, secret: string, now: () => number = Date.now) {
  return {
    async consume(key: string, rule: RateLimitRule): Promise<RateLimitDecision> {
      const t = now();
      const windowMs = rule.window * 1000;
      const hashed = await hmacHex(`${secret}:rate-limit`, key);
      const row = await d1
        .prepare(CONSUME_SQL)
        .bind(crypto.randomUUID(), hashed, t, windowMs)
        .first<{ count: number; last_request: number }>();
      if (Math.random() < PRUNE_PROBABILITY) {
        await d1.prepare("DELETE FROM rate_limits WHERE last_request < ?1").bind(t - PRUNE_AFTER_MS).run();
      }
      if (!row || row.count <= rule.max) return { allowed: true, retryAfter: null };
      return { allowed: false, retryAfter: Math.max(1, Math.ceil((row.last_request + windowMs - t) / 1000)) };
    },
  };
}
