import type { AnalyticsEventName } from "./allowlist";

/**
 * Session-level sampling. A session is in or out of an event's sample as a whole, decided from
 * its id alone, so funnels inside a session stay complete and the browser and the Worker reach
 * the same answer without talking. client/src/lib/telemetry/sampling.ts mirrors `sampleBucket`
 * exactly (a shared test vector in both test files keeps them aligned).
 *
 * Rates are judgment for launch volume: everything is kept except the two highest-frequency,
 * lowest-value events. Stored rows carry `sampleRate` when it is below 1, so counts are
 * reweighted (n / rate) rather than read raw.
 */
export const SAMPLE_RATES: Readonly<Record<AnalyticsEventName, number>> = {
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

/** Client error reports: a session reports at all only if it falls in this share (judgment). */
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
