/**
 * Role and organization vocabulary for entry headers, written for early-career resumes
 * (Novus's own lists). Each pattern is a plain word list so a reviewer can audit it.
 */

const words = (list: readonly string[]): string => list.map((w) => w.replace(/ /g, "\\s+")).join("|");

export const INTERN_RE = new RegExp(`\\b(?:${words([
  "intern", "interns", "internship", "co-op", "coop", "extern", "externship", "apprentice", "apprenticeship",
  "summer analyst", "summer associate", "summer scholar", "summer fellow", "summer engineer",
])})\\b`, "i");

export const RESEARCH_ROLE_RE = new RegExp(`\\b(?:${words([
  "research", "researcher", "research assistant", "research associate", "research fellow", "research intern",
  "research scholar", "research technician", "research aide", "lab assistant", "laboratory assistant",
  "lab technician", "laboratory technician", "lab aide", "field assistant", "undergraduate researcher",
])})\\b`, "i");

export const TEACHING_RE = new RegExp(`\\b(?:${words([
  "tutor", "tutoring", "teaching assistant", "teaching fellow", "course assistant", "learning assistant",
  "grader", "instructor", "teacher", "mentor", "peer mentor", "coach", "supplemental instruction",
  "si leader", "writing fellow", "writing consultant", "writing tutor", "peer educator", "peer advisor",
  "peer adviser", "teaching aide",
])})\\b|\\bTA\\b`, "i");

export const PART_TIME_RE = new RegExp(`\\b(?:${words([
  "cashier", "barista", "server", "waiter", "waitress", "host", "hostess", "busser", "cook", "line cook",
  "prep cook", "dishwasher", "lifeguard", "sales associate", "retail associate", "store associate",
  "crew member", "crew trainer", "team member", "stocker", "clerk", "receptionist", "front desk",
  "customer service", "delivery driver", "courier", "babysitter", "nanny", "dog walker", "pet sitter",
  "camp counselor", "counselor", "valet", "usher", "warehouse associate", "package handler",
  "student worker", "library assistant", "office assistant", "administrative assistant", "food service",
  "dining services", "bagger", "caddie", "part-time", "part time", "shift lead", "shift leader",
  "swim instructor", "server assistant", "bartender", "sales representative", "brand ambassador",
])})\\b`, "i");

export const LEADERSHIP_RE = new RegExp(`\\b(?:${words([
  "president", "vice president", "vice-president", "treasurer", "secretary", "captain", "co-captain",
  "chair", "chairperson", "chairman", "chairwoman", "co-chair", "founder", "co-founder", "cofounder",
  "director", "head", "lead", "leader", "officer", "organizer", "coordinator", "representative", "senator",
  "delegate", "ambassador", "editor-in-chief", "editor in chief", "managing editor", "board member",
  "executive board", "e-board", "chief", "liaison", "manager", "commissioner", "historian",
])})\\b|\\bVP\\b`, "i");

export const MEMBER_RE = new RegExp(`\\b(?:${words([
  "member", "participant", "player", "performer", "athlete", "musician", "singer", "dancer", "writer",
  "contributor", "staff writer", "reporter", "photographer", "competitor", "teammate", "general member",
])})\\b`, "i");

export const VOLUNTEER_RE = /\bvolunteer(?:ed|ing|s)?\b/i;

export const INSIGHT_RE = new RegExp(`\\b(?:${words([
  "insight week", "insight program", "insight day", "insight days", "insight series", "discovery day",
  "discovery program", "spring week", "early insight", "exploration program", "explore program",
  "sophomore program", "freshman program", "first-year program",
])})\\b`, "i");

export const COMPETITION_RE = new RegExp(`\\b(?:${words([
  "hackathon", "olympiad", "competition", "case competition", "science fair", "finalist", "semifinalist",
  "semi-finalist", "winner", "1st place", "2nd place", "3rd place", "first place", "second place",
  "third place", "honorable mention", "datathon", "ideathon", "pitch competition",
])})\\b`, "i");

