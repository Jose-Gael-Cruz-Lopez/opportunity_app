import { ANALYTICS_EVENT_NAMES } from "@shared/contracts/api";
import type { OnboardingFunnelStep } from "@shared/onboarding/analytics";

/**
 * The events the app may send, with the properties each may carry. This mirrors the server's
 * allowlist (server/api/v1/events/allowlist.ts), which is authoritative: an event with any
 * other key is dropped there. Every property is an id, a closed code, a small integer or a
 * boolean; there is no free-text field, so a search query, a filter key, a message or an
 * answer cannot be typed in here.
 */

export type EventName = (typeof ANALYTICS_EVENT_NAMES)[number];

export type EntrySurface = "explore" | "deadlines" | "landing" | "search" | "list" | "tracker" | "roadmap" | "onboarding" | "email" | "direct" | "other";
/** The funnel steps of shared/onboarding/analytics.ts; build these events with `trackOnboarding`. */
export type OnboardingStep = OnboardingFunnelStep;
export type RemindOutcome = "accepted" | "consent_required" | "rate_limited" | "unavailable" | "verification_failed" | "failed";

export interface EventPropsMap {
  page_view: { surface: "public" | "app" | "console" };
  program_view: { programId?: string; cycleId?: string; entry?: EntrySurface };
  apply_click: { programId?: string; cycleId?: string; entry?: EntrySurface };
  remind_me_submit: { cycleId?: string; outcome?: RemindOutcome };
  tracker_add: { programId?: string; cycleId?: string; source?: "self" | "list" | "email_action" | "onboarding" };
  /** Exactly what `onboardingEvent()` builds: a step plus that step's counts, codes and flags. */
  onboarding_step: { step: OnboardingStep } & Partial<Record<"asked" | "skipped" | "seconds" | "strong" | "good" | "stretch" | "explore", number>> &
    Partial<Record<"ok" | "relaxed" | "deviceOnly", boolean>> &
    Partial<Record<"source" | "tier" | "kind", string>>;
  /** Bucket of the text query's result count before filters; never the query or the filters. */
  search: { resultBucket?: "0" | "1-9" | "10+" };
  /** No properties: which filter changed is never sent. Send it for every filter alike. */
  filter_change: Record<string, never>;
  readiness_open: { cycleId?: string };
  ai_explain_open: { cycleId?: string };
}

export const EVENT_NAMES: readonly EventName[] = ANALYTICS_EVENT_NAMES;

/** The result-count bucket for `search` (s10 10.9.3). */
export function resultBucket(count: number): "0" | "1-9" | "10+" {
  return count <= 0 ? "0" : count < 10 ? "1-9" : "10+";
}
