import { runRemindersSchedule } from "@server/services/reminders";
import type { HandlerResult, JobContext } from "../types";

/**
 * `reminders.schedule` (hourly slot, registry priority 1): T−2 reminders, "confirm your campus
 * deadline now" and first-door plan steps become `deadline.reminder` Alerts at their send
 * instant; notify.dispatch sends them on the tick. See server/services/reminders.
 *
 * Register: HANDLERS["reminders.schedule"] = remindersSchedule, and `implemented: true` in
 * server/jobs/registry.ts.
 */
export async function remindersSchedule(ctx: JobContext): Promise<HandlerResult> {
  return runRemindersSchedule({ db: ctx.db, now: ctx.now, budget: ctx.budget, log: ctx.log });
}
