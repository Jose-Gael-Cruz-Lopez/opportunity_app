import type { ResumeLine } from "../types";
import { plainText, renderColumn, type RowSpec } from "./render";
import type { SampleResume } from "./resumes.sample";

/**
 * SAMPLE held-out resumes: written after the parser was tuned on resumes.sample.ts and scored
 * once before any fix, so their numbers estimate how the parser does on layouts it has not
 * seen. README.md records the first-run numbers. All people and details are invented.
 */

const NOW = "2026-11-11";

// H1. Google Docs export: company line with place, then role line with dates; "●" bullets.
const googleDocs: SampleResume = {
  id: "holdout-google-docs",
  label: "SAMPLE (held out): Google Docs export, company line then role line",
  layout: "pasted",
  now: NOW,
  input: {
    text: `Camila Torres
camila.torres@example.com • (555) 010-0177 • Chicago, IL

Education
Loyola University Chicago — Chicago, IL
B.S. Biology, Minor in Chemistry | Expected Graduation: May 2029 | GPA: 3.6

Experience
Northwestern Medicine — Chicago, IL
Patient Care Volunteer | October 2025 – Present
● Restock supplies and deliver meals to 30 patients per shift
● Escort visitors and answer questions at the front desk

Jewel-Osco — Evanston, IL
Pharmacy Clerk | June 2024 – September 2025
● Processed 80 prescriptions a day at the register
● Managed phone calls and refill requests

Activities
Pre-Health Society — Events Coordinator | September 2025 – Present
● Plan monthly talks with local physicians

Skills
Microsoft Excel, Data Entry, CPR/AED, Spanish (fluent), Python (beginner)
`,
  },
  expected: {
    contact: { name: "Camila Torres", email: "camila.torres@example.com", phone: "(555) 010-0177", location: "Chicago, IL" },
    education: [{ institution: "Loyola University Chicago", area: "Biology", degreeLevel: "bachelor", endDate: "2029-05", score: "3.6" }],
    experience: [
      { position: "Patient Care Volunteer", organization: "Northwestern Medicine", kind: "volunteer", startDate: "2025-10", endDate: null },
      { position: "Pharmacy Clerk", organization: "Jewel-Osco", kind: "part_time", startDate: "2024-06", endDate: "2025-09" },
      { position: "Events Coordinator", organization: "Pre-Health Society", kind: "leadership", startDate: "2025-09", endDate: null },
    ],
    projects: [],
    skills: ["Excel", "Data Entry", "CPR", "Spanish", "Python"],
    coursework: [],
    awards: [],
    classYear: "second_year",
  },
  pii: ["Camila", "Torres", "camila.torres@example.com", "010-0177", "Chicago, IL"],
  withheld: ["Loyola", "Northwestern Medicine", "Jewel-Osco", "Pre-Health Society"],
  sensitive: [],
  survives: ["Restock supplies"],
};

// H2. Research-heavy: numeric dates, a publications section with co-authors, honors list.
const research: SampleResume = {
  id: "holdout-research",
  label: "SAMPLE (held out): research resume with publications and numeric dates",
  layout: "pasted",
  now: NOW,
  input: {
    text: `ARJUN MEHTA
arjun.mehta@example.edu | 555-010-0191 | Ann Arbor, MI | arjunmehta.github.io

EDUCATION
University of Michigan, College of Engineering                     Ann Arbor, MI
B.S.E. in Computer Engineering                                     Expected 04/2029
Cumulative GPA: 3.91/4.00

RESEARCH EXPERIENCE
Undergraduate Researcher, Robotics Perception Lab                   01/2026 – Present
- Advised by Prof. Elena Vasquez; built a ROS pipeline for depth camera calibration
- Wrote C++ and Python tools that cut calibration time from 2 hours to 15 minutes

Summer Research Fellow, Michigan Battery Lab                        05/2025 – 08/2025
- Ran 40 cycling tests and analyzed results in MATLAB

PUBLICATIONS
E. Vasquez, A. Mehta, and K. Osei. "Fast Depth Calibration for Mobile Robots." Poster, Midwest Robotics Workshop, 2026.

HONORS
James B. Angell Scholar (2026)
1st Place, MHacks 2025

RELEVANT COURSEWORK
Data Structures and Algorithms, Linear Algebra, Digital Logic, Probability

TECHNICAL SKILLS
C++, Python, ROS, MATLAB, Linux, Git
`,
  },
  expected: {
    contact: { name: "Arjun Mehta", email: "arjun.mehta@example.edu", phone: "555-010-0191", location: "Ann Arbor, MI" },
    education: [{ institution: "University of Michigan", area: "Computer Engineering", degreeLevel: "bachelor", endDate: "2029-04", score: "3.91/4.00" }],
    experience: [
      { position: "Undergraduate Researcher", organization: "Robotics Perception Lab", kind: "research", startDate: "2026-01", endDate: null },
      { position: "Summer Research Fellow", organization: "Michigan Battery Lab", kind: "research", startDate: "2025-05", endDate: "2025-08" },
    ],
    projects: [],
    skills: ["C++", "Python", "ROS", "MATLAB", "Linux", "Git"],
    coursework: ["Data Structures and Algorithms", "Linear Algebra", "Digital Logic", "Probability"],
    awards: ["James B. Angell Scholar (2026)", "1st Place, MHacks 2025"],
    classYear: "second_year",
  },
  pii: ["Arjun", "Mehta", "arjun.mehta@example.edu", "010-0191", "Ann Arbor", "arjunmehta.github.io", "Elena Vasquez", "Osei"],
  withheld: ["University of Michigan", "Robotics Perception Lab", "Angell", "MHacks", "Fast Depth Calibration"],
  sensitive: [],
  survives: ["ROS pipeline"],
};

