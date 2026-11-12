import {
  OPPORTUNITY_CATEGORIES,
  OPPORTUNITY_CATEGORY_KEYS,
  type MajorFamily,
  type OpportunityCategory,
  type OpportunityTypeSlug,
} from "../taxonomy";

/**
 * Onboarding vocabulary: interest topics, the plain-language opportunity categories, the
 * adaptive "this or that" pairs and the option values of the preference questions. All of it
 * is Novus's own wording; none of it names or implies a status or identity category.
 */

// ---------------------------------------------------------------------------------------------
// Interest topics
// ---------------------------------------------------------------------------------------------

export interface InterestTopic {
  readonly id: string;
  readonly label: string;
  /** How a reason names the topic mid-sentence ("Matches your interest in AI and data"). */
  readonly phrase: string;
  /**
   * Phrases that count as evidence of the topic in a program's tags, name or summary. They are
   * deliberately specific ("data science", not "data") so a biology summary that mentions data
   * collection is not sold to the student as an AI program. Words that turn up in job-ad
   * boilerplate ("work environment", "health benefits", "social media", "state of the art",
   * "mentoring") are never terms on their own.
   */
  readonly terms: readonly string[];
  /** Major families the topic usually sits in; used to order skill chips, never as evidence. */
  readonly families: readonly MajorFamily[];
}

export const INTEREST_TOPICS = [
  { id: "ai_data", label: "AI and data", phrase: "AI and data", terms: ["ai", "artificial intelligence", "machine learning", "data science", "analytics"], families: ["computing", "math_statistics"] },
  { id: "software", label: "Software and apps", phrase: "software and apps", terms: ["software", "coding", "programming", "web development", "app development", "computer science"], families: ["computing"] },
  { id: "hardware", label: "Engineering and hardware", phrase: "engineering and hardware", terms: ["robotics", "hardware", "electronics", "mechanical engineering", "electrical engineering", "civil engineering", "manufacturing"], families: ["engineering_technology"] },
  { id: "space", label: "Space and aerospace", phrase: "space and aerospace", terms: ["aerospace", "astronomy", "rocketry", "rocket", "satellite", "space science", "space exploration", "planetary"], families: ["engineering_technology", "physical_sciences"] },
  { id: "climate", label: "Climate and environment", phrase: "climate and the environment", terms: ["climate", "natural environment", "environmental", "sustainability", "clean energy", "renewable energy", "conservation", "ecology"], families: ["agriculture_environment", "life_sciences", "physical_sciences"] },
  { id: "health", label: "Health and medicine", phrase: "health and medicine", terms: ["health care", "health sciences", "health research", "global health", "health equity", "medicine", "medical", "public health", "biomedical", "healthcare", "clinical"], families: ["health", "life_sciences"] },
  { id: "lab_science", label: "Lab science", phrase: "lab science", terms: ["biology", "chemistry", "physics", "laboratory", "neuroscience", "genetics", "biochemistry"], families: ["life_sciences", "physical_sciences"] },
  { id: "business", label: "Business and finance", phrase: "business and finance", terms: ["business", "finance", "financial", "banking", "consulting", "investment", "markets"], families: ["business"] },
  { id: "startups", label: "Startups", phrase: "startups", terms: ["startup", "startups", "entrepreneurship", "entrepreneur", "founder", "venture"], families: ["business", "computing"] },
  { id: "policy", label: "Policy and government", phrase: "policy and government", terms: ["policy", "government", "law school", "pre law", "law firm", "legal", "public service", "civic", "legislative"], families: ["law_policy_service", "social_sciences"] },
  { id: "social_impact", label: "Social impact", phrase: "social impact", terms: ["nonprofit", "social impact", "community service", "community organizing", "volunteer", "volunteering"], families: ["social_sciences", "education"] },
  { id: "education", label: "Teaching and education", phrase: "teaching and education", terms: ["teaching", "education", "tutoring", "classroom"], families: ["education"] },
  { id: "arts_media", label: "Arts, design and media", phrase: "arts, design and media", terms: ["fine art", "studio art", "art history", "visual art", "visual arts", "artist", "artists", "arts", "film", "digital media", "news media", "media production", "media studies", "journalism", "music", "creative writing", "graphic design", "visual design", "animation", "photography"], families: ["arts_design", "communication_media"] },
] as const satisfies readonly InterestTopic[];

