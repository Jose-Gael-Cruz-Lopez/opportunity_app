import type { DeadlineView, ProgramCard } from "../../contracts/registry";

/**
 * SAMPLE DATA for shared/matching tests. Every program and Organization below is fictional,
 * every URL is on example.org, and every card has `isSample: true`. Nothing here describes a
 * real program; do not ship these as registry records.
 *
 * Reference "today" for tests: 2026-11-11 (see SAMPLE_NOW).
 */

/** 2026-11-11 12:00 America/New_York. */
export const SAMPLE_NOW = Date.UTC(2026, 10, 11, 17, 0, 0);
export const SAMPLE_TODAY = "2026-11-11";

function uuid(prefix: string, n: number): string {
  return `${prefix}000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
}

let deadlineSeq = 0;

interface DeadlineSpec {
  readonly date: string;
  readonly kind?: DeadlineView["kind"];
  readonly scope?: DeadlineView["scope"];
  readonly precision?: DeadlineView["precision"];
  readonly tzMode?: DeadlineView["tzMode"];
  readonly time?: string | null;
  readonly basis?: DeadlineView["basis"];
}

export function sampleDeadline(spec: DeadlineSpec): DeadlineView {
  deadlineSeq += 1;
  const precision = spec.precision ?? "date_only";
  const tzMode = spec.tzMode ?? "fixed";
  return {
    id: uuid("5c", deadlineSeq),
    kind: spec.kind ?? "application",
    scope: spec.scope ?? "national",
    roundLabel: "",
    basis: spec.basis ?? "official",
    precision,
    tzMode,
    localDate: precision === "rolling" || precision === "tbd" ? null : spec.date,
    localTime: precision === "exact" ? (spec.time ?? "23:59") : null,
    windowStart: null,
    windowEnd: null,
    timeZone: tzMode === "fixed" ? "America/New_York" : null,
    dueAt: null,
    sortAt: null,
    revision: 1,
  };
}

type CardSpec = Partial<Omit<ProgramCard, "programId" | "programCycleId" | "slug" | "name" | "organizationName" | "flags">> & {
  readonly slug: string;
  readonly name: string;
  readonly organizationName: string;
  readonly flags?: Partial<ProgramCard["flags"]>;
};

export function sampleCard(n: number, spec: CardSpec): ProgramCard {
  const { flags, ...rest } = spec;
  return {
    programId: uuid("5b", n),
    programCycleId: uuid("5a", n),
    cycleKey: "summer-2027",
    summary: null,
    opportunityTypes: ["summer_internship"],
    status: "open",
    verification: { state: "verified", verifiedOn: "2026-11-01", verifiedBy: "sample-curator", freshness: "fresh" },
    deadlines: [],
    opensOn: null,
    prediction: null,
    classYears: [],
    majorFamilies: [],
    cipPrefixes: [],
    interestTags: [],
    aliases: [],
    compensation: null,
    applicationUrl: null,
    officialUrl: `https://example.org/programs/${spec.slug}`,
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
}

const FIRST_SECOND = ["first_year", "second_year"] as const;

