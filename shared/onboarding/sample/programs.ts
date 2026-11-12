import type { EligibilityRule, EligibilityRuleSet } from "../../contracts/eligibility";
import type { Compensation, DeadlineView, ProgramCard } from "../../contracts/registry";
import type { ClassYear, CycleStatus, MajorFamily, OpportunityTypeSlug } from "../../taxonomy";
import { computeDueAt, computeSortAt } from "../../time/deadline";
import { addDays, toIsoInstant } from "../../time/iso";
import { todayIn, toEpochMs, type NowInput } from "../dates";
import { summarizeRequirements, type RequirementLike } from "../schedule";
import type { OnboardingProgram, ProgramFormat } from "../types";

/**
 * SAMPLE DATA. Thirty-one fictional programs from fictional organizations, every one marked
 * `isSample: true`, named "Sample: ..." and linked to example.org. They exist for tests, the
 * offline evaluation and demos; none describes a real program. Dates are offsets from `now`, so
 * the catalogue stays current whenever it is built.
 */

export const SAMPLE_NOTICE = "Sample programs for demonstration. They are not real opportunities.";
const ZONE = "America/New_York";

type DeadlineSpec =
  | number
  | "rolling"
  | "tbd"
  | { readonly monthAhead: number }
  | { readonly window: readonly [number, number] }
  | { readonly applicantLocal: number };

interface RulesSpec {
  readonly standing?: boolean;
  readonly citizenship?: boolean;
  readonly gpa?: number;
  readonly identity?: "gender";
}

interface SampleSpec {
  readonly n: number;
  readonly slug: string;
  readonly name: string;
  readonly org: string;
  readonly summary: string;
  readonly types: readonly OpportunityTypeSlug[];
  /** "summer" uses next summer; otherwise a literal cycle key. */
  readonly cycle: "summer" | "winter" | "rolling" | "ay" | "spring";
  readonly status?: CycleStatus;
  readonly deadline: DeadlineSpec;
  readonly opensIn?: number;
  readonly classYears?: readonly ClassYear[];
  readonly majors?: readonly MajorFamily[];
  readonly tags: readonly string[];
  readonly pay: Compensation["kind"] | null;
  readonly format?: readonly ProgramFormat[];
  /** null: requirements not checked yet. */
  readonly requirements: readonly RequirementLike[] | null;
  readonly skills?: readonly string[];
  /** null: no verified rule set. */
  readonly rules: RulesSpec | null;
  readonly sensitiveAudience?: boolean;
  readonly identityAudience?: boolean;
  readonly nomination?: boolean;
}

const R = (kind: RequirementLike["kind"], quantity = 1): RequirementLike => ({ kind, quantity });

