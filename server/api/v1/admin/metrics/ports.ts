import type { Context } from "hono";
import type { Db, EventsDb } from "@server/db/client";
import type { AppEnv, SessionUser } from "@server/env";

/** What the metrics route needs from outside; index.ts wires the bindings, tests pass SQLite. */
export interface MetricsDeps {
  db(c: Context<AppEnv>): Db;
  /** novus-events; null when the binding is missing, and the event-based sections read empty. */
  eventsDb(c: Context<AppEnv>): EventsDb | null;
  user(c: Context<AppEnv>): SessionUser | undefined;
  now(): number;
  /** ENVIRONMENT var: staging and production serve this only on the console surface (curate.). */
  environment(c: Context<AppEnv>): string;
}
