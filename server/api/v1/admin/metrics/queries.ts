import { sql, type SQL } from "drizzle-orm";
import type { ANALYTICS_EVENT_NAMES } from "@shared/contracts/api";
import type { Db, EventsDb } from "@server/db/client";
import { WEEK_EPOCH_MS, WEEK_MS } from "./weeks";

/**
 * Aggregate reads for the metrics view. Every query returns counts grouped by a step, a week or
 * a state, never a row about a person: no user id, device id, HMAC, email, program or answer
 * leaves these functions. Suppression happens afterwards in ./build.ts.
 *
 * novus-events (analytics_events): the onboarding funnel and weekly retention. The ingest path
 * (POST /api/v1/events) owns the privacy rules on the way in: no rows for sensitive- or
 * identity-audience programs, nothing under GPC, nothing in minor mode (no consent exists yet).
 * It stores a session-scoped id only (user_hmac is always null), so the funnel actor is a
 * browsing session (rotated after 30 idle minutes) and retention is "not measured" until a
 * keyed actor exists (see README "Gaps").
 *
 * novus-main: Tracker and reminder engagement, the onboarding cross-check and registry
 * freshness. Student rows count only for accounts that are live, have analytics on, are not in
 * minor mode (16-17, no analytics consent exists) and hold no staff role, so founders' and
 * Curators' test accounts never inflate the numbers.
 */

type EventName = (typeof ANALYTICS_EVENT_NAMES)[number];

/**
 * Events that count as a student doing something on purpose (plan 10.10.2 "weekly active"):
 * page views, searches and filter changes are browsing and do not count.
 */
export const ACTIVE_EVENT_NAMES: readonly EventName[] = ["program_view", "apply_click", "tracker_add", "readiness_open", "ai_explain_open", "onboarding_step"];

const num = (v: unknown): number => (v === null || v === undefined ? 0 : Number(v));
/**
 * Week index in SQL. The constants are inlined as integer literals (they are module constants,
 * never input): bound parameters can arrive as REAL, which turns the division fractional. CAST
 * keeps it whole either way (times are after 1970, so truncation is the floor).
 */
const week = (column: SQL) => sql`CAST((${column} - ${sql.raw(String(WEEK_EPOCH_MS))}) / ${sql.raw(String(WEEK_MS))} AS INTEGER)`;

// ---------------------------------------------------------------------------------------------
// novus-events
// ---------------------------------------------------------------------------------------------

export interface IngestCounts {
  eventRows: number;
  onboardingEventRows: number;
  lastEventAt: number | null;
  /**
   * Rows carrying a user HMAC. The ingest writes none today (events are keyed by the session id
   * only, docs/telemetry.md), so retention, which needs a person across weeks, is not measured
   * while this is 0.
   */
  keyedEventRows: number;
}

export async function ingestCounts(edb: EventsDb): Promise<IngestCounts> {
  const rows = await edb.all<{ n: number; onboarding: number | null; keyed: number | null; last: number | null }>(sql`
    SELECT count(*) AS n,
           sum(CASE WHEN name = 'onboarding_step' THEN 1 ELSE 0 END) AS onboarding,
           sum(CASE WHEN user_hmac IS NOT NULL THEN 1 ELSE 0 END) AS keyed,
           max(at) AS last
    FROM analytics_events`);
  const r = rows[0];
  return {
    eventRows: num(r?.n),
    onboardingEventRows: num(r?.onboarding),
    keyedEventRows: num(r?.keyed),
    lastEventAt: r?.last === null || r?.last === undefined ? null : Number(r.last),
  };
}

/**
 * Distinct actors per funnel step, among actors whose first `started` in [from, to) opened the
 * cohort; later steps count from that start onward, whenever they happened. The actor is the
 * device id (onboarding begins before sign-in), else the user HMAC. The device id is the
 * telemetry session id, rotated after 30 idle minutes, so an onboarding that spans two browsing
 * sessions reads as a drop-off in the first and (because the start page sends `started` again
 * when the student picks up) a new start in the second. The funnel is per session, not per
 * person, and undercounts later steps for students who pause. `resume_parsed` counts only
 * a successful on-device parse of an actual resume (`ok` and a source other than `none`).
 */
