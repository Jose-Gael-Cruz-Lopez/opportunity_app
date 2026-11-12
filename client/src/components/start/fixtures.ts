import type {
  Compensation,
  EligibilityRule,
  EligibilityRuleSet,
  MajorFamily,
  OpportunityTypeSlug,
  Program,
  ProgramCard,
  ProgramCycle,
  Requirement,
  RequirementKind,
} from "@shared/contracts";

/**
 * SAMPLE programs for onboarding when the API is unreachable, and for tests and demos.
 * Every name, organization and URL here is fictional and labelled "Sample"; none of it is a
 * verified fact about a real program. Deadlines are computed from `now`, so the standalone
 * flow always has open programs to show instead of going stale after one season.
 */

export interface SampleProgram {
  card: ProgramCard;
  program: Program;
  cycle: ProgramCycle;
  requirements: Requirement[];
  /** Device-side display hints the card schema does not carry yet. */
  meta: { remote: boolean; place: string };
}

interface Spec {
  n: number;
  slug: string;
  name: string;
  org: string;
  summary: string;
  types: OpportunityTypeSlug[];
  families: MajorFamily[];
  tags: string[];
  /** Days from now to the application deadline; null means rolling. */
  dueInDays: number | null;
  compensation: Compensation | null;
  remote: boolean;
  place: string;
  /** Adds an on-device citizenship rule, to exercise the private eligibility screen. */
  citizenshipRule?: boolean;
  reqs: Array<{ kind: RequirementKind; label: string; quantity?: number; wordLimit?: number; effortHours: number; leadTimeDays?: number }>;
}