/** Generic job titles; enough to say "this cell is a role, not an organization". */
export const GENERAL_ROLE_RE = new RegExp(`\\b(?:${words([
  "engineer", "engineering intern", "developer", "analyst", "assistant", "associate", "specialist",
  "technician", "consultant", "designer", "programmer", "administrator", "scribe", "aide", "operator",
  "fellow", "scholar", "trainee", "agent", "advisor", "adviser", "strategist", "producer", "editor",
  "planner", "curator", "guide", "docent", "navigator", "emt", "cna", "medical assistant",
  "pharmacy technician", "staff", "worker", "crew", "scientist", "architect", "marketer", "recruiter",
  "facilitator", "moderator", "organizer", "data scientist", "software engineer", "web developer",
])})\\b`, "i");

/** Any role word at all. */
export function hasRoleWord(text: string): boolean {
  return [INTERN_RE, RESEARCH_ROLE_RE, TEACHING_RE, PART_TIME_RE, LEADERSHIP_RE, MEMBER_RE, VOLUNTEER_RE, GENERAL_ROLE_RE].some((re) =>
    re.test(text),
  );
}

/**
 * Words that mark an organization name (capitalized, so "lab" in a sentence does not count).
 */
export const ORG_SUFFIX_RE = new RegExp(`(?<![\\p{L}])(?:${[
  "Inc\\.?", "LLC", "L\\.L\\.C\\.", "Ltd\\.?", "Corp(?:oration)?\\.?", "Co\\.", "Company", "Companies", "Group",
  "Partners", "Capital", "Ventures", "Technologies", "Technology", "Labs?", "Laborator(?:y|ies)", "University",
  "College", "Institute", "School", "Academy", "Center", "Centre", "Foundation", "Hospital", "Clinic", "Health",
  "Club", "Society", "Association", "Council", "Team", "Department", "Dept\\.?", "Museum", "Library", "Bank",
  "Agency", "Office", "Committee", "Organization", "Alliance", "Network", "Union", "Chapter", "Studio", "Systems",
  "Solutions", "Services", "Consulting", "Media", "Press", "Magazine", "Journal", "Newspaper", "Restaurant",
  "Cafe", "Café", "Coffee", "Market", "Store", "Shop", "Camp", "YMCA", "YWCA", "Program", "Project",
  "Initiative", "Coalition", "League", "Federation", "Commission", "Bureau", "Administration", "Authority",
  "Church", "Board", "Fund", "Trust", "Partnership", "Collective", "Ensemble", "Orchestra", "Band", "Choir",
  "Theatre", "Theater", "Gym", "Pharmacy", "Bakery", "Diner", "Grill", "Kitchen", "Farms?", "Industries",
  "International", "Global", "Studios", "Records", "Robotics", "Motors", "Airlines", "Bancorp", "Holdings",
].join("|")})(?![\\p{L}])`, "u");

export function hasOrgWord(text: string): boolean {
  return ORG_SUFFIX_RE.test(text);
}

/** Words that mark a school, for education entries. */
export const INSTITUTION_RE = /(?<![\p{L}])(?:University|Universidad|Université|Universität|Universita|College|Institute(?:\s+of\s+Technology)?|Polytechnic|Academy|Conservatory|School|Community College|High School|Univ\.)(?![\p{L}])|\b(?:CUNY|SUNY|MIT|UCLA|USC|NYU|UC Berkeley|UC San Diego|UC Davis|UC Irvine|UCSD|UCSB|Caltech|Georgia Tech|Virginia Tech|Texas Tech|Cal Poly|Purdue|Rutgers|Stanford|Harvard|Yale|Princeton|Dartmouth|Cornell|Duke|Northwestern|Vanderbilt|Columbia|Brown|Penn State|UPenn|Johns Hopkins|Carnegie Mellon|CMU|Emory|Tufts|Rice|Georgetown|Notre Dame|UNC|UMich|UIUC|UT Austin)\b/u;

export function hasInstitutionWord(text: string): boolean {
  return INSTITUTION_RE.test(text);
}
