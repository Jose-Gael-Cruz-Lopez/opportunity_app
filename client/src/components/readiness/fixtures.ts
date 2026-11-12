/**
 * SAMPLE DATA for the Program, Readiness and Tracker screens while the API is not running.
 *
 * Every program, organization, date, count and amount below is invented. Records carry
 * `isSample: true`, URLs use example.org, and the screens show a "Sample data" banner whenever
 * a fixture is on screen. None of this describes a real program.
 */
import type { ProgramCard, ProgramDetail, DeadlineView } from "@shared/contracts/registry";
import type { ReadinessReport } from "@shared/contracts/readiness";
import type { TrackerItem } from "@shared/contracts/student";
import type { EligibilityRuleSet } from "@shared/contracts/eligibility";

const ID = (n: number) => `0190f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const HASH = "0".repeat(63) + "1";
const CHECKED_AT = "2026-11-04T15:00:00.000Z";

export const SAMPLE_PROGRAM_SLUG = "sample-coastal-research-scholars";
export const SAMPLE_CYCLE_ID = ID(2);

// ---------------------------------------------------------------------------------------------
// Program detail
// ---------------------------------------------------------------------------------------------

const sampleRuleSet: EligibilityRuleSet = {
  id: ID(10),
  programCycleId: SAMPLE_CYCLE_ID,
  version: 2,
  format: "jsonlogic-v1",
  state: "verified",
  templateKey: null,
  coverage: {
    standing: "encoded",
    enrollment: "no_restriction",
    transfer: "no_restriction",
    gpa: "encoded",
    citizenship: "encoded",
    pell: "no_restriction",
    field: "encoded",
  },
  rules: [
    {
      id: "standing",
      dimension: "standing",
      group: "all",
      logic: { in: [{ var: "classYear" }, ["first_year", "second_year"]] },
      fields: ["classYear"],
      sensitive: false,
      asOf: "national_deadline",
      borderline: [],
      officialText: "Open to students in their first or second year of a degree program.",
      evidenceKey: "e1",
    },
    {
      id: "gpa",
      dimension: "gpa",
      group: "all",
      logic: { ">=": [{ var: "gpaMin" }, 3.0] },
      fields: ["gpaMin"],
      sensitive: false,
      asOf: "today",
      borderline: [],
      officialText: "A cumulative GPA of 3.0 or higher.",
      evidenceKey: "e1",
    },
    {
      id: "field",
      dimension: "field",
      group: "all",
      logic: { in: [{ var: "majorFamily" }, ["agriculture_environment", "physical_sciences", "life_sciences", "engineering_technology", "computing", "math_statistics"]] },
      fields: ["majorFamily"],
      sensitive: false,
      asOf: "today",
      borderline: [],
      officialText: "A major in a science, engineering or environmental field.",
      evidenceKey: "e1",
    },
    {
      id: "citizenship",
      dimension: "citizenship",
      group: "all",
      logic: { in: [{ var: "citizenship" }, ["us_citizen", "us_national", "permanent_resident"]] },
      fields: ["citizenship"],
      sensitive: true,
      asOf: "today",
      borderline: [],
      officialText: "U.S. citizens, U.S. nationals and permanent residents.",
      evidenceKey: "e1",
    },
  ],
  anyOf: [],
  attestations: [],
  nomination: null,
  evidence: {
    e1: { basis: "snapshot", url: "https://example.org/sample-coastal/eligibility", quote: "Sample eligibility wording for the prototype.", retrievedOn: "2026-11-04" },
  },
  hash: HASH,
  createdVia: "sample",
  verifiedAt: CHECKED_AT,
  verifiedBy: "Curator AB",
  fromCycleKey: null,
};

const applicationDeadline = {
  id: ID(1),
  programCycleId: SAMPLE_CYCLE_ID,
  kind: "application",
  scope: "national",
  institutionId: null,
  roundLabel: "",
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-28",
  localTime: "23:59",
  windowStart: null,
  windowEnd: null,
  timeZone: "America/New_York",
  tzSource: "stated",
  dueAt: "2027-01-29T04:59:00.000Z",
  sortAt: "2027-01-29T04:59:00.000Z",
  revision: 1,
  verificationState: "verified",
  withdrawnAt: null,
} as const satisfies ProgramDetail["deadlines"][number];

export const SAMPLE_PROGRAM_DETAIL: ProgramDetail = {
  program: {
    id: ID(3),
    slug: SAMPLE_PROGRAM_SLUG,
    name: "Sample Coastal Research Scholars",
    organizationId: ID(4),
    summary: "Sample program: two years of tuition support and a paid summer research placement at a coastal field station.",
    officialUrl: "https://example.org/sample-coastal",
    recurrence: "annual",
    lifecycle: "active",
    opportunityTypes: ["national_scholarship", "research_program"],
    sensitiveAudience: false,
    identityAudience: [],
    majorFamilies: ["agriculture_environment", "physical_sciences"],
    interestTags: ["oceans", "climate"],
    aliases: [],
    isWedge: true,
    isPublished: true,
    isSample: true,
    version: 3,
  },
  organization: {
    id: ID(4),
    slug: "example-ocean-agency",
    name: "Example Ocean Agency (sample)",
    kind: "federal_agency",
    country: "US",
    defaultTimeZone: "America/New_York",
    websiteUrl: "https://example.org",
    isSample: true,
  },
  cycle: {
    id: SAMPLE_CYCLE_ID,
    programId: ID(3),
    cycleKey: "ay-2026-27",
    termLabel: "2026-27 cycle",
    cycleModel: "term",
    status: "open",
    statusChangedAt: "2026-08-27T13:00:00.000Z",
    statusChangedBy: "system:pipeline.hourly",
    timeZone: "America/New_York",
    opensOn: "2026-08-27",
    predictedOpensOn: null,
    predictionLabel: null,
    decisionWindowStart: "2027-04-01",
    decisionWindowEnd: "2027-04-30",
    decisionsReleasedOn: null,
    eventStart: "2027-06-01",
    eventEnd: "2027-08-06",
    applicationUrl: "https://example.org/sample-coastal/apply",
    pellDisplacement: "none",
    applicationFeeCents: 0,
    participantCostCents: 0,
    compensation: { kind: "stipend", amountCents: 750000, period: "total", note: "Sample amount" },
    verificationState: "verified",
    lastVerifiedAt: CHECKED_AT,
    verifiedBy: "Curator AB",
    sourceCheckedAt: CHECKED_AT,
    rolledOverFromId: ID(5),
    version: 4,
  },
  deadlines: [applicationDeadline],
  requirements: [
    { id: ID(20), programCycleId: SAMPLE_CYCLE_ID, kind: "essay", label: "Personal statement", detail: "Up to 500 words", quantity: 1, wordLimit: 500, deadlineId: null, effortHours: null, leadTimeDays: null, evidence: null, verificationState: "verified" },
    { id: ID(21), programCycleId: SAMPLE_CYCLE_ID, kind: "recommendation", label: "Two recommendation letters", detail: null, quantity: 2, wordLimit: null, deadlineId: null, effortHours: null, leadTimeDays: null, evidence: null, verificationState: "verified" },
    { id: ID(22), programCycleId: SAMPLE_CYCLE_ID, kind: "transcript", label: "Transcript (unofficial is fine)", detail: null, quantity: 1, wordLimit: null, deadlineId: null, effortHours: null, leadTimeDays: null, evidence: null, verificationState: "verified" },
    { id: ID(23), programCycleId: SAMPLE_CYCLE_ID, kind: "resume", label: "Resume", detail: null, quantity: 1, wordLimit: null, deadlineId: null, effortHours: null, leadTimeDays: null, evidence: null, verificationState: "verified" },
  ],
  requirementsChecked: true,
  counts: [
    { programCycleId: ID(5), stage: "applicants", count: 1000, kind: "lower_bound", provenance: "official_publication", asOf: "2026-04-15", evidence: null },
    { programCycleId: ID(5), stage: "awards", count: 120, kind: "exact", provenance: "official_publication", asOf: "2026-04-15", evidence: null },
  ],
  stageOdds: [
    {
      fromStage: "applicants",
      toStage: "awards",
      cycleYear: 2026,
      numerator: 120,
      denominator: 1000,
      denominatorKind: "lower_bound",
      sourceUrl: "https://example.org/sample-coastal/news",
      verifiedAt: "2026-11-04",
      verifiedBy: "Curator AB",
    },
  ],
  prediction: null,
  ruleSet: sampleRuleSet,
  otherCycles: [
    { cycleKey: "ay-2024-25", status: "closed" },
    { cycleKey: "ay-2025-26", status: "closed" },
  ],
  citation: {
    novusUrl: "https://example.org/programs/sample-coastal-research-scholars",
    officialUrl: "https://example.org/sample-coastal",
    basis: "official",
    evidenceUrl: "https://example.org/sample-coastal/eligibility",
    evidenceExcerpt: "Sample eligibility wording for the prototype.",
    lastVerifiedAt: "2026-11-04",
    verifiedBy: "Curator AB",
    derivation: null,
    sourceCheckedAt: CHECKED_AT,
    verificationState: "verified",
    freshness: "fresh",
    recordVersion: "3.4",
    license: "CC BY 4.0",
    termsUrl: "https://example.org/terms",
  },
  release: 1,
};

// ---------------------------------------------------------------------------------------------
// Readiness report (as the server would send it: the citizenship rule stays unknown)
// ---------------------------------------------------------------------------------------------

export const SAMPLE_READINESS: ReadinessReport = {
  programCycleId: SAMPLE_CYCLE_ID,
  programSlug: SAMPLE_PROGRAM_SLUG,
  cycleKey: "ay-2026-27",
  algoVersion: "readiness-sample",
  generatedAt: "2026-11-11T12:00:00.000Z",
  eligibility: {
    verdict: "unknown",
    status: "conditional",
    rules: [
      { ruleId: "standing", dimension: "standing", group: "all", verdict: "met", sensitive: false, reasonCode: "ELIGIBLE_STANDING", reason: "You will be a second-year student at the deadline.", officialText: "Open to students in their first or second year of a degree program.", missingFields: [], resolver: null, evidenceKey: "e1", evidence: null },
      { ruleId: "gpa", dimension: "gpa", group: "all", verdict: "met", sensitive: false, reasonCode: "GPA_MET", reason: "Your GPA band starts at 3.25.", officialText: "A cumulative GPA of 3.0 or higher.", missingFields: [], resolver: null, evidenceKey: "e1", evidence: null },
      { ruleId: "field", dimension: "field", group: "all", verdict: "met", sensitive: false, reasonCode: "FIELD_MET", reason: "Environmental science counts.", officialText: "A major in a science, engineering or environmental field.", missingFields: [], resolver: null, evidenceKey: "e1", evidence: null },
      { ruleId: "citizenship", dimension: "citizenship", group: "all", verdict: "unknown", sensitive: true, reasonCode: "SENSITIVE_ON_DEVICE", reason: "Check this rule privately on your device.", officialText: "U.S. citizens, U.S. nationals and permanent residents.", missingFields: ["citizenship"], resolver: "student", evidenceKey: "e1", evidence: null },
    ],
    pending: [
      { id: "citizenship", kind: "rule", dimension: "citizenship", sensitive: true, resolver: "student", selfCheckText: "Eligible if you are a U.S. citizen, U.S. national or permanent resident." },
    ],
    nomination: null,
    ruleSet: { id: ID(10), version: 2, hash: HASH },
    basedOnListedRequirements: false,
    asOf: "2026-11-11",
    sensitiveEvaluated: false,
  },
  requirements: {
    checked: true,
    effectiveDeadline: { date: "2027-01-28", basis: "official", scope: "national", label: "Application deadline" },
    items: [
      { key: ID(21), requirementId: ID(21), kind: "recommendation", label: "Two recommendation letters", quantity: 2, state: "gap", gap: "Ask two recommenders. Letters take about three weeks.", startBy: "2027-01-05", severity: "planned", effortHours: 2, leadDays: 21, evidence: null },
      { key: ID(20), requirementId: ID(20), kind: "essay", label: "Personal statement", quantity: 1, state: "in_progress", gap: "Finish the draft and ask someone to read it.", startBy: "2027-01-08", severity: "planned", effortHours: 6, leadDays: 14, evidence: null },
      { key: ID(22), requirementId: ID(22), kind: "transcript", label: "Transcript (unofficial is fine)", quantity: 1, state: "met", gap: null, startBy: "2027-01-21", severity: "planned", effortHours: 0.5, leadDays: 7, evidence: null },
      { key: "kind:resume", requirementId: null, kind: "resume", label: "Resume", quantity: 1, state: "met", gap: null, startBy: "2027-01-22", severity: "planned", effortHours: 3, leadDays: 3, evidence: null },
    ],
  },
  competitiveness: {
    status: "official_odds_only",
    band: null,
    reason: null,
    basis: {
      kind: "official_counts",
      summary: "Sample: the program published how many applied and how many were selected in 2026. Personal bands need about 30 verified outcomes.",
      stageOdds: SAMPLE_PROGRAM_DETAIL.stageOdds,
      currentStage: "applicants",
      factors: [],
      reportsBanded: "fewer than 10 verified reports",
      nEff: null,
      cycles: [2026],
      modelVersion: null,
      methodologyUrl: "https://example.org/methods",
    },
  },
  nextActions: [
    { id: "ask-recommenders", label: "Ask two recommenders", detail: "Letters take about three weeks, so ask before the winter break.", dueOn: "2027-01-05", severity: "planned", source: "gap", roadmapItemKey: "prep:sample-coastal:letters", relatesTo: ID(21) },
    { id: "finish-statement", label: "Finish the statement draft", detail: "Share it with an advisor or a friend for a read.", dueOn: "2027-01-08", severity: "planned", source: "gap", roadmapItemKey: "prep:sample-coastal:statement", relatesTo: ID(20) },
    { id: "answer-citizenship", label: "Check the citizenship rule privately", detail: "Answer on this device; Novus never sees it.", dueOn: null, severity: null, source: "eligibility_unknown", roadmapItemKey: null, relatesTo: "citizenship" },
    { id: "submit", label: "Submit before 11:59 PM ET", detail: null, dueOn: "2027-01-28", severity: "planned", source: "deadline", roadmapItemKey: "apply:sample-coastal:ay-2026-27", relatesTo: null },
  ],
};

// ---------------------------------------------------------------------------------------------
// Tracker
// ---------------------------------------------------------------------------------------------

function deadlineView(n: number, localDate: string, dueAt: string): DeadlineView {
  return {
    id: ID(n),
    kind: "application",
    scope: "national",
    roundLabel: "",
    basis: "official",
    precision: "exact",
    tzMode: "fixed",
    localDate,
    localTime: "23:59",
    windowStart: null,
    windowEnd: null,
    timeZone: "America/New_York",
    dueAt,
    sortAt: dueAt,
    revision: 1,
  };
}

function sampleCard(args: {
  n: number;
  slug: string;
  name: string;
  org: string;
  types: ProgramCard["opportunityTypes"];
  status: ProgramCard["status"];
  deadline: DeadlineView | null;
  prepDays: number | null;
  cycleKey?: string;
}): ProgramCard {
  return {
    programId: ID(100 + args.n),
    programCycleId: ID(200 + args.n),
    slug: args.slug,
    cycleKey: args.cycleKey ?? "summer-2027",
    name: args.name,
    organizationName: args.org,
    summary: null,
    opportunityTypes: args.types,
    status: args.status,
    verification: { state: "verified", verifiedOn: "2026-11-04", verifiedBy: "Curator AB", freshness: "fresh" },
    deadlines: args.deadline ? [args.deadline] : [],
    opensOn: null,
    prediction: null,
    classYears: ["first_year", "second_year"],
    majorFamilies: [],
    cipPrefixes: [],
    interestTags: [],
    aliases: [],
    flags: { paid: true, participantCost: false, applicationFee: false, pellDisplacement: false, sensitiveAudience: false, identityAudience: false, nominationRequired: false },
    compensation: null,
    applicationUrl: null,
    officialUrl: `https://example.org/${args.slug}`,
    prepDays: args.prepDays,
    rules: null,
    rulesFromPreviousCycle: null,
    isSample: true,
  };
}