export const SAMPLE_SPECS: readonly SampleSpec[] = [
  {
    n: 1, slug: "sample-civic-data-internship", name: "Sample: Civic Data Summer Internship", org: "Riverbend City Lab (sample)",
    summary: "Spend the summer turning city service data into dashboards neighbors can use. Interns clean data in Python and SQL and present findings to community groups.",
    types: ["summer_internship"], cycle: "summer", deadline: 40, classYears: ["first_year", "second_year"],
    majors: ["computing", "math_statistics", "social_sciences"], tags: ["data science", "civic tech", "public service"],
    pay: "stipend", format: ["hybrid"], requirements: [R("resume"), R("essay")], skills: ["python", "sql", "data_analysis"], rules: { standing: true },
  },
  {
    n: 2, slug: "sample-ai-research-experience", name: "Sample: Machine Learning Research Experience", org: "Halden University (sample)",
    summary: "Join a university lab for ten weeks studying how machine learning models make mistakes. Students write Python and read papers with a faculty mentor.",
    types: ["research_program"], cycle: "summer", deadline: 20, classYears: ["first_year", "second_year", "third_year"],
    majors: ["computing", "math_statistics"], tags: ["machine learning", "ai"], pay: "stipend", format: ["in_person"],
    requirements: [R("recommendation", 2), R("essay")], skills: ["python", "machine_learning"], rules: { standing: true, citizenship: true },
  },
  {
    n: 3, slug: "sample-bank-tech-internship", name: "Sample: Trading Technology Internship", org: "Brightwater Bank (sample)",
    summary: "Build internal tools for a trading desk using Java and SQL. Open to juniors and seniors.",
    types: ["summer_internship"], cycle: "summer", deadline: 30, classYears: ["third_year", "fourth_year"],
    majors: ["computing", "business"], tags: ["finance", "software"], pay: "salary_hourly", format: ["in_person"],
    requirements: [R("resume"), R("interview")], skills: ["java", "sql"], rules: { standing: true },
  },
  {
    n: 4, slug: "sample-data-fellowship-closed", name: "Sample: Data for Good Fellowship", org: "Northwind Analytics (sample)",
    summary: "A data science fellowship for students working on nonprofit analytics projects. Applications are closed for this cycle.",
    types: ["undergraduate_fellowship"], cycle: "summer", status: "closed", deadline: -5, classYears: ["first_year", "second_year"],
    majors: ["computing", "math_statistics"], tags: ["data science", "nonprofit"], pay: "stipend", requirements: [R("essay")], rules: { standing: true },
  },
  {
    n: 5, slug: "sample-copperline-swe-internship", name: "Sample: Software Engineering Internship for First- and Second-Years", org: "Copperline Software (sample)",
    summary: "Build web features in JavaScript and Java with a product team, with code review on GitHub. Designed for first- and second-year students.",
    types: ["summer_internship"], cycle: "summer", deadline: 45, classYears: ["first_year", "second_year"],
    majors: ["computing"], tags: ["software", "web development"], pay: "salary_hourly", format: ["in_person"],
    requirements: [R("resume"), R("interview")], skills: ["javascript", "java", "git"], rules: { standing: true },
  },
  {
    n: 6, slug: "sample-biomedical-research-program", name: "Sample: Summer Biomedical Research Program", org: "Harborview Medical Research Institute (sample)",
    summary: "Ten weeks in a cell biology lab: PCR, microscopy and data analysis in R, with weekly research talks and a final poster.",
    types: ["research_program"], cycle: "summer", deadline: 55, classYears: ["first_year", "second_year", "third_year"],
    majors: ["life_sciences", "health", "physical_sciences"], tags: ["biomedical", "laboratory", "health"], pay: "stipend", format: ["in_person"],
    requirements: [R("recommendation"), R("essay"), R("transcript")], skills: ["lab_techniques", "statistics", "r_lang"], rules: { standing: true, citizenship: true },
  },
  {
    n: 7, slug: "sample-goldfinch-science-scholarship", name: "Sample: Goldfinch Science Scholarship", org: "Goldfinch Science Foundation (sample)",
    summary: "A national award for sophomores and juniors planning research careers in science, math or engineering. Students apply through their campus first.",
    types: ["national_scholarship"], cycle: "ay", deadline: 80, classYears: ["second_year", "third_year"],
    majors: ["life_sciences", "physical_sciences", "math_statistics", "engineering_technology", "computing"], tags: ["research", "neuroscience"],
    pay: "award", requirements: [R("recommendation", 3), R("essay"), R("campus_nomination")], rules: { standing: true, citizenship: true }, nomination: true,
  },
  {
    n: 8, slug: "sample-pre-health-shadowing-week", name: "Sample: Winter Break Clinical Shadowing Week", org: "Juniper Health Alliance (sample)",
    summary: "Shadow clinicians for a week over winter break and see how a community hospital runs, from the emergency department to public health outreach.",
    types: ["externship_shadowing"], cycle: "winter", deadline: 21, classYears: ["first_year", "second_year"],
    majors: ["health", "life_sciences"], tags: ["health", "clinical"], pay: "none", format: ["in_person"], requirements: [R("resume"), R("essay")], rules: { standing: true },
  },
  {
    n: 9, slug: "sample-battery-chemistry-research", name: "Sample: Battery Chemistry Research Program", org: "Halden University (sample)",
    summary: "Summer chemistry research on battery materials: titration, spectroscopy and careful lab notebooks, with a clean energy research group.",
    types: ["research_program"], cycle: "summer", deadline: 9, classYears: ["first_year", "second_year", "third_year"],
    majors: ["physical_sciences", "life_sciences", "engineering_technology"], tags: ["chemistry", "laboratory", "clean energy"], pay: "stipend", format: ["in_person"],
    requirements: [R("recommendation", 2), R("essay")], skills: ["lab_techniques"], rules: { standing: true, citizenship: true },
  },
  {
    n: 10, slug: "sample-finance-discovery-week", name: "Sample: Finance Discovery Week", org: "Brightwater Bank (sample)",
    summary: "Three days inside a bank over winter break: markets, a consulting-style case in Excel, and conversations with analysts. No finance background needed.",
    types: ["early_career_exposure"], cycle: "winter", deadline: 30, classYears: ["first_year", "second_year"],
    tags: ["finance", "business", "banking"], pay: "travel", format: ["in_person"], requirements: [R("resume"), R("essay")], skills: ["excel"], rules: { standing: true },
  },
  {
    n: 11, slug: "sample-startup-sprint", name: "Sample: Startup Sprint", org: "Bluebird Startup Studio (sample)",
    summary: "A two-week sprint with an early-stage startup: customer interviews, market research and a pitch on demo day.",
    types: ["sprinternship"], cycle: "rolling", deadline: "rolling", classYears: ["first_year", "second_year"],
    tags: ["startup", "entrepreneurship"], pay: "stipend", format: ["remote", "hybrid"], requirements: [R("resume")], skills: ["marketing"], rules: { standing: true },
  },
  {
    n: 12, slug: "sample-climate-leaders-scholarship", name: "Sample: Climate Leaders Scholarship", org: "Cedar Valley Climate Fund (sample)",
    summary: "A $3,000 award for first- and second-year students leading climate or community service projects on campus or at home.",
    types: ["national_scholarship"], cycle: "ay", deadline: 45, classYears: ["first_year", "second_year"],
    tags: ["climate", "sustainability", "community service"], pay: "award", requirements: [R("essay"), R("recommendation")], rules: { standing: true },
  },
  {
    n: 13, slug: "sample-women-in-engineering-fellowship", name: "Sample: Women in Engineering Fellowship", org: "Atlas Engineering (sample)",
    summary: "A year-long fellowship with mentoring and a summer project for students who identify as women in engineering or computing.",
    types: ["undergraduate_fellowship"], cycle: "summer", deadline: 35, classYears: ["first_year", "second_year"],
    majors: ["engineering_technology", "computing"], tags: ["engineering", "leadership"], pay: "stipend",
    requirements: [R("essay"), R("recommendation")], rules: { standing: true, identity: "gender" }, identityAudience: true,
  },
  {
    n: 14, slug: "sample-open-door-scholarship", name: "Sample: Open Door Futures Scholarship", org: "Open Door Scholars Fund (sample)",
    summary: "A scholarship for students whose eligibility depends on immigration status, as defined by the fund.",
    types: ["private_scholarship"], cycle: "ay", deadline: 40, tags: ["scholarship"], pay: "award",
    requirements: [R("essay")], rules: { citizenship: true }, sensitiveAudience: true,
  },
  {
    n: 15, slug: "sample-rocketry-systems-internship", name: "Sample: Rocketry Systems Internship", org: "Lumen Aerospace (sample)",
    summary: "Design and test avionics boards and CAD parts for a student rocket program, and use MATLAB to study flight data.",
    types: ["summer_internship"], cycle: "summer", deadline: 35, classYears: ["first_year", "second_year", "third_year"],
    majors: ["engineering_technology", "physical_sciences"], tags: ["aerospace", "rocketry"], pay: "salary_hourly", format: ["in_person"],
    requirements: [R("resume"), R("essay")], skills: ["cad", "matlab", "circuits"], rules: { standing: true, citizenship: true },
  },
  {
    n: 16, slug: "sample-mechanical-design-internship", name: "Sample: Mechanical Design Internship", org: "Atlas Engineering (sample)",
    summary: "Design fixtures in SolidWorks and run tests on a factory floor; a good fit for sophomores in mechanical engineering.",
    types: ["summer_internship"], cycle: "summer", deadline: 38, classYears: ["second_year", "third_year"],
    majors: ["engineering_technology"], tags: ["mechanical engineering", "manufacturing"], pay: "salary_hourly", format: ["in_person"],
    requirements: [R("resume"), R("interview")], skills: ["cad"], rules: { standing: true },
  },
  {
    n: 17, slug: "sample-mission-control-volunteer", name: "Sample: Mission Control Volunteer Internship", org: "Starfield Science Center (sample)",
    summary: "Help run planetarium shows and space science outreach as an unpaid summer volunteer intern.",
    types: ["summer_internship"], cycle: "summer", deadline: 30, majors: ["physical_sciences", "education"], tags: ["space science", "aerospace"],
    pay: "none", format: ["in_person"], requirements: [R("resume")], rules: {},
  },
  {
    n: 18, slug: "sample-student-film-design-challenge", name: "Sample: Student Film and Design Challenge", org: "Kestrel Film Collective (sample)",
    summary: "Make a three-minute film or a poster series on this year's theme. Finalists screen their work at a spring festival.",
    types: ["competition"], cycle: "spring", deadline: 28, majors: ["arts_design", "communication_media"],
    tags: ["film", "animation", "graphic design"], pay: "award", requirements: [R("portfolio")], skills: ["video", "graphic_design"], rules: {},
  },
  {
    n: 19, slug: "sample-design-conference-travel", name: "Sample: Design Conference Travel Grant", org: "Northwind Design Society (sample)",
    summary: "Travel funding to attend a national design conference, with a student portfolio review and workshops on UX research.",
    types: ["conference_travel"], cycle: "spring", deadline: 20, majors: ["arts_design", "computing"], tags: ["design", "ux"],
    pay: "travel", requirements: [R("essay")], skills: ["ux_design"], rules: {},
  },
  {
    n: 20, slug: "sample-public-policy-fellows", name: "Sample: Summer Public Policy Fellows", org: "Meridian Policy Center (sample)",
    summary: "A summer in a policy office: research, writing memos and briefing legislative staff, with a cohort of undergraduate fellows.",
    types: ["undergraduate_fellowship"], cycle: "summer", deadline: 50, classYears: ["second_year", "third_year"],
    majors: ["social_sciences", "law_policy_service"], tags: ["policy", "government"], pay: "stipend", format: ["in_person"],
    requirements: [R("recommendation", 2), R("essay")], skills: ["writing", "policy_analysis", "public_speaking"], rules: { standing: true, citizenship: true },
  },
  {
    n: 21, slug: "sample-civic-leadership-cohort", name: "Sample: Civic Leadership Cohort", org: "Meridian Policy Center (sample)",
    summary: "Monthly workshops and a community project for first- and second-year students who want to lead civic initiatives.",
    types: ["leadership_cohort"], cycle: "ay", deadline: 33, classYears: ["first_year", "second_year"],
    tags: ["leadership", "civic", "community service"], pay: "none", requirements: [R("essay")], skills: ["leadership", "public_speaking"], rules: { standing: true },
  },
  {
    n: 22, slug: "sample-city-government-internship", name: "Sample: City Government Internship", org: "Riverbend City Hall (sample)",
    summary: "Work in a city department on policy research and constituent services during the summer.",
    types: ["government_service"], cycle: "summer", deadline: 60, classYears: ["second_year", "third_year", "fourth_year"],
    majors: ["law_policy_service", "social_sciences"], tags: ["government", "policy"], pay: "none", requirements: [R("resume")], rules: { standing: true },
  },
  {
    n: 23, slug: "sample-software-apprenticeship", name: "Sample: Remote Software Apprenticeship", org: "Ironwood Apprenticeship Network (sample)",
    summary: "A paid, remote apprenticeship building web apps in JavaScript with a mentor team; work is reviewed on GitHub.",
    types: ["apprenticeship"], cycle: "rolling", deadline: "rolling", majors: ["computing"], tags: ["software", "web development"],
    pay: "salary_hourly", format: ["remote"], requirements: [R("resume"), R("interview")], skills: ["javascript", "web_development", "git"], rules: {},
  },
  {
    n: 24, slug: "sample-coding-training-program", name: "Sample: Paid Coding Training Program", org: "Copperline Software (sample)",
    summary: "Twelve weeks of paid, full-time coding training in a downtown classroom.",
    types: ["paid_training"], cycle: "spring", deadline: 25, majors: ["computing"], tags: ["software"],
    pay: "stipend", format: ["in_person"], requirements: [R("resume")], skills: ["javascript"], rules: {},
  },
  {
    n: 25, slug: "sample-it-support-apprenticeship", name: "Sample: IT Support Apprenticeship", org: "Ironwood Apprenticeship Network (sample)",
    summary: "Learn IT support and help-desk work while earning a wage; customer service experience helps.",
    types: ["apprenticeship"], cycle: "spring", deadline: 30, majors: ["computing", "trades_applied"], tags: ["it support"],
    pay: "salary_hourly", format: ["remote", "in_person"], requirements: [R("resume")], skills: ["customer_service"], rules: {},
  },
  {
    n: 26, slug: "sample-wetlands-field-research", name: "Sample: Coastal Wetlands Field Research", org: "Saltmarsh Field Station (sample)",
    summary: "Field ecology research on coastal wetlands: field sampling, GIS mapping and data collection with a small team.",
    types: ["research_program"], cycle: "summer", status: "expected", opensIn: 10, deadline: { window: [70, 85] },
    classYears: ["first_year", "second_year"], majors: ["life_sciences", "agriculture_environment"], tags: ["ecology", "field research", "climate"],
    pay: "stipend", format: ["in_person"], requirements: [R("recommendation"), R("essay")], skills: ["field_research", "gis"], rules: { standing: true, citizenship: true },
  },
  {
    n: 27, slug: "sample-summit-fellows-later", name: "Sample: Summit Fellows Program", org: "Summit Scholars Foundation (sample)",
    summary: "A national fellowship that opens in the spring for students interested in public service.",
    types: ["undergraduate_fellowship"], cycle: "summer", status: "expected", opensIn: 90, deadline: { window: [150, 165] },
    classYears: ["first_year", "second_year"], tags: ["public service"], pay: "stipend", requirements: [R("essay")], rules: { standing: true },
  },
  {
    n: 28, slug: "sample-nonprofit-marketing-internship", name: "Sample: Nonprofit Marketing Internship", org: "Harbor Lights Nonprofit (sample)",
    summary: "Help run social media campaigns and market research for a regional nonprofit.",
    types: ["summer_internship"], cycle: "summer", deadline: 44, majors: ["business", "communication_media"],
    tags: ["marketing", "social media", "nonprofit"], pay: "stipend", requirements: null, rules: null,
  },
  {
    n: 29, slug: "sample-tutor-award", name: "Sample: Community Tutor Award", org: "Summit Scholars Foundation (sample)",
    summary: "An award for students who tutor younger students in their community, with a short essay about what they learned.",
    types: ["private_scholarship"], cycle: "ay", deadline: { monthAhead: 2 }, tags: ["education", "tutoring"],
    pay: "award", requirements: [R("essay")], skills: ["tutoring"], rules: {},
  },
  {
    n: 30, slug: "sample-local-journalism-fellowship", name: "Sample: Local Journalism Fellowship", org: "Lantern Press Guild (sample)",
    summary: "A summer fellowship in local journalism: reporting, editing and publishing stories with a community newsroom.",
    types: ["undergraduate_fellowship"], cycle: "summer", deadline: { applicantLocal: 26 }, classYears: ["first_year", "second_year"],
    majors: ["humanities_languages", "communication_media"], tags: ["journalism", "media"], pay: "stipend",
    requirements: [R("essay"), R("recommendation")], skills: ["writing", "editing"], rules: { standing: true },
  },
  {
    n: 31, slug: "sample-analytics-internship-passed", name: "Sample: Analytics Internship", org: "Northwind Analytics (sample)",
    summary: "A data analysis internship using SQL and Tableau. The deadline for this cycle has passed.",
    types: ["summer_internship"], cycle: "summer", deadline: -3, classYears: ["first_year", "second_year"],
    majors: ["computing", "business"], tags: ["data science"], pay: "stipend", requirements: [R("resume")], skills: ["sql", "data_analysis"], rules: { standing: true },
  },
];