const SPECS: Spec[] = [
  {
    n: 1,
    slug: "sample-coastal-data-fellowship",
    name: "Sample Coastal Data Summer Fellowship",
    org: "Sample Ocean Lab",
    summary: "Ten weeks analysing coastal sensor data with a research mentor. Sample listing for the onboarding demo.",
    types: ["undergraduate_fellowship", "research_program"],
    families: ["life_sciences", "computing", "physical_sciences", "agriculture_environment"],
    tags: ["python", "data analysis", "climate", "ocean science", "research"],
    dueInDays: 45,
    compensation: { kind: "stipend", amountCents: 600000, period: "total" },
    remote: false,
    place: "On site, coastal campus",
    citizenshipRule: true,
    reqs: [
      { kind: "resume", label: "Resume", effortHours: 1 },
      { kind: "essay", label: "Statement of interest", wordLimit: 300, effortHours: 3 },
      { kind: "recommendation", label: "One letter of recommendation", quantity: 1, effortHours: 1, leadTimeDays: 21 },
    ],
  },
  {
    n: 2,
    slug: "sample-tech-discovery-week",
    name: "Sample Tech Discovery Week",
    org: "Sample Software Co.",
    summary: "A paid week of workshops and a team project for first- and second-year students new to tech. Sample listing.",
    types: ["early_career_exposure"],
    families: ["computing", "engineering_technology", "math_statistics"],
    tags: ["software engineering", "javascript", "python", "teamwork"],
    dueInDays: 24,
    compensation: { kind: "travel", amountCents: null, period: null, note: "Travel and lodging covered" },
    remote: true,
    place: "Remote, with an optional in-person day",
    reqs: [
      { kind: "resume", label: "Resume", effortHours: 1 },
      { kind: "essay", label: "Short answer: what would you build?", wordLimit: 150, effortHours: 1 },
    ],
  },
  {
    n: 3,
    slug: "sample-community-health-research",
    name: "Sample Community Health Research Program",
    org: "Sample University Health Institute",
    summary: "Summer research on community health questions, with a weekly seminar. Sample listing.",
    types: ["research_program"],
    families: ["health", "life_sciences", "social_sciences"],
    tags: ["public health", "research", "biology", "statistics", "data analysis"],
    dueInDays: 62,
    compensation: { kind: "stipend", amountCents: 500000, period: "total" },
    remote: false,
    place: "On site",
    citizenshipRule: true,
    reqs: [
      { kind: "resume", label: "Resume", effortHours: 1 },
      { kind: "essay", label: "Research interest essay", wordLimit: 500, effortHours: 4 },
      { kind: "recommendation", label: "Two letters of recommendation", quantity: 2, effortHours: 1, leadTimeDays: 21 },
      { kind: "transcript", label: "Unofficial transcript", effortHours: 0.5 },
    ],
  },
  {
    n: 4,
    slug: "sample-first-year-finance-insight",
    name: "Sample First-Year Finance Insight Program",
    org: "Sample Capital Partners",
    summary: "Two days of sessions on markets, banking and careers in finance for first-years. Sample listing.",
    types: ["early_career_exposure"],
    families: ["business", "math_statistics", "social_sciences"],
    tags: ["finance", "excel", "economics", "communication"],
    dueInDays: 19,
    compensation: { kind: "travel", amountCents: null, period: null, note: "Travel covered" },
    remote: false,
    place: "In person, city office",
    reqs: [
      { kind: "resume", label: "Resume", effortHours: 1 },
      { kind: "essay", label: "Why finance? (short answer)", wordLimit: 200, effortHours: 1.5 },
    ],
  },
  {
    n: 5,
    slug: "sample-open-source-starter-sprint",
    name: "Sample Open Source Starter Sprint",
    org: "Sample Open Source Foundation",
    summary: "A four-week remote sprint where mentors help you land a first open-source contribution. Rolling. Sample listing.",
    types: ["open_source_mentorship", "sprinternship"],
    families: ["computing", "engineering_technology"],
    tags: ["open source", "git", "python", "javascript", "documentation"],
    dueInDays: null,
    compensation: { kind: "stipend", amountCents: 100000, period: "total" },
    remote: true,
    place: "Remote",
    reqs: [{ kind: "resume", label: "Resume or short profile", effortHours: 0.5 }],
  },
  {
    n: 6,
    slug: "sample-civic-design-fellowship",
    name: "Sample Civic Design Fellowship",
    org: "Sample City Lab",
    summary: "A spring cohort that redesigns one public service with city staff. Sample listing.",
    types: ["leadership_cohort"],
    families: ["arts_design", "communication_media", "law_policy_service", "social_sciences"],
    tags: ["design", "writing", "policy", "research", "community"],
    dueInDays: 35,
    compensation: { kind: "stipend", amountCents: 150000, period: "total" },
    remote: false,
    place: "Hybrid",
    reqs: [
      { kind: "portfolio", label: "Two work samples", effortHours: 2 },
      { kind: "essay", label: "Statement", wordLimit: 400, effortHours: 3 },
      { kind: "recommendation", label: "One letter of recommendation", quantity: 1, effortHours: 1, leadTimeDays: 21 },
    ],
  },
  {
    n: 7,
    slug: "sample-stem-futures-scholarship",
    name: "Sample STEM Futures Scholarship",
    org: "Sample Education Fund",
    summary: "A merit scholarship for early STEM students, with a mentor match. Sample listing.",
    types: ["national_scholarship"],
    families: ["computing", "engineering_technology", "life_sciences", "physical_sciences", "math_statistics"],
    tags: ["stem", "leadership", "community", "research"],
    dueInDays: 52,
    compensation: { kind: "award", amountCents: 250000, period: "one_time" },
    remote: true,
    place: "Anywhere",
    citizenshipRule: true,
    reqs: [
      { kind: "essay", label: "Personal essay", wordLimit: 500, effortHours: 4 },
      { kind: "recommendation", label: "One letter of recommendation", quantity: 1, effortHours: 1, leadTimeDays: 21 },
      { kind: "transcript", label: "Transcript", effortHours: 0.5 },
    ],
  },
  {
    n: 8,
    slug: "sample-climate-policy-travel-award",
    name: "Sample Climate Policy Conference Travel Award",
    org: "Sample Climate Network",
    summary: "Covers travel to a national climate policy conference, with a student track. Sample listing.",
    types: ["conference_travel"],
    families: ["agriculture_environment", "social_sciences", "law_policy_service"],
    tags: ["climate", "policy", "sustainability", "writing"],
    dueInDays: 12,
    compensation: { kind: "travel", amountCents: 120000, period: "one_time" },
    remote: false,
    place: "Conference city",
    reqs: [
      { kind: "essay", label: "Short essay", wordLimit: 250, effortHours: 2 },
      { kind: "recommendation", label: "One letter of recommendation", quantity: 1, effortHours: 1, leadTimeDays: 21 },
    ],
  },
  {
    n: 9,
    slug: "sample-biotech-lab-apprenticeship",
    name: "Sample Biotech Lab Apprenticeship",
    org: "Sample Bio Works",
    summary: "A paid, part-time apprenticeship in a teaching lab, with training from day one. Sample listing.",
    types: ["apprenticeship"],
    families: ["life_sciences", "engineering_technology", "health"],
    tags: ["lab skills", "biology", "chemistry", "teamwork"],
    dueInDays: 40,
    compensation: { kind: "salary_hourly", amountCents: 2000, period: "hour" },
    remote: false,
    place: "On site",
    reqs: [
      { kind: "resume", label: "Resume", effortHours: 1 },
      { kind: "interview", label: "Short interview", effortHours: 1 },
    ],
  },
];

