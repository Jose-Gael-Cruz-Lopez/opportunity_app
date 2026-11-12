import { z } from "zod";

/**
 * The 33 opportunity types. Slugs are stable keys (lookup rows are seeded from this list), the
 * ordinal fixes display order, and `group` is the student-facing family used for filters.
 * Types 32 and 33 exist only as taxonomy slots (`inScope: false`).
 */

export const OPPORTUNITY_GROUPS = [
  "internships",
  "early_career",
  "research",
  "fellowships",
  "scholarships",
  "apprenticeships_training",
  "service_government",
  "events_competitions",
  "community_resources",
  "other",
] as const;
export const OpportunityGroupSchema = z.enum(OPPORTUNITY_GROUPS);
export type OpportunityGroup = z.infer<typeof OpportunityGroupSchema>;

export const OPPORTUNITY_GROUP_LABELS: Record<OpportunityGroup, string> = {
  internships: "Internships",
  early_career: "Insight weeks and sprints",
  research: "Research",
  fellowships: "Fellowships",
  scholarships: "Scholarships",
  apprenticeships_training: "Apprenticeships and training",
  service_government: "Service and government",
  events_competitions: "Conferences and competitions",
  community_resources: "Communities and resources",
  other: "Other",
};

export interface OpportunityTypeDef {
  readonly slug: string;
  readonly ordinal: number;
  readonly label: string;
  readonly group: OpportunityGroup;
  readonly inScope: boolean;
}

export const OPPORTUNITY_TYPES = [
  { slug: "summer_internship", ordinal: 1, label: "Summer internships", group: "internships", inScope: true },
  { slug: "off_cycle_internship", ordinal: 2, label: "Off-cycle internships and co-ops", group: "internships", inScope: true },
  { slug: "new_grad_rotational", ordinal: 3, label: "New-grad, rotational and leadership-development programs", group: "internships", inScope: true },
  // Insight programs, spring weeks and sprintships share one exposure family (REQ-002).
  { slug: "early_career_exposure", ordinal: 4, label: "Early-insight, discovery and sophomore programs", group: "early_career", inScope: true },
  { slug: "uk_spring_week", ordinal: 5, label: "UK spring weeks", group: "early_career", inScope: true },
  { slug: "sprinternship", ordinal: 6, label: "Sprinternships", group: "early_career", inScope: true },
  { slug: "externship_shadowing", ordinal: 7, label: "Externships and job shadowing", group: "early_career", inScope: true },
  { slug: "micro_internship", ordinal: 8, label: "Micro-internships", group: "internships", inScope: true },
  { slug: "virtual_job_simulation", ordinal: 9, label: "Virtual job simulations", group: "community_resources", inScope: true },
  { slug: "apprenticeship", ordinal: 10, label: "Apprenticeships", group: "apprenticeships_training", inScope: true },
  { slug: "undergraduate_fellowship", ordinal: 11, label: "Undergraduate summer fellowships", group: "fellowships", inScope: true },
  { slug: "graduate_fellowship", ordinal: 12, label: "Graduate and postgraduate fellowships", group: "fellowships", inScope: true },
  { slug: "national_scholarship", ordinal: 13, label: "National undergraduate scholarships and honors", group: "scholarships", inScope: true },
  { slug: "private_scholarship", ordinal: 14, label: "Private scholarships", group: "scholarships", inScope: true },
  { slug: "institutional_scholarship", ordinal: 15, label: "Local and institutional scholarships", group: "scholarships", inScope: true },
  { slug: "service_scholarship", ordinal: 16, label: "Service-commitment scholarships", group: "scholarships", inScope: true },
  { slug: "grant", ordinal: 17, label: "Grants (project, research, travel)", group: "fellowships", inScope: true },
  { slug: "research_program", ordinal: 18, label: "Research programs (REU, SURF, labs)", group: "research", inScope: true },
  { slug: "pipeline_program", ordinal: 19, label: "Pre-professional and PhD pipelines", group: "research", inScope: true },
  { slug: "leadership_cohort", ordinal: 20, label: "Leadership and diversity cohorts", group: "fellowships", inScope: true },
  { slug: "affinity_community", ordinal: 21, label: "Affinity communities and mentorship", group: "community_resources", inScope: true },
  { slug: "conference_travel", ordinal: 22, label: "Conferences with travel scholarships", group: "events_competitions", inScope: true },
  { slug: "competition", ordinal: 23, label: "Competitions (case, pitch, writing, arts, hackathons)", group: "events_competitions", inScope: true },
  { slug: "open_source_mentorship", ordinal: 24, label: "Open-source mentorship", group: "research", inScope: true },
  { slug: "study_abroad_language", ordinal: 25, label: "Study abroad and language", group: "fellowships", inScope: true },
  { slug: "government_service", ordinal: 26, label: "Government and public service", group: "service_government", inScope: true },
  { slug: "service_year", ordinal: 27, label: "Service years and teaching fellowships", group: "service_government", inScope: true },
  { slug: "accelerator_founder", ordinal: 28, label: "Accelerators and founder fellowships", group: "fellowships", inScope: true },
  { slug: "campus_ambassador", ordinal: 29, label: "Campus ambassador programs", group: "other", inScope: true },
  { slug: "campus_job", ordinal: 30, label: "Campus jobs, Work-Study, TA and RA roles", group: "other", inScope: true },
  { slug: "paid_training", ordinal: 31, label: "Paid training and bootcamps", group: "apprenticeships_training", inScope: true },
  { slug: "gap_year", ordinal: 32, label: "Gap-year programs", group: "other", inScope: false },
  { slug: "high_school_pathway", ordinal: 33, label: "High-school-senior pathways", group: "other", inScope: false },
] as const satisfies readonly OpportunityTypeDef[];