// ---------------------------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------------------------

const uuid = (n: number): string => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const SAMPLE_HASH = "0".repeat(63) + "1";

function cycleKeyFor(spec: SampleSpec, today: string): string {
  const year = Number(today.slice(0, 4));
  const month = Number(today.slice(5, 7));
  const summerYear = month >= 6 ? year + 1 : year;
  switch (spec.cycle) {
    case "summer":
      return `summer-${summerYear}`;
    case "winter":
      return `winter-${month >= 6 ? year + 1 : year}`;
    case "spring":
      return `spring-${month >= 6 ? year + 1 : year}`;
    case "rolling":
      return `rolling-${summerYear}`;
    case "ay":
      return `ay-${summerYear}-${String((summerYear + 1) % 100).padStart(2, "0")}`;
  }
}

function deadlineView(spec: SampleSpec, today: string): DeadlineView[] {
  const base = {
    id: uuid(2000 + spec.n),
    kind: "application" as const,
    scope: "national" as const,
    roundLabel: "",
    localTime: null,
    revision: 1,
  };
  const d = spec.deadline;
  if (d === "rolling" || d === "tbd") {
    return [{ ...base, basis: "official", precision: d, tzMode: "fixed", localDate: null, windowStart: null, windowEnd: null, timeZone: null, dueAt: null, sortAt: null }];
  }
  let row: Omit<DeadlineView, "dueAt" | "sortAt">;
  if (typeof d === "number") {
    row = { ...base, basis: "official", precision: "date_only", tzMode: "fixed", localDate: addDays(today, d), windowStart: null, windowEnd: null, timeZone: ZONE };
  } else if ("monthAhead" in d) {
    const y = Number(today.slice(0, 4));
    const m = Number(today.slice(5, 7)) + d.monthAhead;
    const yy = y + Math.floor((m - 1) / 12);
    const mm = ((m - 1) % 12) + 1;
    row = { ...base, basis: "official", precision: "month_only", tzMode: "fixed", localDate: `${yy}-${String(mm).padStart(2, "0")}`, windowStart: null, windowEnd: null, timeZone: null };
  } else if ("window" in d) {
    const [a, b] = d.window;
    row = { ...base, basis: "predicted", precision: "window", tzMode: "fixed", localDate: addDays(today, Math.round((a + b) / 2)), windowStart: addDays(today, a), windowEnd: addDays(today, b), timeZone: ZONE };
  } else {
    row = { ...base, basis: "official", precision: "date_only", tzMode: "applicant_local", localDate: addDays(today, d.applicantLocal), windowStart: null, windowEnd: null, timeZone: null };
  }
  const due = computeDueAt(row);
  const sort = computeSortAt(row);
  return [{ ...row, dueAt: due === null ? null : toIsoInstant(due), sortAt: sort === null ? null : toIsoInstant(sort) }];
}

