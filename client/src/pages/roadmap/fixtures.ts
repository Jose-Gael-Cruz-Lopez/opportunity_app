import type { NextAction, Roadmap, RoadmapItem, TermPlan } from "@shared/contracts";
import { addDays, termKeyForDate } from "@shared/time";
import { academicYearStart } from "@shared/time";
import { termKeyFor, type NextActionContext } from "./model";

/**
 * SAMPLE DATA. Shown only when the Novus API is not reachable, always under a "Sample data"
 * notice. Program names are invented ("Sample ...") and their dates are generated relative to
 * today, so nothing here describes a real program.
 */

const ID = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

interface SampleRow {
  key: string;
  kind: RoadmapItem["kind"];
  title: string;
  detail?: string;
  slug?: string;
  cycle?: number;
  /** Offsets from today in days; null leaves the date unknown. */
  due?: number | null;
  startBy?: number | null;
  /** Fixed term (season offset from the current academic year) for undated rows. */
  term?: { yearOffset: number; season: "fall" | "spring" | "summer" };
  state?: RoadmapItem["state"];
  pinned?: boolean;
  confidence?: RoadmapItem["dateConfidence"];
}

export const SAMPLE_PROGRAM_NAMES: ReadonlyMap<string, string> = new Map([
  ["sample-coastal-science-scholarship", "Sample Coastal Science Scholarship"],
  ["sample-summer-research-program", "Sample Summer Research Program"],
  ["sample-tech-insight-week", "Sample Tech Insight Week"],
  ["sample-open-source-sprint", "Sample Open-Source Sprint"],
  ["sample-campus-nominated-award", "Sample Campus-Nominated Award"],
]);

const ROWS: readonly SampleRow[] = [
  { key: "ms:y1-club", kind: "milestone", title: "Join one club in your field", term: { yearOffset: -1, season: "fall" }, state: "done" },
  { key: "ms:y1-save", kind: "milestone", title: "Save your first five programs", term: { yearOffset: -1, season: "spring" }, state: "done" },
  { key: "ms:y1-summer", kind: "milestone", title: "A summer project you can describe in two lines", term: { yearOffset: -1, season: "summer" }, state: "done" },
  { key: "apply:sample-tech-insight-week:fall", kind: "apply", title: "Apply: Sample Tech Insight Week", slug: "sample-tech-insight-week", cycle: 3, due: 9, state: "open", pinned: true, confidence: "official" },
  { key: "apply:sample-open-source-sprint:fall", kind: "apply", title: "Apply: Sample Open-Source Sprint", slug: "sample-open-source-sprint", cycle: 4, due: 26, confidence: "official" },
  { key: "apply:sample-campus-nominated-award:campus", kind: "apply", title: "Campus deadline: Sample Campus-Nominated Award", detail: "The campus deadline comes before the national one.", slug: "sample-campus-nominated-award", cycle: 5, due: 23, confidence: "estimated" },
  { key: "prep:letters-coastal", kind: "prepare", title: "Ask two recommenders for letters", detail: "Give them four weeks and your draft statement.", slug: "sample-coastal-science-scholarship", cycle: 1, startBy: 6, due: 50 },
  { key: "prep:transcript", kind: "prepare", title: "Order an unofficial transcript", due: -3, state: "done" },
  { key: "apply:sample-coastal-science-scholarship:spring", kind: "apply", title: "Apply: Sample Coastal Science Scholarship", slug: "sample-coastal-science-scholarship", cycle: 1, due: 78, confidence: "official" },
  { key: "apply:sample-summer-research-program:spring", kind: "apply", title: "Apply: Sample Summer Research Program", slug: "sample-summer-research-program", cycle: 2, due: 92, confidence: "expected" },
  { key: "ms:y2-offers", kind: "milestone", title: "Compare offers in your Tracker", term: { yearOffset: 0, season: "spring" } },
  { key: "ms:y2-summer", kind: "milestone", title: "Paid research or internship placement", term: { yearOffset: 0, season: "summer" } },
  { key: "apply:sample-tech-insight-week:next", kind: "apply", title: "Sample Tech Insight Week reopens", slug: "sample-tech-insight-week", cycle: 3, due: 365, confidence: "expected" },
  { key: "ms:y3-lab", kind: "milestone", title: "Choose a research lab or thesis topic", term: { yearOffset: 1, season: "spring" } },
  { key: "ms:y3-summer", kind: "milestone", title: "Second summer placement", term: { yearOffset: 1, season: "summer" } },
  { key: "ms:y4-fellowships", kind: "milestone", title: "Graduate fellowships open", term: { yearOffset: 2, season: "fall" } },
  { key: "ms:y4-graduate", kind: "milestone", title: "Graduate", term: { yearOffset: 2, season: "spring" } },
];

function toItem(row: SampleRow, today: string): RoadmapItem {
  const dueOn = row.due === undefined || row.due === null ? null : addDays(today, row.due);
  const startBy = row.startBy === undefined || row.startBy === null ? null : addDays(today, row.startBy);
  const term = row.term
    ? termKeyFor(academicYearStart(today) + row.term.yearOffset, row.term.season)
    : termKeyForDate(startBy ?? dueOn ?? today);
  return {
    itemKey: row.key,
    kind: row.kind,
    term,
    title: row.title,
    detail: row.detail ?? null,
    programId: row.cycle ? ID(100 + row.cycle) : null,
    programSlug: row.slug ?? null,
    programCycleId: row.cycle ? ID(row.cycle) : null,
    cycleKey: null,
    dueOn,
    startBy,
    dateConfidence: row.confidence ?? (dueOn ? "estimated" : "unknown"),
    state: row.state ?? "open",
    pinned: row.pinned ?? false,
    reasonCodes: ["SAMPLE"],
    source: row.kind === "apply" ? "rule" : "template",
  };
}

export function sampleRoadmap(today: string): Roadmap {
  const terms = new Map<string, TermPlan>();
  for (const row of ROWS) {
    const item = toItem(row, today);
    const plan = terms.get(item.term) ?? { term: item.term, apply: [], prepare: [], milestones: [], more: 0, capacityWarning: null };
    const bucket = item.kind === "apply" ? plan.apply : item.kind === "prepare" ? plan.prepare : plan.milestones;
    bucket.push(item);
    terms.set(item.term, plan);
  }
  const now = termKeyForDate(today);
  const current = terms.get(now);
  if (current) terms.set(now, { ...current, more: 2, capacityWarning: null });
  return {
    generatedAt: `${today}T12:00:00Z`,
    algoVersion: "sample",
    templateKey: "sample-four-year",
    terms: [...terms.values()],
    changedSinceLastVisit: ["apply:sample-open-source-sprint:fall"],
  };
}

export function sampleNextActions(today: string): NextActionContext[] {
  const actions: NextAction[] = [
    {
      id: "gap-statement",
      label: "Draft the personal statement",
      detail: "The sample program asks for 500 words on a problem you want to study.",
      dueOn: addDays(today, 20),
      severity: "soon",
      source: "gap",
      roadmapItemKey: null,
      relatesTo: "kind:essay",
    },
    {
      id: "letters",
      label: "Ask two recommenders for letters",
      detail: null,
      dueOn: addDays(today, 6),
      severity: "soon",
      source: "gap",
      roadmapItemKey: "prep:letters-coastal",
      relatesTo: "kind:recommendation",
    },
  ];
  return [
    {
      programCycleId: ID(1),
      programSlug: "sample-coastal-science-scholarship",
      programName: "Sample Coastal Science Scholarship",
      cycleKey: "spring-2027",
      actions,
    },
  ];
}