export const SAMPLE_CARDS: readonly ProgramCard[] = [
  sampleCard(1, {
    slug: "coastal-ecology-reu",
    name: "Coastal Ecology REU Site",
    organizationName: "Example Marine Lab",
    summary: "Ten-week summer research in marine biology and coastal field ecology with a faculty mentor.",
    opportunityTypes: ["research_program"],
    classYears: [...FIRST_SECOND],
    majorFamilies: ["life_sciences", "agriculture_environment"],
    interestTags: ["life_sciences"],
    aliases: ["Coastal REU"],
    deadlines: [sampleDeadline({ date: "2027-02-15" })],
    prepDays: 30,
    flags: { paid: true },
  }),
  sampleCard(2, {
    slug: "harbor-data-sprint",
    name: "Harbor Data Sprinternship",
    organizationName: "Example Harbor Tech",
    summary: "A three-week winter sprint building data tools with a small engineering team.",
    opportunityTypes: ["sprinternship"],
    classYears: [...FIRST_SECOND],
    majorFamilies: ["computing", "math_statistics"],
    interestTags: ["computing"],
    deadlines: [sampleDeadline({ date: "2026-11-20" })],
    prepDays: 5,
    flags: { paid: true },
  }),
  sampleCard(3, {
    slug: "summit-insight-week",
    name: "Summit Bank Insight Week",
    organizationName: "Example Summit Bank",
    summary: "A week of workshops and job shadowing across markets and operations for first-years.",
    opportunityTypes: ["early_career_exposure"],
    classYears: ["first_year"],
    majorFamilies: [],
    deadlines: [sampleDeadline({ date: "2026-12-01" })],
    prepDays: 10,
  }),
  sampleCard(4, {
    slug: "summit-sophomore-analyst",
    name: "Summit Bank Sophomore Analyst Program",
    organizationName: "Example Summit Bank",
    summary: "Paid summer analyst program for second-year students.",
    opportunityTypes: ["summer_internship"],
    classYears: ["second_year"],
    majorFamilies: ["business", "math_statistics"],
    deadlines: [sampleDeadline({ date: "2026-12-15" })],
    prepDays: 14,
    flags: { paid: true },
  }),
  sampleCard(5, {
    slug: "summit-technology-internship",
    name: "Summit Bank Technology Internship",
    organizationName: "Example Summit Bank",
    summary: "Software engineering internship on trading platforms.",
    opportunityTypes: ["summer_internship"],
    classYears: [...FIRST_SECOND],
    majorFamilies: ["computing"],
    deadlines: [sampleDeadline({ date: "2026-12-20" })],
    prepDays: 14,
    flags: { paid: true },
  }),
  sampleCard(6, {
    slug: "meridian-undergraduate-scholarship",
    name: "Meridian Undergraduate Scholarship",
    organizationName: "Example Meridian Foundation",
    summary: "Merit scholarship for students planning research careers; applicants need a campus nomination.",
    opportunityTypes: ["national_scholarship"],
    classYears: ["second_year", "third_year"],
    majorFamilies: ["life_sciences", "physical_sciences", "math_statistics", "engineering_technology", "computing"],
    aliases: ["Meridian"],
    deadlines: [sampleDeadline({ date: "2027-01-29", precision: "exact", time: "17:00" })],
    prepDays: 40,
    flags: { nominationRequired: true },
  }),
  sampleCard(7, {
    slug: "lattice-ml-fellowship",
    name: "Lattice Machine Learning Fellowship",
    organizationName: "Example Lattice AI",
    summary: "Summer fellowship pairing undergraduates with applied machine learning researchers.",
    opportunityTypes: ["undergraduate_fellowship"],
    majorFamilies: ["computing", "math_statistics"],
    deadlines: [sampleDeadline({ date: "2027-03-01" })],
    prepDays: 21,
    flags: { paid: true },
  }),
  sampleCard(8, {
    slug: "open-source-season",
    name: "Open Source Season Mentorship",
    organizationName: "Example Open Source Collective",
    summary: "Mentored contributions to open-source projects over the spring term.",
    opportunityTypes: ["open_source_mentorship"],
    status: "expected",
    prediction: { p10: "2026-12-01", p50: "2026-12-10", p90: "2026-12-20", label: "medium", method: "history" },
  }),
  sampleCard(9, {
    slug: "civic-leaders-fellowship",
    name: "Civic Leaders Fellowship",
    organizationName: "Example Civic Institute",
    summary: "A year-long leadership cohort on local government and public service.",
    opportunityTypes: ["leadership_cohort"],
    status: "expected",
    opensOn: "2027-03-01",
  }),
  sampleCard(10, {
    slug: "pivot-micro-internships",
    name: "Pivot Micro-Internships",
    organizationName: "Example Pivot Works",
    summary: "Short paid project-based assignments you can apply to any time.",
    opportunityTypes: ["micro_internship"],
    flags: { paid: true },
  }),
  sampleCard(11, {
    slug: "quartz-lab-summer-research",
    name: "Quartz Lab Summer Research",
    organizationName: "Example Quartz Lab",
    opportunityTypes: ["research_program"],
    status: "closed",
    majorFamilies: ["physical_sciences"],
  }),
  sampleCard(12, {
    slug: "granite-engineering-scholars",
    name: "Granite Engineering Scholars",
    organizationName: "Example Granite Works",
    summary: "Scholarship for engineering students; two recommendation letters required.",
    opportunityTypes: ["national_scholarship"],
    majorFamilies: ["engineering_technology"],
    deadlines: [sampleDeadline({ date: "2026-11-13" })],
    prepDays: 23,
  }),
  sampleCard(13, {
    slug: "beacon-health-pathways",
    name: "Beacon Health Pathways",
    organizationName: "Example Beacon Health",
    summary: "Pre-professional pathway for second-year students exploring clinical research.",
    opportunityTypes: ["pipeline_program"],
    classYears: ["second_year"],
    majorFamilies: ["health", "life_sciences"],
    deadlines: [sampleDeadline({ date: "2027-01-10" })],
    prepDays: 21,
  }),
  sampleCard(14, {
    slug: "keystone-software-apprenticeship",
    name: "Keystone Software Apprenticeship",
    organizationName: "Example Keystone Systems",
    summary: "Paid apprenticeship in software engineering with no degree requirement.",
    opportunityTypes: ["apprenticeship"],
    majorFamilies: [],
    deadlines: [sampleDeadline({ date: "2026-12-05", precision: "exact", tzMode: "applicant_local", time: "23:59" })],
    prepDays: 7,
    flags: { paid: true },
  }),
  sampleCard(15, {
    slug: "thames-markets-spring-week",
    name: "Thames Markets Spring Week",
    organizationName: "Example Thames Markets",
    summary: "A spring week in London for students curious about markets.",
    opportunityTypes: ["uk_spring_week"],
    classYears: ["first_year"],
    majorFamilies: [],
    deadlines: [sampleDeadline({ date: "2027-01", precision: "month_only" })],
    prepDays: 7,
  }),
  sampleCard(16, {
    slug: "aurora-computing-travel-award",
    name: "Aurora Computing Conference Travel Award",
    organizationName: "Example Aurora Society",
    summary: "Covers travel and registration for a national computing conference.",
    opportunityTypes: ["conference_travel"],
    majorFamilies: ["computing"],
    deadlines: [sampleDeadline({ date: "2026-12-10" })],
    prepDays: 7,
  }),
  sampleCard(17, {
    slug: "riverside-civic-hackathon",
    name: "Riverside Civic Hackathon",
    organizationName: "Example Riverside City Lab",
    summary: "A weekend hackathon building tools for city services.",
    opportunityTypes: ["competition"],
    deadlines: [sampleDeadline({ date: "2026-11-25" })],
    prepDays: 3,
  }),
  sampleCard(18, {
    slug: "lumen-language-fellowship",
    name: "Lumen Language Fellowship",
    organizationName: "Example Lumen Institute",
    summary: "Funded summer study abroad for intensive language learning.",
    opportunityTypes: ["study_abroad_language"],
    majorFamilies: ["humanities_languages", "social_sciences"],
    deadlines: [sampleDeadline({ date: "2027-02-01" })],
    prepDays: 30,
  }),
  sampleCard(19, {
    slug: "cedar-undergraduate-research-grant",
    name: "Cedar Undergraduate Research Grant",
    organizationName: "Example Cedar Fund",
    summary: "Small grants for independent undergraduate research projects in any field.",
    opportunityTypes: ["grant"],
    deadlines: [sampleDeadline({ date: "2027-01-20" })],
    prepDays: 14,
  }),
  sampleCard(20, {
    slug: "atlas-campus-ambassador",
    name: "Atlas Campus Ambassador Program",
    organizationName: "Example Atlas Learning",
    summary: "Represent a learning platform on your campus; rolling applications.",
    opportunityTypes: ["campus_ambassador"],
    deadlines: [sampleDeadline({ date: "2027-01-01", precision: "rolling" })],
  }),
  sampleCard(21, {
    slug: "northwind-law-externship",
    name: "Northwind Law Externship",
    organizationName: "Example Northwind Legal Aid",
    summary: "A winter-break externship shadowing public interest lawyers.",
    opportunityTypes: ["externship_shadowing"],
    majorFamilies: ["law_policy_service", "social_sciences"],
    deadlines: [sampleDeadline({ date: "2026-12-08" })],
    prepDays: 10,
  }),
  sampleCard(22, {
    slug: "prairie-service-year",
    name: "Prairie Service Year",
    organizationName: "Example Prairie Corps",
    summary: "A paid service year in rural schools and community organizations.",
    opportunityTypes: ["service_year"],
    deadlines: [sampleDeadline({ date: "2027-04-01" })],
    prepDays: 14,
    flags: { paid: true },
  }),
  sampleCard(23, {
    slug: "granite-surf-fellowship",
    name: "Granite Summer Research Fellowship",
    organizationName: "Example Granite Institute of Technology",
    summary: "Summer undergraduate research fellowship in engineering and physics labs.",
    opportunityTypes: ["research_program"],
    majorFamilies: ["engineering_technology", "physical_sciences"],
    aliases: ["Granite SURF"],
    deadlines: [sampleDeadline({ date: "2027-02-01" })],
    prepDays: 30,
    flags: { paid: true },
  }),
  sampleCard(24, {
    slug: "summit-markets-sprint",
    name: "Summit Bank Markets Sprint",
    organizationName: "Example Summit Bank",
    summary: "A two-week sprinternship on a markets desk over winter break.",
    opportunityTypes: ["sprinternship"],
    classYears: [...FIRST_SECOND],
    majorFamilies: ["business"],
    deadlines: [sampleDeadline({ date: "2026-12-18" })],
    prepDays: 14,
  }),
  sampleCard(25, {
    slug: "helix-biotech-discovery",
    name: "Helix Biotech Discovery Program",
    organizationName: "Example Helix Biotech",
    summary: "A discovery program introducing first- and second-year students to biotech careers.",
    opportunityTypes: ["early_career_exposure"],
    classYears: [...FIRST_SECOND],
    majorFamilies: ["life_sciences", "health"],
    deadlines: [sampleDeadline({ date: "2026-12-12" })],
    prepDays: 10,
  }),
];

export function sampleCardBySlug(slug: string): ProgramCard {
  const card = SAMPLE_CARDS.find((c) => c.slug === slug);
  if (!card) throw new Error(`no sample card ${slug}`);
  return card;
}
