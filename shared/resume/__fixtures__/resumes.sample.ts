import type { ClassYear } from "../../taxonomy";
import type { DegreeLevel, ResumeEntryKind, ResumeHints, ResumeLine } from "../types";
import { plainText, renderColumn, type RowSpec } from "./render";

/**
 * SAMPLE resumes for tests. Every person, school pairing, employer pairing, email, phone and
 * address here is invented: emails use example.com / example.edu, US phones use the 555-01xx
 * range reserved for fiction, the UK number is in Ofcom's drama range, and street addresses
 * are fictional. Layouts vary on purpose: pasted text with caps headings, Markdown, a
 * single-column PDF, a two-column PDF, a table-based DOCX, a Canva-style PDF split into one
 * item per glyph, education-last, obfuscated contact details, sensitive statements, and the
 * onboarding mini builder's output.
 */

export interface ExpectedEducation {
  institution: string | null;
  area: string | null;
  degreeLevel: DegreeLevel | null;
  endDate: string | null;
  startDate?: string | null;
  score?: string | null;
}

export interface ExpectedExperience {
  position: string | null;
  organization: string | null;
  kind: ResumeEntryKind;
  startDate: string | null;
  endDate: string | null;
}

export interface ExpectedResume {
  contact: { name: string | null; email: string | null; phone: string | null; location: string | null };
  education: ExpectedEducation[];
  experience: ExpectedExperience[];
  projects: string[];
  skills: string[];
  coursework: string[];
  awards: string[];
  twoColumn?: boolean;
  classYear?: ClassYear | null;
}

export interface SampleResume {
  id: string;
  /** Always starts with "SAMPLE". */
  label: string;
  layout: "pasted" | "markdown" | "pdf" | "pdf-two-column" | "docx" | "pdf-glyphs" | "builder";
  now: string;
  input: { text: string; lines?: ResumeLine[] };
  hints?: ResumeHints;
  expected: ExpectedResume;
  /** The student's own contact details and other people's names: absent from every AI text. */
  pii: string[];
  /** Names the allowlist keeps on the device (schools, organizations, awards, GPA). */
  withheld: string[];
  /** Sensitive statements: absent from every AI text. */
  sensitive: string[];
  /** Benign look-alikes that must survive in the allowlisted text. */
  survives: string[];
}

const NOW = "2026-11-11";

// ---------------------------------------------------------------------------------------------
// 1. Pasted text: caps headings, pipes, right-aligned dates padded with spaces
// ---------------------------------------------------------------------------------------------

const classic: SampleResume = {
  id: "classic-pasted",
  label: "SAMPLE: pasted text with caps headings and pipes",
  layout: "pasted",
  now: NOW,
  input: {
    text: `JORDAN ALVAREZ-REYES
Ithaca, NY | jordan.reyes@example.edu | (555) 010-4477 | linkedin.com/in/jordan-reyes | github.com/jreyes

EDUCATION
Cornell University, Ithaca, NY                                   Expected May 2029
Bachelor of Science in Computer Science, Minor in Statistics
GPA: 3.82/4.00 | Dean's List (Fall 2025, Spring 2026)
Relevant Coursework: CS 2110 Object-Oriented Programming and Data Structures, MATH 2940 Linear Algebra, Discrete Structures

EXPERIENCE
Software Engineering Intern | Acme Robotics, Rochester, NY                Jun 2026 - Aug 2026
• Built a React dashboard used by 40 warehouse staff to track orders
• Automated weekly inventory reports with Python and SQL, saving 6 hours a week

Undergraduate Research Assistant | Cornell Vision Lab                     Jan 2026 - Present
• Labeled 3,000 images and trained a PyTorch classifier under Dr. Maria Chen
• Presented a poster at the spring research forum

PROJECTS
Campus Bus Tracker (React Native, Firebase)                               Fall 2025
• Built a mobile app that shows live bus locations for 1,200 weekly riders

LEADERSHIP & ACTIVITIES
Treasurer, Robotics Club                                                  Sep 2025 - Present
• Managed a $5,000 annual budget and organized two build weekends

SKILLS
Languages: Python, Java, JavaScript, SQL, C++
Tools: Git, React, Node.js, Figma, Excel
`,
  },
  expected: {
    contact: { name: "Jordan Alvarez-Reyes", email: "jordan.reyes@example.edu", phone: "(555) 010-4477", location: "Ithaca, NY" },
    education: [{ institution: "Cornell University", area: "Computer Science", degreeLevel: "bachelor", endDate: "2029-05", score: "3.82/4.00" }],
    experience: [
      { position: "Software Engineering Intern", organization: "Acme Robotics", kind: "internship", startDate: "2026-06", endDate: "2026-08" },
      { position: "Undergraduate Research Assistant", organization: "Cornell Vision Lab", kind: "research", startDate: "2026-01", endDate: null },
      { position: "Treasurer", organization: "Robotics Club", kind: "leadership", startDate: "2025-09", endDate: null },
    ],
    projects: ["Campus Bus Tracker"],
    skills: ["Python", "Java", "JavaScript", "SQL", "C++", "Git", "React", "Node.js", "Figma", "Excel", "React Native", "Firebase", "PyTorch"],
    coursework: ["Object-Oriented Programming and Data Structures", "Linear Algebra", "Discrete Structures"],
    awards: ["Dean's List (Fall 2025, Spring 2026)"],
    classYear: "second_year",
  },
  pii: ["Alvarez", "Reyes", "jordan.reyes@example.edu", "010-4477", "Ithaca, NY", "linkedin.com/in/jordan-reyes", "github.com/jreyes", "Maria Chen"],
  withheld: ["Cornell", "Acme Robotics", "Robotics Club", "Dean's List", "3.82"],
  sensitive: [],
  survives: ["React Native", "PyTorch classifier"],
};

