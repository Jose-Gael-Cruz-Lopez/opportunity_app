import { drizzle, type DrizzleD1Database } from "drizzle-orm/d1";
import * as schema from "./schema";
import * as eventsSchema from "./events-schema";

/**
 * Typed Drizzle clients over the D1 bindings. Only `server/db/repos` should run queries, so a
 * driver swap (Plan B: Turso/libSQL) stays local to this folder.
 */

export type Schema = typeof schema;
export type EventsSchema = typeof eventsSchema;
export type Db = DrizzleD1Database<Schema>;
export type EventsDb = DrizzleD1Database<EventsSchema>;

/** `novus-main` (binding `DB`). */
export function getDb(d1: D1Database): Db {
  return drizzle(d1, { schema });
}

/** `novus-events` (binding `EVENTS_DB`). */
export function getEventsDb(d1: D1Database): EventsDb {
  return drizzle(d1, { schema: eventsSchema });
}

export { schema, eventsSchema };
