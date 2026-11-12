import type { MatchSet, PlanStepKind, Tier } from "./types";
import { PLAN_STEP_KINDS, TIERS } from "./types";

/**
 * Funnel events for onboarding, as `onboarding_step` analytics events (shared/contracts allows
 * that name). Properties are enums, counts and booleans only: never skills, resume content,
 * program names or ids, reasons, or anything derived from a status or identity answer.
 *
 * Funnel: started -> quiz_completed -> resume_parsed -> matches_shown -> first_door_chosen ->
 * first_step_done -> tracker_created. Primary activation is first_step_done plus
 * tracker_created in the first session; time-to-value is start to matches_shown.
 */

export const ONBOARDING_FUNNEL = [
  "started",
  "quiz_completed",
  "resume_parsed",
  "matches_shown",
  "first_door_chosen",
  "first_step_done",
  "tracker_created",
] as const;
export type OnboardingFunnelStep = (typeof ONBOARDING_FUNNEL)[number];

export type OnboardingEventData =
  | { readonly step: "started" }
  | { readonly step: "quiz_completed"; readonly asked: number; readonly skipped: number; readonly seconds?: number }
  | { readonly step: "resume_parsed"; readonly source: "pdf" | "docx" | "paste" | "builder" | "none"; readonly ok: boolean }
  | { readonly step: "matches_shown"; readonly matches: MatchSet }
  | { readonly step: "first_door_chosen"; readonly tier: Tier }
  | { readonly step: "first_step_done"; readonly kind: PlanStepKind }
  | { readonly step: "tracker_created"; readonly deviceOnly: boolean };

export interface OnboardingEvent {
  readonly name: "onboarding_step";
  readonly props: Readonly<Record<string, string | number | boolean>>;
}

const RESUME_SOURCES: ReadonlySet<string> = new Set(["pdf", "docx", "paste", "builder", "none"]);

const count = (n: number): number => (Number.isFinite(n) ? Math.max(0, Math.min(999, Math.floor(n))) : 0);

/** Builds the event; every value is checked against its enum so free text cannot slip in. */
export function onboardingEvent(data: OnboardingEventData): OnboardingEvent {
  switch (data.step) {
    case "started":
      return { name: "onboarding_step", props: { step: "started" } };
    case "quiz_completed":
      return {
        name: "onboarding_step",
        props: {
          step: "quiz_completed",
          asked: count(data.asked),
          skipped: count(data.skipped),
          ...(data.seconds !== undefined ? { seconds: count(data.seconds) } : {}),
        },
      };
    case "resume_parsed":
      if (!RESUME_SOURCES.has(data.source)) throw new RangeError("unknown resume source");
      return { name: "onboarding_step", props: { step: "resume_parsed", source: data.source, ok: data.ok === true } };
    case "matches_shown": {
      const shown = data.matches.items;
      const per = (t: Tier): number => shown.filter((i) => i.tier === t).length;
      // How many cards were picks to explore (the student told us too little to match on): the
      // share of first sessions that only ever see the fallback is the quiz's own quality signal.
      const explore = shown.filter((i) => i.reasonCodes.includes("EXPLORE")).length;
      return {
        name: "onboarding_step",
        props: { step: "matches_shown", strong: per("strong"), good: per("good"), stretch: per("stretch"), explore, relaxed: data.matches.relaxed },
      };
    }
    case "first_door_chosen":
      if (!(TIERS as readonly string[]).includes(data.tier)) throw new RangeError("unknown tier");
      return { name: "onboarding_step", props: { step: "first_door_chosen", tier: data.tier } };
    case "first_step_done":
      if (!(PLAN_STEP_KINDS as readonly string[]).includes(data.kind)) throw new RangeError("unknown step kind");
      return { name: "onboarding_step", props: { step: "first_step_done", kind: data.kind } };
    case "tracker_created":
      return { name: "onboarding_step", props: { step: "tracker_created", deviceOnly: data.deviceOnly === true } };
  }
}
