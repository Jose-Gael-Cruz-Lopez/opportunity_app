import {
  findMatches,
  pickFirstDoor,
  planFirstApplication,
  type MatchSet as EngineMatchSet,
  type OnboardingProgram,
  type PlanPreferences,
} from "@shared/onboarding";
import type { CatalogEntry, FirstApplicationPlan, FirstDoorChoice, MatchEngine, MatchSet } from "./ports";

/**
 * The server MatchEngine port over @shared/onboarding, the same engine the browser runs, so a
 * signed-in student's server matches equal the on-device ones for the same answers.
 *
 * Server rules:
 * - eligibility is shared/onboarding's default (shared/eligibility's server-safe engine): status
 *   and identity rules stay "Eligible if ..." checks for the student's device;
 * - status-defined programs are never opted in (`includeSensitiveAudience` is a device choice);
 * - matching reads each entry's registry card; an entry without a card cannot be matched.
 */

/** A catalog entry as the engine reads it: the card plus compact requirements of its cycle. */
export function toOnboardingProgram(entry: CatalogEntry): OnboardingProgram | null {
  const card = entry.card;
  if (!card) return null;
  return {
    ...card,
    extras: {
      requirements: entry.requirements
        .filter((r) => r.programCycleId === card.programCycleId)
        .map((r) => ({ id: r.id, kind: r.kind, label: r.label, quantity: r.quantity, effortHours: r.effortHours, leadTimeDays: r.leadTimeDays })),
      skills: [...card.interestTags],
    },
  };
}

/** Match sets this module produced, so pickFirstDoor only ever reads a full engine set. */
const produced = new WeakSet<object>();

function isEngineSet(set: MatchSet): set is MatchSet & EngineMatchSet {
  return produced.has(set);
}

export const sharedMatchEngine: MatchEngine = {
  findMatches({ preferences, signals, programs, now, k }) {
    const cards = programs.map(toOnboardingProgram).filter((p): p is OnboardingProgram => p !== null);
    const set = findMatches({ preferences, signals, programs: cards, now, k });
    produced.add(set);
    return set;
  },

  pickFirstDoor(matches, preferences, now): FirstDoorChoice {
    if (!isEngineSet(matches)) return { options: [] };
    return pickFirstDoor(matches, preferences, now);
  },

  planFirstApplication({ program, cycle, requirements, signals, now, deadline, nominationRequired, preferences, timeZone }): FirstApplicationPlan {
    const zone = timeZone ?? preferences?.timeZone ?? null;
    const prefs: PlanPreferences = preferences
      ? { timeZone: zone, skills: preferences.skills, interests: preferences.interests, majorFamily: preferences.majorFamily, classYear: preferences.classYear }
      : { timeZone: zone, skills: [], interests: [], majorFamily: null, classYear: null };
    const resolved =
      deadline && deadline.on !== null && (deadline.basis === "official" || deadline.basis === "estimated" || deadline.basis === "campus_estimate")
        ? { on: deadline.on, basis: deadline.basis }
        : null;
    // Throws FirstDoorClosedError when every deadline has passed; the route answers 409.
    return planFirstApplication({
      program,
      cycle,
      requirements,
      signals,
      now,
      resolvedDeadline: resolved,
      nominationRequired: nominationRequired === true,
      preferences: prefs,
      // The server never offers AI drafting inside the plan; the student writes their own words.
      ai: { available: false },
    });
  },
};
