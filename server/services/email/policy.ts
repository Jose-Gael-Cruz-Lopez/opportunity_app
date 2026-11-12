import type { AlertType } from "@shared/contracts/events";

/**
 * Send-time policy (architecture 2.3.11, plan 6.7.2): quiet hours, quota classes and expiry.
 * Pure functions, so the property that matters ("no deadline-tomorrow mail the day after") is
 * testable without a database.
 */

const HOUR = 3_600_000;

/** Whether `HH:MM` falls inside a quiet window that may wrap midnight (22:00-08:00). */
export function isQuietTime(localHHMM: string, start: string, end: string): boolean {
  if (start === end) return false;
  if (start < end) return localHHMM >= start && localHHMM < end;
  return localHHMM >= start || localHHMM < end;
}

export type SendClass = "essential" | "alert" | "digest";

/** Codes and confirmations are essential; weekly mail is digest; everything else is an alert. */
export function sendClassFor(type: AlertType, stream: "transactional" | "digest"): SendClass {
  if (type === "contact.confirmation" || type === "account.notice") return "essential";
  return stream === "digest" ? "digest" : "alert";
}

/** Share of the daily quota after which each class holds (essential mail never holds). */
export const QUOTA_HOLD_AT: Readonly<Record<SendClass, number>> = { essential: Infinity, alert: 0.85, digest: 0.5 };

/**
 * Whether a send fits the day's quota. Urgent alerts (a deadline under 72 hours away) always go,
 * like codes and confirmations, so the reserve protects exactly the mail that must not fail.
 */
export function quotaAllows(cls: SendClass, sentToday: number, dailyQuota: number, urgent: boolean): boolean {
  if (cls === "essential" || urgent) return true;
  return sentToday < Math.floor(dailyQuota * QUOTA_HOLD_AT[cls]);
}

/** Within 72 hours of the deadline, alerts ignore quiet hours and the quota hold. */
export function isUrgent(nextDeadlineMs: number | null, nowMs: number): boolean {
  return nextDeadlineMs !== null && nextDeadlineMs > nowMs && nextDeadlineMs - nowMs <= 72 * HOUR;
}

/**
 * Notification expiry: a change Alert expires at the earlier of its deadline and 72 hours after
 * the change; a reminder at its deadline; weekly-email items after 7 days. Expired items are
 * dropped, never sent late.
 */
export function notificationExpiry(input: { type: AlertType; createdAt: number; nextDeadlineMs: number | null; digest: boolean }): number {
  if (input.digest) return input.createdAt + 7 * 24 * HOUR;
  const cap = input.createdAt + 72 * HOUR;
  if (input.type === "deadline.reminder") return input.nextDeadlineMs ?? cap;
  if (input.nextDeadlineMs !== null && input.nextDeadlineMs > input.createdAt) return Math.min(cap, input.nextDeadlineMs);
  return cap;
}

/** Start of the UTC day, for the per-day send count (the provider's quota is per UTC day). */
export function utcDayStart(nowMs: number): number {
  const d = new Date(nowMs);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Conservative default until the founders record the account's real quota in config. */
export const DEFAULT_DAILY_QUOTA = 100;
