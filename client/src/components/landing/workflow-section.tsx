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
    Visual: VisualUniverse,
  },
  {
    label: "Research Hub",
    title: "Opportunity Profile Pages",
    description:
      "Each program gets its own research hub — curated videos, articles, and Reddit threads, an alumni LinkedIn layer with coffee-chat requests, crowdsourced interview breakdowns, and a 'Did you get in?' outcome tracker. Wikipedia, YouTube, and Glassdoor combined for that program.",
    discipline: "Content curation, Alumni network, Crowdsourced data",
    role: "Page design system, content sourcing, alumni outreach",
    timeline: "First 30 hand-built profiles by July 2026",
    Visual: VisualProfile,
  },
  {
    label: "Personalization",
    title: "The Career Roadmap Engine",
    description:
      "A three-minute quiz generates a personalized multi-year roadmap from freshman to senior year. Every node links to a real opportunity with a real deadline in the database. The roadmap updates dynamically as users hit milestones or pivot their goals.",
    discipline: "Personalization engine, Goal modeling, Recommendation",
    role: "Roadmap logic, quiz design, engineering",
    timeline: "Engine v1 — Fall 2026 (post-launch)",
    Visual: VisualRoadmap,
  },
  {
    label: "Preparedness",
    title: "The Readiness Score",
    description:
      "A personalized '% ready' score per opportunity, built from the user's profile, crowdsourced data on who typically gets in, and the program's stated requirements. Gaps are listed explicitly with suggested next steps — turning reactive search into proactive preparation.",
    discipline: "Scoring system, Gap analysis, Recommendation",
    role: "Scoring model, data sourcing, UX flow",
    timeline: "Beta — Fall 2026",
    Visual: VisualReadiness,
  },
  {
    label: "Network Effect",
    title: "Community and Social Proof",
    description:
      "Every accepted student becomes a resource for the next applicant. Structured 'I Got In!' stories feed back into profile pages. Cohort groups, mentor matching with in-platform fifteen-minute scheduling, and verified badges turn each acceptance into compounding intel.",
    discipline: "Social proof, Mentor matching, Cohort moderation",
    role: "Community design, mentor matching algorithm, story templates",
    timeline: "Stories live at launch — mentor matching Q4 2026",
    Visual: VisualCommunity,
  },
  {
    label: "Retention",
    title: "The Daily Personalized Feed",
    description:
      "A daily-open surface for year-round retention — deadline alerts on tracked programs, fresh peer wins from the same school, new content drops on saved opportunities, and community questions worth answering. A reason to return outside of recruiting season.",
    discipline: "Personalized feed, Notification engine, Engagement loops",
    role: "Feed ranking, notification design, content pipeline",
    timeline: "v1 — Q4 2026 (post readiness launch)",
    Visual: VisualFeed,
  },
];

import { useState } from "react";
import { ChevronDown, ChevronUp, ArrowUpRight, ArrowRight } from "lucide-react";

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
  const tabs = Array.from({ length: index + 1 }, (_, i) => index + 1 - i);

  return (
    <div
      className="sticky top-0 h-screen w-full overflow-hidden"
      style={{ zIndex: index + 1, background: PAGE_BG }}
    >
      {/* Cumulative number tabs — top-right of viewport */}
      <div className="pointer-events-none absolute right-0 top-0 z-40 flex">
        {tabs.map((n) => (
          <NumberTab key={n} n={n} />
        ))}
      </div>

      {/* Left text content area */}
      <div
        className="absolute flex flex-col"
        style={{
          left: "15%",
          right: "61%",
          top: "5%",
          bottom: "26%",
          paddingRight: "40px",
        }}
      >
        <LeftContent surface={surface} />
      </div>

      {/* Dark right visual panel — inset rectangle */}
      <div
        className="absolute flex items-center justify-center overflow-hidden"
        style={{
          left: "39%",
          right: "1.5%",
          top: "5%",
          bottom: "26%",
          background: DARK_BG,
        }}
      >
        {/* Open affordance — left-center of dark panel */}
        <div className="absolute left-6 top-1/2 z-10 -translate-y-1/2">
          <div
            className="inline-flex items-center gap-2 bg-black px-2.5 py-1.5 text-[12px] text-white"
            style={{ fontFamily: "var(--font-mono)" }}
          >
            <span style={{ color: OPEN_GREEN }}>›</span>
            <span>Open</span>
          </div>
        </div>

        <div className="w-full max-w-[640px] px-12">
          <surface.Visual />
        </div>
      </div>

      {/* Up-arrow square — very bottom-left of viewport */}
      <button
        className="absolute z-30 flex h-8 w-8 items-center justify-center text-white transition-opacity hover:opacity-90"
        style={{ background: COBALT, left: 24, bottom: 24 }}
        aria-label="Back to top"
      >
        <ChevronUp className="h-3.5 w-3.5" strokeWidth={2.5} />
      </button>

      {/* Center cluster: → Menu Resume */}
      <div
        className="absolute z-30 left-1/2 flex -translate-x-1/2 items-center gap-5"
        style={{ bottom: "9%" }}
      >
        <ArrowRight className="h-5 w-5 text-neutral-700" strokeWidth={1.5} />
        <button
          className="rounded-[6px] bg-black px-5 py-2 text-[13px] text-white/90 transition-colors hover:bg-neutral-800"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Menu
        </button>
        <button
          className="rounded-[6px] bg-black px-5 py-2 text-[13px] text-white/90 transition-colors hover:bg-neutral-800"
          style={{ fontFamily: "var(--font-mono)" }}
        >
          Resume
        </button>
      </div>
    </div>
  );
}

