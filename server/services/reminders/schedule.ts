import type { Db } from "@server/db/client";
import type { AlertInsert } from "@server/db/repos/notifications";
import type { Budget } from "@server/jobs/budget";
import type { HandlerResult, Logger } from "@server/jobs/types";
import { recipientContext } from "./context";
import { planCycleReminders, planStepReminder, type CycleInfo, type RecipientContext, type ReminderDraft } from "./plan";
import { isoWeekKey } from "./policy";
import {
  dueStepReminders,
  existingDedupeKeys,
  insertReminderAlerts,
  loadAudience,
  loadCycleInfos,
  loadUserSettings,
  markStepReminders,
  stepTitleFrom,
  weeklyStates,
} from "./store";

/**
 * `reminders.schedule` (hourly; plan 6.7.1-6.7.2, s02 2.3.7). Each run:
 *   1. plans T−2 and "confirm your campus deadline" reminders for every followed cycle and writes
 *      the due ones as `deadline.reminder` Alerts, scheduled at their exact send instant;
 *   2. turns due first-door plan steps (`reminders` rows) into Alerts and marks them sent, or
 *      cancels them once the application is submitted, decided or dropped.
 * notify.dispatch then sends them on the tick with every send-time rule (preferences, exam pause,
 * quiet hours, quota, suppression, one-click unsubscribe, expiry at the deadline).
 * Idempotent: Alerts dedupe on (recipient, key), keys carry the deadline and its date, so a
 * re-run, a duplicated cron or a catch-up writes nothing twice. Logs carry counts only.
 */

export interface ReminderJobDeps {
  readonly db: Db;
  readonly now: () => number;
  readonly budget: Budget;
  readonly log: Logger;
}

/** Alerts per insert round (15 columns, 6 rows per statement under D1's parameter limit). */
const INSERT_CHUNK = 120;
const STEP_LIMIT = 500;
/**
 * Reminder keys are only re-planned while due (at most a few days before a deadline), so only
 * recent Alerts can collide; older ones are left out of the pre-check (inserts still dedupe).
 */
const EXISTING_WINDOW_MS = 14 * 86_400_000;
/**
 * How long a merged T−2 waits for the weekly email after its send instant before it goes on its
 * own. digest.send runs hourly, so two runs fit; late, but never lost.
 */
export const MERGE_GRACE_MS = 2 * 3_600_000;

function toAlert(ctx: RecipientContext, d: ReminderDraft): AlertInsert {
  return {
    type: "deadline.reminder",
    userId: ctx.userId,
    contactId: ctx.userId ? null : ctx.contactId,
    programCycleId: d.programCycleId || null,
    dedupeKey: d.dedupeKey,
    priority: "p1",
    title: d.title,
    body: d.body,
    href: d.href,
    scheduledFor: d.scheduledFor,
  };
}