// ---------------------------------------------------------------------------------------------
// 2. Markdown with Title Case headings and inline bold
// ---------------------------------------------------------------------------------------------

const markdown: SampleResume = {
  id: "markdown-title-case",
  label: "SAMPLE: Markdown export with Title Case headings",
  layout: "markdown",
  now: NOW,
  input: {
    text: `# Priya Natarajan
priya.natarajan@example.com · 555-010-0142 · Austin, TX · priyanatarajan.dev

## Education
**The University of Texas at Austin** — B.A. in Economics, Class of 2030
- GPA: 3.9
- Relevant coursework: Microeconomics, Intro to Statistics, Calculus II

## Experience
**Marketing Intern**, Lone Star Credit Union (Summer 2026)
- Wrote 12 newsletters for 8,000 members and grew open rates by 9%
- Analyzed survey data in Excel and Google Sheets

**Peer Tutor**, UT Learning Center (Sep 2026 – Present)
- Tutor 15 students a week in calculus and statistics

## Projects
**Budget Buddy** — a Python app that sorts bank transactions into categories
- Used pandas and Matplotlib to chart monthly spending

## Skills
Python, Excel, Google Sheets, Tableau, Spanish (conversational)
`,
  },
  expected: {
    contact: { name: "Priya Natarajan", email: "priya.natarajan@example.com", phone: "555-010-0142", location: "Austin, TX" },
    education: [{ institution: "The University of Texas at Austin", area: "Economics", degreeLevel: "bachelor", endDate: "2030", score: "3.9" }],
    experience: [
      { position: "Marketing Intern", organization: "Lone Star Credit Union", kind: "internship", startDate: "2026-06", endDate: "2026-08" },
      { position: "Peer Tutor", organization: "UT Learning Center", kind: "teaching", startDate: "2026-09", endDate: null },
    ],
    projects: ["Budget Buddy"],
    skills: ["Python", "Excel", "Google Sheets", "Tableau", "Spanish", "pandas", "Matplotlib"],
    coursework: ["Microeconomics", "Intro to Statistics", "Calculus II"],
    awards: [],
    classYear: "first_year",
  },
  pii: ["Priya", "Natarajan", "priya.natarajan@example.com", "555-010-0142", "Austin, TX", "priyanatarajan.dev"],
  withheld: ["University of Texas", "Lone Star Credit Union", "UT Learning Center", "3.9"],
  sensitive: [],
  survives: ["Google Sheets"],
};

// ---------------------------------------------------------------------------------------------
// 3. Single-column PDF: bold caps headings, bold organizations, right-aligned dates
// ---------------------------------------------------------------------------------------------

