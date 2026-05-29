type Surface = {
  label: string;
  title: string;
  description: string;
  discipline: string;
  role: string;
  timeline: string;
  Visual: () => JSX.Element;
};

const COBALT = "#1F2BFA";
const PAGE_BG = "#EFECE6";
const DARK_BG = "#0B0B0B";
const OPEN_GREEN = "#B6F25C";
const MOCKUP_BG = "#FAFAF7";

const SURFACES: Surface[] = [
  {
    label: "Database",
    title: "The Opportunity Universe",
    description:
      "A curated, human-verified database of every type of student opportunity — internships, scholarships, fellowships, research programs, leadership cohorts, and graduate-school pipelines. Tagged by major, year, GPA range, location, deadline, and industry. Open to all schools, not gated.",
    discipline: "Curated database, Search & filter, Taxonomy design",
    role: "Product architecture, sourcing pipeline, community verification",
    timeline: "Sourcing Q2 2026 — soft launch August 2026",
    Visual: () => <div />,
  },
  {
    label: "Research Hub",
    title: "Opportunity Profile Pages",
    description:
      "Each program gets its own research hub — curated videos, articles, and Reddit threads, an alumni LinkedIn layer with coffee-chat requests, crowdsourced interview breakdowns, and a 'Did you get in?' outcome tracker. Wikipedia, YouTube, and Glassdoor combined for that program.",
    discipline: "Content curation, Alumni network, Crowdsourced data",
    role: "Page design system, content sourcing, alumni outreach",
    timeline: "First 30 hand-built profiles by July 2026",
    Visual: () => <div />,
  },
  {
    label: "Personalization",
    title: "The Career Roadmap Engine",
    description:
      "A three-minute quiz generates a personalized multi-year roadmap from freshman to senior year. Every node links to a real opportunity with a real deadline in the database. The roadmap updates dynamically as users hit milestones or pivot their goals.",
    discipline: "Personalization engine, Goal modeling, Recommendation",
    role: "Roadmap logic, quiz design, engineering",
    timeline: "Engine v1 — Fall 2026 (post-launch)",
    Visual: () => <div />,
  },
  {
    label: "Preparedness",
    title: "The Readiness Score",
    description:
      "A personalized '% ready' score per opportunity, built from the user's profile, crowdsourced data on who typically gets in, and the program's stated requirements. Gaps are listed explicitly with suggested next steps — turning reactive search into proactive preparation.",
    discipline: "Scoring system, Gap analysis, Recommendation",
    role: "Scoring model, data sourcing, UX flow",
    timeline: "Beta — Fall 2026",
    Visual: () => <div />,
  },
  {
    label: "Network Effect",
    title: "Community and Social Proof",
    description:
      "Every accepted student becomes a resource for the next applicant. Structured 'I Got In!' stories feed back into profile pages. Cohort groups, mentor matching with in-platform fifteen-minute scheduling, and verified badges turn each acceptance into compounding intel.",
    discipline: "Social proof, Mentor matching, Cohort moderation",
    role: "Community design, mentor matching algorithm, story templates",
    timeline: "Stories live at launch — mentor matching Q4 2026",
    Visual: () => <div />,
  },
  {
    label: "Retention",
    title: "The Daily Personalized Feed",
    description:
      "A daily-open surface for year-round retention — deadline alerts on tracked programs, fresh peer wins from the same school, new content drops on saved opportunities, and community questions worth answering. A reason to return outside of recruiting season.",
    discipline: "Personalized feed, Notification engine, Engagement loops",
    role: "Feed ranking, notification design, content pipeline",
    timeline: "v1 — Q4 2026 (post readiness launch)",
    Visual: () => <div />,
  },
];

export function WorkflowSection() {
  return (
    <section
      className="relative w-full"
      style={{ height: `${SURFACES.length * 100}vh`, background: PAGE_BG }}
    >
      {SURFACES.map((surface, i) => (
        <Panel key={i} index={i} surface={surface} />
      ))}
    </section>
  );
}

function Panel({ index, surface }: { index: number; surface: Surface }) {
  return (
    <div
      className="sticky top-0 h-screen w-full overflow-hidden"
      style={{ zIndex: index + 1, background: PAGE_BG }}
    />
  );
}

function NumberTab({ n }: { n: number }) {
  return (
    <div
      className="flex items-center justify-center text-white"
      style={{
        width: 64,
        height: 64,
        background: COBALT,
        fontFamily: "'SF Mono', 'JetBrains Mono', monospace",
        fontSize: 20,
        letterSpacing: "0.04em",
        fontWeight: 500,
      }}
    >
      {String(n).padStart(2, "0")}
    </div>
  );
}
