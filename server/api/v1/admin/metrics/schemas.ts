import { z } from "zod";
import { ONBOARDING_FUNNEL } from "@shared/onboarding/analytics";
import { TRACKER_STATUSES } from "@shared/taxonomy";

/**
 * Wire shapes of GET /api/v1/admin/metrics. The console mirrors them in
 * client/src/console/metrics/api.ts; a client test parses its fixture with this schema so the
 * two cannot drift. Every student-derived number is a Cell: `n` is null exactly when hidden.
 */

export const METRICS_DAYS = [7, 28, 90] as const;
export const DEFAULT_DAYS = 28;
export const DEFAULT_WEEKS = 8;
export const MIN_WEEKS = 4;
export const MAX_WEEKS = 26;

export const MetricsQuerySchema = z
  .object({
    days: z.coerce
      .number()
      .int()
      .refine((d) => (METRICS_DAYS as readonly number[]).includes(d), "days must be 7, 28 or 90")
      .default(DEFAULT_DAYS),
    weeks: z.coerce.number().int().min(MIN_WEEKS).max(MAX_WEEKS).default(DEFAULT_WEEKS),
  })
  .strict();
export type MetricsQuery = z.infer<typeof MetricsQuerySchema>;

export const CellSchema = z
  .object({ n: z.number().int().nonnegative().nullable(), hidden: z.boolean() })
  .strict()
  .refine((c) => (c.n === null) === c.hidden, "n is null exactly when hidden")
  .refine((c) => c.n === null || c.n === 0 || c.n >= 5, "shown counts are 0 or at least 5");

const Rate = z.number().min(0).max(1).nullable();
const IsoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const PartitionSchema = z
  .object({ total: CellSchema, cells: z.array(z.object({ key: z.string(), count: CellSchema }).strict()) })
  .strict();

export const FunnelStepSchema = z
  .object({
    step: z.enum(ONBOARDING_FUNNEL),
    actors: CellSchema,
    optional: z.boolean(),
    fromPrevious: Rate,
    fromStart: Rate,
  })
  .strict();

export const FreshnessSliceSchema = z
  .object({
    published: z.number().int().nonnegative(),
    verifiedWithinWindow: z.number().int().nonnegative(),
    share: Rate,
    neverVerified: z.number().int().nonnegative(),
    medianDaysSinceVerification: z.number().nonnegative().nullable(),
    ageBuckets: z.array(z.object({ key: z.enum(["0-7", "8-14", "15-30", "31-90", "90+", "never"]), n: z.number().int().nonnegative() }).strict()),
  })
  .strict();

export const AdminMetricsViewSchema = z
  .object({
    generatedAt: z.string(),
    k: z.literal(5),
    window: z.object({ days: z.number().int(), weeks: z.number().int(), from: IsoDate, to: IsoDate, firstWeek: IsoDate }).strict(),
    ingest: z
      .object({
        eventsDb: z.enum(["ok", "unbound"]),
        eventRows: z.number().int().nonnegative(),
        onboardingEventRows: z.number().int().nonnegative(),
        lastEventAt: z.string().nullable(),
      })
      .strict(),
    funnel: z
      .object({
        steps: z.array(FunnelStepSchema),
        serverRecorded: z.object({ records: CellSchema, quizSaved: CellSchema, firstDoorChosen: CellSchema, completed: CellSchema }).strict(),
      })
      .strict(),
    retention: z
      .object({
        /**
         * False while no event row carries a keyed actor (the ingest stores session ids only):
         * cohorts are then empty and the page says "not measured" instead of showing zeros.
         */
        measured: z.boolean(),
        cohorts: z.array(
          z
            .object({
              weekStart: IsoDate,
              size: CellSchema,
              weeks: z.array(z.object({ offset: z.number().int().nonnegative(), actors: CellSchema, rate: Rate, partial: z.boolean() }).strict()),
            })
            .strict(),
        ),
      })
      .strict(),
    engagement: z
      .object({
        weeks: z.array(
          z
            .object({
              weekStart: IsoDate,
              partial: z.boolean(),
              trackerItemsAdded: CellSchema,
              studentsAdding: CellSchema,
              remindersScheduled: CellSchema,
              remindersSent: CellSchema,
              remindersCancelled: CellSchema,
            })
            .strict(),
        ),
        studentsTracking: CellSchema,
        studentsWithUpcomingReminder: CellSchema,
        trackerStatus: PartitionSchema,
        remindedItems: z.object({ items: CellSchema, progressed: CellSchema, rate: Rate }).strict(),
        unremindedItems: z.object({ items: CellSchema, progressed: CellSchema, rate: Rate }).strict(),
      })
      .strict(),
    freshness: z
      .object({ windowDays: z.literal(30), targetMedianDays: z.literal(14), real: FreshnessSliceSchema, sample: FreshnessSliceSchema })
      .strict(),
  })
  .strict();

export type AdminMetricsView = z.infer<typeof AdminMetricsViewSchema>;
export type FreshnessSlice = z.infer<typeof FreshnessSliceSchema>;

/** Tracker statuses that mean the student is applying or past it. */
export const PROGRESSED_STATUSES: readonly (typeof TRACKER_STATUSES)[number][] = ["applying", "submitted", "decided"];