export async function runRemindersSchedule(deps: ReminderJobDeps): Promise<HandlerResult> {
  const { db, budget, log } = deps;
  if (!budget.allows(8)) return { processed: 0, outcome: "partial" };
  const now = deps.now();

  const audience = await loadAudience(db);
  budget.spend();
  const steps = await dueStepReminders(db, new Date(now + 2 * 86_400_000).toISOString().slice(0, 10), STEP_LIMIT);
  budget.spend();
  const userIds = [...new Set([...audience.flatMap((a) => (a.userId ? [a.userId] : [])), ...steps.map((st) => st.userId)])];
  const settings = await loadUserSettings(db, userIds);
  budget.spend();
  const cycleIds = [...new Set([...audience.flatMap((a) => a.followed.map((f) => f.cycleId)), ...steps.flatMap((st) => (st.cycleId ? [st.cycleId] : []))])];
  const infos = await loadCycleInfos(db, cycleIds);
  budget.spend(3);
  const recipientKeys = audience.map((a) => a.recipientKey);
  const existing = await existingDedupeKeys(db, recipientKeys, ["t2:", "campus:"], now - EXISTING_WINDOW_MS);
  budget.spend();

  // ---- 1. Deadline reminders --------------------------------------------------------------
  const contexts = new Map<string, RecipientContext>();
  const planned: { ctx: RecipientContext; draft: ReminderDraft }[] = [];
  for (const row of audience) {
    const ctx = recipientContext(row, row.userId ? settings.get(row.userId) : undefined);
    contexts.set(row.recipientKey, ctx);
    for (const followed of row.followed) {
      const info = infos.get(followed.cycleId);
      if (!info) continue;
      for (const draft of planCycleReminders(ctx, followed, info, now)) {
        if (existing.has(`${ctx.recipientKey}|${draft.dedupeKey}`)) continue;
        planned.push({ ctx, draft });
      }
    }
  }

  // A T−2 on the weekly day rides in the weekly email. digest.send records each T−2 it carried as
  // an Alert under the T−2's own key (so `existing` above already skips those). Any other merged
  // T−2 waits only while that email can still carry it: its record is missing or queued and the
  // send instant is less than MERGE_GRACE_MS behind. Otherwise (the email went without it,
  // failed, expired or never came) the reminder goes on its own rather than not at all.
  const mergedWeeks = [...new Set(planned.filter((p) => p.draft.merged).map((p) => isoWeekKey(p.draft.localDate)))];
  const states = mergedWeeks.length > 0 ? await weeklyStates(db, [...new Set(planned.filter((p) => p.draft.merged).map((p) => p.ctx.recipientKey))], mergedWeeks) : new Map<string, string>();
  if (mergedWeeks.length > 0) budget.spend();
  const rows: AlertInsert[] = [];
  let merged = 0;
  for (const { ctx, draft } of planned) {
    if (draft.merged) {
      const state = states.get(`${ctx.recipientKey}|${isoWeekKey(draft.localDate)}`);
      const waiting = (state === undefined || state === "queued") && now < draft.scheduledFor + MERGE_GRACE_MS;
      if (waiting) {
        merged++;
        continue;
      }
    }
    rows.push(toAlert(ctx, draft));
  }

  let written = 0;
  let partial = false;
  for (let i = 0; i < rows.length; i += INSERT_CHUNK) {
    const chunk = rows.slice(i, i + INSERT_CHUNK);
    if (!budget.allows(Math.ceil(chunk.length / 6) + 1)) {
      partial = true;
      break;
    }
    written += await insertReminderAlerts(db, chunk, now);
    budget.spend(Math.ceil(chunk.length / 6));
  }

  // ---- 2. First-door plan steps -------------------------------------------------------------
  const stepAlerts: AlertInsert[] = [];
  const stepUpdates: { id: string; state: "sent" | "cancelled" }[] = [];
  const missingInfo = steps.filter((st) => st.cycleId && !infos.has(st.cycleId)).length;
  for (const st of steps) {
    const ctx =
      contexts.get(`u:${st.userId}`) ?? recipientContext({ recipientKey: `u:${st.userId}`, userId: st.userId, contactId: null }, settings.get(st.userId));
    const info: CycleInfo | null = st.cycleId ? (infos.get(st.cycleId) ?? null) : null;
    const decision = planStepReminder(
      st.row,
      { recipient: ctx, trackerStatus: st.trackerStatus, stepTitle: stepTitleFrom(st.firstDoor, st.row.stepId), info, nameInMessages: st.nameInMessages },
      now,
    );
    if (decision.action === "wait") continue;
    if (decision.action === "cancel") {
      stepUpdates.push({ id: st.row.id, state: "cancelled" });
      continue;
    }
    // The tracked cycle, even when unpublished since: the unsubscribe link names it.
    stepAlerts.push(toAlert(ctx, { ...decision.draft, programCycleId: st.cycleId ?? decision.draft.programCycleId }));
    stepUpdates.push({ id: st.row.id, state: "sent" });
  }
  if (stepAlerts.length + stepUpdates.length > 0) {
    if (budget.allows(Math.ceil(stepAlerts.length / 6) + 2)) {
      for (let i = 0; i < stepAlerts.length; i += INSERT_CHUNK) written += await insertReminderAlerts(db, stepAlerts.slice(i, i + INSERT_CHUNK), now);
      // Marked after the Alerts exist: a crash in between re-plans the same dedupe keys next hour.
      await markStepReminders(db, stepUpdates, now);
      budget.spend(Math.ceil(stepAlerts.length / 6) + 1);
    } else {
      partial = true;
    }
  }

  const detail = {
    recipients: audience.length,
    planned: rows.length,
    merged,
    written,
    steps: stepUpdates.length,
    missingCycles: missingInfo,
  };
  if (written > 0 || partial) log("info", "reminders.schedule", detail);
  return { processed: written, outcome: partial ? "partial" : "ok", detail };
}
