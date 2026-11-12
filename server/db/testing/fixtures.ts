/**
 * TEST ONLY. Fresh in-memory databases with the committed migrations applied, optionally with
 * the sample seed, plus small row factories.
 */
import { getDb, getEventsDb, type Db, type EventsDb } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { buildSampleSeed, type SampleSeed } from "../seed/build";
import { renderSeedSql } from "../seed/statements";
import { createTestEventsDb, createTestMainDb, type SqliteD1 } from "./sqlite-d1";

// `import.meta.url` exists in Node (vitest); the Workers ImportMeta type does not declare it.
const moduleUrl = (import.meta as unknown as { url: string }).url;
export const REPO_ROOT = decodeURIComponent(new URL("../../../", moduleUrl).pathname).replace(/\/$/, "");

export interface TestDb {
  raw: SqliteD1;
  db: Db;
}

export async function freshDb(): Promise<TestDb> {
  const raw = await createTestMainDb(REPO_ROOT);
  return { raw, db: getDb(raw.d1) };
}

export async function seededDb(today = "2026-11-11"): Promise<TestDb & { seed: SampleSeed }> {
  const t = await freshDb();
  const seed = await buildSampleSeed(today);
  t.raw.exec(renderSeedSql(seed));
  return { ...t, seed };
}

export async function freshEventsDb(): Promise<{ raw: SqliteD1; edb: EventsDb }> {
  const raw = await createTestEventsDb(REPO_ROOT);
  return { raw, edb: getEventsDb(raw.d1) };
}

export async function createUser(db: Db, email = `${uuidv7()}@example.org`): Promise<string> {
  const id = uuidv7();
  await db.insert(s.users).values({ id, email, name: "Test student" });
  return id;
}
