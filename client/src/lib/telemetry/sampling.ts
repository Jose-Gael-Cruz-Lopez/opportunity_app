import type { EventName } from "./events";

/**
 * Session-level sampling, mirrored from server/api/v1/events/sampling.ts: same hash, same
 * rates, so the browser skips what the Worker would drop anyway. A test vector shared by both
 * test files keeps the two in step; the server is authoritative.
 */
export const SAMPLE_RATES: Readonly<Record<EventName, number>> = {
  page_view: 1,
  program_view: 1,
  apply_click: 1,
  remind_me_submit: 1,
  tracker_add: 1,
  onboarding_step: 1,
  search: 0.5,
  filter_change: 0.25,
  readiness_open: 1,
  ai_explain_open: 1,
};

/** Share of sessions that report client errors at all (judgment; lower it at volume). */
export const ERROR_SAMPLE_RATE = 1;

/** 32-bit FNV-1a of the id, reduced to a bucket in [0, 10000). */
export function sampleBucket(sessionId: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < sessionId.length; i++) {
    h ^= sessionId.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) % 10_000;
}

export function inSample(sessionId: string, rate: number): boolean {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  return sampleBucket(sessionId) < Math.round(rate * 10_000);
}
