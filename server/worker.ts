import { createApp } from "./app";
import type { Env } from "./env";
import { runScheduled } from "./jobs";
import { rootLogger } from "./lib/log";
import { errorClassOf } from "./middleware/error-handler";

/**
 * Worker entry: `fetch` serves every route through one Hono app (built once per isolate), and
 * `scheduled` runs the Cron Triggers (5-minute tick, hourly, daily) through server/jobs.
 */
const app = createApp();

export default {
  fetch(request, env, ctx) {
    return app.fetch(request, env, ctx);
  },

  async scheduled(controller, env, ctx) {
    try {
      await runScheduled(controller, env, ctx);
    } catch (err) {
      // Logged without content and rethrown, so the invocation is marked failed and retried by
      // the next tick (jobs keep their attempts).
      rootLogger().error("scheduled_failed", { cron: controller.cron, errorClass: errorClassOf(err) });
      throw err;
    }
  },
} satisfies ExportedHandler<Env>;