export async function funnelCounts(edb: EventsDb, from: number, to: number): Promise<Map<string, number>> {
  const rows = await edb.all<{ step: string | null; n: number }>(sql`
    WITH ev AS (
      SELECT coalesce(device_id, user_hmac) AS actor,
             json_extract(props, '$.step') AS step,
             json_extract(props, '$.ok') AS ok,
             json_extract(props, '$.source') AS source,
             at
      FROM analytics_events
      WHERE name = 'onboarding_step' AND coalesce(device_id, user_hmac) IS NOT NULL
    ),
    starters AS (
      SELECT actor, min(at) AS t0 FROM ev
      WHERE step = 'started' AND at >= ${from} AND at < ${to}
      GROUP BY actor
    )
    SELECT ev.step AS step, count(DISTINCT ev.actor) AS n
    FROM ev JOIN starters s ON s.actor = ev.actor
    WHERE ev.at >= s.t0
      AND (ev.step <> 'resume_parsed' OR (ev.ok = 1 AND coalesce(ev.source, 'none') <> 'none'))
    GROUP BY ev.step`);
  const out = new Map<string, number>();
  for (const r of rows) if (typeof r.step === "string") out.set(r.step, num(r.n));
  return out;
}

export interface RetentionRow {
  cohortWeek: number;
  offset: number;
  n: number;
}

/**
 * Weekly retention of signed-in students (user HMAC only, so one person on two devices is one
 * actor). A cohort is the week of the actor's first active event ever; a cohort week counts the
 * actors with any active event in that week. Only cohorts from `firstWeek` on are returned.
 */
export async function retentionRows(edb: EventsDb, firstWeek: number): Promise<RetentionRow[]> {
  const names = sql.join(
    ACTIVE_EVENT_NAMES.map((n) => sql`${n}`),
    sql`, `,
  );
  const rows = await edb.all<{ cohort: number; off: number; n: number }>(sql`
    WITH a AS (
      SELECT user_hmac AS actor, ${week(sql`at`)} AS wk
      FROM analytics_events
      WHERE user_hmac IS NOT NULL AND name IN (${names})
    ),
    f AS (SELECT actor, min(wk) AS w0 FROM a GROUP BY actor)
    SELECT f.w0 AS cohort, a.wk - f.w0 AS off, count(DISTINCT a.actor) AS n
    FROM a JOIN f ON f.actor = a.actor
    WHERE f.w0 >= ${firstWeek}
    GROUP BY f.w0, a.wk - f.w0`);
  return rows.map((r) => ({ cohortWeek: num(r.cohort), offset: num(r.off), n: num(r.n) }));
}

// ---------------------------------------------------------------------------------------------
// novus-main
// ---------------------------------------------------------------------------------------------

/**
 * Accounts whose activity may be counted (alias `u`) at `now`: live, analytics on, no staff role,
 * and not in minor mode. Minor mode matches `adultFrom()` (remind/service.ts) and the events
 * ingest (events/store.ts `viewerAllowsAnalytics`): someone born in YYYY-MM is an adult from the
 * start of the month after that month, 18 years on, so they count only once the current UTC
 * month is later than (YYYY+18)-MM. No analytics consent exists yet (s09 S09-029), so a 16-17
 * year old never counts (plan 9.10.2). A profile without a birth month counts, as at ingest.
 */