export type OpportunityTypeSlug = (typeof OPPORTUNITY_TYPES)[number]["slug"];
export const OPPORTUNITY_TYPE_SLUGS = OPPORTUNITY_TYPES.map((t) => t.slug) as [
  OpportunityTypeSlug,
  ...OpportunityTypeSlug[],
];
export const OpportunityTypeSlugSchema = z.enum(OPPORTUNITY_TYPE_SLUGS);

const BY_SLUG: ReadonlyMap<string, OpportunityTypeDef> = new Map(OPPORTUNITY_TYPES.map((t) => [t.slug, t]));

export function getOpportunityType(slug: string): OpportunityTypeDef | undefined {
  return BY_SLUG.get(slug);
}

export function opportunityTypesInGroup(group: OpportunityGroup): OpportunityTypeDef[] {
  return OPPORTUNITY_TYPES.filter((t) => t.group === group);
}

/**
 * Plain-language categories the product brief names (internships, fellowships, research, ...).
 * Each maps to the slugs it covers, so filters and onboarding can use the short list.
 */
export const OPPORTUNITY_CATEGORIES = {
  internships: ["summer_internship", "off_cycle_internship", "new_grad_rotational", "micro_internship"],
  fellowships: ["undergraduate_fellowship", "graduate_fellowship", "leadership_cohort", "grant", "study_abroad_language", "accelerator_founder"],
  research: ["research_program", "pipeline_program", "open_source_mentorship"],
  apprenticeships: ["apprenticeship", "paid_training"],
  scholarships: ["national_scholarship", "private_scholarship", "institutional_scholarship", "service_scholarship"],
  insight_weeks: ["early_career_exposure", "uk_spring_week", "externship_shadowing"],
  sprints: ["sprinternship"],
  conferences: ["conference_travel", "competition"],
} as const satisfies Record<string, readonly OpportunityTypeSlug[]>;
export type OpportunityCategory = keyof typeof OPPORTUNITY_CATEGORIES;
export const OPPORTUNITY_CATEGORY_KEYS = Object.keys(OPPORTUNITY_CATEGORIES) as [
  OpportunityCategory,
  ...OpportunityCategory[],
];
export const OpportunityCategorySchema = z.enum(OPPORTUNITY_CATEGORY_KEYS);
