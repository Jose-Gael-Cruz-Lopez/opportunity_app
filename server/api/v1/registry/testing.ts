import type { DeadlineView, ProgramCard } from "@shared/contracts/registry";
import { sampleCard } from "@shared/matching/fixtures/sample-cards";
import { computeDueAt, computeSortAt, toIsoInstant } from "@shared/time";
import { CardCache } from "./cards";
import type { RegistryDeps, RegistryStore } from "./ports";

/**
 * TEST ONLY. Synthetic cards with real derived instants (the shared fixtures leave sortAt null),
 * and an in-memory RegistryStore. Every name is invented and marked as sample data.
 */

export const TEST_NOW = Date.UTC(2026, 10, 11, 15, 0, 0);

let seq = 0;

export function deadline(spec: {
  date: string;
  kind?: DeadlineView["kind"];
  time?: string;
  tzMode?: DeadlineView["tzMode"];
  precision?: DeadlineView["precision"];
}): DeadlineView {
  seq += 1;
  const precision = spec.precision ?? (spec.time ? "exact" : "date_only");
  const tzMode = spec.tzMode ?? "fixed";
  const fields = {
    basis: "official" as const,
    precision,
    tzMode,
    localDate: precision === "rolling" || precision === "tbd" ? null : spec.date,
    localTime: precision === "exact" ? (spec.time ?? "23:59") : null,
    windowStart: null,
    windowEnd: null,
    timeZone: tzMode === "fixed" && precision !== "rolling" && precision !== "tbd" ? "America/New_York" : null,
  };
  const due = computeDueAt(fields);
  const sort = computeSortAt(fields);
  return {
    id: `7e000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    kind: spec.kind ?? "application",
    scope: "national",
    roundLabel: "",
    ...fields,
    dueAt: due === null ? null : toIsoInstant(due),
    sortAt: sort === null ? null : toIsoInstant(sort),
    revision: 1,
  };
}

export function card(n: number, spec: Parameters<typeof sampleCard>[1]): ProgramCard {
  return sampleCard(100 + n, spec);
}

export const CARDS: readonly ProgramCard[] = [
  card(1, {
    slug: "sample-late-internship",
    name: "Sample Late Internship",
    organizationName: "Example Org A",
    opportunityTypes: ["summer_internship"],
    classYears: ["first_year", "second_year"],
    deadlines: [deadline({ date: "2027-03-01" })],
  }),
  card(2, {
    slug: "sample-soon-sprint",
    name: "Sample Soon Sprint",
    organizationName: "Example Org B",
    opportunityTypes: ["sprinternship"],
    classYears: ["first_year"],
    deadlines: [deadline({ date: "2026-11-25", time: "17:00" })],
  }),
  card(3, {
    slug: "sample-nominated-scholarship",
    name: "Sample Nominated Scholarship",
    organizationName: "Example Org C",
    opportunityTypes: ["national_scholarship"],
    classYears: ["second_year", "third_year"],
    // National 29 Jan 2027; E1 = 70 days earlier (20 Nov 2026), still ahead on 11 Nov.
    deadlines: [deadline({ date: "2027-01-29", time: "18:00" })],
    flags: { nominationRequired: true },
  }),
  card(4, {
    slug: "sample-expected-fellowship",
    name: "Sample Expected Fellowship",
    organizationName: "Example Org A",
    status: "expected",
    opportunityTypes: ["undergraduate_fellowship"],
    deadlines: [],
  }),
  card(5, {
    slug: "sample-closed-program",
    name: "Sample Closed Program",
    organizationName: "Example Org B",
    status: "closed",
    opportunityTypes: ["summer_internship"],
    deadlines: [deadline({ date: "2026-10-01" })],
  }),
  card(6, {
    slug: "sample-applicant-local-award",
    name: "Sample Applicant Local Award",
    organizationName: "Example Org D",
    opportunityTypes: ["private_scholarship"],
    deadlines: [deadline({ date: "2026-12-05", time: "23:59", tzMode: "applicant_local" }), deadline({ date: "2027-06-01", kind: "program_start" })],
  }),
];

export function memoryStore(overrides: Partial<RegistryStore> = {}, cards: readonly ProgramCard[] = CARDS): RegistryStore & { calls: string[] } {
  const calls: string[] = [];
  const base: RegistryStore = {
    async currentRelease() {
      calls.push("currentRelease");
      return 7;
    },
    async listCards() {
      calls.push("listCards");
      return [...cards];
    },
    async mergedSlugs() {
      return { "sample-old-name": "sample-late-internship" };
    },
    async programDetail() {
      return null;
    },
    async renamedSlug() {
      return null;
    },
    async organizationBySlug() {
      return null;
    },
    async opportunityTypeCounts() {
      return [];
    },
    async searchInstitutions() {
      return [];
    },
  };
  return Object.assign({ ...base, ...overrides }, { calls });
}

export function testDeps(store: RegistryStore, now = TEST_NOW): RegistryDeps {
  return { store: () => store, now: () => now, origin: () => "https://novus.example.org", cards: new CardCache() };
}
