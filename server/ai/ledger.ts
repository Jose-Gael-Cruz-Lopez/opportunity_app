import { CHARS_PER_TOKEN, ESTIMATE_PADDING, priceFor, type AiRouteId } from "./config";
import type { AiLog, TokenUsage } from "./types";

/**
 * Spend ledger: token and cost accounting per attempt, a monthly cap per route, and a daily
 * request cap per user. Costs are integer micro-USD so sums never drift.
 *
 * Storage is D1 `EVENTS_DB` when bound (DDL below, to be added as a migration by the schema
 * owner) with an in-isolate memory ledger as the backstop: if D1 fails, the memory counts still
 * bound spend within this isolate, and Google Cloud billing alerts remain the hard backstop.
 */

/** Cost of one attempt. Thinking tokens are billed as output; cached tokens are priced as input (conservative). */
export function costMicros(model: string, usage: TokenUsage, isoDate: string): number {
  const p = priceFor(model, isoDate);
  const input = usage.inputTokens * p.inputPerM;
  const output = (usage.outputTokens + usage.thoughtTokens) * p.outputPerM;
  return Math.ceil((input + output) / 1_000_000);
}

/** Upper-bound estimate before a call: padded input at ~4 chars/token, full output allowance. */
export function estimateMicros(models: readonly string[], inputChars: number, maxOutputTokens: number, isoDate: string): number {
  const inputTokens = Math.ceil((inputChars / CHARS_PER_TOKEN) * ESTIMATE_PADDING);
  const usage: TokenUsage = { inputTokens, outputTokens: maxOutputTokens, thoughtTokens: 0, cachedTokens: 0 };
  return Math.max(0, ...models.map((m) => costMicros(m, usage, isoDate)));
}

export interface SpendEntry {
  readonly month: string;
  readonly route: AiRouteId;
  readonly model: string;
  readonly usage: TokenUsage;
  readonly costMicros: number;
}

export interface SpendLedger {
  monthSpendMicros(route: AiRouteId, month: string): Promise<number>;
  userRequests(route: AiRouteId, userKey: string, day: string): Promise<number>;
  recordSpend(entry: SpendEntry): Promise<void>;
  recordUserRequest(route: AiRouteId, userKey: string, day: string): Promise<void>;
}

export class MemoryLedger implements SpendLedger {
  private readonly spend = new Map<string, number>();
  private readonly requests = new Map<string, number>();
  readonly entries: SpendEntry[] = [];

  async monthSpendMicros(route: AiRouteId, month: string): Promise<number> {
    return this.spend.get(`${month}|${route}`) ?? 0;
  }

  async userRequests(route: AiRouteId, userKey: string, day: string): Promise<number> {
    return this.requests.get(`${day}|${route}|${userKey}`) ?? 0;
  }

  async recordSpend(entry: SpendEntry): Promise<void> {
    const key = `${entry.month}|${entry.route}`;
    this.spend.set(key, (this.spend.get(key) ?? 0) + entry.costMicros);
    this.entries.push(entry);
  }

  async recordUserRequest(route: AiRouteId, userKey: string, day: string): Promise<void> {
    const key = `${day}|${route}|${userKey}`;
    this.requests.set(key, (this.requests.get(key) ?? 0) + 1);
  }
}

// ---------------------------------------------------------------------------------------------
// D1
// ---------------------------------------------------------------------------------------------

/** The slice of D1Database the ledger uses (keeps tests free of the Workers runtime). */
export interface D1Like {
  prepare(query: string): D1StatementLike;
}
export interface D1StatementLike {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  run(): Promise<unknown>;
}

/**
 * Proposed migration for novus-events (owned by the schema module). user_key is a SHA-256 of the
 * user id, so this table cannot be joined back to a person without the users table; rows older
 * than 7 days should be pruned by a job (see `pruneUserDailySql`).
 */