function rule(partial: Omit<EligibilityRule, "group" | "asOf" | "borderline" | "evidenceKey">): EligibilityRule {
  return { group: "all", asOf: "today", borderline: [], evidenceKey: null, ...partial };
}

function ruleSet(spec: SampleSpec, cycleId: string, verifiedAt: string): EligibilityRuleSet | null {
  const r = spec.rules;
  if (r === null) return null;
  const rules: EligibilityRule[] = [];
  const years = spec.classYears ?? [];
  if (r.standing && years.length > 0) {
    rules.push(rule({ id: "standing", dimension: "standing", logic: { in: [{ var: "classYear" }, [...years]] }, fields: ["classYear"], sensitive: false, officialText: `Open to ${years.map((y) => y.replace(/_/g, "-")).join(", ")} students` }));
  }
  if (r.citizenship) {
    rules.push(
      spec.sensitiveAudience
        ? rule({ id: "citizenship", dimension: "citizenship", logic: { in: [{ var: "citizenship" }, ["daca", "tps"]] }, fields: ["citizenship"], sensitive: true, officialText: "Open only to students with the immigration statuses the fund lists" })
        : rule({ id: "citizenship", dimension: "citizenship", logic: { in: [{ var: "citizenship" }, ["us_citizen", "us_national", "permanent_resident"]] }, fields: ["citizenship"], sensitive: true, officialText: "U.S. citizens, U.S. nationals or permanent residents" }),
    );
  }
  if (r.gpa !== undefined) {
    rules.push(rule({ id: "gpa", dimension: "gpa", logic: { ">=": [{ var: "gpaMin" }, r.gpa] }, fields: ["gpaMin"], sensitive: false, officialText: `Minimum GPA of ${r.gpa.toFixed(1)}` }));
  }
  if (r.identity === "gender") {
    rules.push(rule({ id: "identity", dimension: "identity", logic: { in: ["woman", { var: "identity.gender_identity" }] }, fields: ["identity.gender_identity"], sensitive: true, officialText: "Open to students who identify as women" }));
  }
  const has = (dim: string): boolean => rules.some((x) => x.dimension === dim);
  return {
    id: uuid(3000 + spec.n),
    programCycleId: cycleId,
    version: 1,
    format: "jsonlogic-v1",
    state: "verified",
    templateKey: null,
    coverage: {
      standing: has("standing") ? "encoded" : "no_restriction",
      enrollment: "no_restriction",
      transfer: "no_restriction",
      gpa: has("gpa") ? "encoded" : "no_restriction",
      citizenship: has("citizenship") ? "encoded" : "no_restriction",
      pell: "no_restriction",
      institution: "none_stated",
      field: "none_stated",
      identity: has("identity") ? "encoded" : "none_stated",
      age: "none_stated",
      residency: "none_stated",
      first_gen: "none_stated",
      prior_award: "none_stated",
      team: "none_stated",
      host_enrollment: "none_stated",
    },
    rules,
    anyOf: [],
    attestations: [],
    nomination: spec.nomination ? { nominator: "campus_rep", campusDeadlineKinds: ["campus_internal"], quota: null, evidenceKey: null } : null,
    evidence: {},
    hash: SAMPLE_HASH,
    createdVia: "sample",
    verifiedAt,
    verifiedBy: "Sample Curator",
    fromCycleKey: null,
  };
}

