import { like } from "drizzle-orm";
import { getDb, type Db } from "@server/db/client";
import { config as configTable } from "@server/db/schema";
import { getFlags as readFlagRows } from "@server/db/repos/jobs";
import type { Env } from "../env";
import {
  FLAG_CACHE_TTL_MS,
  FLAG_DEFAULTS,
  FLAG_KEYS,
  ROLLOUT_CONFIG_PREFIX,
  isFlagKey,
  type FlagKey,
  type FlagValues,
} from "../config/flags";
import { hmacSha256 } from "./crypto";
import { rootLogger } from "./log";

/**
 * Feature flags from D1 with a 60-second in-isolate cache (plan 02 2.3.12). When D1 fails, the
 * last good copy is kept (marked stale) and, with none, the compiled-in defaults apply, so a D1
 * outage never turns a kill switch into an error page.
 */

export interface FlagSnapshot {
  readonly values: FlagValues;
  /** Percent (0-100) per flag with a rollout row in the `config` table. */
  readonly rollouts: Readonly<Partial<Record<FlagKey, number>>>;
  readonly fetchedAt: number;
  readonly source: "d1" | "stale" | "defaults";
}

export interface FlagSource {
  load(): Promise<{ flags: Record<string, boolean>; rollouts: Record<string, unknown> }>;
}

export function d1FlagSource(db: Db): FlagSource {
  return {
    async load() {
      const flags = await readFlagRows(db);
      const rows = await db
        .select({ key: configTable.key, value: configTable.value })
        .from(configTable)
        .where(like(configTable.key, `${ROLLOUT_CONFIG_PREFIX}%`));
      const rollouts = Object.fromEntries(rows.map((r) => [r.key.slice(ROLLOUT_CONFIG_PREFIX.length), r.value]));
      return { flags, rollouts };
    },
  };
}

/** Merges stored rows over the defaults; unknown keys are ignored, so a typo cannot add a flag. */
export function mergeFlags(rows: Record<string, boolean>): FlagValues {
  const out: Record<FlagKey, boolean> = { ...FLAG_DEFAULTS };
  for (const [k, v] of Object.entries(rows)) if (isFlagKey(k) && typeof v === "boolean") out[k] = v;
  return out;
}

export function parseRollouts(rows: Record<string, unknown>): Partial<Record<FlagKey, number>> {
  const out: Partial<Record<FlagKey, number>> = {};
  for (const [k, v] of Object.entries(rows)) {
    if (isFlagKey(k) && typeof v === "number" && Number.isFinite(v)) out[k] = Math.min(100, Math.max(0, v));
  }
  return out;
}

/** After a failed read, the next attempt waits this long. */
export const FLAG_RETRY_MS = 5_000;

const DEFAULT_SNAPSHOT: FlagSnapshot = { values: FLAG_DEFAULTS, rollouts: {}, fetchedAt: 0, source: "defaults" };

export class FlagCache {
  private snapshot: FlagSnapshot | null = null;
  private inflight: Promise<FlagSnapshot> | null = null;

  constructor(
    private readonly ttlMs = FLAG_CACHE_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  async get(source: FlagSource): Promise<FlagSnapshot> {
    const now = this.now();
    if (this.snapshot && now - this.snapshot.fetchedAt < this.ttlMs) return this.snapshot;
    // One D1 read per isolate per expiry, however many requests arrive at once.
    this.inflight ??= this.refresh(source, now).finally(() => {
      this.inflight = null;
    });
    return this.inflight;
  }

  private async refresh(source: FlagSource, now: number): Promise<FlagSnapshot> {
    try {
      const { flags, rollouts } = await source.load();
      this.snapshot = { values: mergeFlags(flags), rollouts: parseRollouts(rollouts), fetchedAt: now, source: "d1" };
      return this.snapshot;
    } catch (err) {
      rootLogger().warn("flags_unavailable", { errorClass: err instanceof Error ? err.name : "unknown" });
      // Keep the last good copy (or the defaults) and retry after a short pause, not per request.
      const prev = this.snapshot;
      const hadData = prev !== null && prev.source !== "defaults";
      this.snapshot = {
        ...(hadData ? prev : DEFAULT_SNAPSHOT),
        source: hadData ? "stale" : "defaults",
        fetchedAt: now - this.ttlMs + FLAG_RETRY_MS,
      };
      return this.snapshot;
    }
  }

  /** Drops the cached copy (after an admin changes a flag in this isolate). */
  invalidate(): void {
    this.snapshot = null;
  }
}

// One cache per D1 binding object: in production that is one per isolate.
const caches = new WeakMap<object, FlagCache>();

function cacheFor(d1: object): FlagCache {
  let c = caches.get(d1);
  if (!c) {
    c = new FlagCache();
    caches.set(d1, c);
  }
  return c;
}

export async function loadFlags(env: Pick<Env, "DB">): Promise<FlagSnapshot> {
  // Without a database binding (a misconfigured preview), the compiled-in defaults apply.
  if (!env?.DB) return DEFAULT_SNAPSHOT;
  return cacheFor(env.DB).get(d1FlagSource(getDb(env.DB)));
}

export function invalidateFlags(env: Pick<Env, "DB">): void {
  cacheFor(env.DB).invalidate();
}

export async function isEnabled(env: Pick<Env, "DB">, key: FlagKey): Promise<boolean> {
  return (await loadFlags(env)).values[key];
}

/**
 * A stable bucket in [0, 100) for a subject under one flag, from an HMAC so users cannot pick a
 * subject id that lands in a rollout, and buckets differ between flags.
 */
export async function rolloutBucket(secret: string, key: FlagKey, subject: string): Promise<number> {
  const mac = await hmacSha256(secret, `flag-rollout\n${key}\n${subject}`);
  const n = ((mac[0]! << 24) | (mac[1]! << 16) | (mac[2]! << 8) | mac[3]!) >>> 0;
  return (n / 0x1_0000_0000) * 100;
}

/** True when the flag is on and, if a rollout percent is set, the subject falls inside it. */
export async function isEnabledFor(
  snapshot: FlagSnapshot,
  key: FlagKey,
  subject: string,
  secret: string,
): Promise<boolean> {
  if (!snapshot.values[key]) return false;
  const pct = snapshot.rollouts[key];
  if (pct === undefined || pct >= 100) return true;
  if (pct <= 0) return false;
  return (await rolloutBucket(secret, key, subject)) < pct;
}

export { FLAG_KEYS };
