import { request, type FetchLike } from "../api";

/**
 * Client for GET /api/v1/admin/metrics. The shapes mirror
 * server/api/v1/admin/metrics/schemas.ts (metrics.test.ts parses the fixture with the server's
 * schema, so a drift fails the build). Every student-derived count is a Cell: `n` is null when
 * the server hid it (1 to 4 people).
 */

export interface Cell {
  n: number | null;
  hidden: boolean;
}

export type Rate = number | null;

export const FUNNEL_STEPS = ["started", "quiz_completed", "resume_parsed", "matches_shown", "first_door_chosen", "first_step_done", "tracker_created"] as const;
export type FunnelStep = (typeof FUNNEL_STEPS)[number];

export interface Partition {
  total: Cell;
  cells: { key: string; count: Cell }[];
}

export interface FreshnessSlice {
  published: number;
  verifiedWithinWindow: number;
  share: Rate;
  neverVerified: number;
  medianDaysSinceVerification: number | null;
  ageBuckets: { key: "0-7" | "8-14" | "15-30" | "31-90" | "90+" | "never"; n: number }[];
}

export interface ItemSplit {
  items: Cell;
  progressed: Cell;
  rate: Rate;
}

export interface AdminMetricsView {
  generatedAt: string;
  k: 5;
  window: { days: number; weeks: number; from: string; to: string; firstWeek: string };
  ingest: { eventsDb: "ok" | "unbound"; eventRows: number; onboardingEventRows: number; lastEventAt: string | null };
  funnel: {
    steps: { step: FunnelStep; actors: Cell; optional: boolean; fromPrevious: Rate; fromStart: Rate }[];
    serverRecorded: { records: Cell; quizSaved: Cell; firstDoorChosen: Cell; completed: Cell };
  };
  /** `measured` is false while no event carries a keyed actor; cohorts are then empty. */
  retention: { measured: boolean; cohorts: { weekStart: string; size: Cell; weeks: { offset: number; actors: Cell; rate: Rate; partial: boolean }[] }[] };
  engagement: {
    weeks: {
      weekStart: string;
      partial: boolean;
      trackerItemsAdded: Cell;
      studentsAdding: Cell;
      remindersScheduled: Cell;
      remindersSent: Cell;
      remindersCancelled: Cell;
    }[];
    studentsTracking: Cell;
    studentsWithUpcomingReminder: Cell;
    trackerStatus: Partition;
    remindedItems: ItemSplit;
    unremindedItems: ItemSplit;
  };
  freshness: { windowDays: 30; targetMedianDays: 14; real: FreshnessSlice; sample: FreshnessSlice };
}

export const METRICS_DAYS = [7, 28, 90] as const;
export const METRICS_WEEKS = [4, 8, 12, 26] as const;
export type MetricsDays = (typeof METRICS_DAYS)[number];
export type MetricsWeeks = (typeof METRICS_WEEKS)[number];

export function metricsPath(days: MetricsDays, weeks: MetricsWeeks): string {
  return `/api/v1/admin/metrics?${new URLSearchParams({ days: String(days), weeks: String(weeks) }).toString()}`;
}

export function createMetricsApi(fetcher?: FetchLike) {
  return {
    metrics: (days: MetricsDays, weeks: MetricsWeeks) => request<AdminMetricsView>(metricsPath(days, weeks), {}, fetcher),
  };
}

export type MetricsApi = ReturnType<typeof createMetricsApi>;
export const metricsApi = createMetricsApi();
