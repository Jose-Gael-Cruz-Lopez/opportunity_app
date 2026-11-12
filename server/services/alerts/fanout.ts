import { CHANGE_EVENT_TYPES, type ChangeEventType } from "@shared/contracts/events";
import type { Db } from "@server/db/client";
import { notifications, registry } from "@server/db/repos";
import type { AlertInsert } from "@server/db/repos/notifications";
import type { Budget } from "@server/jobs/budget";
import type { HandlerResult, Logger } from "@server/jobs/types";
import { changeAlertDedupeKey, draftAlert, type CycleFacts } from "./copy";

/**
 * `alerts.match`: drains the ChangeEvent outbox into one Alert per recipient. Inserts are
 * idempotent on (recipient_key, dedupe_key), so an event interrupted by the budget is simply
 * re-read next tick, and only a fully fanned-out event is marked done.
 */

/** Recipients per insert round; keeps each D1 batch small (6 rows per INSERT at 15 columns). */
export const RECIPIENT_CHUNK = 300;
/** Events read per tick; the budget usually stops the loop first. */
export const EVENTS_PER_TICK = 50;

export interface FanOutDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly budget: Budget;
  readonly log: Logger;
}

async function cycleFacts(db: Db, cycleId: string): Promise<CycleFacts | null> {
  const ctx = await registry.getCycleContext(db, cycleId);
  if (!ctx) return null;
  return {
    cycleId,
    programName: ctx.program.name,
    programSlug: ctx.program.slug,
    termLabel: ctx.cycle.termLabel,
    sensitiveAudience: ctx.program.sensitiveAudience,
    identityAudience: ctx.program.identityAudience,
    isSample: ctx.program.isSample,
  };
}

function isChangeEventType(type: string): type is ChangeEventType {
  return (CHANGE_EVENT_TYPES as readonly string[]).includes(type);
}

export async function fanOutChangeEvents(deps: FanOutDeps): Promise<HandlerResult> {
  const { db, budget, log } = deps;
  if (!budget.allows(1)) return { processed: 0, outcome: "partial" };
  const events = await notifications.listPendingChangeEvents(db, EVENTS_PER_TICK);
  budget.spend();
  const factsCache = new Map<string, CycleFacts | null>();
  let processed = 0;
  let alerts = 0;

  for (const event of events) {
    // Facts, recipients, at least one insert round and the done mark.
    if (!budget.allows(4)) return { processed, outcome: "partial", detail: { alerts } };
    const now = deps.now();
    if (!factsCache.has(event.programCycleId)) {
      factsCache.set(event.programCycleId, await cycleFacts(db, event.programCycleId));
      budget.spend();
    }
    const facts = factsCache.get(event.programCycleId) ?? null;
    if (!facts || !isChangeEventType(event.type)) {
      // A cycle that vanished (sample cleanup) or an unknown type: nothing to send, close it.
      log("warn", "alerts.match.skip_event", { changeEventId: event.id, reason: facts ? "unknown_type" : "no_cycle" });
      await notifications.markChangeEventFannedOut(db, event.id, now);
      budget.spend();
      processed++;
      continue;
    }
    const recipients = await notifications.recipientsForCycle(db, event.programCycleId);
    budget.spend();

    const rows: AlertInsert[] = [];
    for (const r of recipients) {
      const draft = draftAlert({ id: event.id, type: event.type, programCycleId: event.programCycleId, payload: event.payload }, facts, r, now);
      if (!draft) continue;
      rows.push({
        type: draft.type,
        userId: r.userId,
        contactId: r.userId ? null : r.contactId,
        programCycleId: event.programCycleId,
        changeEventId: event.id,
        dedupeKey: changeAlertDedupeKey(event.id, draft.type),
        priority: draft.priority,
        title: draft.title,
        body: draft.body,
        href: draft.href,
        scheduledFor: now,
      });
    }

    let complete = true;
    for (let i = 0; i < rows.length; i += RECIPIENT_CHUNK) {
      if (!budget.allows(2)) {
        complete = false;
        break;
      }
      const res = await notifications.insertAlerts(db, rows.slice(i, i + RECIPIENT_CHUNK), now);
      budget.spend(Math.ceil(Math.min(RECIPIENT_CHUNK, rows.length - i) / 6));
      if (!res.ok) {
        // A guard trigger (for example consent revoked mid-run) refused the batch. Insert one by
        // one so the other recipients still get their Alert; the refused rows are skipped.
        log("warn", "alerts.match.batch_refused", { changeEventId: event.id, error: res.error });
        for (const row of rows.slice(i, i + RECIPIENT_CHUNK)) {
          if (!budget.allows(1)) {
            complete = false;
            break;
          }
          await notifications.insertAlerts(db, [row], now);
          budget.spend();
        }
        if (!complete) break;
      }
      alerts += Math.min(RECIPIENT_CHUNK, rows.length - i);
    }
    if (!complete) return { processed, outcome: "partial", detail: { alerts } };
    await notifications.markChangeEventFannedOut(db, event.id, now);
    budget.spend();
    processed++;
  }
  return { processed, outcome: "ok", detail: { alerts } };
}
