import type { Program, ProgramCycle, Requirement, TrackerItem } from "@shared/contracts";
import type { CatalogEntry } from "./ports";

/**
 * SAMPLE data for tests only. These programs are invented; every record is flagged isSample and
 * named "Sample ...". Nothing here describes a real organisation.
 */

export const SAMPLE_IDS = {
  programA: "00000000-0000-4000-8000-00000000000a",
  programB: "00000000-0000-4000-8000-00000000000b",
  programSensitive: "00000000-0000-4000-8000-00000000000c",
  cycleA: "00000000-0000-4000-8000-0000000000a1",
  cycleAClosed: "00000000-0000-4000-8000-0000000000a2",
  cycleB: "00000000-0000-4000-8000-0000000000b1",
  cycleSensitive: "00000000-0000-4000-8000-0000000000c1",
  org: "00000000-0000-4000-8000-0000000000ff",
  tracker: "00000000-0000-4000-8000-0000000000e1",
} as const;

export function sampleProgram(overrides: Partial<Program> = {}): Program {
  return {
    id: SAMPLE_IDS.programA,
    slug: "sample-research-program",
    name: "Sample Research Program",
    organizationId: SAMPLE_IDS.org,
    summary: "Sample program for tests.",
    officialUrl: "https://example.org/sample",
    recurrence: "annual",
    lifecycle: "active",
    opportunityTypes: ["research_program"],
    sensitiveAudience: false,
    identityAudience: [],
    majorFamilies: ["computing"],
    interestTags: ["data"],
    aliases: [],
    isWedge: false,
    isPublished: true,
    isSample: true,
    version: 1,
    ...overrides,
  };
}

export function sampleCycle(overrides: Partial<ProgramCycle> = {}): ProgramCycle {
  return {
    id: SAMPLE_IDS.cycleA,
    programId: SAMPLE_IDS.programA,
    cycleKey: "summer-2027",
    termLabel: "Summer 2027",
    cycleModel: "term",
    status: "open",
    statusChangedAt: "2026-10-01T00:00:00Z",
    statusChangedBy: "system:test",
    timeZone: "America/Chicago",
    opensOn: "2026-10-01",
    predictedOpensOn: null,
    predictionLabel: null,
    decisionWindowStart: null,
    decisionWindowEnd: null,
    decisionsReleasedOn: null,
    eventStart: null,
    eventEnd: null,
    applicationUrl: null,
    pellDisplacement: "unknown",
    applicationFeeCents: null,
    participantCostCents: null,
    compensation: null,
    verificationState: "draft",
    lastVerifiedAt: null,
    verifiedBy: null,
    sourceCheckedAt: null,
    rolledOverFromId: null,
    version: 1,
    ...overrides,
  };
}

export function sampleRequirement(overrides: Partial<Requirement> = {}): Requirement {
  return {
    id: "00000000-0000-4000-8000-0000000000d1",
    programCycleId: SAMPLE_IDS.cycleA,
    kind: "essay",
    label: "Short essay",
    detail: null,
    quantity: 1,
    wordLimit: 300,
    deadlineId: null,
    effortHours: null,
    leadTimeDays: null,
    evidence: null,
    verificationState: "draft",
    ...overrides,
  };
}

export function sampleTracker(overrides: Partial<TrackerItem> = {}): TrackerItem {
  return {
    id: SAMPLE_IDS.tracker,
    programCycleId: SAMPLE_IDS.cycleA,
    programSlug: "sample-research-program",
    cycleKey: "summer-2027",
    status: "applying",
    statusSource: "student",
    ownCampusDeadline: null,
    submittedOn: null,
    nameInMessages: true,
    createdAt: "2026-11-11T15:00:00Z",
    updatedAt: "2026-11-11T15:00:00Z",
    version: 1,
    ...overrides,
  };
}

/** Three SAMPLE catalog entries: a plain program, a second org, and a sensitive-audience one. */
export function sampleCatalog(): CatalogEntry[] {
  return [
    {
      program: sampleProgram(),
      cycles: [
        sampleCycle(),
        sampleCycle({ id: SAMPLE_IDS.cycleAClosed, cycleKey: "summer-2026", termLabel: "Summer 2026", status: "closed" }),
      ],
      requirements: [sampleRequirement()],
      deadlines: { [SAMPLE_IDS.cycleA]: "2027-01-15", [SAMPLE_IDS.cycleAClosed]: "2026-01-15" },
    },
    {
      program: sampleProgram({
        id: SAMPLE_IDS.programB,
        slug: "sample-insight-week",
        name: "Sample Insight Week",
        opportunityTypes: ["early_career_exposure"],
      }),
      cycles: [sampleCycle({ id: SAMPLE_IDS.cycleB, programId: SAMPLE_IDS.programB, cycleKey: "spring-2027" })],
      requirements: [],
    },
    {
      program: sampleProgram({
        id: SAMPLE_IDS.programSensitive,
        slug: "sample-status-scholarship",
        name: "Sample Status Scholarship",
        opportunityTypes: ["private_scholarship"],
        sensitiveAudience: true,
      }),
      cycles: [sampleCycle({ id: SAMPLE_IDS.cycleSensitive, programId: SAMPLE_IDS.programSensitive })],
      requirements: [],
    },
  ];
}
