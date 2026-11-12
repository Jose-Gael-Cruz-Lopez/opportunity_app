import { describe, expect, it } from "vitest";
import { TrackerItemUpdateSchema } from "@shared/contracts/student";
import { SAMPLE_CARDS, SAMPLE_TRACKER } from "@/components/readiness/fixtures";
import { buildTrackerCard, compareCards, groupTracker, monogramFor, movePatch, trackerSummary } from "./model";

const NOW = Date.parse("2026-11-11T17:00:00.000Z");
const TZ = "America/New_York";
const cards = new Map(SAMPLE_CARDS.map((c) => [c.slug, c]));

describe("groupTracker", () => {
  const columns = groupTracker(SAMPLE_TRACKER, cards, NOW, TZ);

  it("has one column per status in board order", () => {
    expect(columns.map((c) => c.label)).toEqual(["Interested", "Applying", "Submitted", "Decided", "Not applying"]);
    expect(columns.map((c) => c.cards.length)).toEqual([2, 2, 1, 0, 0]);
  });

  it("orders each column by the earliest date, undated last", () => {
    expect(columns[1]?.cards.map((c) => c.slug)).toEqual(["sample-software-sophomore-week", "sample-coastal-research-scholars"]);
    expect(columns[0]?.cards.at(-1)?.slug).toBe("sample-design-sprint");
  });

  it("summarises tracked, due-soon and submitted counts", () => {
    expect(trackerSummary(columns)).toEqual({ tracked: 5, dueSoon: 1, submitted: 1 });
  });
});

describe("buildTrackerCard", () => {
  const item = SAMPLE_TRACKER[1]!; // software week, due 20 Nov, 6 prep days

  it("words the deadline, flags it hot and gives a start-by date", () => {
    const v = buildTrackerCard(item, cards.get(item.programSlug), NOW, TZ);
    expect(v.line).toBe("Closes Fri 20 Nov · 9 days left");
    expect(v.hot).toBe(true);
    expect(v.startByLine).toBe("Start by Sat 14 Nov");
    expect(v.monogram).toBe("SS");
  });

  it("says start now when the prep time has run out", () => {
    const later = Date.parse("2026-11-17T17:00:00.000Z");
    const v = buildTrackerCard(item, cards.get(item.programSlug), later, TZ);
    expect(v.startByLate).toBe(true);
    expect(v.startByLine).toMatch(/^Start now/);
  });

  it("puts the student's private campus date first", () => {
    const v = buildTrackerCard({ ...item, ownCampusDeadline: "2026-11-16" }, cards.get(item.programSlug), NOW, TZ);
    expect(v.line).toBe("Your campus deadline Mon 16 Nov · 5 days left");
    expect(v.sortDate).toBe("2026-11-16");
  });

  it("shows submitted cards without a countdown and survives a missing card", () => {
    const submitted = buildTrackerCard(SAMPLE_TRACKER[3]!, cards.get(SAMPLE_TRACKER[3]!.programSlug), NOW, TZ);
    expect(submitted.line).toBe("Submitted Mon 12 Oct");
    expect(submitted.hot).toBe(false);
    expect(submitted.startByLine).toBeNull();
    const orphan = buildTrackerCard({ ...item, programSlug: "unknown-program" }, undefined, NOW, TZ);
    expect(orphan.name).toBe("Unknown Program");
    expect(orphan.line).toBe("No deadline listed");
  });

  it("sorts by date, then name", () => {
    const a = buildTrackerCard(item, cards.get(item.programSlug), NOW, TZ);
    const b = { ...a, sortDate: null, name: "B" };
    const c = { ...a, sortDate: null, name: "A" };
    expect([b, a, c].sort(compareCards).map((x) => x.name)).toEqual([a.name, "A", "B"]);
  });
});

describe("movePatch", () => {
  const card = buildTrackerCard(SAMPLE_TRACKER[0]!, cards.get(SAMPLE_TRACKER[0]!.programSlug), NOW, TZ);

  it("sends the seen version and records a submission date", () => {
    const p = movePatch(card, "submitted", "2026-11-11");
    expect(p).toEqual({ status: "submitted", version: 1, submittedOn: "2026-11-11" });
    expect(TrackerItemUpdateSchema.safeParse(p).success).toBe(true);
  });

  it("clears the submission date when moved back to an active column", () => {
    const submitted = { ...card, status: "submitted" as const };
    expect(movePatch(submitted, "applying", "2026-11-11")).toEqual({ status: "applying", version: 1, submittedOn: null });
    expect(movePatch(submitted, "decided", "2026-11-11")).toEqual({ status: "decided", version: 1 });
  });
});

describe("monogramFor", () => {
  it("takes up to two initials", () => {
    expect(monogramFor("Sample Coastal Research Scholars")).toBe("SC");
    expect(monogramFor("NASA")).toBe("N");
    expect(monogramFor("—")).toBe("?");
  });
});
