import { and, eq, sql } from "drizzle-orm";
import type { AnalyticsEvent } from "../../../shared/contracts/api";
import { findSensitiveKeys } from "../../../shared/contracts/sensitive";
import type { EventsDb } from "../client";
import * as e from "../events-schema";
import { uuidv7 } from "../columns";
import { chunked, rowsPerInsert } from "../util";

/**
 * `novus-events` writes: analytics events, day-level program counters, LLM metering and budget
 * reservations, and the email send ledger. These run against EVENTS_DB so they never queue
 * behind Alerts on `novus-main`.
 */

export interface StoredAnalyticsEvent extends Omit<AnalyticsEvent, "at"> {
  at: number;
  userHmac?: string | null;
  hmacKeyId?: string | null;
}

/**
 * Inserts allowlisted events. Any event whose properties carry a sensitive-looking key is
 * dropped (never stored), as a last line behind the route's own check.
 */
export async function recordAnalyticsEvents(edb: EventsDb, events: readonly StoredAnalyticsEvent[], now: number): Promise<number> {
  const rows = events
    .filter((ev) => findSensitiveKeys(ev.props).length === 0)
    .map((ev) => ({
      id: uuidv7(now),
      name: ev.name,
      at: ev.at,
      deviceId: ev.deviceId,
      userHmac: ev.userHmac ?? null,
      hmacKeyId: ev.hmacKeyId ?? null,
      path: ev.path,
      props: ev.props,
      receivedAt: now,
    }));
  if (rows.length === 0) return 0;
  const stmts = chunked(rows, rowsPerInsert(9)).map((c) => edb.insert(e.analyticsEvents).values(c));
  await edb.batch(stmts as unknown as [(typeof stmts)[number], ...(typeof stmts)[number][]]);
  return rows.length;
}

/** The only record of views and clicks on sensitive- or identity-audience programs. */
export async function incrementProgramDailyCount(edb: EventsDb, programId: string, day: string, eventName: string): Promise<void> {
  await edb
    .insert(e.programDailyCounts)
    .values({ programId, day, eventName, n: 1 })
    .onConflictDoUpdate({
      target: [e.programDailyCounts.programId, e.programDailyCounts.day, e.programDailyCounts.eventName],
      set: { n: sql`${e.programDailyCounts.n} + 1` },
    });
}

export async function incrementAttributionDaily(edb: EventsDb, codeId: string, day: string, field: "signups" | "activations"): Promise<void> {
  const column = field === "signups" ? e.attributionCodeDaily.signups : e.attributionCodeDaily.activations;
  await edb
    .insert(e.attributionCodeDaily)
    .values({ codeId, day, signups: field === "signups" ? 1 : 0, activations: field === "activations" ? 1 : 0 })
    .onConflictDoUpdate({ target: [e.attributionCodeDaily.codeId, e.attributionCodeDaily.day], set: { [field]: sql`${column} + 1` } });
}

// =============================================================================================
// LLM metering (no prompt or output text is ever stored)
// =============================================================================================

export type LlmCallInsert = Omit<typeof e.llmCalls.$inferInsert, "id" | "createdAt">;

export async function recordLlmCall(edb: EventsDb, call: LlmCallInsert, now: number): Promise<string> {
  const id = uuidv7(now);
  await edb.insert(e.llmCalls).values({ ...call, id, createdAt: now });
  return id;
}

/**
 * Reserves an estimate against the month's budget for a class. Fails (returns null) when the cap
 * would be exceeded, so callers degrade instead of overspending. One batch: the reservation and
 * the budget increment commit together; the budget row update is conditional on headroom.
 */