const pdfRows: RowSpec[] = [
  { text: "Daniel Okafor", size: 20, bold: true, x: 240 },
  { text: "Columbus, OH | daniel.okafor@example.edu | (555) 010-0187", x: 160, gap: 22 },
  { text: "EDUCATION", size: 11, bold: true, gap: 24 },
  { text: "The Ohio State University", bold: true, right: "Columbus, OH", gap: 16 },
  { text: "Bachelor of Science in Mechanical Engineering", right: "Expected May 2030" },
  { text: "GPA: 3.65/4.0", bullet: "•" },
  { text: "Dean's List (Spring 2026)", bullet: "•" },
  { text: "EXPERIENCE", size: 11, bold: true, gap: 24 },
  { text: "Buckeye Formula Racing Team", bold: true, right: "Sep 2026 – Present", gap: 16 },
  { text: "Suspension Team Member", right: "Columbus, OH" },
  { text: "Modeled suspension geometry in SolidWorks and checked loads in MATLAB", bullet: "•" },
  { text: "Machined 14 aluminum brackets on a manual mill", bullet: "•" },
  { text: "Kroger", bold: true, right: "Jun 2025 – Aug 2026", gap: 19 },
  { text: "Cashier", right: "Dublin, OH" },
  { text: "Handled 300 transactions a shift with a balanced drawer", bullet: "•" },
  { text: "PROJECTS", size: 11, bold: true, gap: 24 },
  { text: "Desk Fan Redesign", bold: true, right: "Spring 2026", gap: 16 },
  { text: "Designed a quieter fan housing in Fusion 360 and 3D printed three prototypes", bullet: "•" },
  { text: "SKILLS", size: 11, bold: true, gap: 24 },
  { text: "SolidWorks, MATLAB, Fusion 360, Excel, 3D Printing", gap: 16 },
];
const pdfLines = renderColumn(pdfRows, { x: 36, top: 760 });

const pdfSingle: SampleResume = {
  id: "pdf-single-column",
  label: "SAMPLE: single-column PDF with right-aligned dates",
  layout: "pdf",
  now: NOW,
  input: { text: plainText(pdfLines), lines: pdfLines },
  hints: { fileName: "Daniel_Okafor_Resume.pdf", author: "Daniel Okafor" },
  expected: {
    contact: { name: "Daniel Okafor", email: "daniel.okafor@example.edu", phone: "(555) 010-0187", location: "Columbus, OH" },
    education: [{ institution: "The Ohio State University", area: "Mechanical Engineering", degreeLevel: "bachelor", endDate: "2030-05", score: "3.65/4.0" }],
    experience: [
      { position: "Suspension Team Member", organization: "Buckeye Formula Racing Team", kind: "club", startDate: "2026-09", endDate: null },
      { position: "Cashier", organization: "Kroger", kind: "part_time", startDate: "2025-06", endDate: "2026-08" },
    ],
    projects: ["Desk Fan Redesign"],
    skills: ["SolidWorks", "MATLAB", "Fusion 360", "Excel", "3D Printing"],
    coursework: [],
    awards: ["Dean's List (Spring 2026)"],
    classYear: "first_year",
  },
  pii: ["Daniel", "Okafor", "daniel.okafor@example.edu", "010-0187", "Columbus, OH"],
  withheld: ["Ohio State", "Kroger", "Buckeye", "3.65", "Dean's List"],
  sensitive: [],
  survives: ["Fusion 360"],
};

// ---------------------------------------------------------------------------------------------
// 4. Two-column PDF: a left sidebar (skills, coursework, languages) beside the main column
// ---------------------------------------------------------------------------------------------

