import type {
  ClassYear,
  CycleModel,
  DeadlineKind,
  IdentityCategory,
  MajorFamily,
  OpportunityTypeSlug,
  OrganizationKind,
  PellDisplacement,
  Recurrence,
  RequirementKind,
  Term,
} from "../../../shared/taxonomy";
import type { Compensation } from "../../../shared/contracts/registry";
import type { EligibilityRule, NominationProcess } from "../../../shared/contracts/eligibility";
import * as R from "./rules";

/**
 * SAMPLE DATA. Every organization, program, date, rule and quote below is invented for local
 * development and demos. Names say "Sample" or "Example", every URL is on example.org, and every
 * row is stored with `is_sample = 1` (rule sets with `created_via = 'sample'`). None of it
 * describes a real program, so none of it may be shown as a verified fact about one.
 *
 * Dates are offsets in days from the seed's `today` (default 2026-11-11), so the demo stays
 * realistic whenever it is reseeded.
 */

export const SAMPLE_TODAY = "2026-11-11";
export const SAMPLE_CURATOR_HANDLE = "Sample Curator";
export const SAMPLE_URL_BASE = "https://example.org/sample";

export interface SampleOrganization {
  key: string;
  name: string;
  kind: OrganizationKind;
  country: string;
  timeZone: string;
}

export const SAMPLE_ORGANIZATIONS: readonly SampleOrganization[] = [
  { key: "example-analytics-co", name: "Example Analytics Co (sample)", kind: "company", country: "US", timeZone: "America/New_York" },
  { key: "example-manufacturing", name: "Example Manufacturing Group (sample)", kind: "company", country: "US", timeZone: "America/Chicago" },
  { key: "example-bank-uk", name: "Example Bank UK (sample)", kind: "company", country: "GB", timeZone: "Europe/London" },
  { key: "example-tech-nonprofit", name: "Example Tech Access Nonprofit (sample)", kind: "nonprofit", country: "US", timeZone: "America/Los_Angeles" },
  { key: "example-science-foundation", name: "Example Science Foundation (sample)", kind: "foundation", country: "US", timeZone: "America/Chicago" },
  { key: "example-federal-office", name: "Example Federal Education Office (sample)", kind: "federal_agency", country: "US", timeZone: "America/New_York" },
  { key: "example-community-foundation", name: "Example Community Foundation (sample)", kind: "foundation", country: "US", timeZone: "America/Los_Angeles" },
  { key: "sample-state-university-org", name: "Sample State University (sample)", kind: "university", country: "US", timeZone: "America/Denver" },
  { key: "example-research-society", name: "Example Undergraduate Research Society (sample)", kind: "professional_society", country: "US", timeZone: "America/New_York" },
  { key: "example-open-source-collective", name: "Example Open Source Collective (sample)", kind: "nonprofit", country: "US", timeZone: "America/Los_Angeles" },
  { key: "example-service-corps", name: "Example Service Corps (sample)", kind: "nonprofit", country: "US", timeZone: "America/New_York" },
  { key: "example-venture-studio", name: "Example Venture Studio (sample)", kind: "company", country: "US", timeZone: "America/Los_Angeles" },
  { key: "example-language-institute", name: "Example Language Institute (sample)", kind: "nonprofit", country: "US", timeZone: "America/New_York" },
];

export interface SampleInstitution {
  key: string;
  name: string;
  level: "two_year" | "four_year";
  state: string;
  timeZone: string;
  calendar: "semester" | "quarter";
  emailDomain: string;
}

export const SAMPLE_INSTITUTIONS: readonly SampleInstitution[] = [
  { key: "sample-state-university", name: "Sample State University (sample)", level: "four_year", state: "CO", timeZone: "America/Denver", calendar: "semester", emailDomain: "students.sample-state.example.org" },
  { key: "sample-community-college", name: "Sample Community College (sample)", level: "two_year", state: "AZ", timeZone: "America/Phoenix", calendar: "semester", emailDomain: "mail.sample-cc.example.org" },
];

export interface SampleDeadline {
  kind: DeadlineKind;
  precision: "exact" | "date_only" | "month_only" | "rolling" | "tbd" | "window";
  /** Days after `today` (negative = already passed). Ignored for rolling, tbd and window rows. */
  inDays?: number;
  /** `HH:MM` for exact rows. */
  time?: string;
  /** "11:59 pm, your time zone" style rows. */
  applicantLocal?: boolean;
  /** A campus row at this sample institution. */
  campusInstitution?: string;
  round?: string;
  /** Predicted rows: p10, p50, p90 as day offsets. */
  window?: readonly [number, number, number];
}

