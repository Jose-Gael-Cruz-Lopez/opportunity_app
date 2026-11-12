import { eq, inArray } from "drizzle-orm";
import { getDb, getEventsDb } from "@server/db/client";
import { deriveSubkey, hmacSha256Hex } from "@server/internal/crypto";
import { consumeD1Window, type RateDecision, type WindowRule } from "@server/lib/rate-limit";
import { incrementProgramDailyCount, recordAnalyticsEvents, type StoredAnalyticsEvent } from "@server/db/repos/events";
import * as s from "@server/db/schema";
import { adultFrom } from "../remind/service";

/** Durable daily windows: per network (HMAC of the /24 or /64, never the address) or global. */
export type DailyCapScope = "events" | "errors" | "errors_all";
import { CLIENT_ERROR_TABLE, UPSERT_CLIENT_ERROR_SQL, type ClientErrorKey } from "./client-errors";

/**
 * Ports the events routes use, with the D1 implementation. Tests pass an in-memory SQLite D1
 * (server/db/testing) through the same functions, so the SQL is exercised for real.
 */

export interface ProgramAudience {
  readonly programId: string;
  /** `sensitive_audience` or a non-empty `identity_audience`: counters only, never rows. */
  readonly restricted: boolean;
}

export interface EventsStore {
  /** Audience of each known program and cycle id; unknown ids are absent. */
  audiences(input: { programIds: readonly string[]; cycleIds: readonly string[] }): Promise<{
    programs: ReadonlyMap<string, ProgramAudience>;
    cycles: ReadonlyMap<string, ProgramAudience>;
  }>;
  /** False for an account with analytics switched off or in minor mode (no analytics consent exists yet). */
  viewerAllowsAnalytics(userId: string, now: number): Promise<boolean>;
  insertEvents(rows: readonly StoredAnalyticsEvent[], now: number): Promise<number>;
  incrementCounter(programId: string, day: string, eventName: string): Promise<void>;
  /** Day counters for client errors; "no_table" until the proposed migration is applied. */
  recordClientErrors(keys: readonly ClientErrorKey[], day: string): Promise<"stored" | "no_table">;
  /**
   * One hit on a durable daily window in novus-main `rate_limits` (exact and global across
   * isolates and locations). `network` is the /24 or /64 from `networkOf()`; it is stored only
   * as an HMAC under a subkey of BETTER_AUTH_SECRET, and without that secret the per-network
   * windows are skipped (allowed). `errors_all` ignores the network.
   */
  consumeDailyCap(scope: DailyCapScope, network: string, rule: WindowRule, now: number): Promise<RateDecision>;
}

export interface EventsStoreBindings {
  readonly DB: D1Database;
  readonly EVENTS_DB: D1Database;
  /** Keys the per-network daily windows (HMAC subkey `events-net-v1`). */
  readonly BETTER_AUTH_SECRET?: string;
  /**
   * The deployed client build id (the VITE_RELEASE the build was made with). When set, SPA and
   * console crash reports must carry it; when unset, any well-formed release is accepted and
   * only the daily caps bound the counter rows.
   */
  readonly RELEASE_ID?: string;
}

function isRestricted(row: { sensitiveAudience: boolean; identityAudience: readonly string[] | null }): boolean {
  return row.sensitiveAudience || (row.identityAudience?.length ?? 0) > 0;
}

function isMissingTable(err: unknown): boolean {
  const message = err instanceof Error ? `${err.message} ${String((err as { cause?: unknown }).cause ?? "")}` : String(err);
  return new RegExp(`no such table:?\\s*(main\\.)?${CLIENT_ERROR_TABLE}`, "i").test(message);
}

export function createD1EventsStore(env: EventsStoreBindings): EventsStore {
  const db = getDb(env.DB);
  const edb = getEventsDb(env.EVENTS_DB);
  return {
    async audiences({ programIds, cycleIds }) {
      const programs = new Map<string, ProgramAudience>();
      const cycles = new Map<string, ProgramAudience>();
      if (programIds.length > 0) {
        const rows = await db
          .select({ id: s.programs.id, sensitiveAudience: s.programs.sensitiveAudience, identityAudience: s.programs.identityAudience })
          .from(s.programs)
          .where(inArray(s.programs.id, [...programIds]));
        for (const r of rows) programs.set(r.id, { programId: r.id, restricted: isRestricted(r) });
      }
      if (cycleIds.length > 0) {
        const rows = await db
          .select({
            id: s.programCycles.id,
            programId: s.programs.id,
            sensitiveAudience: s.programs.sensitiveAudience,
            identityAudience: s.programs.identityAudience,
          })
          .from(s.programCycles)
          .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
          .where(inArray(s.programCycles.id, [...cycleIds]));
        for (const r of rows) cycles.set(r.id, { programId: r.programId, restricted: isRestricted(r) });
      }
      return { programs, cycles };
    },

    async viewerAllowsAnalytics(userId, now) {
      const [row] = await db
        .select({ off: s.users.analyticsOffAt, birth: s.studentProfiles.birthYearMonth })
        .from(s.users)
        .leftJoin(s.studentProfiles, eq(s.studentProfiles.userId, s.users.id))
        .where(eq(s.users.id, userId))
        .limit(1);
      if (!row) return false;
      if (row.off !== null && row.off !== undefined) return false;
      // Minor mode: under 18 by the youngest reading of the birth month. No analytics consent
      // exists yet (s09 S09-029), so 16-17 is a "No" (s10 S10-002).
      if (row.birth && /^\d{4}-(0[1-9]|1[0-2])$/.test(row.birth) && now < adultFrom(row.birth)) return false;
      return true;
    },

    insertEvents(rows, now) {
      return recordAnalyticsEvents(edb, rows, now);
    },

    incrementCounter(programId, day, eventName) {
      return incrementProgramDailyCount(edb, programId, day, eventName);
    },

    async consumeDailyCap(scope, network, rule, now) {
      if (scope === "errors_all") return consumeD1Window(db, "events:errors:all", rule, now);
      const secret = env.BETTER_AUTH_SECRET;
      if (!secret) return { allowed: true, retryAfterSeconds: 0 };
      const key = await deriveSubkey(secret, "events-net-v1");
      return consumeD1Window(db, `events:${scope}:${(await hmacSha256Hex(key, network)).slice(0, 32)}`, rule, now);
    },

    async recordClientErrors(keys, day) {
      if (keys.length === 0) return "stored";
      const stmts = keys.map((k) => env.EVENTS_DB.prepare(UPSERT_CLIENT_ERROR_SQL).bind(day, k.kind, k.surface, k.errorClass, k.route, k.release, k.browser, k.file, k.line));
      try {
        await env.EVENTS_DB.batch(stmts);
        return "stored";
      } catch (err) {
        if (isMissingTable(err)) return "no_table";
        throw err;
      }
    },
  };
}