const header2 = renderColumn(
  [
    { text: "Mei-Lin Zhou", size: 22, bold: true },
    { text: "Seattle, WA | meilin.zhou@example.com | 555.010.0123 | github.com/meilinzhou", gap: 20 },
  ],
  { x: 36, top: 770 },
);
const sidebar = renderColumn(
  [
    { text: "SKILLS", size: 11, bold: true },
    { text: "Python", gap: 15 },
    { text: "R" },
    { text: "SQL" },
    { text: "Tableau" },
    { text: "Git" },
    { text: "COURSEWORK", size: 11, bold: true, gap: 22 },
    { text: "Data Structures", gap: 15 },
    { text: "Intro to Statistics" },
    { text: "Linear Algebra" },
    { text: "LANGUAGES", size: 11, bold: true, gap: 22 },
    { text: "English", gap: 15 },
    { text: "Mandarin" },
  ],
  { x: 36, top: 700 },
);
const main2 = renderColumn(
  [
    { text: "EDUCATION", size: 11, bold: true },
    { text: "University of Washington", bold: true, gap: 15 },
    { text: "B.S. in Informatics", right: "Expected June 2030" },
    { text: "EXPERIENCE", size: 11, bold: true, gap: 22 },
    { text: "Data Science Intern", bold: true, right: "Jun 2026 – Sep 2026", gap: 15 },
    { text: "Pacific Northwest Data Lab" },
    { text: "Cleaned two million rows of sensor data with pandas", bullet: "•" },
    { text: "Built a Tableau dashboard for the lab's weekly review", bullet: "•" },
    { text: "Barista", bold: true, right: "Oct 2025 – Present", gap: 19 },
    { text: "Cafe Allegro" },
    { text: "Made 150 drinks a shift during the morning rush", bullet: "•" },
    { text: "PROJECTS", size: 11, bold: true, gap: 22 },
    { text: "Rain Predictor", bold: true, right: "Spring 2026", gap: 15 },
    { text: "Trained a scikit-learn model on ten years of weather records", bullet: "•" },
  ],
  { x: 220, top: 700 },
);
const twoColumnLines = [...header2, ...sidebar, ...main2];

const pdfTwoColumn: SampleResume = {
  id: "pdf-two-column",
  label: "SAMPLE: two-column PDF with a skills sidebar",
  layout: "pdf-two-column",
  now: NOW,
  input: { text: plainText(twoColumnLines), lines: twoColumnLines },
  expected: {
    contact: { name: "Mei-Lin Zhou", email: "meilin.zhou@example.com", phone: "555.010.0123", location: "Seattle, WA" },
    education: [{ institution: "University of Washington", area: "Informatics", degreeLevel: "bachelor", endDate: "2030-06" }],
    experience: [
      { position: "Data Science Intern", organization: "Pacific Northwest Data Lab", kind: "internship", startDate: "2026-06", endDate: "2026-09" },
      { position: "Barista", organization: "Cafe Allegro", kind: "part_time", startDate: "2025-10", endDate: null },
    ],
    projects: ["Rain Predictor"],
    skills: ["Python", "R", "SQL", "Tableau", "Git", "English", "Mandarin", "pandas", "scikit-learn"],
    coursework: ["Data Structures", "Intro to Statistics", "Linear Algebra"],
    awards: [],
    twoColumn: true,
    classYear: "first_year",
  },
  pii: ["Mei-Lin", "Zhou", "meilin.zhou@example.com", "555.010.0123", "Seattle, WA", "github.com/meilinzhou", "meilinzhou"],
  withheld: ["University of Washington", "Pacific Northwest Data Lab", "Cafe Allegro"],
  sensitive: [],
  survives: ["scikit-learn"],
};

// ---------------------------------------------------------------------------------------------
// 5. DOCX built from a table: one line per cell, bold flags, heading sizes, no positions
// ---------------------------------------------------------------------------------------------

const docxLines: ResumeLine[] = [
  { text: "Sofia Martínez", bold: true, fontSize: 20 },
  { text: "Miami, FL | sofia.martinez@example.edu | 555-010-0165" },
  { text: "EDUCATION", bold: true, fontSize: 14 },
  { text: "Miami Dade College", bold: true },
  { text: "Aug 2025 – May 2027" },
  { text: "Associate in Arts, Biology" },
  { text: "GPA 3.7" },
  { text: "EXPERIENCE", bold: true, fontSize: 14 },
  { text: "Pharmacy Technician Trainee", bold: true },
  { text: "Jan 2026 – Present" },
  { text: "Walgreens, Hialeah, FL" },
  { text: "Counted and labeled prescriptions for 120 patients a day" },
  { text: "Answered insurance questions at the pickup counter" },
  { text: "VOLUNTEER EXPERIENCE", bold: true, fontSize: 14 },
  { text: "Hospital Volunteer", bold: true },
  { text: "Jun 2025 – Aug 2025" },
  { text: "Jackson Memorial Hospital" },
  { text: "Guided 40 visitors a day to clinics and waiting rooms" },
  { text: "SKILLS", bold: true, fontSize: 14 },
  { text: "Microsoft Office, Phlebotomy, CPR, Spanish" },
];