const hex = (n: number, width: number) => n.toString(16).padStart(width, "0");
/** Deterministic, valid UUIDs so tests and saved progress stay stable across reloads. */
export const sampleId = (kind: number, n: number, sub = 0) =>
  `5a3e${hex(kind, 4)}-0000-4000-8000-${hex(n, 6)}${hex(sub, 6)}`;

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(now: Date, days: number): Date {
  return new Date(now.getTime() + days * 86_400_000);
}

/** prepDays as plan 06 defines it: max over requirements of lead time plus effort days (1 h a day). */
export function prepDaysFor(reqs: Spec["reqs"]): number {
  let max = 0;
  for (const r of reqs) {
    const effortDays = Math.ceil(r.effortHours * (r.quantity ?? 1));
    max = Math.max(max, (r.leadTimeDays ?? 0) + effortDays);
  }
  return max;
}

const STANDING_RULE: EligibilityRule = {
  id: "standing.early",
  dimension: "standing",
  group: "all",
  logic: { in: [{ var: "classYear" }, ["incoming_first_year", "first_year", "second_year"]] },
  fields: ["classYear"],
  sensitive: false,
  asOf: "today",
  borderline: [],
  officialText: "Open to first- and second-year undergraduates (sample rule).",
  evidenceKey: null,
};

const CITIZENSHIP_RULE: EligibilityRule = {
  id: "citizenship.us",
  dimension: "citizenship",
  group: "all",
  logic: { in: [{ var: "citizenship" }, ["us_citizen", "us_national", "permanent_resident"]] },
  fields: ["citizenship"],
  sensitive: true,
  asOf: "today",
  borderline: [],
  officialText: "Open to U.S. citizens, U.S. nationals and permanent residents (sample rule).",
  evidenceKey: null,
};

function ruleSet(spec: Spec, cycleId: string): EligibilityRuleSet {
  return {
    id: sampleId(5, spec.n),
    programCycleId: cycleId,
    version: 1,
    format: "jsonlogic-v1",
    state: "draft",
    templateKey: null,
    coverage: {
      standing: "encoded",
      enrollment: "no_restriction",
      transfer: "no_restriction",
      gpa: "no_restriction",
      citizenship: spec.citizenshipRule ? "encoded" : "no_restriction",
      pell: "no_restriction",
    },
    rules: spec.citizenshipRule ? [STANDING_RULE, CITIZENSHIP_RULE] : [STANDING_RULE],
    anyOf: [],
    attestations: [],
    nomination: null,
    evidence: {},
    hash: null,
    createdVia: "sample",
    verifiedAt: null,
    verifiedBy: null,
    fromCycleKey: null,
  };
}