export function countedUser(now: number): SQL {
  const nowMonth = new Date(now).toISOString().slice(0, 7);
  return sql`u.deleted_at IS NULL AND u.analytics_off_at IS NULL AND NOT EXISTS (
  SELECT 1 FROM user_roles r WHERE r.user_id = u.id AND r.role <> 'student' AND r.revoked_at IS NULL)
  AND NOT EXISTS (
  SELECT 1 FROM student_profiles p WHERE p.user_id = u.id
    AND p.birth_year_month GLOB '[0-9][0-9][0-9][0-9]-[01][0-9]'
    AND printf('%04d', CAST(substr(p.birth_year_month, 1, 4) AS INTEGER) + 18) || substr(p.birth_year_month, 5, 3) >= ${nowMonth})`;
}

export interface EngagementWeekRow {
  week: number;
  trackerItemsAdded: number;
  studentsAdding: number;
  remindersScheduled: number;
  remindersSent: number;
  remindersCancelled: number;
}

export async function engagementWeeks(db: Db, fromMs: number, now: number): Promise<Map<number, EngagementWeekRow>> {
  const COUNTED_USER = countedUser(now);
  const out = new Map<number, EngagementWeekRow>();
  const row = (wk: number): EngagementWeekRow => {
    let r = out.get(wk);
    if (!r) {
      r = { week: wk, trackerItemsAdded: 0, studentsAdding: 0, remindersScheduled: 0, remindersSent: 0, remindersCancelled: 0 };
      out.set(wk, r);
    }
    return r;
  };

  const tracker = await db.all<{ wk: number; items: number; students: number }>(sql`
    SELECT ${week(sql`t.created_at`)} AS wk, count(*) AS items, count(DISTINCT t.user_id) AS students
    FROM tracker_items t JOIN users u ON u.id = t.user_id
    WHERE t.deleted_at IS NULL AND t.created_at >= ${fromMs} AND ${COUNTED_USER}
    GROUP BY wk`);
  for (const t of tracker) Object.assign(row(num(t.wk)), { trackerItemsAdded: num(t.items), studentsAdding: num(t.students) });

  const scheduled = await db.all<{ wk: number; n: number }>(sql`
    SELECT ${week(sql`m.created_at`)} AS wk, count(*) AS n
    FROM reminders m JOIN users u ON u.id = m.user_id
    WHERE m.created_at >= ${fromMs} AND ${COUNTED_USER}
    GROUP BY wk`);
  for (const s of scheduled) row(num(s.wk)).remindersScheduled = num(s.n);

  const sent = await db.all<{ wk: number; n: number }>(sql`
    SELECT ${week(sql`m.sent_at`)} AS wk, count(*) AS n
    FROM reminders m JOIN users u ON u.id = m.user_id
    WHERE m.state = 'sent' AND m.sent_at IS NOT NULL AND m.sent_at >= ${fromMs} AND ${COUNTED_USER}
    GROUP BY wk`);
  for (const s of sent) row(num(s.wk)).remindersSent = num(s.n);

  const cancelled = await db.all<{ wk: number; n: number }>(sql`
    SELECT ${week(sql`m.updated_at`)} AS wk, count(*) AS n
    FROM reminders m JOIN users u ON u.id = m.user_id
    WHERE m.state = 'cancelled' AND m.updated_at >= ${fromMs} AND ${COUNTED_USER}
    GROUP BY wk`);
  for (const s of cancelled) row(num(s.wk)).remindersCancelled = num(s.n);
  return out;
}

export interface TrackerSnapshot {
  byStatus: Map<string, number>;
  studentsTracking: number;
  studentsWithUpcomingReminder: number;
  reminded: { items: number; progressed: number };
  unreminded: { items: number; progressed: number };
}

