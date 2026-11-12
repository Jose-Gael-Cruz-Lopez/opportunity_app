import { eq, sql } from "drizzle-orm";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { chunked, rowsPerInsert } from "../util";
import { classifyWriteError, ok, runBatch, type RepoResult, type Stmt } from "./common";

/**
 * Onboarding records, reminders and the roadmap rows first door writes. The record holds the
 * quiz answers and confirmed resume signals as JSON documents in the shared onboarding
 * vocabulary; callers validate them with the shared zod schemas on both sides of this module, so
 * nothing here interprets them. No resume text, no SensitiveAnswer and no score ever reaches
 * these tables (schema.test.ts checks the column names).
 */

export interface OnboardingRow {
  readonly preferences: unknown;
  readonly signals: unknown;
  readonly step: string | null;
  readonly completedAt: number | null;
  readonly firstDoor: unknown;
  readonly updatedAt: number;
}

export interface OnboardingWrite {
  readonly preferences: Record<string, unknown> | null;
  readonly signals: Record<string, unknown> | null;
  readonly step: string | null;
  readonly completedAt: number | null;
  readonly firstDoor: Record<string, unknown> | null;
}

export async function getOnboardingRecord(db: Db, userId: string): Promise<OnboardingRow | null> {
  const row = await db.query.onboardingRecords.findFirst({ where: eq(s.onboardingRecords.userId, userId) });
  if (!row || row.deletedAt !== null) return null;
  return {
    preferences: row.preferences ?? null,
    signals: row.signals ?? null,
    step: row.step,
    completedAt: row.completedAt,
    firstDoor: row.firstDoor ?? null,
    updatedAt: row.updatedAt,
  };
}

/** Insert or replace the student's record (last write wins; the record is the student's own). */
export async function saveOnboardingRecord(db: Db, userId: string, record: OnboardingWrite, now: number): Promise<void> {
  const values = {
    preferences: record.preferences,
    signals: record.signals,
    step: record.step,
    completedAt: record.completedAt,
    firstDoor: record.firstDoor,
  };
  await db
    .insert(s.onboardingRecords)
    .values({ userId, ...values, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: s.onboardingRecords.userId,
      set: { ...values, deletedAt: null, updatedAt: now, version: sql`${s.onboardingRecords.version} + 1` },
    });
}

export interface ReminderWrite {
  readonly key: string;
  readonly trackerItemId: string;
  readonly kind: (typeof s.REMINDER_KINDS)[number];
  readonly stepId: string;
  readonly sendOn: string;
  readonly at: string;
  readonly timeZone: string;
  readonly neutral: boolean;
}

/**
 * Upserts reminders by (user, key), so retrying first door never duplicates them. A reminder that
 * was already sent keeps its state; a cancelled one is scheduled again (the student re-chose it).
 */
export async function scheduleReminders(db: Db, userId: string, items: readonly ReminderWrite[], now: number): Promise<void> {
  if (items.length === 0) return;
  const rows = items.map((r) => ({
    id: uuidv7(now),
    userId,
    reminderKey: r.key,
    trackerItemId: r.trackerItemId,
    kind: r.kind,
    stepId: r.stepId,
    sendOn: r.sendOn,
    sendAt: r.at.slice(0, 5),
    timeZone: r.timeZone,
    neutral: r.neutral,
    createdAt: now,
    updatedAt: now,
  }));
  const statements: Stmt[] = [];
  for (const chunk of chunked(rows, rowsPerInsert(14))) {
    statements.push(
      db
        .insert(s.reminders)
        .values(chunk)
        .onConflictDoUpdate({
          target: [s.reminders.userId, s.reminders.reminderKey],
          set: {
            sendOn: sql`excluded.send_on`,
            sendAt: sql`excluded.send_at`,
            timeZone: sql`excluded.time_zone`,
            neutral: sql`excluded.neutral`,
            trackerItemId: sql`excluded.tracker_item_id`,
            state: sql`CASE WHEN ${s.reminders.state} = 'sent' THEN 'sent' ELSE 'scheduled' END`,
            updatedAt: now,
          },
        }),
    );
  }
  await runBatch(db, statements);
}

export async function listReminders(db: Db, userId: string) {
  return db.select().from(s.reminders).where(eq(s.reminders.userId, userId));
}

export interface RoadmapRowWrite {
  readonly itemKey: string;
  readonly programId: string | null;
  readonly pinned: boolean;
  readonly state: "open" | "done";
}

/**
 * Upserts roadmap action rows for first door's plan. A retry never undoes what the student did
 * since: a done item stays done and a pin stays pinned. The audience trigger refuses rows for
 * status-defined programs (no roadmap actions on them at all); that is reported as
 * consent_required and nothing is written.
 */
export async function upsertRoadmapRows(db: Db, userId: string, items: readonly RoadmapRowWrite[], now: number): Promise<RepoResult<true>> {
  if (items.length === 0) return ok(true);
  const rows = items.map((i) => ({ userId, itemKey: i.itemKey, programId: i.programId, pinned: i.pinned, state: i.state, createdAt: now, updatedAt: now }));
  const statements: Stmt[] = [];
  for (const chunk of chunked(rows, rowsPerInsert(7))) {
    statements.push(
      db
        .insert(s.roadmapItems)
        .values(chunk)
        .onConflictDoUpdate({
          target: [s.roadmapItems.userId, s.roadmapItems.itemKey],
          set: {
            pinned: sql`(${s.roadmapItems.pinned} OR excluded.pinned)`,
            state: sql`CASE WHEN excluded.state = 'done' OR ${s.roadmapItems.state} = 'done' THEN 'done' WHEN ${s.roadmapItems.deletedAt} IS NOT NULL THEN excluded.state ELSE ${s.roadmapItems.state} END`,
            programId: sql`excluded.program_id`,
            deletedAt: null,
            updatedAt: now,
          },
        }),
    );
  }
  try {
    await runBatch(db, statements);
  } catch (err) {
    return classifyWriteError(err);
  }
  return ok(true);
}