const docxTable: SampleResume = {
  id: "docx-table",
  label: "SAMPLE: table-based DOCX read cell by cell",
  layout: "docx",
  now: NOW,
  input: { text: docxLines.map((l) => l.text).join("\n"), lines: docxLines },
  expected: {
    contact: { name: "Sofia Martínez", email: "sofia.martinez@example.edu", phone: "555-010-0165", location: "Miami, FL" },
    education: [{ institution: "Miami Dade College", area: "Biology", degreeLevel: "associate", startDate: "2025-08", endDate: "2027-05", score: "3.7" }],
    experience: [
      { position: "Pharmacy Technician Trainee", organization: "Walgreens", kind: "work", startDate: "2026-01", endDate: null },
      { position: "Hospital Volunteer", organization: "Jackson Memorial Hospital", kind: "volunteer", startDate: "2025-06", endDate: "2025-08" },
    ],
    projects: [],
    skills: ["Microsoft Office", "Phlebotomy", "CPR", "Spanish"],
    coursework: [],
    awards: [],
    classYear: "second_year",
  },
  pii: ["Sofia", "Martínez", "Martinez", "sofia.martinez@example.edu", "555-010-0165", "Miami, FL"],
  withheld: ["Miami Dade", "Walgreens", "Jackson Memorial", "3.7"],
  sensitive: [],
  survives: ["prescriptions"],
};

// ---------------------------------------------------------------------------------------------
// 6. High school senior, objective first, education last, part-time work, a confounder
// ---------------------------------------------------------------------------------------------

const highSchool: SampleResume = {
  id: "hs-education-last",
  label: "SAMPLE: high school senior, education last",
  layout: "pasted",
  now: NOW,
  input: {
    text: `Aaliyah Brooks
aaliyah.brooks@example.com   (555) 010-0110   Atlanta, GA

OBJECTIVE
High school senior looking for a summer program in public health.

WORK EXPERIENCE
Cashier, Old Navy                                    June 2025 - Present
- Helped 100+ customers a shift and balanced the register
- Trained 3 new team members on returns

VOLUNTEER EXPERIENCE
Volunteer, Atlanta Community Food Bank               2024 - 2025
- Packed 2,000 meals for local families

SKILLS
Customer service, Microsoft Word, Canva, Spanish

EDUCATION
Westlake High School, Atlanta, GA
High School Diploma, Expected May 2027
GPA: 3.8 (unweighted)
`,
  },
  expected: {
    contact: { name: "Aaliyah Brooks", email: "aaliyah.brooks@example.com", phone: "(555) 010-0110", location: "Atlanta, GA" },
    education: [{ institution: "Westlake High School", area: null, degreeLevel: "high_school", endDate: "2027-05", score: "3.8" }],
    experience: [
      { position: "Cashier", organization: "Old Navy", kind: "part_time", startDate: "2025-06", endDate: null },
      { position: "Volunteer", organization: "Atlanta Community Food Bank", kind: "volunteer", startDate: "2024", endDate: "2025" },
    ],
    projects: [],
    skills: ["Customer Service", "Microsoft Word", "Canva", "Spanish"],
    coursework: [],
    awards: [],
    classYear: "incoming_first_year",
  },
  pii: ["Aaliyah", "Brooks", "aaliyah.brooks@example.com", "010-0110", "Atlanta, GA"],
  withheld: ["Westlake", "Old Navy", "Atlanta Community Food Bank", "3.8"],
  sensitive: [],
  survives: ["balanced the register"],
};

// ---------------------------------------------------------------------------------------------
// 7. Sensitive statements next to benign look-alikes
// ---------------------------------------------------------------------------------------------

