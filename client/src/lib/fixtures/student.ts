import type { InboxItem } from "@shared/contracts/events";
import type { Roadmap, RoadmapItem } from "@shared/contracts/roadmap";
import { EMPTY_STUDENT_PROFILE, type MeSessionResponse, type TrackerItem } from "@shared/contracts/student";
import { addDays, isoWeekday, localDateIn, termKeyForDate, toIsoInstant } from "@shared/time";
import { sampleId } from "./programs";

/**
 * SAMPLE DATA for the signed-in screens: a fictional second-year student, a few tracked
 * sample programs, a short inbox and this week's plan. No real person or program appears here.
 * The profile holds only non-sensitive fields; status and identity answers never exist outside
 * the browser's memory, so they have no fixture either.
 */

const ZONE = "America/New_York";
const DAY_MS = 86_400_000;

export function sampleSession(): MeSessionResponse {
  return {
    user: {
      publicId: "SampleStudent0000001",
      email: "sample.student@example.org",
      displayName: "Sam",
      roles: ["student"],
      onboarded: true,
    },
    profile: {
      ...EMPTY_STUDENT_PROFILE,
      classYear: "second_year",
      majorFamily: "agriculture_environment",
      timeZone: ZONE,
      interestTags: ["environment", "research"],
      preferredOpportunityTypes: ["research_program", "summer_internship", "national_scholarship"],
      weeklyPrepHours: 4,
    },
  };
}

function trackerItem(n: number, programNumber: number, slug: string, status: TrackerItem["status"], now: number, cycleKey: string): TrackerItem {
  const at = toIsoInstant(now - n * 3 * DAY_MS);
  return {
    id: sampleId(500 + n),
    programCycleId: sampleId(100 + programNumber),
    programSlug: slug,
    cycleKey,
    status,
    statusSource: "student",
    ownCampusDeadline: null,
    submittedOn: status === "submitted" ? localDateIn(now - 2 * DAY_MS, ZONE) : null,
    nameInMessages: true,
    createdAt: at,
    updatedAt: at,
    version: 1,
  };
}

/** Tracked sample programs; ids line up with sampleProgramCards(). */
export function sampleTracker(now: number = Date.now()): TrackerItem[] {
  const cycleKey = `summer-${Number(localDateIn(now, ZONE).slice(0, 4)) + 1}`;
  return [
    trackerItem(1, 7, "sample-coastal-research-scholars", "applying", now, cycleKey),
    trackerItem(2, 3, "sample-national-science-scholarship", "applying", now, cycleKey),
    trackerItem(3, 2, "sample-software-sophomore-internship", "interested", now, cycleKey),
    trackerItem(4, 8, "sample-summer-lab-research", "interested", now, cycleKey),
    trackerItem(5, 1, "sample-early-insight-week", "submitted", now, cycleKey),
    trackerItem(6, 13, "sample-case-competition", "not_applying", now, cycleKey),
  ];
}

export function sampleInbox(now: number = Date.now()): InboxItem[] {
  const ago = (days: number) => toIsoInstant(now - days * DAY_MS);
  return [
    { id: sampleId(601), type: "deadline.changed", priority: "p1", title: "Lumen Software Sophomore Internship moved its deadline earlier by 5 days.", body: "Sample data. The official page now lists an earlier date.", href: "/app/programs/sample-software-sophomore-internship", readAt: null, createdAt: ago(2) },
    { id: sampleId(602), type: "program_cycle.verified", priority: "p2", title: "Coastal Research Scholars added an FAQ about recommendation letters.", body: "Sample data.", href: "/app/programs/sample-coastal-research-scholars", readAt: null, createdAt: ago(5) },
    { id: sampleId(603), type: "posting.opened", priority: "p2", title: "Harbor Open-Source Sprint listed its new project mentors.", body: "Sample data.", href: "/app/programs/sample-open-source-sprint", readAt: ago(6), createdAt: ago(7) },
  ];
}

function prepItem(key: string, term: string, title: string, dueOn: string, state: RoadmapItem["state"], programSlug: string | null): RoadmapItem {
  return {
    itemKey: `prep:${key}`,
    kind: "prepare",
    term,
    title,
    detail: null,
    programId: null,
    programSlug,
    programCycleId: null,
    cycleKey: null,
    dueOn,
    startBy: null,
    dateConfidence: "official",
    state,
    pinned: false,
    reasonCodes: [],
    source: "template",
  };
}

/** This term's plan with four prepare items spread over the current week. */
export function sampleRoadmap(now: number = Date.now()): Roadmap {
  const today = localDateIn(now, ZONE);
  const monday = addDays(today, 1 - isoWeekday(today));
  const term = termKeyForDate(today);
  return {
    generatedAt: toIsoInstant(now),
    algoVersion: "sample",
    templateKey: null,
    terms: [
      {
        term,
        apply: [],
        prepare: [
          prepItem("save-three", term, "Save three programs", monday, "done", null),
          prepItem("ask-letter", term, "Ask a professor for a letter", addDays(monday, 2), "open", "sample-coastal-research-scholars"),
          prepItem("draft-statement", term, "Draft the Coastal Research statement", addDays(monday, 3), "open", "sample-coastal-research-scholars"),
          prepItem("transcript", term, "Order an unofficial transcript", addDays(monday, 4), "open", null),
        ],
        milestones: [],
        more: 0,
        capacityWarning: null,
      },
    ],
    changedSinceLastVisit: [],
  };
}