function build(spec: Spec, now: Date): SampleProgram {
  const programId = sampleId(1, spec.n);
  const cycleId = sampleId(2, spec.n);
  const orgId = sampleId(3, spec.n);
  const due = spec.dueInDays === null ? null : isoDate(addDays(now, spec.dueInDays));
  const nowIso = now.toISOString();
  const year = now.getUTCFullYear() + (now.getUTCMonth() >= 6 ? 1 : 0);
  const cycleKey = `summer-${year}`;
  const officialUrl = `https://example.org/sample/${spec.slug}`;
  const applicationUrl = `${officialUrl}/apply`;
  const prepDays = prepDaysFor(spec.reqs);
  const rules = ruleSet(spec, cycleId);
  const paid = spec.compensation !== null && spec.compensation.kind !== "none";

  const requirements: Requirement[] = spec.reqs.map((r, i) => ({
    id: sampleId(4, spec.n, i + 1),
    programCycleId: cycleId,
    kind: r.kind,
    label: r.label,
    detail: null,
    quantity: r.quantity ?? 1,
    wordLimit: r.wordLimit ?? null,
    deadlineId: null,
    effortHours: r.effortHours,
    leadTimeDays: r.leadTimeDays ?? null,
    evidence: null,
    verificationState: "unverified",
  }));

  const card: ProgramCard = {
    programId,
    programCycleId: cycleId,
    slug: spec.slug,
    cycleKey,
    name: spec.name,
    organizationName: spec.org,
    summary: spec.summary,
    opportunityTypes: spec.types,
    status: "open",
    verification: { state: "unverified", verifiedOn: null, verifiedBy: null, freshness: "fresh" },
    deadlines: [
      {
        id: sampleId(6, spec.n),
        kind: "application",
        scope: "national",
        roundLabel: "",
        basis: "official",
        precision: due ? "date_only" : "rolling",
        tzMode: "fixed",
        localDate: due,
        localTime: null,
        windowStart: null,
        windowEnd: null,
        timeZone: due ? "America/New_York" : null,
        dueAt: due ? `${due}T23:59:00-05:00` : null,
        sortAt: due ? `${due}T23:59:00-05:00` : null,
        revision: 1,
      },
    ],
    opensOn: null,
    prediction: null,
    classYears: ["incoming_first_year", "first_year", "second_year"],
    majorFamilies: spec.families,
    cipPrefixes: [],
    interestTags: spec.tags,
    aliases: [],
    flags: {
      paid,
      participantCost: false,
      applicationFee: false,
      pellDisplacement: false,
      sensitiveAudience: false,
      identityAudience: false,
      nominationRequired: false,
    },
    compensation: spec.compensation,
    applicationUrl,
    officialUrl,
    prepDays,
    rules,
    rulesFromPreviousCycle: null,
    isSample: true,
  };

  const program: Program = {
    id: programId,
    slug: spec.slug,
    name: spec.name,
    organizationId: orgId,
    summary: spec.summary,
    officialUrl,
    recurrence: spec.dueInDays === null ? "rolling" : "annual",
    lifecycle: "active",
    opportunityTypes: spec.types,
    sensitiveAudience: false,
    identityAudience: [],
    majorFamilies: spec.families,
    interestTags: spec.tags,
    aliases: [],
    isWedge: false,
    isPublished: true,
    isSample: true,
    version: 1,
  };

  const cycle: ProgramCycle = {
    id: cycleId,
    programId,
    cycleKey,
    termLabel: `Summer ${year}`,
    cycleModel: spec.dueInDays === null ? "rolling" : "term",
    status: "open",
    statusChangedAt: nowIso,
    statusChangedBy: "system:sample",
    timeZone: due ? "America/New_York" : null,
    opensOn: null,
    predictedOpensOn: null,
    predictionLabel: null,
    decisionWindowStart: null,
    decisionWindowEnd: null,
    decisionsReleasedOn: null,
    eventStart: null,
    eventEnd: null,
    applicationUrl,
    pellDisplacement: "unknown",
    applicationFeeCents: 0,
    participantCostCents: 0,
    compensation: spec.compensation,
    verificationState: "unverified",
    lastVerifiedAt: null,
    verifiedBy: null,
    sourceCheckedAt: null,
    rolledOverFromId: null,
    version: 1,
  };

  return { card, program, cycle, requirements, meta: { remote: spec.remote, place: spec.place } };
}

/** All sample programs with deadlines relative to `now`. */
export function buildSamplePrograms(now: Date): SampleProgram[] {
  return SPECS.map((s) => build(s, now));
}

export const SAMPLE_COUNT = SPECS.length;