const sensitive: SampleResume = {
  id: "sensitive-statements",
  label: "SAMPLE: sensitive statements and confounders",
  layout: "pasted",
  now: NOW,
  input: {
    text: `Jamal Washington
jamal.w@example.com | 555-010-0133 | 1442 Peachtree Street NE, Apt 5, Atlanta, GA 30309

SUMMARY
First-generation college student and Pell Grant recipient who loves building software.

EDUCATION
Georgia Institute of Technology                     Expected May 2030
B.S. Computer Science
Scholarships: QuestBridge National College Match Scholar, Hispanic Scholarship Fund

EXPERIENCE
Software Engineering Intern, Delta Air Lines        Jun 2026 - Aug 2026
- Built a React Native app for gate agents
- Wrote unit tests in Jest for the boarding flow
- Ran a double-blind study of two check-in flows with 40 travelers

LEADERSHIP
Treasurer, Black Student Union                      Sep 2026 - Present
- Managed a $3,000 budget for 12 events

Mentor, Muslim Students Association                 Sep 2026 - Present
- Organized weekly iftar dinners during Ramadan

VOLUNTEER
Volunteer, Salvation Army                           2024 - 2025
- Sorted donations for the holiday drive

ADDITIONAL INFORMATION
- DACA recipient; authorized to work in the U.S.
- Diagnosed with ADHD; registered with the Office of Disability Services
- U.S. Army veteran
- Pronouns: he/him

SKILLS
Python, JavaScript, React Native, Jest, Git
`,
  },
  expected: {
    contact: { name: "Jamal Washington", email: "jamal.w@example.com", phone: "555-010-0133", location: "Atlanta, GA" },
    education: [{ institution: "Georgia Institute of Technology", area: "Computer Science", degreeLevel: "bachelor", endDate: "2030-05" }],
    experience: [
      { position: "Software Engineering Intern", organization: "Delta Air Lines", kind: "internship", startDate: "2026-06", endDate: "2026-08" },
      { position: "Treasurer", organization: "Black Student Union", kind: "leadership", startDate: "2026-09", endDate: null },
      { position: "Mentor", organization: "Muslim Students Association", kind: "teaching", startDate: "2026-09", endDate: null },
      { position: "Volunteer", organization: "Salvation Army", kind: "volunteer", startDate: "2024", endDate: "2025" },
    ],
    projects: [],
    skills: ["Python", "JavaScript", "React Native", "Jest", "Git"],
    coursework: [],
    awards: ["QuestBridge National College Match Scholar", "Hispanic Scholarship Fund"],
    classYear: "first_year",
  },
  pii: ["Jamal", "Washington", "jamal.w@example.com", "555-010-0133", "1442 Peachtree", "Apt 5", "30309"],
  withheld: ["Georgia Institute of Technology", "Delta Air Lines"],
  sensitive: [
    "First-generation",
    "Pell",
    "QuestBridge",
    "Hispanic",
    "Black Student Union",
    "Muslim",
    "iftar",
    "Ramadan",
    "DACA",
    "authorized to work",
    "ADHD",
    "Disability",
    "Army veteran",
    "he/him",
    "Managed a $3,000 budget",
  ],
  survives: ["React Native", "double-blind study", "Sorted donations"],
};

// ---------------------------------------------------------------------------------------------
// 8. Canva-style PDF: one item per glyph, private-use bullets, a ligature
// ---------------------------------------------------------------------------------------------

const glyphRows: RowSpec[] = [
  { text: "ETHAN KOWALSKI", size: 18, bold: true },
  { text: "ethan.kowalski@example.com | +1 555 010 0156 | Pittsburgh, PA", gap: 20 },
  { text: "EDUCATION", size: 12, bold: true, gap: 24 },
  { text: "University of Pittsburgh", bold: true, right: "Expected April 2029", gap: 16 },
  { text: "B.S. in Bioengineering, GPA 3.71/4.00" },
  { text: "RESEARCH EXPERIENCE", size: 12, bold: true, gap: 24 },
  { text: "Research Assistant, Tissue Engineering Lab", bold: true, right: "Jan 2026 – Present", gap: 16 },
  { text: "Classiﬁed 800 cell images with a Python script", bullet: "\uF0B7" },
  { text: "Prepared scaffolds and ran cell culture assays", bullet: "\uF0B7" },
  { text: "SKILLS", size: 12, bold: true, gap: 24 },
  { text: "MATLAB, Python, SolidWorks, Cell Culture", gap: 16 },
];
const glyphLines = renderColumn(glyphRows, { x: 40, top: 760, glyphs: true });