export async function reserveLlmBudget(
  edb: EventsDb,
  input: { idempotencyKey: string; routeId: string; budgetClass: string; month: string; estimateMicros: number; capMicros: number; ttlMs: number },
  now: number,
): Promise<string | null> {
  const existing = await edb.query.llmReservations.findFirst({ where: eq(e.llmReservations.idempotencyKey, input.idempotencyKey) });
  if (existing) return existing.state === "released" ? null : existing.id;
  await edb
    .insert(e.llmBudgets)
    .values({ id: uuidv7(now), month: input.month, budgetClass: input.budgetClass, capMicros: input.capMicros })
    .onConflictDoNothing();
  const updated = await edb
    .update(e.llmBudgets)
    .set({ reservedMicros: sql`${e.llmBudgets.reservedMicros} + ${input.estimateMicros}`, version: sql`${e.llmBudgets.version} + 1` })
    .where(
      and(
        eq(e.llmBudgets.month, input.month),
        eq(e.llmBudgets.budgetClass, input.budgetClass),
        sql`${e.llmBudgets.reservedMicros} + ${e.llmBudgets.settledMicros} + ${input.estimateMicros} <= ${e.llmBudgets.capMicros}`,
      ),
    )
    .returning({ id: e.llmBudgets.id });
  if (updated.length === 0) return null;
  const id = uuidv7(now);
  await edb.insert(e.llmReservations).values({
    id,
    idempotencyKey: input.idempotencyKey,
    routeId: input.routeId,
    budgetClass: input.budgetClass,
    estimateMicros: input.estimateMicros,
    expiresAt: now + input.ttlMs,
    createdAt: now,
  });
  return id;
}

/** Settles a reservation at its actual cost (or releases it with actual = 0). */
export async function settleLlmReservation(edb: EventsDb, reservationId: string, month: string, actualMicros: number, release = false): Promise<void> {
  const r = await edb.query.llmReservations.findFirst({ where: eq(e.llmReservations.id, reservationId) });
  if (!r || r.state !== "reserved") return;
  await edb.batch([
    edb
      .update(e.llmReservations)
      .set({ state: release ? "released" : "settled", actualMicros: release ? 0 : actualMicros })
      .where(and(eq(e.llmReservations.id, reservationId), eq(e.llmReservations.state, "reserved"))),
    edb
      .update(e.llmBudgets)
      .set({
        reservedMicros: sql`max(0, ${e.llmBudgets.reservedMicros} - ${r.estimateMicros})`,
        settledMicros: sql`${e.llmBudgets.settledMicros} + ${release ? 0 : actualMicros}`,
      })
      .where(and(eq(e.llmBudgets.month, month), eq(e.llmBudgets.budgetClass, r.budgetClass))),
  ]);
}

export async function llmSpend(edb: EventsDb, month: string) {
  return edb.select().from(e.llmBudgets).where(eq(e.llmBudgets.month, month));
}

// =============================================================================================
// Email send ledger
// =============================================================================================

export async function appendEmailLedger(
  edb: EventsDb,
  entry: { notificationId: string; stream: "transactional" | "digest"; outcome: "sent" | "failed" | "suppressed" | "quota_deferred"; providerMessageId?: string | null; dryRun?: boolean },
  now: number,
): Promise<void> {
  await edb.insert(e.emailSendLedger).values({ id: uuidv7(now), ...entry, providerMessageId: entry.providerMessageId ?? null, dryRun: entry.dryRun ?? false, createdAt: now });
}

/** Emails sent since an instant (the daily quota check). */
export async function emailsSentSince(edb: EventsDb, sinceMs: number): Promise<number> {
  const rows = await edb
    .select({ n: sql<number>`count(*)` })
    .from(e.emailSendLedger)
    .where(and(eq(e.emailSendLedger.outcome, "sent"), sql`${e.emailSendLedger.createdAt} >= ${sinceMs}`));
  return Number(rows[0]?.n ?? 0);
}

/** Days of client crash counters kept (judgment; s09 retention class "ops_metrics"). */
export const CLIENT_ERROR_RETENTION_DAYS = 90;

/** Deletes `client_error_daily` rows older than the retention window; returns rows removed. */
export async function sweepClientErrorDaily(edb: EventsDb, now: number, keepDays = CLIENT_ERROR_RETENTION_DAYS): Promise<number> {
  const cutoff = new Date(now - keepDays * 86_400_000).toISOString().slice(0, 10);
  const removed = await edb.delete(e.clientErrorDaily).where(sql`${e.clientErrorDaily.day} < ${cutoff}`).returning({ day: e.clientErrorDaily.day });
  return removed.length;
}