export interface SampleRequirement {
  kind: RequirementKind;
  label: string;
  quantity?: number;
  wordLimit?: number;
  leadTimeDays?: number;
  effortHours?: number;
}

export interface SampleRuleContext {
  institutionId: (key: string) => string;
}

export interface SampleProgram {
  slug: string;
  name: string;
  org: string;
  types: readonly OpportunityTypeSlug[];
  summary: string;
  recurrence: Recurrence;
  term: Term;
  model?: CycleModel;
  /** Day offset of the opening; positive means the cycle is still expected. */
  opensInDays?: number;
  deadlines: readonly SampleDeadline[];
  /** Day offsets for event programs (conferences). */
  event?: readonly [number, number];
  classYears: readonly ClassYear[];
  rules: (ctx: SampleRuleContext) => EligibilityRule[];
  anyOf?: readonly { id: string; label: string }[];
  attestations?: readonly { id: string; dimension: EligibilityRule["dimension"]; text: string }[];
  nomination?: NominationProcess;
  requirements: readonly SampleRequirement[];
  majorFamilies?: readonly MajorFamily[];
  cip?: readonly (readonly [string, "core" | "related" | "borderline"])[];
  tags?: readonly string[];
  aliases?: readonly string[];
  compensation?: Compensation;
  applicationFeeCents?: number;
  participantCostCents?: number;
  pellDisplacement?: PellDisplacement;
  sensitiveAudience?: boolean;
  identityAudience?: readonly IdentityCategory[];
  /** Left unverified to exercise the "Not yet verified" state. */
  unverified?: boolean;
  isWedge?: boolean;
}

const EARLY: readonly ClassYear[] = ["first_year", "second_year"];
const UNDERGRAD: readonly ClassYear[] = ["first_year", "second_year", "third_year", "fourth_year"];

