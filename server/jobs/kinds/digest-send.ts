import { providerFor } from "@server/services/email/provider";
import { runDigestSend } from "@server/services/reminders";
import type { HandlerResult, JobContext } from "../types";

/**
 * `digest.send` (hourly slot, registry priority 4): the weekly email at each recipient's local
 * hour on their weekly day, with one-click unsubscribe for the weekly list. Idempotent per
 * recipient and ISO week. See server/services/reminders.
 *
 * Register: HANDLERS["digest.send"] = digestSend, and `implemented: true` in
 * server/jobs/registry.ts.
 */
export async function digestSend(ctx: JobContext): Promise<HandlerResult> {
  return runDigestSend({
    db: ctx.db,
    edb: ctx.edb,
    provider: providerFor(ctx.env, ctx.log),
    appOrigin: ctx.env.APP_ORIGIN ?? "http://localhost:8787",
    secret: ctx.env.BETTER_AUTH_SECRET ?? null,
    now: ctx.now,
    budget: ctx.budget,
    log: ctx.log,
  });
}
