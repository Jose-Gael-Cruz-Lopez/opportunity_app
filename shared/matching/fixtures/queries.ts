import type { LabeledQuery } from "../eval";
import type { MatchingProfile } from "../facets";
import { sampleCardBySlug } from "./sample-cards";

/**
 * SAMPLE, PROVISIONAL team-written queries over the fictional sample cards. They stand in for the
 * real frozen test half (plan 6.5) and never feed the alias table. Labels are programCycleIds.
 */
function q(id: string, query: string, slugs: readonly string[]): LabeledQuery {
  return { id, query, relevant: slugs.map((s) => sampleCardBySlug(s).programCycleId), source: "provisional" };
}

export const PROVISIONAL_QUERIES: readonly LabeledQuery[] = [
  q("p01", "reu", ["coastal-ecology-reu"]),
  q("p02", "surf", ["granite-surf-fellowship"]),
  q("p03", "insight week", ["summit-insight-week"]),
  q("p04", "sprintship", ["harbor-data-sprint", "summit-markets-sprint"]),
  q("p05", "machine learning fellowship", ["lattice-ml-fellowship"]),
  q("p06", "ml", ["lattice-ml-fellowship"]),
  q("p07", "open source", ["open-source-season"]),
  q("p08", "software apprenticeship", ["keystone-software-apprenticeship"]),
  q("p09", "spring week", ["thames-markets-spring-week"]),
  q("p10", "hackathon", ["riverside-civic-hackathon"]),
  q("p11", "marine biology research", ["coastal-ecology-reu"]),
  q("p12", "summit bank", ["summit-insight-week", "summit-sophomore-analyst", "summit-technology-internship", "summit-markets-sprint"]),
  q("p13", "law externship", ["northwind-law-externship"]),
  q("p14", "conference travel", ["aurora-computing-travel-award"]),
  q("p15", "language study abroad", ["lumen-language-fellowship"]),
  q("p16", "meridan scholarship", ["meridian-undergraduate-scholarship"]),
  q("p17", "micro internship", ["pivot-micro-internships"]),
  q("p18", "campus ambassador", ["atlas-campus-ambassador"]),
  q("p19", "health pathways", ["beacon-health-pathways"]),
  q("p20", "research grant", ["cedar-undergraduate-research-grant"]),
  q("p21", "service year", ["prairie-service-year"]),
  q("p22", "biotech", ["helix-biotech-discovery"]),
  q("p23", "civic", ["civic-leaders-fellowship", "riverside-civic-hackathon"]),
  q("p24", "engineering scholarship", ["granite-engineering-scholars"]),
  q("p25", "data sprint", ["harbor-data-sprint"]),
];

/** SAMPLE synthetic personas: first- and second-year profiles, no real students. */
export interface SamplePersona {
  readonly id: string;
  readonly profile: MatchingProfile;
}

export const SAMPLE_PERSONAS: readonly SamplePersona[] = [
  { id: "fy-bio", profile: { classYear: "first_year", majorFamily: "life_sciences", interestTags: ["life_sciences"] } },
  { id: "fy-cs", profile: { classYear: "first_year", majorFamily: "computing", majorCip: "11.0701", interestTags: ["computing"] } },
  { id: "sy-cs", profile: { classYear: "second_year", majorFamily: "computing", preferredOpportunityTypes: ["summer_internship"] } },
  { id: "fy-business", profile: { classYear: "first_year", majorFamily: "business" } },
  { id: "sy-business", profile: { classYear: "second_year", majorFamily: "business", preferredOpportunityTypes: ["sprinternship"] } },
  { id: "sy-health", profile: { classYear: "second_year", majorFamily: "health" } },
  { id: "fy-undeclared", profile: { classYear: "first_year", majorFamily: "undeclared" } },
  { id: "sy-engineering", profile: { classYear: "second_year", majorFamily: "engineering_technology" } },
  { id: "fy-humanities", profile: { classYear: "first_year", majorFamily: "humanities_languages" } },
  { id: "sy-math", profile: { classYear: "second_year", majorFamily: "math_statistics", timeZone: "America/Los_Angeles" } },
  { id: "incoming", profile: { classYear: "incoming_first_year" } },
  { id: "anonymous", profile: {} },
];