/** The live Tracker now: items by status, and whether a sent reminder goes with progress. */
export async function trackerSnapshot(db: Db, now: number): Promise<TrackerSnapshot> {
  const todayIso = new Date(now).toISOString().slice(0, 10);
  const COUNTED_USER = countedUser(now);
  const status = await db.all<{ status: string; n: number }>(sql`
    SELECT t.status AS status, count(*) AS n
    FROM tracker_items t JOIN users u ON u.id = t.user_id
    WHERE t.deleted_at IS NULL AND ${COUNTED_USER}
    GROUP BY t.status`);
  const students = await db.all<{ n: number }>(sql`
    SELECT count(DISTINCT t.user_id) AS n
    FROM tracker_items t JOIN users u ON u.id = t.user_id
    WHERE t.deleted_at IS NULL AND ${COUNTED_USER}`);
  const upcoming = await db.all<{ n: number }>(sql`
    SELECT count(DISTINCT m.user_id) AS n
    FROM reminders m JOIN users u ON u.id = m.user_id
    WHERE m.state = 'scheduled' AND m.send_on >= ${todayIso} AND ${COUNTED_USER}`);
  const split = await db.all<{ reminded: number; items: number; progressed: number }>(sql`
    SELECT (EXISTS (SELECT 1 FROM reminders m WHERE m.tracker_item_id = t.id AND m.state = 'sent')) AS reminded,
           count(*) AS items,
           sum(CASE WHEN t.status IN ('applying', 'submitted', 'decided') THEN 1 ELSE 0 END) AS progressed
    FROM tracker_items t JOIN users u ON u.id = t.user_id
    WHERE t.deleted_at IS NULL AND ${COUNTED_USER}
    GROUP BY reminded`);
  const part = (flag: number) => {
    const r = split.find((s) => num(s.reminded) === flag);
    return { items: num(r?.items), progressed: num(r?.progressed) };
  };
  return {
    byStatus: new Map(status.map((s) => [s.status, num(s.n)])),
    studentsTracking: num(students[0]?.n),
    studentsWithUpcomingReminder: num(upcoming[0]?.n),
    reminded: part(1),
    unreminded: part(0),
  };
}

export interface OnboardingRecordCounts {
  records: number;
  quizSaved: number;
  firstDoorChosen: number;
  completed: number;
}

/** Server-side cross-check of the funnel: onboarding records opened in [from, to), counted as of `now`. */
export async function onboardingRecordCounts(db: Db, from: number, to: number, now: number = to): Promise<OnboardingRecordCounts> {
  const COUNTED_USER = countedUser(now);
  const rows = await db.all<{ records: number; quiz: number | null; door: number | null; done: number | null }>(sql`
    SELECT count(*) AS records,
           sum(CASE WHEN o.preferences IS NOT NULL THEN 1 ELSE 0 END) AS quiz,
           sum(CASE WHEN o.first_door IS NOT NULL THEN 1 ELSE 0 END) AS door,
           sum(CASE WHEN o.completed_at IS NOT NULL THEN 1 ELSE 0 END) AS done
    FROM onboarding_records o JOIN users u ON u.id = o.user_id
    WHERE o.deleted_at IS NULL AND o.created_at >= ${from} AND o.created_at < ${to} AND ${COUNTED_USER}`);
  const r = rows[0];
  return { records: num(r?.records), quizSaved: num(r?.quiz), firstDoorChosen: num(r?.door), completed: num(r?.done) };
}

export interface ProgramVerification {
  isSample: boolean;
  /** Latest Curator verification over the program's verified cycles, epoch ms. */
  lastVerifiedAt: number | null;
}

/** One row per published, active program (registry data, not about students). */
export async function programVerifications(db: Db): Promise<ProgramVerification[]> {
  const rows = await db.all<{ sample: number; last: number | null }>(sql`
    SELECT p.is_sample AS sample,
           max(CASE WHEN c.verification_state IN ('verified', 'reverifying') THEN c.last_verified_at END) AS last
    FROM programs p LEFT JOIN program_cycles c ON c.program_id = p.id
    WHERE p.is_published = 1 AND p.lifecycle = 'active'
    GROUP BY p.id`);
  return rows.map((r) => ({ isSample: num(r.sample) === 1, lastVerifiedAt: r.last === null || r.last === undefined ? null : Number(r.last) }));
}
