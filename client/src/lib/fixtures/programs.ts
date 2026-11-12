import type { DeadlineView, ProgramCard } from "@shared/contracts/registry";
import type { ClassYear, MajorFamily, OpportunityTypeSlug } from "@shared/taxonomy";
import { addDays, computeDueAt, computeSortAt, localDateIn, toIsoInstant } from "@shared/time";

/**
 * SAMPLE DATA. Fictional programs used until the registry API answers. Names, organizations and
 * numbers are invented, every URL is on example.org, and every card has `isSample: true`, which
 * the UI shows as a "Sample" tag. Dates are relative to `now`, so the samples stay in season.
 */

const ZONE = "America/New_York";

/** Deterministic UUID-shaped ids for fixtures. */
export function sampleId(n: number): string {
  return `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
}

function deadline(n: number, today: string, inDays: number, opts: Partial<Pick<DeadlineView, "kind" | "scope" | "localTime" | "roundLabel">> = {}): DeadlineView {
  const localDate = addDays(today, inDays);
  const fields = {
    basis: "official" as const,
    precision: "exact" as const,
    tzMode: "fixed" as const,
    localDate,
    localTime: opts.localTime ?? "17:00",
    windowStart: null,
    windowEnd: null,
    timeZone: ZONE,
  };
  const due = computeDueAt(fields);
  const sort = computeSortAt(fields);
  return {
    id: sampleId(1000 + n),
    kind: opts.kind ?? "application",
    scope: opts.scope ?? "national",
    roundLabel: opts.roundLabel ?? "",
    ...fields,
    dueAt: due === null ? null : toIsoInstant(due),
    sortAt: sort === null ? null : toIsoInstant(sort),
    revision: 1,
  };
}

interface SampleSpec {
  n: number;
  slug: string;
  name: string;
  org: string;
  summary: string;
  types: OpportunityTypeSlug[];
  status: ProgramCard["status"];
  /** Days from today to the application deadline; null for rolling or undated. */
  dueInDays: number | null;
  /** Days from today to the opening date (negative = already open). */
  opensInDays: number | null;
  classYears: ClassYear[];
  majors: MajorFamily[];
  tags: string[];
  paid: boolean;
  nomination?: boolean;
  sensitiveAudience?: boolean;
  campusDueInDays?: number;
  predicted?: boolean;
  prepDays: number | null;
  verifiedDaysAgo: number;
  stipendCents?: number;
}

const SPECS: readonly SampleSpec[] = [
  { n: 1, slug: "sample-early-insight-week", name: "Northwind Early Insight Week", org: "Northwind Partners (sample)", summary: "A three-day introduction to finance careers for first- and second-year students.", types: ["early_career_exposure"], status: "open", dueInDays: 9, opensInDays: -40, classYears: ["first_year", "second_year"], majors: [], tags: ["finance", "business"], paid: true, prepDays: 5, verifiedDaysAgo: 3 },
  { n: 2, slug: "sample-software-sophomore-internship", name: "Lumen Software Sophomore Internship", org: "Lumen Labs (sample)", summary: "A twelve-week paid software internship built for students early in a computing degree.", types: ["summer_internship"], status: "open", dueInDays: 20, opensInDays: -55, classYears: ["first_year", "second_year"], majors: ["computing"], tags: ["software", "computing"], paid: true, prepDays: 14, verifiedDaysAgo: 3, stipendCents: 3200 },
  { n: 3, slug: "sample-national-science-scholarship", name: "Meridian Science Scholarship", org: "Meridian Scholarship Foundation (sample)", summary: "A national award for second-year science students. Your campus nominates; its deadline comes first.", types: ["national_scholarship"], status: "open", dueInDays: 85, opensInDays: -70, classYears: ["second_year", "third_year"], majors: ["life_sciences", "physical_sciences", "math_statistics", "engineering_technology"], tags: ["research", "science"], paid: true, nomination: true, campusDueInDays: 23, prepDays: 30, verifiedDaysAgo: 5, stipendCents: 750000 },
  { n: 4, slug: "sample-open-source-sprint", name: "Harbor Open-Source Sprint", org: "Harbor Collective (sample)", summary: "Twelve-week remote sprints on open-source projects with a mentor.", types: ["open_source_mentorship", "sprinternship"], status: "open", dueInDays: 26, opensInDays: -30, classYears: ["first_year", "second_year", "third_year"], majors: ["computing"], tags: ["open source", "remote"], paid: true, prepDays: 10, verifiedDaysAgo: 6 },
  { n: 5, slug: "sample-community-fellows", name: "Bridgeway Fellows", org: "Bridgeway (sample)", summary: "Summer internship placement plus a year-round fellowship community.", types: ["leadership_cohort", "undergraduate_fellowship"], status: "open", dueInDays: 33, opensInDays: -21, classYears: ["second_year", "third_year"], majors: ["computing", "engineering_technology"], tags: ["community", "mentorship"], paid: true, sensitiveAudience: true, prepDays: 21, verifiedDaysAgo: 8 },
  { n: 6, slug: "sample-museum-internships", name: "Civic Museum Internships", org: "Example Civic Museum (sample)", summary: "Museum, archive and field placements across departments.", types: ["summer_internship"], status: "open", dueInDays: 65, opensInDays: -10, classYears: ["first_year", "second_year", "third_year", "fourth_year"], majors: ["humanities_languages", "arts_design", "social_sciences"], tags: ["museums", "archives"], paid: false, prepDays: 20, verifiedDaysAgo: 9 },
  { n: 7, slug: "sample-coastal-research-scholars", name: "Coastal Research Scholars", org: "Example Ocean Agency (sample)", summary: "A scholarship plus a paid summer research internship for environmental science students.", types: ["research_program", "national_scholarship"], status: "open", dueInDays: 78, opensInDays: -5, classYears: ["second_year"], majors: ["agriculture_environment", "life_sciences", "physical_sciences"], tags: ["environment", "research", "ocean"], paid: true, sensitiveAudience: true, prepDays: 28, verifiedDaysAgo: 7, stipendCents: 950000 },
  { n: 8, slug: "sample-summer-lab-research", name: "Summit Summer Lab Research", org: "Summit Research Foundation (sample)", summary: "Paid summer lab research at partner universities.", types: ["research_program"], status: "expected", dueInDays: null, opensInDays: 20, classYears: ["second_year", "third_year"], majors: ["life_sciences", "physical_sciences", "health"], tags: ["lab", "research", "biology"], paid: true, predicted: true, prepDays: 25, verifiedDaysAgo: 10 },
  { n: 9, slug: "sample-conference-travel-award", name: "Women in Computing Travel Award", org: "Example Computing Society (sample)", summary: "Covers registration and travel to a national computing conference.", types: ["conference_travel"], status: "expected", dueInDays: null, opensInDays: 62, classYears: ["first_year", "second_year", "third_year", "fourth_year"], majors: ["computing"], tags: ["conference", "travel"], paid: true, predicted: true, sensitiveAudience: true, prepDays: 7, verifiedDaysAgo: 12 },
  { n: 10, slug: "sample-tech-apprenticeship", name: "Keystone Tech Apprenticeship", org: "Keystone Consulting (sample)", summary: "Paid from day one; learn on the job with a mentor.", types: ["apprenticeship"], status: "open", dueInDays: null, opensInDays: -90, classYears: ["first_year", "second_year", "recent_graduate"], majors: [], tags: ["apprenticeship", "it"], paid: true, prepDays: 7, verifiedDaysAgo: 4 },
  { n: 11, slug: "sample-conservation-crews", name: "Trailhead Conservation Crews", org: "Trailhead Corps (sample)", summary: "Outdoor conservation crews with start dates all year.", types: ["service_year", "off_cycle_internship"], status: "open", dueInDays: null, opensInDays: -120, classYears: ["first_year", "second_year", "third_year"], majors: ["agriculture_environment"], tags: ["outdoors", "conservation"], paid: true, prepDays: 7, verifiedDaysAgo: 11 },
  { n: 12, slug: "sample-venture-fellows", name: "Granite Venture Fellows", org: "Granite Ventures (sample)", summary: "Closed for this cycle. The last cycle ran from August to October.", types: ["accelerator_founder"], status: "closed", dueInDays: -30, opensInDays: -100, classYears: ["third_year", "fourth_year"], majors: ["computing", "business"], tags: ["startups", "venture"], paid: true, prepDays: 21, verifiedDaysAgo: 20 },
  { n: 13, slug: "sample-case-competition", name: "Delta Case Competition", org: "Delta Business School (sample)", summary: "A weekend strategy case competition for first-year teams.", types: ["competition"], status: "open", dueInDays: 15, opensInDays: -25, classYears: ["first_year"], majors: ["business", "social_sciences"], tags: ["case", "strategy"], paid: false, prepDays: 6, verifiedDaysAgo: 2 },
  { n: 14, slug: "sample-micro-internships", name: "Brightpath Micro-Internships", org: "Brightpath (sample)", summary: "Paid 10-40 hour remote projects you can fit around classes.", types: ["micro_internship"], status: "open", dueInDays: null, opensInDays: -200, classYears: ["first_year", "second_year", "third_year", "fourth_year"], majors: [], tags: ["remote", "projects"], paid: true, prepDays: 2, verifiedDaysAgo: 6 },
];

function cycleKeyFor(today: string): string {
  return `summer-${Number(today.slice(0, 4)) + 1}`;
}

function buildCard(spec: SampleSpec, today: string): ProgramCard {
  const deadlines: DeadlineView[] = [];
  if (spec.campusDueInDays !== undefined) {
    deadlines.push(deadline(spec.n * 10 + 1, today, spec.campusDueInDays, { kind: "campus_internal", scope: "campus", roundLabel: "Campus" }));
  }
  if (spec.dueInDays !== null) deadlines.push(deadline(spec.n * 10, today, spec.dueInDays));
  const opensOn = spec.opensInDays === null ? null : addDays(today, spec.opensInDays);
  const prediction = spec.predicted
    ? {
        p10: addDays(today, (spec.opensInDays ?? 30) + 40),
        p50: addDays(today, (spec.opensInDays ?? 30) + 55),
        p90: addDays(today, (spec.opensInDays ?? 30) + 75),
        label: "medium" as const,
        method: "history" as const,
      }
    : null;
  return {
    programId: sampleId(spec.n),
    programCycleId: sampleId(100 + spec.n),
    slug: spec.slug,
    cycleKey: cycleKeyFor(today),
    name: spec.name,
    organizationName: spec.org,
    summary: spec.summary,
    opportunityTypes: spec.types,
    status: spec.status,
    verification: {
      state: "verified",
      verifiedOn: addDays(today, -spec.verifiedDaysAgo),
      verifiedBy: "Sample curator",
      freshness: spec.verifiedDaysAgo <= 14 ? "fresh" : "aging",
    },
    deadlines,
    opensOn,
    prediction,
    classYears: spec.classYears,
    majorFamilies: spec.majors,
    cipPrefixes: [],
    interestTags: spec.tags,
    aliases: [],
    flags: {
      paid: spec.paid,
      participantCost: false,
      applicationFee: false,
      pellDisplacement: false,
      sensitiveAudience: spec.sensitiveAudience ?? false,
      identityAudience: false,
      nominationRequired: spec.nomination ?? false,
    },
    compensation: spec.stipendCents ? { kind: "stipend", amountCents: spec.stipendCents, period: spec.stipendCents < 10000 ? "hour" : "total" } : spec.paid ? { kind: "varies", amountCents: null, period: null } : null,
    applicationUrl: `https://example.org/apply/${spec.slug}`,
    officialUrl: `https://example.org/programs/${spec.slug}`,
    prepDays: spec.prepDays,
    rules: null,
    rulesFromPreviousCycle: null,
    isSample: true,
  };
}

/** Sample program cards with dates relative to `now` (epoch ms). */
export function sampleProgramCards(now: number = Date.now()): ProgramCard[] {
  const today = localDateIn(now, ZONE);
  return SPECS.map((spec) => buildCard(spec, today));
}