// H3. Plain text with colon headings, no blank lines, "Role at Company (years)".
const colons: SampleResume = {
  id: "holdout-colon-headings",
  label: "SAMPLE (held out): colon headings, no blank lines, role at company",
  layout: "pasted",
  now: NOW,
  input: {
    text: `Name: Tomás Herrera
Contact: tomas.herrera@example.com, 555-010-0128, Phoenix, AZ
Education:
Arizona State University, B.A. Political Science, 2026-2030
Experience:
Campaign Intern at Maricopa Civic Project (Summer 2026)
Called 1,500 voters and logged responses in a shared spreadsheet
Barista at Desert Bloom Coffee (2025-2026)
Opened the store three mornings a week
Skills:
Public speaking, Google Docs, Canva, social media
`,
  },
  expected: {
    contact: { name: "Tomás Herrera", email: "tomas.herrera@example.com", phone: "555-010-0128", location: "Phoenix, AZ" },
    education: [{ institution: "Arizona State University", area: "Political Science", degreeLevel: "bachelor", endDate: "2030" }],
    experience: [
      { position: "Campaign Intern", organization: "Maricopa Civic Project", kind: "internship", startDate: "2026-06", endDate: "2026-08" },
      { position: "Barista", organization: "Desert Bloom Coffee", kind: "part_time", startDate: "2025", endDate: "2026" },
    ],
    projects: [],
    skills: ["Public Speaking", "Google Docs", "Canva", "Social Media"],
    coursework: [],
    awards: [],
    classYear: "first_year",
  },
  pii: ["Tomás", "Herrera", "tomas.herrera@example.com", "010-0128", "Phoenix, AZ"],
  withheld: ["Arizona State", "Maricopa Civic Project", "Desert Bloom"],
  sensitive: [],
  survives: ["Called 1,500 voters"],
};

// H4. PDF with size-only Title Case headings (not bold, not caps) and dates on the left.
const sizeRows: RowSpec[] = [
  { text: "Grace Oyelaran", size: 24 },
  { text: "grace.oyelaran@example.com · 555-010-0149 · Houston, TX", gap: 22 },
  { text: "Education", size: 14, gap: 26 },
  { text: "2025 – 2029", gap: 18 },
  { text: "Rice University, B.A. in Cognitive Sciences", x: 120, gap: 0 },
  { text: "Experience", size: 14, gap: 26 },
  { text: "2026 – Present", gap: 18 },
  { text: "Peer Academic Coach, Rice Center for Academic Success", x: 120, gap: 0 },
  { text: "Meet weekly with six first-year students to plan study schedules", x: 130, bullet: "–" },
  { text: "2025", gap: 18 },
  { text: "Camp Counselor, Lakeside Day Camp", x: 120, gap: 0 },
  { text: "Led a group of 12 campers through daily science activities", x: 130, bullet: "–" },
  { text: "Skills", size: 14, gap: 26 },
  { text: "R, SPSS, Qualtrics, Excel", gap: 18 },
];
const sizeLines: ResumeLine[] = renderColumn(sizeRows, { x: 40, top: 760 });

const sizeOnly: SampleResume = {
  id: "holdout-size-headings",
  label: "SAMPLE (held out): PDF with size-only headings and dates on the left",
  layout: "pdf",
  now: NOW,
  input: { text: plainText(sizeLines), lines: sizeLines },
  expected: {
    contact: { name: "Grace Oyelaran", email: "grace.oyelaran@example.com", phone: "555-010-0149", location: "Houston, TX" },
    education: [{ institution: "Rice University", area: "Cognitive Sciences", degreeLevel: "bachelor", endDate: "2029", startDate: "2025" }],
    experience: [
      { position: "Peer Academic Coach", organization: "Rice Center for Academic Success", kind: "teaching", startDate: "2026", endDate: null },
      { position: "Camp Counselor", organization: "Lakeside Day Camp", kind: "part_time", startDate: "2025", endDate: "2025" },
    ],
    projects: [],
    skills: ["R", "SPSS", "Qualtrics", "Excel"],
    coursework: [],
    awards: [],
    classYear: "second_year",
  },
  pii: ["Grace Oyelaran", "Oyelaran", "grace.oyelaran@example.com", "010-0149", "Houston, TX"],
  withheld: ["Rice University", "Lakeside Day Camp"],
  sensitive: [],
  survives: ["study schedules"],
};

export const HOLDOUT_RESUMES: readonly SampleResume[] = [googleDocs, research, colons, sizeOnly];