export type InterestTopicId = (typeof INTEREST_TOPICS)[number]["id"];
export const INTEREST_TOPIC_IDS = INTEREST_TOPICS.map((t) => t.id) as [InterestTopicId, ...InterestTopicId[]];

const TOPIC_BY_ID: ReadonlyMap<string, InterestTopic> = new Map(INTEREST_TOPICS.map((t) => [t.id, t]));
export function interestTopic(id: string): InterestTopic | undefined {
  return TOPIC_BY_ID.get(id);
}

// ---------------------------------------------------------------------------------------------
// Opportunity categories (the "What are you looking for?" answers)
// ---------------------------------------------------------------------------------------------

export const CATEGORY_LABELS: Record<OpportunityCategory, string> = {
  internships: "Internships",
  research: "Research",
  fellowships: "Fellowships",
  scholarships: "Scholarships",
  insight_weeks: "Insight weeks",
  sprints: "Sprints",
  conferences: "Conferences and competitions",
  apprenticeships: "Apprenticeships",
};

/** Lowercase noun for reasons: "One of the internships you asked for". */
export const CATEGORY_NOUNS: Record<OpportunityCategory, string> = {
  internships: "internships",
  research: "research programs",
  fellowships: "fellowships",
  scholarships: "scholarships",
  insight_weeks: "insight weeks",
  sprints: "sprints",
  conferences: "conferences and competitions",
  apprenticeships: "apprenticeships",
};

const CATEGORIES_BY_TYPE: ReadonlyMap<string, readonly OpportunityCategory[]> = (() => {
  const map = new Map<string, OpportunityCategory[]>();
  for (const key of OPPORTUNITY_CATEGORY_KEYS) {
    for (const slug of OPPORTUNITY_CATEGORIES[key]) {
      const list = map.get(slug) ?? [];
      list.push(key);
      map.set(slug, list);
    }
  }
  return map;
})();

/** Categories a program belongs to, from its opportunity types (types outside every category give none). */
export function categoriesForTypes(types: readonly string[]): OpportunityCategory[] {
  const out = new Set<OpportunityCategory>();
  for (const t of types) for (const c of CATEGORIES_BY_TYPE.get(t) ?? []) out.add(c);
  return OPPORTUNITY_CATEGORY_KEYS.filter((c) => out.has(c));
}

/** Every type slug a set of categories covers, in taxonomy order. */
export function typesForCategories(categories: readonly OpportunityCategory[]): OpportunityTypeSlug[] {
  const out = new Set<OpportunityTypeSlug>();
  for (const c of categories) for (const t of OPPORTUNITY_CATEGORIES[c]) out.add(t);
  return [...out];
}

/** Types a first-year can usually join without prior experience (insight weeks, sprints, events, most scholarships). */
export const ENTRY_LEVEL_TYPES: ReadonlySet<string> = new Set<OpportunityTypeSlug>([
  "early_career_exposure",
  "uk_spring_week",
  "sprinternship",
  "externship_shadowing",
  "virtual_job_simulation",
  "conference_travel",
  "national_scholarship",
  "private_scholarship",
  "institutional_scholarship",
  "affinity_community",
  "campus_ambassador",
]);

// ---------------------------------------------------------------------------------------------
// Adaptive "this or that" pairs (Golbandi, Koren and Lempel 2011: ask what splits the candidates)
// ---------------------------------------------------------------------------------------------

export interface PairSide {
  readonly value: string;
  readonly label: string;
  /** Reason shown on a card whose type sits on this side. */
  readonly reason: string;
  readonly types: readonly OpportunityTypeSlug[];
}

export interface PairDef {
  readonly id: "pair_style" | "pair_length" | "pair_value";
  readonly prompt: string;
  readonly a: PairSide;
  readonly b: PairSide;
}

const SCHOLARSHIP_AND_GRANT_TYPES: readonly OpportunityTypeSlug[] = [
  "national_scholarship",
  "private_scholarship",
  "institutional_scholarship",
  "service_scholarship",
  "grant",
];

