import { describe, expect, it } from "vitest";
import { sampleProgramCards } from "@/lib/fixtures/programs";
import { sampleInbox, sampleRoadmap, sampleSession, sampleTracker } from "@/lib/fixtures/student";
import { buildWeek, eventDatesThisWeek, feedRows, pickForSeason, planForWeek, tileState, weekRange } from "./model";

const NOW = Date.parse("2026-11-11T15:00:00Z"); // Wednesday
const TODAY = "2026-11-11";
const cards = sampleProgramCards(NOW);
const profile = sampleSession().profile;

describe("week strip", () => {
  it("runs Monday to Sunday and marks today and event days", () => {
    const week = buildWeek(TODAY, ["2026-11-13", "2027-01-01"]);
    expect(week.map((d) => d.date)).toEqual(["2026-11-09", "2026-11-10", "2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15"]);
    expect(week.find((d) => d.isToday)?.name).toBe("Wednesday");
    expect(week.filter((d) => d.hasEvent).map((d) => d.day)).toEqual([13]);
    expect(weekRange("2026-11-15")).toEqual({ start: "2026-11-09", end: "2026-11-15" });
  });
});

describe("plan for the week", () => {
  it("lists this week's items by date, including done ones", () => {
    const plan = planForWeek(sampleRoadmap(NOW), TODAY);
    expect(plan).toHaveLength(4);
    expect(plan[0]?.state).toBe("done");
    expect(plan.map((p) => p.dueOn)).toEqual([...plan.map((p) => p.dueOn)].sort());
  });

  it("falls back to the next open items when the week is empty", () => {
    const plan = planForWeek(sampleRoadmap(NOW), "2026-11-30");
    expect(plan.every((p) => p.state === "open")).toBe(true);
    expect(planForWeek(null, TODAY)).toEqual([]);
  });

  it("marks plan and tracked deadline days", () => {
    const plan = planForWeek(sampleRoadmap(NOW), TODAY);
    const dates = eventDatesThisWeek(TODAY, plan, cards, NOW, "America/New_York");
    expect(dates).toContain("2026-11-11");
    expect(dates.every((d) => d >= "2026-11-09" && d <= "2026-11-15")).toBe(true);
  });
});

describe("picked for your season", () => {
  it("skips tracked programs and programs for other years, and says why", () => {
    const tracker = sampleTracker(NOW);
    const pick = pickForSeason(cards, profile, tracker, NOW);
    expect(pick).not.toBeNull();
    expect(tracker.some((t) => t.programCycleId === pick?.card.programCycleId)).toBe(false);
    expect(pick?.card.classYears).toContain("second_year");
    expect(pick?.reason).toMatch(/^Shown because it /);
    expect(pick?.reason).not.toMatch(/%|\bscore\b/i);
  });

  it("returns null when nothing is left", () => {
    expect(pickForSeason([], profile, [], NOW)).toBeNull();
  });
});

describe("changes feed", () => {
  it("orders newest first, strips the /app prefix and flags deadline changes", () => {
    const rows = feedRows(sampleInbox(NOW));
    expect(rows[0]?.tone).toBe("warn");
    expect(rows[0]?.href).toBe("/programs/sample-software-sophomore-internship");
    expect(rows.map((r) => r.createdAt)).toEqual([...rows.map((r) => r.createdAt)].sort().reverse());
  });
});

describe("tile state", () => {
  const loading = { isPending: true, isError: false };
  const failed = { isPending: false, isError: true };
  const ready = { isPending: false, isError: false };

  it("never reports ready (and so an empty state) while a query is loading or failed", () => {
    expect(tileState(loading)).toBe("loading");
    expect(tileState(failed)).toBe("error");
    expect(tileState(ready)).toBe("ready");
  });

  it("needs every query a tile reads, and reports an error before loading", () => {
    expect(tileState(ready, loading)).toBe("loading");
    expect(tileState(loading, failed)).toBe("error");
    expect(tileState(ready, ready)).toBe("ready");
  });
});