const canva: SampleResume = {
  id: "pdf-glyph-split",
  label: "SAMPLE: Canva-style PDF split into glyphs",
  layout: "pdf-glyphs",
  now: NOW,
  input: { text: "", lines: glyphLines },
  expected: {
    contact: { name: "Ethan Kowalski", email: "ethan.kowalski@example.com", phone: "+1 555 010 0156", location: "Pittsburgh, PA" },
    education: [{ institution: "University of Pittsburgh", area: "Bioengineering", degreeLevel: "bachelor", endDate: "2029-04", score: "3.71/4.00" }],
    experience: [{ position: "Research Assistant", organization: "Tissue Engineering Lab", kind: "research", startDate: "2026-01", endDate: null }],
    projects: [],
    skills: ["MATLAB", "Python", "SolidWorks", "Cell Culture"],
    coursework: [],
    awards: [],
    classYear: "second_year",
  },
  pii: ["Ethan", "Kowalski", "ethan.kowalski@example.com", "555 010 0156", "Pittsburgh, PA"],
  withheld: ["University of Pittsburgh", "Tissue Engineering Lab", "3.71"],
  sensitive: [],
  survives: ["Classified 800 cell images"],
};

// ---------------------------------------------------------------------------------------------
// 9. Obfuscated contact details, a street address, an international phone, a non-Anglo name
// ---------------------------------------------------------------------------------------------

const obfuscated: SampleResume = {
  id: "obfuscated-contact",
  label: "SAMPLE: obfuscated email, street address, international phone",
  layout: "pasted",
  now: NOW,
  input: {
    text: `Nguyễn Thị Minh Anh
Email: minhanh.nguyen [at] example [dot] edu
Phone: +44 20 7946 0123
Address: 742 Evergreen Terrace, Springfield, OR 97477
LinkedIn: linkedin.com/in/minh-anh-nguyen

Education
De Anza College - Associate of Science in Mathematics, expected June 2027
GPA 3.95/4.0

Work
Math Tutor - De Anza Math Lab - Sep 2025 to Present
Tutored 20 students a week in calculus and statistics
Created practice worksheets in LaTeX

Library Assistant - Cupertino Public Library - Summer 2025
Shelved and checked out 500 books a week

Skills
LaTeX, Python, Excel, Vietnamese, English
`,
  },
  expected: {
    contact: { name: "Nguyễn Thị Minh Anh", email: "minhanh.nguyen [at] example [dot] edu", phone: "+44 20 7946 0123", location: "Springfield, OR" },
    education: [{ institution: "De Anza College", area: "Mathematics", degreeLevel: "associate", endDate: "2027-06", score: "3.95/4.0" }],
    experience: [
      { position: "Math Tutor", organization: "De Anza Math Lab", kind: "teaching", startDate: "2025-09", endDate: null },
      { position: "Library Assistant", organization: "Cupertino Public Library", kind: "part_time", startDate: "2025-06", endDate: "2025-08" },
    ],
    projects: [],
    skills: ["LaTeX", "Python", "Excel", "Vietnamese", "English"],
    coursework: [],
    awards: [],
    classYear: "second_year",
  },
  pii: ["Nguyễn", "Nguyen", "Minh Anh", "minhanh", "7946 0123", "742 Evergreen", "Springfield", "97477", "linkedin.com/in/minh-anh-nguyen"],
  withheld: ["De Anza", "Cupertino Public Library", "3.95"],
  sensitive: [],
  survives: ["practice worksheets"],
};

// ---------------------------------------------------------------------------------------------
// 10. The onboarding mini builder's output: no contact block, three tiny sections
// ---------------------------------------------------------------------------------------------

const builder: SampleResume = {
  id: "builder-minimal",
  label: "SAMPLE: three-answer mini builder text",
  layout: "builder",
  now: NOW,
  input: {
    text: `PROJECTS
- Built a website for my school's robotics club with HTML and CSS
ACTIVITIES
- Captain of the varsity soccer team
SKILLS
Python, HTML, CSS, Public Speaking`,
  },
  expected: {
    contact: { name: null, email: null, phone: null, location: null },
    education: [],
    experience: [{ position: null, organization: null, kind: "leadership", startDate: null, endDate: null }],
    projects: [],
    skills: ["Python", "HTML", "CSS", "Public Speaking"],
    coursework: [],
    awards: [],
    classYear: null,
  },
  pii: [],
  withheld: [],
  sensitive: [],
  survives: ["Built a website", "Captain of the varsity soccer team"],
};

export const SAMPLE_RESUMES: readonly SampleResume[] = [classic, markdown, pdfSingle, pdfTwoColumn, docxTable, highSchool, sensitive, canva, obfuscated, builder];
