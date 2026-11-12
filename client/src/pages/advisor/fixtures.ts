import type { AdvisorWorkspace, ProgramList, WorkspaceReport } from "@shared/contracts/advisor";
import type { CampusView, ProgressView } from "./model";

/**
 * SAMPLE DATA for the advisor screen while the API is unreachable. Everything here is invented:
 * the workspace, lists and counts describe no real office, program or student. The page shows
 * its "Sample data" banner whenever these are on screen.
 */

const WS = "01930000-0000-7000-8000-00000000a001";

export const SAMPLE_WORKSPACES: AdvisorWorkspace[] = [
  { id: WS, name: "Sample Fellowships Office", institutionId: "01930000-0000-7000-8000-00000000a0f1", kind: "concierge_pilot", createdAt: "2026-10-01T15:00:00.000Z", isSample: true },
];

export function sampleLists(now: number = Date.now()): ProgramList[] {
  const updatedAt = new Date(now - 2 * 86_400_000).toISOString();
  return [
    {
      id: "01930000-0000-7000-8000-00000000b001",
      workspaceId: WS,
      title: "Sample: first-year summer picks",
      description: "Sample list. Programs our office suggests to first-year students.",
      visibility: "public",
      slug: "sample-first-year-summer-picks-0b001",
      token: null,
      restricted: false,
      items: [
        { programSlug: "sample-early-insight-week", cycleKey: null, note: "Short and paid; a good first application.", position: 0 },
        { programSlug: "sample-software-sophomore-internship", cycleKey: null, note: null, position: 1 },
      ],
      updatedAt,
    },
    {
      id: "01930000-0000-7000-8000-00000000b002",
      workspaceId: WS,
      title: "Sample: campus nominations",
      description: null,
      visibility: "unlisted",
      slug: null,
      token: "SampleToken000000000001",
      restricted: false,
      items: [{ programSlug: "sample-national-science-scholarship", cycleKey: null, note: "Campus deadline comes first. Email the office.", position: 0 }],
      updatedAt,
    },
  ];
}

export function sampleProgress(period: string): ProgressView {
  return {
    period,
    population: "all_novus_students",
    minGroupSize: 5,
    programs: [
      { slug: "sample-early-insight-week", name: "Northwind Early Insight Week (sample)" },
      { slug: "sample-software-sophomore-internship", name: "Lumen Software Sophomore Internship (sample)" },
      { slug: "sample-national-science-scholarship", name: "Meridian Science Scholarship (sample)" },
    ],
    excluded: [],
    byProgram: {
      period,
      suppressed: false,
      total: "45",
      cells: [
        { key: "sample-early-insight-week", label: "25" },
        { key: "sample-software-sophomore-internship", label: "10-19" },
        { key: "sample-national-science-scholarship", label: "fewer than 5" },
      ],
    },
    byStage: {
      period,
      suppressed: false,
      total: "45",
      cells: [
        { key: "saved", label: "30" },
        { key: "started", label: "10-19" },
        { key: "submitted", label: "fewer than 5" },
      ],
    },
  };
}

export const SAMPLE_CAMPUS: CampusView = {
  institutionLinked: true,
  pending: 1,
  approved: [
    {
      programSlug: "sample-national-science-scholarship",
      programName: "Meridian Science Scholarship (sample)",
      cycleKey: "ay-2026-27",
      kind: "nomination",
      localDate: "2026-12-04",
      localTime: "17:00",
      timeZone: "America/New_York",
      confirmedOn: "2026-11-02",
    },
  ],
};

export function sampleReport(period: string): WorkspaceReport {
  return {
    workspaceId: WS,
    period,
    listViews: "50-99",
    trackedPrograms: "25-49",
    rows: [
      { programSlug: "sample-early-insight-week", trackers: "10-24" },
      { programSlug: "sample-national-science-scholarship", trackers: "fewer than 10" },
      { programSlug: "sample-software-sophomore-internship", trackers: "10-24" },
    ],
  };
}