export const SAMPLE_CARDS: ProgramCard[] = [
  { ...sampleCard({ n: 0, slug: SAMPLE_PROGRAM_SLUG, name: "Sample Coastal Research Scholars", org: "Example Ocean Agency (sample)", types: ["national_scholarship", "research_program"], status: "open", deadline: deadlineView(31, "2027-01-28", "2027-01-29T04:59:00.000Z"), prepDays: 23, cycleKey: "ay-2026-27" }), programCycleId: SAMPLE_CYCLE_ID },
  sampleCard({ n: 1, slug: "sample-software-sophomore-week", name: "Sample Software Sophomore Week", org: "Example Tech Co. (sample)", types: ["early_career_exposure"], status: "open", deadline: deadlineView(32, "2026-11-20", "2026-11-21T04:59:00.000Z"), prepDays: 6 }),
  sampleCard({ n: 2, slug: "sample-summer-research-lab", name: "Sample Summer Research Lab", org: "Example University (sample)", types: ["research_program"], status: "open", deadline: deadlineView(33, "2027-02-12", "2027-02-13T04:59:00.000Z"), prepDays: 21 }),
  sampleCard({ n: 3, slug: "sample-policy-fellows", name: "Sample Policy Fellows", org: "Example Foundation (sample)", types: ["undergraduate_fellowship"], status: "closed", deadline: deadlineView(34, "2026-10-15", "2026-10-16T03:59:00.000Z"), prepDays: null }),
  sampleCard({ n: 4, slug: "sample-design-sprint", name: "Sample Design Sprint", org: "Example Studio (sample)", types: ["sprinternship"], status: "expected", deadline: null, prepDays: null }),
];

function trackerItem(n: number, card: ProgramCard, status: TrackerItem["status"], extra: Partial<TrackerItem> = {}): TrackerItem {
  return {
    id: ID(300 + n),
    programCycleId: card.programCycleId,
    programSlug: card.slug,
    cycleKey: card.cycleKey,
    status,
    statusSource: "student",
    ownCampusDeadline: null,
    submittedOn: null,
    nameInMessages: true,
    createdAt: "2026-10-01T15:00:00.000Z",
    updatedAt: "2026-11-01T15:00:00.000Z",
    version: 1,
    ...extra,
  };
}

const [c0, c1, c2, c3, c4] = SAMPLE_CARDS as [ProgramCard, ProgramCard, ProgramCard, ProgramCard, ProgramCard];

export const SAMPLE_TRACKER: TrackerItem[] = [
  trackerItem(0, c0, "applying"),
  trackerItem(1, c1, "applying"),
  trackerItem(2, c2, "interested"),
  trackerItem(3, c3, "submitted", { submittedOn: "2026-10-12" }),
  trackerItem(4, c4, "interested"),
];