export const SAMPLE_PROGRAMS: readonly SampleProgram[] = [
  {
    slug: "sample-summer-analytics-internship",
    name: "Sample Summer Analytics Internship",
    org: "example-analytics-co",
    types: ["summer_internship"],
    summary: "Sample listing: a ten-week paid analytics internship for first- and second-year students, with a mentor and a final project.",
    recurrence: "annual",
    term: "summer",
    opensInDays: -30,
    deadlines: [{ kind: "application", precision: "exact", inDays: 45, time: "23:59" }],
    classYears: EARLY,
    rules: () => [R.standing(EARLY, "Sample rule: open to first- and second-year undergraduates."), R.fullTime()],
    requirements: [
      { kind: "resume", label: "One-page resume" },
      { kind: "essay", label: "Short answer: a problem you solved with data", wordLimit: 300 },
      { kind: "interview", label: "Two virtual interviews" },
    ],
    majorFamilies: ["computing", "math_statistics", "business"],
    cip: [["11", "core"], ["27", "core"], ["52", "related"]],
    tags: ["data", "analytics", "paid"],
    compensation: { kind: "salary_hourly", amountCents: 2400, period: "hour" },
    isWedge: true,
  },
  {
    slug: "sample-engineering-co-op",
    name: "Sample Engineering Co-op",
    org: "example-manufacturing",
    types: ["off_cycle_internship"],
    summary: "Sample listing: a paid spring or fall co-op rotation in manufacturing engineering, reviewed on a rolling basis.",
    recurrence: "rolling",
    term: "rolling",
    model: "rolling",
    deadlines: [{ kind: "application", precision: "rolling" }],
    classYears: ["second_year", "third_year"],
    rules: () => [
      R.standing(["second_year", "third_year"], "Sample rule: open to students who have completed at least one year of study."),
      R.majorCip(["14", "15"], "Sample rule: engineering or engineering technology majors.", ["40"]),
    ],
    requirements: [
      { kind: "resume", label: "Resume" },
      { kind: "transcript", label: "Unofficial transcript" },
    ],
    majorFamilies: ["engineering_technology"],
    cip: [["14", "core"], ["15", "core"], ["40", "borderline"]],
    tags: ["engineering", "co-op", "paid"],
    compensation: { kind: "salary_hourly", amountCents: 2200, period: "hour" },
  },
  {
    slug: "sample-rotational-leadership-program",
    name: "Sample Rotational Leadership Program",
    org: "example-analytics-co",
    types: ["new_grad_rotational"],
    summary: "Sample listing: a two-year rotational program for graduating students; shown here so early-year students can plan ahead.",
    recurrence: "annual",
    term: "year",
    opensInDays: 200,
    deadlines: [{ kind: "application", precision: "window", window: [230, 250, 275] }],
    classYears: ["fourth_year", "recent_graduate"],
    rules: () => [R.standing(["fourth_year", "recent_graduate"], "Sample rule: graduating seniors and recent graduates.")],
    requirements: [
      { kind: "resume", label: "Resume" },
      { kind: "essay", label: "Cover letter", wordLimit: 500 },
    ],
    tags: ["leadership", "rotational"],
    compensation: { kind: "salary_hourly", amountCents: 3500, period: "hour" },
  },
  {
    slug: "sample-discovery-insight-day",
    name: "Sample Discovery Insight Day",
    org: "example-analytics-co",
    types: ["early_career_exposure"],
    summary: "Sample listing: a one-day virtual insight program introducing analytics careers to first-year students.",
    recurrence: "annual",
    term: "spring",
    opensInDays: -10,
    deadlines: [{ kind: "application", precision: "date_only", inDays: 20 }],
    event: [70, 70],
    classYears: ["incoming_first_year", "first_year"],
    rules: () => [R.standing(["incoming_first_year", "first_year"], "Sample rule: first-year students only.")],
    requirements: [{ kind: "essay", label: "Short answer: why this career interests you", wordLimit: 150 }],
    tags: ["insight", "virtual", "first-year"],
    aliases: ["insight day"],
    compensation: { kind: "none", amountCents: null, period: null },
    isWedge: true,
  },
  {
    slug: "sample-spring-week-london",
    name: "Sample Spring Week (London)",
    org: "example-bank-uk",
    types: ["uk_spring_week"],
    summary: "Sample listing: a week-long spring insight programme in London for students in their first year of a UK degree.",
    recurrence: "annual",
    term: "spring",
    opensInDays: -40,
    deadlines: [{ kind: "application", precision: "month_only", inDays: 50 }],
    classYears: ["first_year"],
    rules: () => [R.standing(["first_year"], "Sample rule: first-year undergraduates.")],
    requirements: [
      { kind: "resume", label: "CV" },
      { kind: "test_score", label: "Online situational judgement test" },
    ],
    tags: ["finance", "insight", "uk"],
    aliases: ["spring week"],
    compensation: { kind: "stipend", amountCents: 50000, period: "total" },
  },
  {
    slug: "sample-sprinternship",
    name: "Sample Sprinternship",
    org: "example-tech-nonprofit",
    types: ["sprinternship"],
    summary: "Sample listing: a three-week paid team sprint at a host company over a school break.",
    recurrence: "biannual",
    term: "spring",
    opensInDays: -5,
    deadlines: [{ kind: "application", precision: "exact", inDays: 33, time: "23:59", applicantLocal: true }],
    classYears: EARLY,
    rules: () => [
      R.standing(EARLY, "Sample rule: first- and second-year students."),
      R.institutionLevel(["two_year", "four_year"], "Sample rule: enrolled at a two-year or four-year college."),
    ],
    requirements: [
      { kind: "essay", label: "Two short answers", quantity: 2, wordLimit: 200 },
      { kind: "interview", label: "Group interview" },
    ],
    majorFamilies: ["computing"],
    cip: [["11", "core"]],
    tags: ["tech", "paid", "sprint"],
    aliases: ["sprintship"],
    compensation: { kind: "stipend", amountCents: 150000, period: "total" },
    isWedge: true,
  },
  {
    slug: "sample-job-shadow-week",
    name: "Sample Job Shadow Week",
    org: "example-manufacturing",
    types: ["externship_shadowing"],
    summary: "Sample listing: shadow an engineer for a week over winter break.",
    recurrence: "annual",
    term: "winter",
    opensInDays: -20,
    deadlines: [{ kind: "application", precision: "date_only", inDays: 12 }],
    event: [40, 44],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: current undergraduates."), R.minAge(18)],
    requirements: [{ kind: "essay", label: "Short statement of interest", wordLimit: 250 }],
    tags: ["shadowing", "engineering"],
  },
  {
    slug: "sample-micro-internship-board",
    name: "Sample Micro-internship Board",
    org: "example-tech-nonprofit",
    types: ["micro_internship"],
    summary: "Sample listing: short paid projects of 10 to 40 hours posted year-round.",
    recurrence: "rolling",
    term: "rolling",
    model: "rolling",
    deadlines: [{ kind: "application", precision: "rolling" }],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: current undergraduates.")],
    requirements: [{ kind: "resume", label: "Profile with resume" }],
    tags: ["paid", "project", "remote"],
    compensation: { kind: "varies", amountCents: null, period: null },
  },
  {
    slug: "sample-virtual-job-simulation",
    name: "Sample Virtual Job Simulation",
    org: "example-bank-uk",
    types: ["virtual_job_simulation"],
    summary: "Sample listing: a free self-paced simulation of tasks in an analyst role.",
    recurrence: "rolling",
    term: "rolling",
    model: "rolling",
    deadlines: [{ kind: "application", precision: "rolling" }],
    classYears: ["incoming_first_year", ...UNDERGRAD],
    rules: () => [],
    requirements: [],
    tags: ["self-paced", "free", "finance"],
    compensation: { kind: "none", amountCents: null, period: null },
  },
  {
    slug: "sample-registered-apprenticeship",
    name: "Sample Registered Apprenticeship",
    org: "example-manufacturing",
    types: ["apprenticeship", "paid_training"],
    summary: "Sample listing: a paid earn-and-learn apprenticeship with classroom training at a partner college.",
    recurrence: "annual",
    term: "fall",
    opensInDays: -60,
    deadlines: [{ kind: "application", precision: "exact", inDays: 75, time: "17:00" }],
    classYears: ["incoming_first_year", "first_year", "second_year"],
    rules: () => [R.minAge(18), R.institutionLevel(["two_year"], "Sample rule: enrolled at a two-year college.")],
    requirements: [
      { kind: "transcript", label: "High school or college transcript" },
      { kind: "interview", label: "Panel interview" },
    ],
    majorFamilies: ["trades_applied", "engineering_technology"],
    cip: [["47", "core"], ["48", "core"], ["15", "related"]],
    tags: ["apprenticeship", "paid", "trades"],
    compensation: { kind: "salary_hourly", amountCents: 1900, period: "hour" },
  },
  {
    slug: "sample-summer-research-fellowship",
    name: "Sample Summer Research Fellowship",
    org: "example-science-foundation",
    types: ["undergraduate_fellowship", "research_program"],
    summary: "Sample listing: a funded ten-week lab placement with a faculty mentor, housing and travel.",
    recurrence: "annual",
    term: "summer",
    opensInDays: -15,
    deadlines: [
      { kind: "application", precision: "exact", inDays: 80, time: "17:00" },
      { kind: "recommendation", precision: "exact", inDays: 87, time: "17:00" },
    ],
    classYears: ["first_year", "second_year", "third_year"],
    rules: () => [
      R.standing(["first_year", "second_year", "third_year"], "Sample rule: undergraduates who will return to school next fall."),
      R.gpaAtLeast(3.0),
      R.citizenship(["us_citizen", "us_national", "permanent_resident"], "Sample rule: U.S. citizens, nationals and permanent residents."),
    ],
    requirements: [
      { kind: "essay", label: "Research interest statement", wordLimit: 750, leadTimeDays: 21 },
      { kind: "recommendation", label: "Faculty letters of recommendation", quantity: 2, leadTimeDays: 28 },
      { kind: "transcript", label: "Unofficial transcript" },
    ],
    majorFamilies: ["life_sciences", "physical_sciences", "math_statistics"],
    cip: [["26", "core"], ["40", "core"], ["27", "related"]],
    tags: ["research", "stem", "funded"],
    compensation: { kind: "stipend", amountCents: 650000, period: "total" },
    isWedge: true,
  },
  {
    slug: "sample-graduate-research-fellowship",
    name: "Sample Graduate Research Fellowship",
    org: "example-science-foundation",
    types: ["graduate_fellowship"],
    summary: "Sample listing: three years of graduate funding; listed so students can plan coursework and research early.",
    recurrence: "annual",
    term: "fall",
    opensInDays: -120,
    deadlines: [{ kind: "application", precision: "exact", inDays: -20, time: "17:00" }],
    classYears: ["fourth_year", "recent_graduate", "graduate"],
    rules: () => [
      R.standing(["fourth_year", "recent_graduate", "graduate"], "Sample rule: seniors, recent graduates and first-year graduate students."),
      R.citizenship(["us_citizen", "us_national", "permanent_resident"], "Sample rule: U.S. citizens, nationals and permanent residents."),
    ],
    requirements: [
      { kind: "essay", label: "Personal statement", wordLimit: 1000, leadTimeDays: 45 },
      { kind: "essay", label: "Research plan", wordLimit: 1000, leadTimeDays: 45 },
      { kind: "recommendation", label: "Reference letters", quantity: 3, leadTimeDays: 30 },
    ],
    tags: ["graduate", "research", "funded"],
    compensation: { kind: "stipend", amountCents: 3700000, period: "year" },
  },
  {
    slug: "sample-national-stem-scholarship",
    name: "Sample National STEM Scholarship",
    org: "example-federal-office",
    types: ["national_scholarship"],
    summary: "Sample listing: a merit scholarship for sophomores and juniors in STEM that requires a campus nomination.",
    recurrence: "annual",
    term: "ay",
    opensInDays: -45,
    deadlines: [
      { kind: "campus_internal", precision: "exact", inDays: 38, time: "23:59", campusInstitution: "sample-state-university" },
      { kind: "nomination", precision: "exact", inDays: 79, time: "17:00" },
    ],
    classYears: ["second_year", "third_year"],
    rules: () => [
      R.semestersLeft(1, 4, "Sample rule: one to four full-time semesters of undergraduate study left at the program start."),
      R.fullTime("Sample rule: full-time matriculated students."),
      R.gpaAtLeast(3.0),
      R.citizenship(["us_citizen", "us_national", "permanent_resident"], "Sample rule: U.S. citizens, nationals and permanent residents."),
      R.participates(),
    ],
    nomination: {
      nominator: "campus_rep",
      campusDeadlineKinds: ["campus_internal"],
      quota: { base: 4, bonuses: [], max: 4 },
      evidenceKey: "e8",
    },
    requirements: [
      { kind: "campus_nomination", label: "Nomination by your campus representative", leadTimeDays: 30 },
      { kind: "essay", label: "Research essay", wordLimit: 1200, leadTimeDays: 42 },
      { kind: "recommendation", label: "Letters of recommendation", quantity: 3, leadTimeDays: 30 },
    ],
    majorFamilies: ["physical_sciences", "math_statistics", "engineering_technology", "life_sciences", "computing"],
    cip: [["26", "core"], ["27", "core"], ["40", "core"], ["14", "core"], ["11", "core"]],
    tags: ["scholarship", "stem", "nomination"],
    compensation: { kind: "award", amountCents: 750000, period: "year" },
    pellDisplacement: "possible",
    isWedge: true,
  },
  {
    slug: "sample-community-foundation-scholarship",
    name: "Sample Community Foundation Scholarship",
    org: "example-community-foundation",
    types: ["private_scholarship"],
    summary: "Sample listing: a renewable award for West Coast residents; one of the eligibility routes is first-generation status.",
    recurrence: "annual",
    term: "ay",
    opensInDays: -25,
    deadlines: [{ kind: "application", precision: "date_only", inDays: 95 }],
    classYears: ["incoming_first_year", "first_year", "second_year"],
    rules: () => [
      R.residency(["CA", "OR", "WA"], "Sample rule: residents of California, Oregon or Washington."),
      R.standing(["incoming_first_year", "first_year", "second_year"], "Sample rule: entering or current first- and second-year students."),
      R.firstGeneration("access"),
      R.gpaAtLeast(3.5, "e3"),
    ].map((r) => (r.id === "gpa" ? { ...r, group: "access" } : r)),
    anyOf: [{ id: "access", label: "First-generation students or students with a GPA of at least 3.5" }],
    requirements: [
      { kind: "essay", label: "Personal essay", wordLimit: 500, leadTimeDays: 14 },
      { kind: "recommendation", label: "One recommendation" },
    ],
    tags: ["scholarship", "renewable"],
    compensation: { kind: "award", amountCents: 250000, period: "year" },
    pellDisplacement: "possible",
  },
  {
    slug: "sample-campus-merit-award",
    name: "Sample Campus Merit Award",
    org: "sample-state-university-org",
    types: ["institutional_scholarship"],
    summary: "Sample listing: a campus-funded award for continuing students at Sample State University.",
    recurrence: "annual",
    term: "ay",
    opensInDays: -5,
    deadlines: [{ kind: "application", precision: "exact", inDays: 60, time: "23:59" }],
    classYears: ["first_year", "second_year", "third_year"],
    rules: (ctx) => [
      R.atInstitution(ctx.institutionId("sample-state-university"), "Sample rule: enrolled at Sample State University."),
      R.gpaAtLeast(3.25),
    ],
    requirements: [{ kind: "essay", label: "Short essay", wordLimit: 400 }],
    tags: ["campus", "scholarship"],
    compensation: { kind: "tuition", amountCents: 200000, period: "year" },
  },
  {
    slug: "sample-public-service-scholarship",
    name: "Sample Public Service Scholarship",
    org: "example-federal-office",
    types: ["service_scholarship", "government_service"],
    summary: "Sample listing: tuition support in exchange for two years of public service after graduation, with a summer placement.",
    recurrence: "annual",
    term: "ay",
    opensInDays: 25,
    deadlines: [{ kind: "application", precision: "window", window: [60, 75, 95] }],
    classYears: ["second_year", "third_year"],
    rules: () => [
      R.standing(["second_year", "third_year"], "Sample rule: sophomores and juniors."),
      R.citizenship(["us_citizen"], "Sample rule: U.S. citizens only."),
    ],
    requirements: [
      { kind: "essay", label: "Statement of public service interest", wordLimit: 800, leadTimeDays: 21 },
      { kind: "interview", label: "Interview" },
    ],
    tags: ["government", "service", "tuition"],
    compensation: { kind: "tuition", amountCents: null, period: "year" },
  },
  {
    slug: "sample-student-project-grant",
    name: "Sample Student Project Grant",
    org: "example-research-society",
    types: ["grant"],
    summary: "Sample listing: small grants for student-led research or creative projects, with a priority round.",
    recurrence: "biannual",
    term: "spring",
    opensInDays: -14,
    deadlines: [
      { kind: "priority_round", precision: "date_only", inDays: 16, round: "priority" },
      { kind: "application", precision: "date_only", inDays: 46, round: "final" },
    ],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: current undergraduates.")],
    requirements: [
      { kind: "essay", label: "Project proposal", wordLimit: 1000, leadTimeDays: 21 },
      { kind: "other", label: "Budget sheet" },
      { kind: "recommendation", label: "Faculty sponsor letter" },
    ],
    tags: ["grant", "project"],
    compensation: { kind: "award", amountCents: 100000, period: "total" },
  },
  {
    slug: "sample-reu-site-ecology",
    name: "Sample REU Site in Field Ecology",
    org: "example-science-foundation",
    types: ["research_program"],
    summary: "Sample listing: a summer research site for undergraduates in field ecology, with stipend, housing and travel.",
    recurrence: "annual",
    term: "summer",
    opensInDays: -7,
    deadlines: [{ kind: "application", precision: "exact", inDays: 98, time: "23:59" }],
    classYears: ["first_year", "second_year", "third_year"],
    rules: () => [
      R.standing(["first_year", "second_year", "third_year"], "Sample rule: undergraduates who have not yet graduated."),
      R.citizenship(["us_citizen", "us_national", "permanent_resident"], "Sample rule: U.S. citizens, nationals and permanent residents."),
      R.majorCip(["26", "03"], "Sample rule: biology, ecology or environmental science majors.", ["40"]),
    ],
    requirements: [
      { kind: "essay", label: "Statement of interest", wordLimit: 600, leadTimeDays: 14 },
      { kind: "recommendation", label: "Letters of recommendation", quantity: 2, leadTimeDays: 21 },
      { kind: "transcript", label: "Unofficial transcript" },
    ],
    majorFamilies: ["life_sciences", "agriculture_environment"],
    cip: [["26", "core"], ["03", "core"], ["40", "borderline"]],
    tags: ["research", "ecology", "fieldwork"],
    aliases: ["REU"],
    compensation: { kind: "stipend", amountCents: 600000, period: "total" },
    isWedge: true,
  },
  {
    slug: "sample-phd-pathway-program",
    name: "Sample PhD Pathway Program",
    org: "example-research-society",
    types: ["pipeline_program"],
    summary: "Sample listing: a two-summer research and mentoring pathway toward a PhD, open to Pell Grant recipients.",
    recurrence: "annual",
    term: "summer",
    opensInDays: -20,
    deadlines: [{ kind: "application", precision: "exact", inDays: 70, time: "17:00" }],
    classYears: ["second_year", "third_year"],
    rules: () => [R.standing(["second_year", "third_year"], "Sample rule: sophomores and juniors."), R.pellRecipient()],
    requirements: [
      { kind: "essay", label: "Personal statement", wordLimit: 800, leadTimeDays: 21 },
      { kind: "recommendation", label: "Faculty recommendation", leadTimeDays: 21 },
    ],
    tags: ["research", "phd", "mentoring"],
    compensation: { kind: "stipend", amountCents: 500000, period: "total" },
    sensitiveAudience: true,
  },
  {
    slug: "sample-women-in-computing-cohort",
    name: "Sample Women in Computing Cohort",
    org: "example-tech-nonprofit",
    types: ["leadership_cohort", "affinity_community"],
    summary: "Sample listing: a year-long mentoring and leadership cohort for women in computing majors.",
    recurrence: "annual",
    term: "year",
    opensInDays: -12,
    deadlines: [{ kind: "application", precision: "exact", inDays: 28, time: "23:59" }],
    classYears: EARLY,
    rules: () => [
      R.standing(EARLY, "Sample rule: first- and second-year students."),
      R.identityIncludes("gender_identity", "woman", "Sample rule: students who identify as women."),
      R.majorCip(["11"], "Sample rule: computing majors or intended majors.", ["30"]),
    ],
    requirements: [{ kind: "essay", label: "Short answers", quantity: 3, wordLimit: 150 }],
    majorFamilies: ["computing"],
    cip: [["11", "core"], ["30", "borderline"]],
    tags: ["community", "mentoring", "computing"],
    identityAudience: ["gender_identity"],
  },
  {
    slug: "sample-undergraduate-research-conference",
    name: "Sample Undergraduate Research Conference",
    org: "example-research-society",
    types: ["conference_travel"],
    summary: "Sample listing: a national student research conference with travel scholarships for presenters.",
    recurrence: "annual",
    term: "spring",
    model: "event",
    opensInDays: -30,
    deadlines: [
      { kind: "application", precision: "exact", inDays: 55, time: "23:59" },
      { kind: "supplemental", precision: "date_only", inDays: 62 },
    ],
    event: [140, 142],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: undergraduate presenters.")],
    requirements: [
      { kind: "essay", label: "Research abstract", wordLimit: 250, leadTimeDays: 14 },
      { kind: "fee", label: "Registration fee (waived for travel scholars)" },
    ],
    tags: ["conference", "travel", "research"],
    compensation: { kind: "travel", amountCents: 80000, period: "total" },
    applicationFeeCents: 2500,
  },
  {
    slug: "sample-case-competition",
    name: "Sample Case Competition",
    org: "example-bank-uk",
    types: ["competition"],
    summary: "Sample listing: a team case competition with a written round and a live final.",
    recurrence: "annual",
    term: "spring",
    model: "round_based",
    opensInDays: -3,
    deadlines: [
      { kind: "interest_form", precision: "date_only", inDays: 9, round: "registration" },
      { kind: "application", precision: "exact", inDays: 40, time: "12:00", round: "written" },
    ],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: teams of current undergraduates.")],
    requirements: [{ kind: "other", label: "Team of three or four students", quantity: 1 }],
    tags: ["competition", "business", "team"],
    compensation: { kind: "award", amountCents: 300000, period: "total" },
  },
  {
    slug: "sample-open-source-mentorship",
    name: "Sample Open Source Mentorship",
    org: "example-open-source-collective",
    types: ["open_source_mentorship"],
    summary: "Sample listing: a paid summer of contributing to open-source projects with a maintainer as mentor.",
    recurrence: "annual",
    term: "summer",
    opensInDays: 70,
    deadlines: [{ kind: "application", precision: "window", window: [95, 110, 125] }],
    classYears: UNDERGRAD,
    rules: () => [R.minAge(18)],
    requirements: [
      { kind: "portfolio", label: "Links to code you have written", leadTimeDays: 14 },
      { kind: "essay", label: "Project proposal", wordLimit: 1500, leadTimeDays: 21 },
    ],
    majorFamilies: ["computing"],
    cip: [["11", "core"]],
    tags: ["open-source", "remote", "paid"],
    compensation: { kind: "stipend", amountCents: 450000, period: "total" },
  },
  {
    slug: "sample-language-immersion-fellowship",
    name: "Sample Language Immersion Fellowship",
    org: "example-language-institute",
    types: ["study_abroad_language"],
    summary: "Sample listing: a fully funded summer of intensive language study abroad.",
    recurrence: "annual",
    term: "summer",
    opensInDays: -35,
    deadlines: [{ kind: "application", precision: "exact", inDays: 64, time: "20:00" }],
    classYears: UNDERGRAD,
    rules: () => [
      R.standing(UNDERGRAD, "Sample rule: current undergraduates."),
      R.citizenship(["us_citizen"], "Sample rule: U.S. citizens."),
      R.minAge(18),
    ],
    requirements: [
      { kind: "essay", label: "Two essays", quantity: 2, wordLimit: 500, leadTimeDays: 21 },
      { kind: "recommendation", label: "Recommendations", quantity: 2, leadTimeDays: 21 },
    ],
    majorFamilies: ["humanities_languages"],
    tags: ["language", "abroad", "funded"],
    compensation: { kind: "award", amountCents: null, period: null, note: "Sample: program costs covered" },
  },
  {
    slug: "sample-teaching-service-year",
    name: "Sample Teaching Service Year",
    org: "example-service-corps",
    types: ["service_year"],
    summary: "Sample listing: a paid year of tutoring in public schools after graduation, with an education award.",
    recurrence: "annual",
    term: "fall",
    opensInDays: -50,
    deadlines: [
      { kind: "priority_round", precision: "date_only", inDays: 30, round: "early" },
      { kind: "application", precision: "date_only", inDays: 120, round: "final" },
    ],
    classYears: ["fourth_year", "recent_graduate"],
    rules: () => [R.standing(["fourth_year", "recent_graduate"], "Sample rule: graduating seniors and recent graduates."), R.minAge(18)],
    requirements: [
      { kind: "essay", label: "Motivation statement", wordLimit: 500 },
      { kind: "interview", label: "Interview" },
    ],
    majorFamilies: ["education"],
    tags: ["service", "teaching"],
    compensation: { kind: "stipend", amountCents: 2400000, period: "year" },
  },
  {
    slug: "sample-student-founder-fellowship",
    name: "Sample Student Founder Fellowship",
    org: "example-venture-studio",
    types: ["accelerator_founder"],
    summary: "Sample listing: a summer stipend and coaching for students building a venture.",
    recurrence: "annual",
    term: "summer",
    opensInDays: -8,
    deadlines: [{ kind: "application", precision: "exact", inDays: 52, time: "23:59" }],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: current undergraduates."), R.fullTime()],
    requirements: [
      { kind: "other", label: "Two-minute pitch video" },
      { kind: "essay", label: "Venture summary", wordLimit: 600 },
    ],
    tags: ["entrepreneurship", "startup"],
    compensation: { kind: "stipend", amountCents: 1000000, period: "total" },
  },
  {
    slug: "sample-campus-ambassador",
    name: "Sample Campus Ambassador Program",
    org: "example-analytics-co",
    types: ["campus_ambassador"],
    summary: "Sample listing: a paid part-time role representing a company on campus during the academic year.",
    recurrence: "rolling",
    term: "rolling",
    model: "rolling",
    deadlines: [{ kind: "application", precision: "rolling" }],
    classYears: UNDERGRAD,
    rules: () => [R.standing(UNDERGRAD, "Sample rule: current undergraduates.")],
    requirements: [{ kind: "resume", label: "Resume" }],
    tags: ["ambassador", "part-time", "paid"],
    compensation: { kind: "salary_hourly", amountCents: 1800, period: "hour" },
    unverified: true,
  },
  {
    slug: "sample-undergraduate-research-assistant",
    name: "Sample Undergraduate Research Assistant Role",
    org: "sample-state-university-org",
    types: ["campus_job"],
    summary: "Sample listing: paid lab assistant positions for Sample State University students during the term.",
    recurrence: "rolling",
    term: "rolling",
    model: "rolling",
    deadlines: [{ kind: "application", precision: "rolling" }],
    classYears: UNDERGRAD,
    rules: (ctx) => [R.atInstitution(ctx.institutionId("sample-state-university"), "Sample rule: Sample State University students.")],
    requirements: [
      { kind: "resume", label: "Resume" },
      { kind: "coursework", label: "Completed introductory lab course" },
    ],
    tags: ["campus", "research", "paid"],
    compensation: { kind: "salary_hourly", amountCents: 1600, period: "hour" },
    unverified: true,
  },
];
