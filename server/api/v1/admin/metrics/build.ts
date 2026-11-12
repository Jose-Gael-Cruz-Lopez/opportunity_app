import { ONBOARDING_FUNNEL, type OnboardingFunnelStep } from "@shared/onboarding/analytics";
import { TRACKER_STATUSES } from "@shared/taxonomy";
import type { EngagementWeekRow, IngestCounts, OnboardingRecordCounts, ProgramVerification, RetentionRow, TrackerSnapshot } from "./queries";
import type { AdminMetricsView, FreshnessSlice } from "./schemas";
import { cell, HIDDEN, K_MIN, partition, rate, type Cell } from "./suppress";
import { DAY_MS, weekIndex, weekStartDate } from "./weeks";

/**
 * Turns raw aggregates into the view the console shows. Pure: the clock and every count are
 * inputs, and every student-derived number passes through ./suppress.ts on the way out.
 */

export const FRESHNESS_WINDOW_DAYS = 30;
export const FRESHNESS_TARGET_MEDIAN_DAYS = 14;
/** Optional steps: a student can reach matches without a resume. */
const OPTIONAL_STEPS: ReadonlySet<OnboardingFunnelStep> = new Set(["resume_parsed"]);

export interface MetricsInputs {
  now: number;
  days: number;
  weeks: number;
  eventsDb: "ok" | "unbound";
  ingest: IngestCounts;
  funnel: Map<string, number>;
  onboardingRecords: OnboardingRecordCounts;
  retention: RetentionRow[];
  engagement: Map<number, EngagementWeekRow>;
  tracker: TrackerSnapshot;
  programs: ProgramVerification[];
}

export interface MetricsWindow {
  /** Funnel cohort window [from, to): the `days` x 24 hours up to now. */
  from: number;
  to: number;
  /** First week index of the retention and engagement series (current week included). */
  firstWeek: number;
  currentWeek: number;
}

export function metricsWindow(now: number, days: number, weeks: number): MetricsWindow {
  const currentWeek = weekIndex(now);
  return { from: now - days * DAY_MS, to: now, firstWeek: currentWeek - (weeks - 1), currentWeek };
}

const isoDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export function buildFunnel(counts: Map<string, number>): AdminMetricsView["funnel"]["steps"] {
  const cells = ONBOARDING_FUNNEL.map((step) => cell(counts.get(step) ?? 0));
  const start = cells[0] ?? HIDDEN;
  let previous: Cell = start;
  return ONBOARDING_FUNNEL.map((step, i) => {
    const actors = cells[i] ?? HIDDEN;
    const optional = OPTIONAL_STEPS.has(step);
    const out = { step, actors, optional, fromPrevious: i === 0 ? null : rate(actors, previous), fromStart: i === 0 ? null : rate(actors, start) };
    // The step after an optional one compares with the last required step.
    if (!optional) previous = actors;
    return out;
  });
}

export function buildRetention(rows: readonly RetentionRow[], w: MetricsWindow, measured = true): AdminMetricsView["retention"] {
  // No keyed actor exists, so there is nothing to measure: not a row of zeros that reads as churn.
  if (!measured) return { measured: false, cohorts: [] };
  const cohorts: AdminMetricsView["retention"]["cohorts"] = [];
  for (let cohort = w.firstWeek; cohort <= w.currentWeek; cohort++) {
    const mine = rows.filter((r) => r.cohortWeek === cohort);
    const sizeN = mine.find((r) => r.offset === 0)?.n ?? 0;
    const size = cell(sizeN);
    const weeks: AdminMetricsView["retention"]["cohorts"][number]["weeks"] = [];
    for (let offset = 0; cohort + offset <= w.currentWeek; offset++) {
      // A cohort too small to show hides every week, so its weeks cannot be read as a cohort.
      const actors = size.hidden ? HIDDEN : cell(mine.find((r) => r.offset === offset)?.n ?? 0);
      weeks.push({ offset, actors, rate: rate(actors, size), partial: cohort + offset === w.currentWeek });
    }
    cohorts.push({ weekStart: weekStartDate(cohort), size, weeks });
  }
  return { measured: true, cohorts };
}

function pairCells(a: number, b: number): [Cell, Cell] {
  const p = partition([
    { key: "a", n: a },
    { key: "b", n: b },
  ]);
  return [p.cells[0]!.count, p.cells[1]!.count];
}

