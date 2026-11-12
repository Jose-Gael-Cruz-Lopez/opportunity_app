import { sql } from "drizzle-orm";
import type { Db } from "@server/db/client";
import { rateLimits } from "@server/db/schema";
import { uuidv7 } from "@server/db/columns";

/**
 * Rate-limit building blocks (plan 02 2.3.10, 2.3.13). Three layers, each with a gap the next
 * covers:
 * - the Workers rate-limit binding: shared per location, but only 10- or 60-second periods;
 * - an in-isolate fixed window (`WindowLimiter`): any period, but per isolate, so approximate;
 * - a D1 fixed window (`consumeD1Window`): exact and global, for low-volume costly actions such
 *   as sending email (keyed by an HMAC of the address, never the address).
 * Keys are IPs, internal user ids or HMACs; never request content.
 */

export interface WindowRule {
  readonly limit: number;
  readonly windowMs: number;
}

export interface RateDecision {
  readonly allowed: boolean;
  /** Seconds until a slot frees up (0 when allowed). */
  readonly retryAfterSeconds: number;
}

const ALLOW: RateDecision = { allowed: true, retryAfterSeconds: 0 };

/** Fixed-window counters per rule. Pure apart from its own map; `now` is injected. */
export class WindowLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();

  constructor(
    private readonly rules: readonly WindowRule[],
    private readonly maxKeys = 10_000,
  ) {}

  /** Counts the hit only when every rule allows it, so refused requests do not extend a ban. */
  check(key: string, now: number): RateDecision {
    let retry = 0;
    const slots: { id: string; start: number; count: number }[] = [];
    this.rules.forEach((rule, i) => {
      const id = `${i}:${key}`;
      const start = Math.floor(now / rule.windowMs) * rule.windowMs;
      const current = this.windows.get(id);
      const count = current && current.start === start ? current.count : 0;
      if (count >= rule.limit) retry = Math.max(retry, Math.ceil((start + rule.windowMs - now) / 1000));
      slots.push({ id, start, count });
    });
    if (retry > 0) return { allowed: false, retryAfterSeconds: retry };
    if (this.windows.size >= this.maxKeys) this.evict(now);
    for (const s of slots) {
      // Re-inserting moves the key to the end, so eviction order is least recently used.
      this.windows.delete(s.id);
      this.windows.set(s.id, { start: s.start, count: s.count + 1 });
    }
    return ALLOW;
  }

  /**
   * Makes room without resetting anyone's live window: first drops windows that have ended,
   * then, if a flood of fresh keys still fills the map, the least recently used tenth. Clearing
   * the whole map here would hand every client, the flooder included, a fresh window.
   */
  private evict(now: number): void {
    for (const [id, w] of this.windows) {
      const rule = this.rules[Number(id.slice(0, id.indexOf(":")))];
      if (!rule || w.start + rule.windowMs <= now) this.windows.delete(id);
    }
    let excess = this.windows.size - Math.floor(this.maxKeys * 0.9);
    for (const id of this.windows.keys()) {
      if (excess-- <= 0) break;
      this.windows.delete(id);
    }
  }

  /** Keys held, for tests. */
  get size(): number {
    return this.windows.size;
  }

  reset(): void {
    this.windows.clear();
  }
}

/** The Workers rate-limit binding shape. */
export interface RateLimitBindingLike {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

/**
 * Asks the binding; fails open on a binding error, because the in-isolate window still applies
 * and refusing all traffic during a platform fault would be worse.
 */
export async function checkBinding(binding: RateLimitBindingLike | undefined, key: string, periodSeconds = 60): Promise<RateDecision> {
  if (!binding) return ALLOW;
  try {
    const { success } = await binding.limit({ key });
    return success ? ALLOW : { allowed: false, retryAfterSeconds: periodSeconds };
  } catch {
    return ALLOW;
  }
}

/** Rows written here are prefixed so they never collide with Better Auth's own counters. */
export const D1_RATE_KEY_PREFIX = "novus:";

/**
 * An exact fixed window in D1's `rate_limits` table, in one upsert. For our rows
 * `last_request` holds the window start. SQLite evaluates every SET expression against the old
 * row, so both CASEs see the same previous window.
 */
export async function consumeD1Window(db: Db, key: string, rule: WindowRule, now: number): Promise<RateDecision> {
  const fullKey = `${D1_RATE_KEY_PREFIX}${key}`;
  const start = Math.floor(now / rule.windowMs) * rule.windowMs;
  const rows = await db
    .insert(rateLimits)
    .values({ id: uuidv7(now), key: fullKey, count: 1, lastRequest: start })
    .onConflictDoUpdate({
      target: rateLimits.key,
      set: {
        count: sql`CASE WHEN ${rateLimits.lastRequest} < ${start} THEN 1 ELSE ${rateLimits.count} + 1 END`,
        lastRequest: sql`CASE WHEN ${rateLimits.lastRequest} < ${start} THEN ${start} ELSE ${rateLimits.lastRequest} END`,
      },
    })
    .returning({ count: rateLimits.count });
  const count = rows[0]?.count ?? 1;
  if (count <= rule.limit) return ALLOW;
  return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((start + rule.windowMs - now) / 1000)) };
}

/**
 * The client IP as Cloudflare saw it. Only CF-Connecting-IP is trusted: X-Forwarded-For is
 * client-controlled. Used only as an in-memory or binding key, never stored or logged.
 */
export function clientIp(headers: Headers): string {
  return headers.get("cf-connecting-ip")?.trim() || "unknown";
}

/**
 * Truncates an address to its network (IPv4 /24, IPv6 /48), the granularity plan 2.3.10 allows
 * wherever an address must be kept.
 */
export function truncateIp(ip: string): string {
  if (ip.includes(":")) {
    const parts = ip.split("::")[0]!.split(":").filter(Boolean);
    return `${parts.slice(0, 3).join(":")}::/48`;
  }
  const octets = ip.split(".");
  if (octets.length !== 4) return "unknown";
  return `${octets.slice(0, 3).join(".")}.0/24`;
}
