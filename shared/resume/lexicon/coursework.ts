import type { MajorFamily } from "../../taxonomy";

/**
 * Coursework keywords: a closed list that course titles are folded into for ProfileSignals
 * ("CS 2110: Object-Oriented Programming and Data Structures" gives Programming and Data
 * Structures). Novus's own list. A course that matches nothing stays on the device.
 */
export interface CourseKeyword {
  keyword: string;
  family: MajorFamily;
  pattern: RegExp;
}

const k = (keyword: string, family: MajorFamily, pattern: RegExp): CourseKeyword => ({ keyword, family, pattern });

export const COURSE_KEYWORDS: readonly CourseKeyword[] = [
  // Computing
  k("Programming", "computing", /\b(?:intro(?:duction)? to (?:computer science|computing|programming)|programming|object[- ]oriented|cs ?1\b|computer science i\b|coding)\b/i),
  k("Data Structures", "computing", /\bdata structures?\b/i),
  k("Algorithms", "computing", /\balgorithms?\b/i),
  k("Discrete Math", "math_statistics", /\bdiscrete (?:math(?:ematics)?|structures)\b/i),
  k("Computer Systems", "computing", /\b(?:computer (?:systems|organization|architecture)|systems programming)\b/i),
  k("Operating Systems", "computing", /\boperating systems?\b/i),
  k("Databases", "computing", /\b(?:databases?|database systems|data management)\b/i),
  k("Software Engineering", "computing", /\bsoftware (?:engineering|design|development)\b/i),
  k("Web Development", "computing", /\bweb (?:development|programming|design|applications?)\b/i),
  k("Machine Learning", "computing", /\bmachine learning\b/i),
  k("Artificial Intelligence", "computing", /\b(?:artificial intelligence|\bai\b)/i),
  k("Computer Networks", "computing", /\b(?:computer )?network(?:s|ing)\b/i),
  k("Cybersecurity", "computing", /\b(?:cyber ?security|computer security|cryptography|information security)\b/i),
  k("Human-Computer Interaction", "computing", /\b(?:human[- ]computer interaction|hci|user interface design)\b/i),
  k("Theory of Computation", "computing", /\b(?:theory of computation|automata|computability)\b/i),
  k("Data Science", "computing", /\bdata (?:science|analysis|analytics)\b/i),
  // Math and statistics
  k("Calculus", "math_statistics", /\b(?:calculus|calc (?:i|ii|iii|1|2|3)\b|ap calc)/i),
  k("Multivariable Calculus", "math_statistics", /\b(?:multivariable|multivariate|vector) calculus\b|\bcalculus iii\b/i),
  k("Linear Algebra", "math_statistics", /\blinear algebra\b/i),
  k("Differential Equations", "math_statistics", /\bdifferential equations?\b|\bdiff ?eq\b|\bodes?\b/i),
  k("Probability", "math_statistics", /\bprobability\b/i),
  k("Statistics", "math_statistics", /\b(?:statistics|statistical methods|biostatistics|ap stats?)\b/i),
  k("Real Analysis", "math_statistics", /\breal analysis\b/i),
  k("Abstract Algebra", "math_statistics", /\babstract algebra\b/i),
  k("Econometrics", "social_sciences", /\beconometrics\b/i),
  // Sciences
  k("General Chemistry", "physical_sciences", /\b(?:general chemistry|gen chem|intro(?:duction)? to chemistry|chemistry i\b|ap chemistry)\b/i),
  k("Organic Chemistry", "physical_sciences", /\b(?:organic chemistry|orgo|o-?chem)\b/i),
  k("Biochemistry", "life_sciences", /\bbiochemistry\b/i),
  k("Physical Chemistry", "physical_sciences", /\bphysical chemistry\b|\bp-?chem\b/i),
  k("Physics", "physical_sciences", /\b(?:physics|electricity and magnetism|e&m|electromagnetism|classical mechanics|quantum mechanics|newtonian mechanics)\b/i),
  k("Biology", "life_sciences", /\b(?:biology|intro(?:duction)? to bio|ap bio(?:logy)?)\b/i),
  k("Cell Biology", "life_sciences", /\b(?:cell|cellular|molecular) biology\b/i),
  k("Genetics", "life_sciences", /\bgenetics\b|\bgenomics\b/i),
  k("Microbiology", "life_sciences", /\bmicrobiology\b/i),
  k("Ecology", "life_sciences", /\b(?:ecology|evolution(?:ary biology)?)\b/i),
  k("Anatomy and Physiology", "health", /\b(?:anatomy|physiology)\b/i),
  k("Neuroscience", "life_sciences", /\bneuro(?:science|biology)\b/i),
  k("Environmental Science", "agriculture_environment", /\benvironmental (?:science|studies)\b|\bclimate\b/i),
  k("Astronomy", "physical_sciences", /\bastronomy\b|\bastrophysics\b/i),
  k("Geology", "physical_sciences", /\bgeology\b|\bearth science\b/i),
  // Engineering
  k("Statics", "engineering_technology", /\bstatics\b/i),
  k("Dynamics", "engineering_technology", /\bdynamics\b/i),
  k("Thermodynamics", "engineering_technology", /\bthermodynamics\b/i),
  k("Fluid Mechanics", "engineering_technology", /\bfluid (?:mechanics|dynamics)\b/i),
  k("Circuits", "engineering_technology", /\b(?:circuits?|electronics)\b/i),
  k("Signals and Systems", "engineering_technology", /\bsignals and systems\b|\bsignal processing\b/i),
  k("Digital Logic", "engineering_technology", /\bdigital (?:logic|design|systems)\b/i),
  k("Materials Science", "engineering_technology", /\bmaterials? science\b/i),
  k("Engineering Design", "engineering_technology", /\bengineering design\b|\bcad\b/i),
  k("Mechanics of Materials", "engineering_technology", /\bmechanics of materials\b|\bstrength of materials\b/i),
  // Business and social sciences
  k("Microeconomics", "social_sciences", /\bmicro ?economics\b|\bmicro econ\b/i),
  k("Macroeconomics", "social_sciences", /\bmacro ?economics\b|\bmacro econ\b/i),
  k("Economics", "social_sciences", /\beconomics\b|\becon \d/i),
  k("Accounting", "business", /\baccounting\b/i),
  k("Finance", "business", /\b(?:finance|financial (?:management|markets|accounting))\b/i),
  k("Marketing", "business", /\bmarketing\b/i),
  k("Management", "business", /\b(?:management|organizational behavior|leadership)\b/i),
  k("Business Law", "business", /\bbusiness law\b/i),
  k("Entrepreneurship", "business", /\bentrepreneurship\b/i),
  k("Psychology", "social_sciences", /\bpsychology\b|\bpsych \d/i),
  k("Sociology", "social_sciences", /\bsociology\b/i),
  k("Anthropology", "social_sciences", /\banthropology\b/i),
  k("Political Science", "social_sciences", /\b(?:political science|american government|comparative politics|government)\b/i),
  k("Public Policy", "law_policy_service", /\bpublic policy\b|\bpolicy analysis\b/i),
  k("International Relations", "social_sciences", /\binternational relations\b|\bglobal affairs\b/i),
  k("Research Methods", "social_sciences", /\bresearch methods?\b|\bresearch design\b/i),
  // Humanities, health, arts
  k("Writing", "humanities_languages", /\b(?:writing|composition|rhetoric|english 1\d\d)\b/i),
  k("Public Speaking", "communication_media", /\bpublic speaking\b|\bspeech\b/i),
  k("Philosophy", "humanities_languages", /\bphilosophy\b|\b(?:formal|symbolic|deductive) logic\b|\bintro(?:duction)? to logic\b/i),
  k("Ethics", "humanities_languages", /\bethics\b/i),
  k("History", "humanities_languages", /\bhistory\b/i),
  k("Literature", "humanities_languages", /\bliterature\b/i),
  k("Foreign Language", "humanities_languages", /\b(?:spanish|french|german|italian|chinese|mandarin|japanese|korean|arabic|portuguese|russian|latin) (?:i|ii|iii|1|2|3|\d{3,4}|language|conversation|composition)\b/i),
  k("Public Health", "health", /\bpublic health\b|\bepidemiology\b/i),
  k("Nutrition", "health", /\bnutrition\b/i),
  k("Medical Terminology", "health", /\bmedical terminology\b/i),
  k("Design", "arts_design", /\b(?:graphic design|design thinking|drawing|studio art|visual design)\b/i),
  k("Music Theory", "arts_design", /\bmusic theory\b/i),
  k("Film", "communication_media", /\bfilm\b|\bcinema\b/i),
];