/** Builds the sample catalogue with dates relative to `now` (in America/New_York). */
export function buildSamplePrograms(now: NowInput): OnboardingProgram[] {
  const nowMs = toEpochMs(now);
  const today = todayIn(nowMs, ZONE);
  const verifiedOn = addDays(today, -3);
  const verifiedAt = `${verifiedOn}T15:00:00.000Z`;
  return SAMPLE_SPECS.map((spec) => {
    const programCycleId = uuid(1000 + spec.n);
    const prep = spec.requirements === null ? null : summarizeRequirements(spec.requirements);
    const opensOn = spec.opensIn !== undefined ? addDays(today, spec.opensIn) : null;
    const card: ProgramCard = {
      programId: uuid(spec.n),
      programCycleId,
      slug: spec.slug,
      cycleKey: cycleKeyFor(spec, today),
      name: spec.name,
      organizationName: spec.org,
      summary: spec.summary,
      opportunityTypes: [...spec.types],
      status: spec.status ?? "open",
      verification: { state: "verified", verifiedOn, verifiedBy: "Sample Curator", freshness: "fresh" },
      deadlines: deadlineView(spec, today),
      opensOn,
      prediction:
        spec.status === "expected" && opensOn
          ? { p10: addDays(opensOn, -5), p50: opensOn, p90: addDays(opensOn, 10), label: "medium", method: "history" }
          : null,
      classYears: [...(spec.classYears ?? [])],
      majorFamilies: [...(spec.majors ?? [])],
      cipPrefixes: [],
      interestTags: [...spec.tags],
      aliases: [],
      flags: {
        paid: spec.pay !== null && !["none", "travel"].includes(spec.pay),
        participantCost: false,
        applicationFee: false,
        pellDisplacement: false,
        sensitiveAudience: Boolean(spec.sensitiveAudience),
        identityAudience: Boolean(spec.identityAudience),
        nominationRequired: Boolean(spec.nomination),
      },
      compensation: spec.pay === null ? null : { kind: spec.pay, amountCents: null, period: null },
      applicationUrl: `https://example.org/sample/${spec.slug}/apply`,
      officialUrl: `https://example.org/sample/${spec.slug}`,
      prepDays: prep ? prep.prepDays : null,
      rules: ruleSet(spec, programCycleId, verifiedAt),
      rulesFromPreviousCycle: null,
      isSample: true,
    };
    return {
      ...card,
      extras: {
        ...(spec.format ? { format: [...spec.format] } : {}),
        ...(spec.requirements ? { requirements: [...spec.requirements] } : {}),
        ...(spec.skills ? { skills: [...spec.skills] } : {}),
      },
    };
  });
}

/** Sample Requirements in the contract's shape, for planFirstApplication demos. */
export function sampleRequirements(program: OnboardingProgram): RequirementLike[] {
  return [...(program.extras?.requirements ?? [])];
}
