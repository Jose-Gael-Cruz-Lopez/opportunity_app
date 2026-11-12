import {
  EMPTY_STUDENT_PROFILE,
  ReadinessReportSchema,
  type ReadinessReport,
  type StudentProfile,
} from "@shared/contracts";
import type { AiSourceInput } from "../prompts/common";

/**
 * SAMPLE data for tests and local demos. The program, organisation, URLs and dates are invented
 * (example.org) and are not facts about any real program.
 */

export const SAMPLE_PROGRAM_SLUG = "sample-summer-research-program";
export const SAMPLE_CYCLE_ID = "0b7c9f1e-2d3a-4c5b-8e6f-7a8b9c0d1e2f";

export const SAMPLE_REPORT: ReadinessReport = ReadinessReportSchema.parse({
  programCycleId: SAMPLE_CYCLE_ID,
  programSlug: SAMPLE_PROGRAM_SLUG,
  cycleKey: "2027",
  algoVersion: "readiness-v1-sample",
  generatedAt: "2026-11-11T15:00:00Z",
  eligibility: {
    verdict: "unknown",
    status: "conditional",
    rules: [
      {
        ruleId: "standing.first_or_second",
        dimension: "standing",
        group: "all",
        verdict: "met",
        sensitive: false,
        reasonCode: "ELIGIBLE_STANDING",
        reason: "Open to first- and second-year students.",
        officialText: "Applicants must be first- or second-year undergraduates.",
        missingFields: [],
        resolver: null,
        evidenceKey: "e1",
        evidence: null,
      },
      {
        ruleId: "citizenship.us",
        dimension: "citizenship",
        group: "all",
        verdict: "unknown",
        sensitive: true,
        reasonCode: "SENSITIVE_ON_DEVICE",
        reason: "SECRET-SENSITIVE-REASON citizenship rule checked on device",
        officialText: "SECRET-SENSITIVE-OFFICIAL text about citizenship",
        missingFields: [],
        resolver: "student",
        evidenceKey: null,
        evidence: null,
      },
    ],
    pending: [
      {
        id: "pending.citizenship",
        kind: "rule",
        dimension: "citizenship",
        sensitive: true,
        resolver: "student",
        selfCheckText: "SECRET-SENSITIVE-PENDING eligible if a US citizen",
      },
    ],
    nomination: null,
    ruleSet: null,
    basedOnListedRequirements: false,
    asOf: "2026-11-11",
    sensitiveEvaluated: false,
  },
  requirements: {
    checked: true,
    effectiveDeadline: { date: "2027-02-01", basis: "official", scope: "national", label: "Application deadline" },
    items: [
      {
        key: "kind:resume",
        requirementId: null,
        kind: "resume",
        label: "Resume",
        quantity: 1,
        state: "met",
        gap: null,
        startBy: null,
        severity: null,
        effortHours: 3,
        leadDays: 7,
        evidence: null,
      },
      {
        key: "kind:recommendation",
        requirementId: null,
        kind: "recommendation",
        label: "Recommendation letters",
        quantity: 2,
        state: "gap",
        gap: "Ask two recommenders",
        startBy: "2026-12-14",
        severity: "soon",
        effortHours: 2,
        leadDays: 49,
        evidence: null,
      },
    ],
  },
  competitiveness: {
    status: "insufficient_data",
    band: null,
    reason: "no_official_counts",
    basis: {
      kind: "none",
      summary: "The program does not publish applicant counts.",
      stageOdds: [],
      currentStage: null,
      factors: [],
      reportsBanded: null,
      nEff: null,
      cycles: [],
      modelVersion: null,
      methodologyUrl: null,
    },
  },
  nextActions: [
    {
      id: "act.recommenders",
      label: "Ask two recommenders",
      detail: "Give them at least seven weeks.",
      dueOn: "2026-12-14",
      severity: "soon",
      source: "gap",
      roadmapItemKey: "recommenders",
      relatesTo: "kind:recommendation",
    },
  ],
});

export const SAMPLE_PROFILE: StudentProfile = {
  ...EMPTY_STUDENT_PROFILE,
  classYear: "first_year",
  majorFamily: "life_sciences",
  institutionId: "11111111-2222-4333-8444-555555555555",
  birthYearMonth: "2006-05",
  residenceState: "CA",
  gpaBand: "3_5_to_3_74",
  interestTags: ["marine biology", "LGBTQ+ advocacy", "data analysis"],
  priorExperience: ["research"],
};

export const SAMPLE_PROGRAM_SOURCES: AiSourceInput[] = [
  {
    kind: "program_page",
    title: "Sample Summer Research Program: How to apply (sample)",
    url: "https://example.org/sample-program/apply",
    programSlug: SAMPLE_PROGRAM_SLUG,
    text: "Applications close February 1, 2027. Submit a resume and two letters of recommendation from faculty who know your work.",
    retrievedOn: "2026-11-01",
  },
];

/** An adult viewer (born 2006-05, so 18 since 2024-05) and a minor one, for the age gate. */
export const ADULT_VIEWER = { userId: "user-adult-sample", birthYearMonth: "2006-05" } as const;
export const MINOR_VIEWER = { userId: "user-minor-sample", birthYearMonth: "2009-03" } as const;