function MockupShell({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="overflow-hidden rounded-2xl shadow-2xl"
      style={{
        background: MOCKUP_BG,
        boxShadow: "0 30px 60px -20px rgba(0,0,0,0.6), 0 0 0 1px rgba(255,255,255,0.04)",
      }}
    >
      {children}
    </div>
  );
}

function VisualUniverse() {
  return (
    <MockupShell>
      <div className="flex">
        <div className="w-[140px] border-r border-neutral-200 bg-[#F2EEE7] p-3">
          <div className="mb-3 flex items-center gap-2">
            <div className="h-5 w-5 rounded" style={{ background: COBALT }} />
            <div className="text-[12px] font-semibold text-neutral-800">
              Universe
            </div>
          </div>
          {[
            "Internships",
            "Fellowships",
            "Scholarships",
            "Research",
            "Leadership",
            "Government",
          ].map((s, i) => (
            <div
              key={s}
              className={`mb-1 rounded-md px-2 py-1.5 text-[11px] ${
                i === 0
                  ? "bg-white text-neutral-900 shadow-sm"
                  : "text-neutral-500"
              }`}
            >
              {s}
            </div>
          ))}
        </div>
        <div className="flex-1 p-4">
          <div className="mb-3 flex items-center justify-between">
            <div className="text-[12px] font-semibold text-neutral-800">
              All internships
            </div>
            <div
              className="rounded-full px-2.5 py-0.5 text-[10px] font-medium text-white"
              style={{ background: COBALT }}
            >
              + Track
            </div>
          </div>
          <div className="grid grid-cols-3 gap-2">
            {[
              ["Microsoft Explore", "Apr 30", "~14%"],
              ["Google STEP", "Mar 12", "~9%"],
              ["MLT Pathfinder", "May 1", "~6%"],
              ["Goldman Soph", "Feb 28", "~5%"],
              ["JPM Force", "Mar 20", "~8%"],
              ["Citadel TF", "Apr 5", "~3%"],
            ].map(([name, due, acc]) => (
              <div
                key={name}
                className="rounded-lg border border-neutral-200 bg-white p-2.5"
              >
                <div className="mb-2 text-[10px] font-semibold text-neutral-800">
                  {name}
                </div>
                <div className="flex items-center justify-between text-[9px] text-neutral-500">
                  <span>{due}</span>
                  <span className="font-medium text-neutral-700">{acc}</span>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </MockupShell>
  );
}
function VisualProfile() {
  return (
    <MockupShell>
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <div className="text-[14px] font-semibold text-neutral-900">
              Microsoft Explore
            </div>
            <div className="text-[11px] text-neutral-500">
              Sophomore program · Redmond
            </div>
          </div>
          <div
            className="rounded-full px-3 py-1 text-[11px] font-medium text-white"
            style={{ background: COBALT }}
          >
            Track
          </div>
        </div>
        <div className="mb-5 grid grid-cols-3 gap-2">
          {[
            ["Acceptance", "~14%"],
            ["Alumni", "412"],
            ["Deadline", "Mar 5"],
          ].map(([k, v]) => (
            <div
              key={k}
              className="rounded-lg border border-neutral-200 bg-white p-2.5"
            >
              <div className="mb-1 text-[10px] uppercase tracking-wider text-neutral-500">
                {k}
              </div>
              <div className="text-[15px] font-semibold text-neutral-900">{v}</div>
            </div>
          ))}
        </div>
        <div className="mb-2 text-[11px] uppercase tracking-wider text-neutral-500">
          Resource bundle
        </div>
        <div className="space-y-1.5">
          {[
            ["Day-in-the-life", "YouTube"],
            ["Interview breakdown", "Reddit"],
            ["How I got in", "Medium"],
          ].map(([t, src]) => (
            <div
              key={t}
              className="flex items-center justify-between rounded-md border border-neutral-200 bg-white px-3 py-2 text-[12px]"
            >
              <span className="text-neutral-800">{t}</span>
              <span className="text-neutral-400">{src} ›</span>
            </div>
          ))}
        </div>
      </div>
    </MockupShell>
  );
}
function VisualRoadmap() {
  const years = ["Freshman", "Sophomore", "Junior", "Senior"];
  return (
    <MockupShell>
      <div className="p-5">
        <div className="mb-4 flex items-center justify-between">
          <div className="text-[14px] font-semibold text-neutral-900">
            Your roadmap
          </div>
          <div className="text-[11px] text-neutral-500">CS · 2026</div>
        </div>
        <div className="space-y-2.5">
          {years.map((year, i) => (
            <div key={year} className="flex items-start gap-3">
              <div className="relative flex flex-col items-center">
                <div
                  className="flex h-7 w-7 items-center justify-center rounded-full text-[10px] font-semibold text-white"
                  style={{ background: i === 1 ? COBALT : "#D5D2CB" }}
                >
                  {i + 1}
                </div>
                {i < years.length - 1 && (
                  <div className="mt-1 h-8 w-px bg-neutral-300" />
                )}
              </div>
              <div className="flex-1 rounded-lg border border-neutral-200 bg-white p-3">
                <div className="mb-1 flex items-center justify-between">
                  <div className="text-[12px] font-semibold text-neutral-900">
                    {year} year
                  </div>
                  <div className="text-[10px] text-neutral-500">{i + 2} nodes</div>
                </div>
                <div className="text-[11px] text-neutral-600">
                  {
                    [
                      "Join one cohort org. Apply to two intro programs.",
                      "Microsoft Explore, Goldman Soph, MLT Pathfinder.",
                      "Target eight summer internships. Build a project.",
                      "Full-time recruiting. Grad-school applications.",
                    ][i]
                  }
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </MockupShell>
  );
}
function VisualReadiness() { return <MockupShell><div className="h-48" /></MockupShell>; }
function VisualCommunity() { return <MockupShell><div className="h-48" /></MockupShell>; }
function VisualFeed() { return <MockupShell><div className="h-48" /></MockupShell>; }

function LeftContent({ surface }: { surface: Surface }) {
  return (
    <>
      <div
        className="mb-9 text-[12px] uppercase tracking-[0.22em] text-neutral-500"
        style={{ fontFamily: "var(--font-mono)" }}
      >
        {surface.label}
      </div>

      <h2
        className="mb-7 max-w-[440px] text-[2.4rem] leading-[1.05] text-neutral-900"
        style={{ fontFamily: "var(--font-display)", fontWeight: 500, letterSpacing: "-0.01em" }}
      >
        {surface.title}
      </h2>

      <p
        className="mb-10 max-w-[440px] text-[14.5px] leading-[1.6] text-neutral-600"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        {surface.description}
      </p>

      <div className="max-w-[440px] border-t border-neutral-300/80">
        <AccordionRow label="Discipline" defaultOpen>
          {surface.discipline}
        </AccordionRow>
        <AccordionRow label="My Role">{surface.role}</AccordionRow>
        <AccordionRow label="Timeline">{surface.timeline}</AccordionRow>
      </div>

      <div className="mt-auto pt-10">
        <button
          className="inline-flex items-center gap-2 px-5 py-3 text-[13px] font-medium text-white transition-transform hover:-translate-y-0.5"
          style={{
            background: COBALT,
            fontFamily: "var(--font-mono)",
            letterSpacing: "0.06em",
          }}
        >
          Case study
          <ArrowUpRight className="h-4 w-4" strokeWidth={2} />
        </button>
      </div>
    </>
  );
}

function AccordionRow({
  label,
  children,
  defaultOpen = false,
}: {
  label: string;
  children: React.ReactNode;
  defaultOpen?: boolean;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="border-b border-neutral-300/80">
      <button
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center justify-between py-4 text-left text-[15px] text-neutral-900"
        style={{ fontFamily: "var(--font-sans)" }}
      >
        <span className="font-medium">{label}</span>
        {open ? (
          <ChevronUp className="h-4 w-4 text-neutral-500" strokeWidth={2} />
        ) : (
          <ChevronDown className="h-4 w-4 text-neutral-500" strokeWidth={2} />
        )}
      </button>
      <div
        className={`grid overflow-hidden transition-[grid-template-rows] duration-300 ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">
          <div
            className="pb-4 text-[14px] text-neutral-600"
            style={{ fontFamily: "var(--font-sans)" }}
          >
            {children}
          </div>
        </div>
      </div>
    </div>
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