export const PAIRS: readonly PairDef[] = [
  {
    id: "pair_style",
    prompt: "Which sounds more like you?",
    a: {
      value: "build",
      label: "Build or make things",
      reason: "Hands-on work, like you wanted",
      types: ["summer_internship", "off_cycle_internship", "micro_internship", "new_grad_rotational", "apprenticeship", "paid_training", "sprinternship", "competition", "accelerator_founder", "virtual_job_simulation"],
    },
    b: {
      value: "investigate",
      label: "Investigate questions",
      reason: "A real question to dig into, like you wanted",
      types: ["research_program", "pipeline_program", "undergraduate_fellowship", "graduate_fellowship", "grant", "open_source_mentorship"],
    },
  },
  {
    id: "pair_length",
    prompt: "What fits your time better?",
    a: {
      value: "short",
      label: "A short burst: a few days to a week",
      reason: "A short program, like you wanted",
      types: ["early_career_exposure", "uk_spring_week", "sprinternship", "externship_shadowing", "micro_internship", "virtual_job_simulation", "conference_travel", "competition"],
    },
    b: {
      value: "long",
      label: "A whole summer or term",
      reason: "A longer experience, like you wanted",
      types: ["summer_internship", "off_cycle_internship", "new_grad_rotational", "research_program", "pipeline_program", "apprenticeship", "paid_training", "undergraduate_fellowship", "leadership_cohort", "study_abroad_language", "service_year", "government_service"],
    },
  },
  {
    id: "pair_value",
    prompt: "What would help you most right now?",
    a: {
      value: "experience",
      label: "Experience for your resume",
      reason: "Experience you can put on your resume",
      types: ["summer_internship", "off_cycle_internship", "micro_internship", "new_grad_rotational", "early_career_exposure", "uk_spring_week", "sprinternship", "externship_shadowing", "research_program", "pipeline_program", "apprenticeship", "paid_training", "competition", "conference_travel", "open_source_mentorship", "leadership_cohort"],
    },
    b: {
      value: "funding",
      label: "Money for school",
      reason: "Money for school",
      types: SCHOLARSHIP_AND_GRANT_TYPES,
    },
  },
];

export type PairId = PairDef["id"];
export const PAIR_IDS: readonly PairId[] = PAIRS.map((p) => p.id);
export const PAIR_EITHER = "either";

export function pairDef(id: string): PairDef | undefined {
  return PAIRS.find((p) => p.id === id);
}

/** Which side of a pair a program's types fall on: "a", "b", or null when neither or both. */
export function pairSide(pair: PairDef, types: readonly string[]): "a" | "b" | null {
  const inA = types.some((t) => (pair.a.types as readonly string[]).includes(t));
  const inB = types.some((t) => (pair.b.types as readonly string[]).includes(t));
  if (inA === inB) return null;
  return inA ? "a" : "b";
}

// ---------------------------------------------------------------------------------------------
// Preference option values (stable keys; labels live in the quiz spec)
// ---------------------------------------------------------------------------------------------

export const TIMING_VALUES = ["next_summer", "during_term", "winter_break"] as const;
export type TimingValue = (typeof TIMING_VALUES)[number];

export const LOCATION_VALUES = ["remote", "nearby", "travel"] as const;
export type LocationValue = (typeof LOCATION_VALUES)[number];

export const PAY_VALUES = ["must", "prefer", "any"] as const;
export type PayValue = (typeof PAY_VALUES)[number];

export const GOAL_VALUES = ["first_yes", "explore", "funding", "specific"] as const;
export type GoalValue = (typeof GOAL_VALUES)[number];

export const STYLE_VALUES = ["build", "investigate"] as const;
export const LENGTH_VALUES = ["short", "long"] as const;
export const VALUE_VALUES = ["experience", "funding"] as const;

/** Resume sources the quiz records (the file itself never leaves the device). */
export const RESUME_SOURCES = ["pdf", "docx", "paste", "none"] as const;
export type ResumeSource = (typeof RESUME_SOURCES)[number];