export function buildEngagement(rows: Map<number, EngagementWeekRow>, tracker: TrackerSnapshot, w: MetricsWindow): AdminMetricsView["engagement"] {
  const weeks: AdminMetricsView["engagement"]["weeks"] = [];
  for (let wk = w.firstWeek; wk <= w.currentWeek; wk++) {
    const r = rows.get(wk);
    weeks.push({
      weekStart: weekStartDate(wk),
      partial: wk === w.currentWeek,
      trackerItemsAdded: cell(r?.trackerItemsAdded ?? 0),
      studentsAdding: cell(r?.studentsAdding ?? 0),
      remindersScheduled: cell(r?.remindersScheduled ?? 0),
      remindersSent: cell(r?.remindersSent ?? 0),
      remindersCancelled: cell(r?.remindersCancelled ?? 0),
    });
  }
  // Reminded and unreminded items add up to the Tracker total shown above, and their progressed
  // counts add up to the applying-or-later statuses, so each pair is released as a partition.
  const [remindedItems, unremindedItems] = pairCells(tracker.reminded.items, tracker.unreminded.items);
  const [remindedProgressed, unremindedProgressed] = pairCells(tracker.reminded.progressed, tracker.unreminded.progressed);
  return {
    weeks,
    studentsTracking: cell(tracker.studentsTracking),
    studentsWithUpcomingReminder: cell(tracker.studentsWithUpcomingReminder),
    trackerStatus: partition(TRACKER_STATUSES.map((key) => ({ key, n: tracker.byStatus.get(key) ?? 0 }))),
    remindedItems: { items: remindedItems, progressed: remindedProgressed, rate: rate(remindedProgressed, remindedItems) },
    unremindedItems: { items: unremindedItems, progressed: unremindedProgressed, rate: rate(unremindedProgressed, unremindedItems) },
  };
}

export function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const m = sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
  return Math.round(m * 10) / 10;
}

const BUCKETS = [
  { key: "0-7", max: 7 },
  { key: "8-14", max: 14 },
  { key: "15-30", max: 30 },
  { key: "31-90", max: 90 },
  { key: "90+", max: Number.POSITIVE_INFINITY },
] as const;

/** Registry freshness: programs, not students, so counts are exact. */
export function freshnessSlice(programs: readonly ProgramVerification[], now: number): FreshnessSlice {
  const ages = programs.filter((p) => p.lastVerifiedAt !== null).map((p) => Math.max(0, (now - (p.lastVerifiedAt as number)) / DAY_MS));
  const neverVerified = programs.length - ages.length;
  const verifiedWithinWindow = ages.filter((a) => a <= FRESHNESS_WINDOW_DAYS).length;
  const ageBuckets: FreshnessSlice["ageBuckets"] = BUCKETS.map((b, i) => ({
    key: b.key,
    n: ages.filter((a) => a <= b.max && (i === 0 || a > BUCKETS[i - 1]!.max)).length,
  }));
  ageBuckets.push({ key: "never", n: neverVerified });
  return {
    published: programs.length,
    verifiedWithinWindow,
    share: programs.length === 0 ? null : Math.round((verifiedWithinWindow / programs.length) * 1000) / 1000,
    neverVerified,
    medianDaysSinceVerification: median(ages),
    ageBuckets,
  };
}

export function buildMetricsView(input: MetricsInputs): AdminMetricsView {
  const w = metricsWindow(input.now, input.days, input.weeks);
  const rec = input.onboardingRecords;
  return {
    generatedAt: new Date(input.now).toISOString(),
    k: K_MIN,
    window: { days: input.days, weeks: input.weeks, from: isoDay(w.from), to: isoDay(w.to), firstWeek: weekStartDate(w.firstWeek) },
    ingest: {
      eventsDb: input.eventsDb,
      eventRows: input.ingest.eventRows,
      onboardingEventRows: input.ingest.onboardingEventRows,
      lastEventAt: input.ingest.lastEventAt === null ? null : new Date(input.ingest.lastEventAt).toISOString(),
    },
    funnel: {
      steps: buildFunnel(input.funnel),
      serverRecorded: { records: cell(rec.records), quizSaved: cell(rec.quizSaved), firstDoorChosen: cell(rec.firstDoorChosen), completed: cell(rec.completed) },
    },
    retention: buildRetention(input.retention, w, input.eventsDb === "ok" && input.ingest.keyedEventRows > 0),
    engagement: buildEngagement(input.engagement, input.tracker, w),
    freshness: {
      windowDays: FRESHNESS_WINDOW_DAYS,
      targetMedianDays: FRESHNESS_TARGET_MEDIAN_DAYS,
      real: freshnessSlice(
        input.programs.filter((p) => !p.isSample),
        input.now,
      ),
      sample: freshnessSlice(
        input.programs.filter((p) => p.isSample),
        input.now,
      ),
    },
  };
}
