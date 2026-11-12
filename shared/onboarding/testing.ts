import type { DeadlineView, ProgramCard } from "../contracts/registry";
import { computeDueAt, computeSortAt } from "../time/deadline";
import { addDays, toIsoInstant } from "../time/iso";
import { toPreferences, createQuizState } from "./quiz";
import type { OnboardingProgram, ProgramExtras, StudentPreferences } from "./types";

/**
 * Test builders for onboarding (used by this module's tests and available to the route tests).
 * Everything they build is marked as sample data.
 */

let counter = 0;
const uuid = (n: number): string => `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`;

export interface CardOptions extends Partial<Omit<ProgramCard, "deadlines" | "flags">> {
  /** Today's date (YYYY-MM-DD) the deadline offset counts from. */
  readonly today: string;
  /** Days from today to a date-only application deadline; "rolling" or "tbd" for undated rows; null for none. */
  readonly deadlineIn?: number | "rolling" | "tbd" | null;
  readonly flags?: Partial<ProgramCard["flags"]>;
  readonly extras?: ProgramExtras;
}

export function makeDeadline(today: string, offset: number | "rolling" | "tbd", kind: DeadlineView["kind"] = "application"): DeadlineView {
  counter++;
  const base = { id: uuid(500000 + counter), kind, scope: "national" as const, roundLabel: "", localTime: null, revision: 1, windowStart: null, windowEnd: null };
  if (offset === "rolling" || offset === "tbd") {
    return { ...base, basis: "official", precision: offset, tzMode: "fixed", localDate: null, timeZone: null, dueAt: null, sortAt: null };
  }
  const row = { ...base, basis: "official" as const, precision: "date_only" as const, tzMode: "fixed" as const, localDate: addDays(today, offset), timeZone: "America/New_York" };
  const due = computeDueAt(row);
  const sort = computeSortAt(row);
  return { ...row, dueAt: due === null ? null : toIsoInstant(due), sortAt: sort === null ? null : toIsoInstant(sort) };
}

export function makeCard(opts: CardOptions): OnboardingProgram {
  counter++;
  const n = counter;
  const { today, deadlineIn = 30, flags, extras, ...rest } = opts;
  const slug = rest.slug ?? `test-program-${n}`;
  const card: ProgramCard = {
    programId: uuid(n),
    programCycleId: uuid(100000 + n),
    slug,
    cycleKey: "summer-2027",
    name: `Sample: Test Program ${n}`,
    organizationName: `Test Org ${n} (sample)`,
    summary: null,
    opportunityTypes: ["summer_internship"],
    status: "open",
    verification: { state: "verified", verifiedOn: today, verifiedBy: "Sample Curator", freshness: "fresh" },
    deadlines: deadlineIn === null ? [] : [makeDeadline(today, deadlineIn)],
    opensOn: null,
    prediction: null,
    classYears: [],
    majorFamilies: [],
    cipPrefixes: [],
    interestTags: [],
    aliases: [],
    compensation: null,
    applicationUrl: `https://example.org/sample/${slug}/apply`,
    officialUrl: `https://example.org/sample/${slug}`,
    prepDays: null,
    rules: null,
    rulesFromPreviousCycle: null,
    isSample: true,
    ...rest,
    flags: {
      paid: false,
      participantCost: false,
      applicationFee: false,
      pellDisplacement: false,
      sensitiveAudience: false,
      identityAudience: false,
      nominationRequired: false,
      ...flags,
    },
  };
  return extras ? { ...card, extras } : card;
}

/** Preferences with every field at its "no preference" value, overridden as needed. */
export function makePreferences(overrides: Partial<StudentPreferences> = {}): StudentPreferences {
  return { ...toPreferences(createQuizState({ timeZone: "America/New_York", now: Date.UTC(2026, 10, 11, 15) })), ...overrides };
}
