import type { AdminMetricsView, Cell } from "./api";

/**
 * A synthetic metrics view for tests and local previews. Every number is made up; no program,
 * student or event behind it exists.
 */

const c = (n: number | null): Cell => (n === null ? { n: null, hidden: true } : { n, hidden: false });

export const sampleMetricsView: AdminMetricsView = {
  generatedAt: "2026-11-11T15:00:00.000Z",
  k: 5,
  window: { days: 28, weeks: 4, from: "2026-10-14", to: "2026-11-11", firstWeek: "2026-10-19" },
  ingest: { eventsDb: "ok", eventRows: 412, onboardingEventRows: 96, lastEventAt: "2026-11-11T14:52:00.000Z" },
  funnel: {
    steps: [
      { step: "started", actors: c(40), optional: false, fromPrevious: null, fromStart: null },
      { step: "quiz_completed", actors: c(32), optional: false, fromPrevious: 0.8, fromStart: 0.8 },
      { step: "resume_parsed", actors: c(12), optional: true, fromPrevious: 0.375, fromStart: 0.3 },
      { step: "matches_shown", actors: c(30), optional: false, fromPrevious: 0.938, fromStart: 0.75 },
      { step: "first_door_chosen", actors: c(18), optional: false, fromPrevious: 0.6, fromStart: 0.45 },
      { step: "first_step_done", actors: c(null), optional: false, fromPrevious: null, fromStart: null },
      { step: "tracker_created", actors: c(15), optional: false, fromPrevious: null, fromStart: 0.375 },
    ],
    serverRecorded: { records: c(22), quizSaved: c(20), firstDoorChosen: c(14), completed: c(null) },
  },
  retention: {
    measured: true,
    cohorts: [
      { weekStart: "2026-10-19", size: c(20), weeks: [{ offset: 0, actors: c(20), rate: 1, partial: false }, { offset: 1, actors: c(11), rate: 0.55, partial: false }, { offset: 2, actors: c(null), rate: null, partial: false }, { offset: 3, actors: c(6), rate: 0.3, partial: true }] },
      { weekStart: "2026-10-26", size: c(null), weeks: [{ offset: 0, actors: c(null), rate: null, partial: false }, { offset: 1, actors: c(null), rate: null, partial: false }, { offset: 2, actors: c(null), rate: null, partial: true }] },
      { weekStart: "2026-11-02", size: c(9), weeks: [{ offset: 0, actors: c(9), rate: 1, partial: false }, { offset: 1, actors: c(5), rate: 0.556, partial: true }] },
      { weekStart: "2026-11-09", size: c(0), weeks: [{ offset: 0, actors: c(0), rate: null, partial: true }] },
    ],
  },
  engagement: {
    weeks: [
      { weekStart: "2026-10-19", partial: false, trackerItemsAdded: c(14), studentsAdding: c(9), remindersScheduled: c(12), remindersSent: c(null), remindersCancelled: c(0) },
      { weekStart: "2026-10-26", partial: false, trackerItemsAdded: c(8), studentsAdding: c(6), remindersScheduled: c(7), remindersSent: c(10), remindersCancelled: c(null) },
      { weekStart: "2026-11-02", partial: false, trackerItemsAdded: c(21), studentsAdding: c(13), remindersScheduled: c(18), remindersSent: c(6), remindersCancelled: c(0) },
      { weekStart: "2026-11-09", partial: true, trackerItemsAdded: c(5), studentsAdding: c(null), remindersScheduled: c(6), remindersSent: c(9), remindersCancelled: c(0) },
    ],
    studentsTracking: c(31),
    studentsWithUpcomingReminder: c(17),
    trackerStatus: { total: c(48), cells: [{ key: "interested", count: c(29) }, { key: "applying", count: c(13) }, { key: "submitted", count: c(6) }, { key: "decided", count: c(0) }, { key: "not_applying", count: c(0) }] },
    remindedItems: { items: c(20), progressed: c(11), rate: 0.55 },
    unremindedItems: { items: c(28), progressed: c(8), rate: 0.286 },
  },
  freshness: {
    windowDays: 30,
    targetMedianDays: 14,
    real: {
      published: 0,
      verifiedWithinWindow: 0,
      share: null,
      neverVerified: 0,
      medianDaysSinceVerification: null,
      ageBuckets: [{ key: "0-7", n: 0 }, { key: "8-14", n: 0 }, { key: "15-30", n: 0 }, { key: "31-90", n: 0 }, { key: "90+", n: 0 }, { key: "never", n: 0 }],
    },
    sample: {
      published: 28,
      verifiedWithinWindow: 21,
      share: 0.75,
      neverVerified: 3,
      medianDaysSinceVerification: 9.5,
      ageBuckets: [{ key: "0-7", n: 10 }, { key: "8-14", n: 6 }, { key: "15-30", n: 5 }, { key: "31-90", n: 4 }, { key: "90+", n: 0 }, { key: "never", n: 3 }],
    },
  },
};
