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
];

export function WorkflowSection() {
  return (
    <section
      className="relative w-full"
      style={{ height: `${SURFACES.length * 100}vh`, background: PAGE_BG }}
    />
  );
}