export const AI_LEDGER_DDL = `
CREATE TABLE IF NOT EXISTS ai_spend_monthly (
  month TEXT NOT NULL,
  route TEXT NOT NULL,
  model TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  input_tokens INTEGER NOT NULL DEFAULT 0,
  output_tokens INTEGER NOT NULL DEFAULT 0,
  thought_tokens INTEGER NOT NULL DEFAULT 0,
  cached_tokens INTEGER NOT NULL DEFAULT 0,
  cost_micros INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (month, route, model)
);
CREATE TABLE IF NOT EXISTS ai_user_daily (
  day TEXT NOT NULL,
  user_key TEXT NOT NULL,
  route TEXT NOT NULL,
  requests INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (day, user_key, route)
);
`.trim();

export const pruneUserDailySql = "DELETE FROM ai_user_daily WHERE day < ?";

export class D1Ledger implements SpendLedger {
  constructor(
    private readonly db: D1Like,
    private readonly backstop: MemoryLedger,
    private readonly log: AiLog,
  ) {}

  async monthSpendMicros(route: AiRouteId, month: string): Promise<number> {
    const local = await this.backstop.monthSpendMicros(route, month);
    try {
      const row = await this.db
        .prepare("SELECT COALESCE(SUM(cost_micros), 0) AS total FROM ai_spend_monthly WHERE month = ? AND route = ?")
        .bind(month, route)
        .first<{ total: number }>();
      return Math.max(local, Number(row?.total ?? 0));
    } catch {
      this.log("ai.ledger_read_failed", { route });
      return local;
    }
  }

  async userRequests(route: AiRouteId, userKey: string, day: string): Promise<number> {
    const local = await this.backstop.userRequests(route, userKey, day);
    try {
      const row = await this.db
        .prepare("SELECT requests FROM ai_user_daily WHERE day = ? AND user_key = ? AND route = ?")
        .bind(day, userKey, route)
        .first<{ requests: number }>();
      return Math.max(local, Number(row?.requests ?? 0));
    } catch {
      this.log("ai.ledger_read_failed", { route });
      return local;
    }
  }

  async recordSpend(entry: SpendEntry): Promise<void> {
    await this.backstop.recordSpend(entry);
    const u = entry.usage;
    try {
      await this.db
        .prepare(
          `INSERT INTO ai_spend_monthly (month, route, model, attempts, input_tokens, output_tokens, thought_tokens, cached_tokens, cost_micros)
           VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)
           ON CONFLICT (month, route, model) DO UPDATE SET
             attempts = attempts + 1,
             input_tokens = input_tokens + excluded.input_tokens,
             output_tokens = output_tokens + excluded.output_tokens,
             thought_tokens = thought_tokens + excluded.thought_tokens,
             cached_tokens = cached_tokens + excluded.cached_tokens,
             cost_micros = cost_micros + excluded.cost_micros`,
        )
        .bind(entry.month, entry.route, entry.model, u.inputTokens, u.outputTokens, u.thoughtTokens, u.cachedTokens, entry.costMicros)
        .run();
    } catch {
      this.log("ai.ledger_write_failed", { route: entry.route });
    }
  }

  async recordUserRequest(route: AiRouteId, userKey: string, day: string): Promise<void> {
    await this.backstop.recordUserRequest(route, userKey, day);
    try {
      await this.db
        .prepare(
          `INSERT INTO ai_user_daily (day, user_key, route, requests) VALUES (?, ?, ?, 1)
           ON CONFLICT (day, user_key, route) DO UPDATE SET requests = requests + 1`,
        )
        .bind(day, userKey, route)
        .run();
    } catch {
      this.log("ai.ledger_write_failed", { route });
    }
  }
}

/** SHA-256 of a user id, hex, first 32 chars. Works in Workers and Node (Web Crypto). */
export async function hashUserKey(userId: string): Promise<string> {
  const data = new TextEncoder().encode(`novus-ai-ledger:${userId}`);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function utcMonth(ms: number): string {
  return new Date(ms).toISOString().slice(0, 7);
}
