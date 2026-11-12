import { z } from "zod";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema } from "./common";

/**
 * The publish outbox and its fan-out: ChangeEvents (registry facts, written only by publish
 * batches) become Alerts (one recipient each) and Notifications (one per Alert and channel).
 */

export const CHANGE_EVENT_TYPES = [
  "program_cycle.verified",
  "deadline.changed",
  "cycle.status_changed",
  "eligibility.changed",
  "cycle.urgent_recheck",
  "cycle.prediction_changed",
  "cycle.decisions_released",
  "posting.opened",
  "posting.closed",
] as const;
export const ChangeEventTypeSchema = z.enum(CHANGE_EVENT_TYPES);
export type ChangeEventType = z.infer<typeof ChangeEventTypeSchema>;

export const ALERT_TYPES = [
  ...CHANGE_EVENT_TYPES,
  "deadline.reminder",
  "cycle.predicted_soon",
  "roadmap.replanned",
  "profile.newly_eligible",
  "curator.note",
  "advisor.list_item",
  "account.notice",
  "contact.confirmation",
] as const;
export const AlertTypeSchema = z.enum(ALERT_TYPES);
export type AlertType = z.infer<typeof AlertTypeSchema>;

export const ChangeEventSchema = z
  .object({
    id: IdSchema,
    type: ChangeEventTypeSchema,
    programCycleId: IdSchema,
    /** Registry facts only (before/after of the changed fields); never student data. */
    payload: z.record(z.unknown()),
    taskId: z.string().max(80).nullable(),
    release: z.number().int().nonnegative().nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type ChangeEvent = z.infer<typeof ChangeEventSchema>;

export const ALERT_PRIORITIES = ["p0", "p1", "p2"] as const;

export const AlertSchema = z
  .object({
    id: IdSchema,
    type: AlertTypeSchema,
    /** `u:{userId}` or `c:{contactId}`: exactly one recipient. */
    recipientKey: z.string().regex(/^[uc]:[0-9a-f-]{36}$/),
    programCycleId: IdSchema.nullable(),
    changeEventId: IdSchema.nullable(),
    dedupeKey: z.string().max(200),
    priority: z.enum(ALERT_PRIORITIES),
    title: z.string().max(200),
    body: z.string().max(1000),
    /** In-app link (relative path). */
    href: z.string().max(300).nullable(),
    scheduledFor: IsoDateTimeSchema,
    readAt: IsoDateTimeSchema.nullable(),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type Alert = z.infer<typeof AlertSchema>;

export const NOTIFICATION_CHANNELS = ["email", "in_app", "push"] as const;
export const NOTIFICATION_STREAMS = ["transactional", "digest"] as const;
export const NOTIFICATION_STATES = ["queued", "sent", "failed", "suppressed", "expired"] as const;

export const NotificationSchema = z
  .object({
    id: IdSchema,
    alertId: IdSchema,
    channel: z.enum(NOTIFICATION_CHANNELS),
    stream: z.enum(NOTIFICATION_STREAMS),
    /** `notif:{alertId}:{channel}` */
    idempotencyKey: z.string().max(120),
    state: z.enum(NOTIFICATION_STATES),
    expiresAt: IsoDateTimeSchema,
    sentAt: IsoDateTimeSchema.nullable(),
    attempts: z.number().int().nonnegative(),
  })
  .strict();
export type Notification = z.infer<typeof NotificationSchema>;

export const NotificationPrefsSchema = z
  .object({
    weeklyEmail: z.boolean(),
    weeklyDay: z.number().int().min(1).max(7).nullable(),
    quietHoursStart: z.string().regex(/^\d{2}:\d{2}$/),
    quietHoursEnd: z.string().regex(/^\d{2}:\d{2}$/),
    examPauseUntil: IsoDateSchema.nullable(),
    channels: z.object({ email: z.boolean(), inApp: z.boolean(), push: z.boolean() }).strict(),
  })
  .strict();
export type NotificationPrefs = z.infer<typeof NotificationPrefsSchema>;

/** In-app notification list item for the student. */
export const InboxItemSchema = AlertSchema.pick({
  id: true,
  type: true,
  priority: true,
  title: true,
  body: true,
  href: true,
  readAt: true,
  createdAt: true,
});
export type InboxItem = z.infer<typeof InboxItemSchema>;
