import type { SectionKey } from "../types";

/**
 * Section headings early-career resumes use, normalized (lowercase, "&" and "/" read as
 * "and", punctuation dropped). Novus's own list, compiled from common student templates.
 */
export const HEADING_LEXICON: ReadonlyArray<readonly [SectionKey, readonly string[]]> = [
  ["education", [
    "education", "academic background", "academics", "education and honors", "education and awards",
    "academic history", "educational background", "academic profile", "academic information",
    "education and certifications", "education and training",
  ]],
  ["experience", [
    "experience", "experiences", "work experience", "professional experience", "relevant experience",
    "employment", "employment history", "employment experience", "work history", "internships",
    "internship experience", "work", "jobs", "career history", "professional history",
    "industry experience", "technical experience", "related experience", "additional experience",
    "other experience", "selected experience", "teaching experience", "work and leadership experience",
    "experience and leadership", "professional and leadership experience",
  ]],
  ["research", [
    "research", "research experience", "research and projects", "laboratory experience", "lab experience",
    "research positions", "undergraduate research",
  ]],
  ["projects", [
    "projects", "personal projects", "academic projects", "technical projects", "selected projects",
    "research projects", "project experience", "independent projects", "class projects", "course projects",
    "side projects", "portfolio", "projects and hackathons", "hackathons", "notable projects", "key projects",
  ]],
  ["skills", [
    "skills", "technical skills", "skills and interests", "skills and tools", "core competencies",
    "technologies", "languages and technologies", "tools", "skills and certifications", "computer skills",
    "technical proficiencies", "proficiencies", "qualifications", "skills summary", "relevant skills",
    "abilities", "software", "technical expertise", "tools and technologies", "technical skills and interests",
    "skills and abilities", "additional skills", "competencies", "programming languages",
  ]],
  ["coursework", [
    "relevant coursework", "coursework", "related courses", "selected coursework", "courses",
    "relevant courses", "course work", "related coursework", "key coursework", "academic coursework",
  ]],
  ["activities", [
    "leadership", "leadership experience", "activities", "extracurricular activities", "extracurriculars",
    "extra curricular activities", "extracurricular", "involvement", "campus involvement",
    "clubs and organizations", "student organizations", "leadership and activities", "activities and leadership",
    "leadership and involvement", "organizations", "clubs", "athletics", "sports", "campus activities",
    "co curricular activities", "memberships", "affiliations", "professional affiliations",
    "leadership and service", "activities and interests", "activities and honors", "student involvement",
    "leadership and extracurricular activities", "extracurricular activities and leadership",
  ]],
  ["volunteer", [
    "volunteer experience", "volunteering", "community service", "service", "volunteer work",
    "community involvement", "volunteer", "community engagement", "civic engagement", "outreach",
    "volunteer and community service", "service and volunteering",
  ]],
  ["awards", [
    "awards", "honors", "honors and awards", "awards and honors", "achievements", "scholarships",
    "recognition", "distinctions", "accomplishments", "awards and achievements", "honors and achievements",
    "scholarships and awards", "awards and scholarships", "competitions", "honors and activities",
    "awards and recognition", "honors and distinctions",
  ]],
  ["certifications", [
    "certifications", "certificates", "licenses and certifications", "certifications and licenses",
    "licenses", "training", "certifications and training", "professional development",
  ]],
  ["publications", [
    "publications", "presentations", "posters", "conferences", "publications and presentations",
    "papers", "research publications", "presentations and publications",
  ]],
  ["summary", [
    "summary", "profile", "objective", "about me", "career objective", "professional summary",
    "personal statement", "about", "overview", "career summary", "summary of qualifications", "personal profile",
  ]],
  ["interests", ["interests", "hobbies", "hobbies and interests", "personal interests", "interests and hobbies"]],
  ["languages", ["languages", "language skills", "spoken languages", "language proficiency"]],
  ["references", ["references", "references available upon request", "referees", "references available on request"]],
  ["other", ["additional information", "other", "miscellaneous", "additional", "highlights", "other information"]],
];

/**
 * One-word headings that are also ordinary words in a list ("Leadership" in a column of soft
 * skills). They count as headings only with a visual cue: caps, bold, a larger font, a colon,
 * an underline, a Markdown "#" or a blank line before.
 */
export const AMBIGUOUS_HEADINGS: ReadonlySet<string> = new Set([
  "leadership", "service", "work", "research", "tools", "software", "languages", "training", "outreach",
  "sports", "athletics", "clubs", "organizations", "about", "profile", "overview", "volunteer", "licenses",
  "papers", "conferences", "portfolio", "courses", "qualifications", "abilities", "technologies", "jobs",
  "memberships", "affiliations", "recognition", "accomplishments", "achievements", "involvement",
  "competencies", "highlights", "other", "additional", "interests", "hobbies", "posters", "presentations",
]);

/**
 * Head nouns for headings the lexicon does not list ("Software Engineering Experience",
 * "Leadership & Community Service"). Checked in order, so the specific ones come first.
 */
export const HEAD_NOUNS: ReadonlyArray<readonly [RegExp, SectionKey]> = [
  [/\b(?:volunteer\w*|community service)\b/, "volunteer"],
  [/\bresearch\b/, "research"],
  [/\b(?:publications?|presentations?|posters?)\b/, "publications"],
  [/\b(?:projects?|hackathons?)\b/, "projects"],
  [/\bcourse ?work\b|\bcourses\b/, "coursework"],
  [/\b(?:skills|technologies|tools|competencies|proficienc\w+)\b/, "skills"],
  [/\b(?:awards?|honou?rs|scholarships?|achievements?|recognitions?|competitions?|distinctions?)\b/, "awards"],
  [/\b(?:certifications?|certificates?|licenses?)\b/, "certifications"],
  [/\b(?:leadership|activities|involvement|organizations|clubs|athletics|extracurriculars?)\b/, "activities"],
  [/\b(?:experiences?|employment|internships?)\b/, "experience"],
  [/\b(?:education|academics?)\b/, "education"],
  [/\b(?:interests|hobbies)\b/, "interests"],
  [/\blanguages\b/, "languages"],
  [/\b(?:summary|objective)\b/, "summary"],
  [/\breferences\b/, "references"],
  [/\b(?:information|miscellaneous)\b/, "other"],
];
