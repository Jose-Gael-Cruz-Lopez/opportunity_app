import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ONBOARDING_FUNNEL } from "@shared/onboarding/analytics";
import { buildEngagement, buildFunnel, buildMetricsView, freshnessSlice, median, metricsWindow } from "./build";
import { adminMetricsRoutes } from "./index";
import type { TrackerSnapshot } from "./queries";
import { AdminMetricsViewSchema } from "./schemas";
import { DAY_MS } from "./weeks";

const NOW = Date.parse("2026-11-11T15:00:00Z");

const tracker = (over: Partial<TrackerSnapshot> = {}): TrackerSnapshot => ({
  byStatus: new Map(),
  studentsTracking: 0,
  studentsWithUpcomingReminder: 0,
  reminded: { items: 0, progressed: 0 },
  unreminded: { items: 0, progressed: 0 },
  ...over,
});

describe("buildFunnel", () => {
  it("lists every step in order and gives no rates when the start is hidden", () => {
    const steps = buildFunnel(new Map([["started", 3], ["quiz_completed", 3]]));
    expect(steps.map((s) => s.step)).toEqual([...ONBOARDING_FUNNEL]);
    expect(steps[0]!.actors.hidden).toBe(true);
    expect(steps.every((s) => s.fromStart === null && s.fromPrevious === null)).toBe(true);
  });
});

describe("buildEngagement", () => {
  it("hides every non-zero status when one small status could be recovered from the total", () => {
    const w = metricsWindow(NOW, 28, 4);
    const e = buildEngagement(new Map(), tracker({ byStatus: new Map([["interested", 8], ["applying", 6], ["submitted", 2]]) }), w);
    expect(e.trackerStatus.total).toEqual({ n: 16, hidden: false });
    expect(e.trackerStatus.cells.map((c) => c.count.n)).toEqual([null, null, null, 0, 0]);
  });

  it("releases reminded and unreminded items as a pair, since they add up to the Tracker total", () => {
    const w = metricsWindow(NOW, 28, 4);
    const e = buildEngagement(new Map(), tracker({ reminded: { items: 3, progressed: 2 }, unreminded: { items: 40, progressed: 12 } }), w);
    expect(e.remindedItems.items.hidden).toBe(true);
    expect(e.unremindedItems.items.hidden).toBe(true);
    expect(e.unremindedItems.rate).toBeNull();
    expect(e.weeks).toHaveLength(4);
    expect(e.weeks.every((wk) => wk.trackerItemsAdded.n === 0)).toBe(true);
  });
});

describe("freshness", () => {
  it("takes the median over verified programs and counts the never-verified apart", () => {
    expect(median([])).toBeNull();
    expect(median([1, 2, 3, 10])).toBe(2.5);
    const f = freshnessSlice(
      [
        { isSample: false, lastVerifiedAt: NOW - 30 * DAY_MS },
        { isSample: false, lastVerifiedAt: NOW - 31 * DAY_MS },
        { isSample: false, lastVerifiedAt: NOW + DAY_MS },
        { isSample: false, lastVerifiedAt: null },
      ],
      NOW,
    );
    expect(f).toMatchObject({ published: 4, verifiedWithinWindow: 2, share: 0.5, neverVerified: 1, medianDaysSinceVerification: 30 });
    expect(f.ageBuckets.map((b) => b.n)).toEqual([1, 0, 1, 1, 0, 1]);
    expect(freshnessSlice([], NOW)).toMatchObject({ published: 0, share: null, medianDaysSinceVerification: null });
  });
});

describe("buildMetricsView", () => {
  it("fits the wire schema with no data at all", () => {
    const v = buildMetricsView({
      now: NOW,
      days: 28,
      weeks: 8,
      eventsDb: "ok",
      ingest: { eventRows: 0, onboardingEventRows: 0, keyedEventRows: 0, lastEventAt: null },
      funnel: new Map(),
      onboardingRecords: { records: 0, quizSaved: 0, firstDoorChosen: 0, completed: 0 },
      retention: [],
      engagement: new Map(),
      tracker: tracker(),
      programs: [],
    });
    expect(AdminMetricsViewSchema.parse(v)).toEqual(v);
    expect(v.window).toEqual({ days: 28, weeks: 8, from: "2026-10-14", to: "2026-11-11", firstWeek: "2026-09-21" });
    // No keyed actor: retention is "not measured", never a table of zeros.
    expect(v.retention).toEqual({ measured: false, cohorts: [] });
  });
});

describe("router wiring", () => {
  it("mounted under /api/v1 it serves exactly GET /api/v1/admin/metrics", () => {
    const app = new Hono().route("/api/v1", adminMetricsRoutes);
    const keys = app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`);
    expect([...new Set(keys)]).toEqual(["GET /api/v1/admin/metrics"]);
  });
});
