import { describe, expect, it } from "vitest";
import { epochDayOf, isoFromEpochDay } from "./calendar";
import { createRng } from "./math/random";
import { backwardFill, demandBoundCheck, levelledLoad, supplyBetween, weeklyCapacity, whatFits, type ScheduleTask } from "./schedule";

/*
 * The planning study's fixture: today 2026-11-16, 1 h a day, three overlapping applications.
 * The per-item formula says all three are "planned"; their combined hours do not fit.
 */
const TODAY = "2026-11-16";
const oneHourADay = weeklyCapacity(7);
const fixture: ScheduleTask[] = [
  { id: "T1", effortHours: 8, due: "2026-12-04" },
  { id: "T2", effortHours: 6, due: "2026-12-11" },
  { id: "T3", effortHours: 20, due: "2026-12-18" },
];

function randomTasks(seed: number, count: number): ScheduleTask[] {
  const rng = createRng(seed);
  return Array.from({ length: count }, (_, i) => ({
    id: `t${String(i).padStart(2, "0")}`,
    effortHours: Math.round((0.25 + rng.uniform() * 14) * 4) / 4,
    due: isoFromEpochDay(epochDayOf(TODAY) + 1 + rng.int(90)),
  }));
}

describe("backwardFill (reverse-time EDF, as late as possible)", () => {
  it("reproduces the study fixture: T3 28 Nov, T2 22 Nov, T1 14 Nov and 2 h late", () => {
    const r = backwardFill(fixture, { today: TODAY, capacity: oneHourADay });
    expect(r.latestStart.get("T3")).toBe("2026-11-28");
    expect(r.latestStart.get("T2")).toBe("2026-11-22");
    expect(r.latestStart.get("T1")).toBe("2026-11-14");
    expect(r.lateHours.get("T1")).toBeCloseTo(2, 12);
    expect(r.overflowHours).toBeCloseTo(2, 12);
    expect(r.feasible).toBe(false);
  });

  it("matches the per-item formula when one task has the days to itself", () => {
    const r = backwardFill([{ id: "solo", effortHours: 3, due: "2026-12-10" }], { today: TODAY, capacity: oneHourADay });
    expect(r.latestStart.get("solo")).toBe("2026-12-07"); // 10 Dec − ceil(3 / 1)
    expect(r.feasible).toBe(true);
  });

  it("ignores zero-effort tasks and handles an empty plan", () => {
    const r = backwardFill([{ id: "fee", effortHours: 0, due: "2026-12-01" }], { today: TODAY, capacity: oneHourADay });
    expect(r.latestStart.get("fee")).toBeNull();
    expect(r.feasible).toBe(true);
  });

  it("weekday-only capacity leaves weekends empty", () => {
    const weekdays = weeklyCapacity(5, { weekdaysOnly: true });
    expect(weekdays.hoursOn(epochDayOf("2026-11-21"))).toBe(0); // Saturday
    expect(weekdays.hoursOn(epochDayOf("2026-11-20"))).toBe(1); // Friday
    // Due Monday 23 Nov: the 2 h land on Thursday and Friday.
    const r = backwardFill([{ id: "x", effortHours: 2, due: "2026-11-23" }], { today: TODAY, capacity: weekdays });
    expect(r.latestStart.get("x")).toBe("2026-11-19");
  });

  it("properties: latest start before due, no task finishes late when feasible, deterministic", () => {
    for (let seed = 0; seed < 60; seed++) {
      const tasks = randomTasks(seed, 1 + (seed % 9));
      const capacity = weeklyCapacity(3 + (seed % 12));
      const r = backwardFill(tasks, { today: TODAY, capacity });
      for (const t of tasks) {
        const start = r.latestStart.get(t.id);
        if (start !== null && start !== undefined) expect(start < t.due).toBe(true);
      }
      const again = backwardFill([...tasks].reverse(), { today: TODAY, capacity });
      expect([...again.latestStart.entries()].sort()).toEqual([...r.latestStart.entries()].sort());
      // Feasibility agrees with the exact demand-bound test (all tasks available now).
      expect(r.feasible).toBe(demandBoundCheck(tasks, { today: TODAY, capacity }).feasible);
    }
  });

  it("monotone: removing a task or adding hours never moves another task's latest start earlier", () => {
    for (let seed = 100; seed < 160; seed++) {
      const tasks = randomTasks(seed, 6);
      const capacity = weeklyCapacity(4);
      const full = backwardFill(tasks, { today: TODAY, capacity });
      const fewer = backwardFill(tasks.slice(1), { today: TODAY, capacity });
      const more = backwardFill(tasks, { today: TODAY, capacity: weeklyCapacity(8) });
      for (const t of tasks.slice(1)) {
        const base = full.latestStart.get(t.id) ?? "0000-01-01";
        expect((fewer.latestStart.get(t.id) ?? "0000-01-01") >= base).toBe(true);
        expect((more.latestStart.get(t.id) ?? "0000-01-01") >= base).toBe(true);
      }
    }
  });
});

describe("demand-bound check and levelled load", () => {
  it("finds the binding deadline: 34 h due by 18 Dec against 32 h available", () => {
    const r = demandBoundCheck(fixture, { today: TODAY, capacity: oneHourADay });
    expect(r.rows.map((row) => [row.due, row.demandHours, row.supplyHours])).toEqual([
      ["2026-12-04", 8, 18],
      ["2026-12-11", 14, 25],
      ["2026-12-18", 34, 32],
    ]);
    expect(r.firstViolation?.due).toBe("2026-12-18");
    expect(r.firstViolation?.gapHours).toBeCloseTo(2, 12);
  });

  it("levels the plan at the YDS density: 34 h over 32 days is about 7.5 h a week", () => {
    const load = levelledLoad(fixture, { today: TODAY });
    expect(load.hoursPerDay).toBeCloseTo(34 / 32, 12);
    expect(load.weeklyHoursRounded).toBe(7.5);
    expect(load.criticalDue).toBe("2026-12-18");
    expect(load.pastDue).toEqual([]);
    // At the levelled load the plan just fits.
    expect(demandBoundCheck(fixture, { today: TODAY, capacity: weeklyCapacity(load.hoursPerDay * 7) }).feasible).toBe(true);
  });

  it("lists tasks already due as past due", () => {
    const load = levelledLoad([{ id: "old", effortHours: 2, due: TODAY }, ...fixture], { today: TODAY });
    expect(load.pastDue).toEqual(["old"]);
  });

  it("the levelled load is the smallest feasible weekly load (property)", () => {
    for (let seed = 200; seed < 240; seed++) {
      const tasks = randomTasks(seed, 5);
      const load = levelledLoad(tasks, { today: TODAY });
      const at = (weekly: number) => demandBoundCheck(tasks, { today: TODAY, capacity: weeklyCapacity(weekly) }).feasible;
      expect(at(load.hoursPerDay * 7 * 1.0001)).toBe(true);
      expect(at(load.hoursPerDay * 7 * 0.98)).toBe(false);
    }
  });

  it("supply counts hours on [from, to)", () => {
    expect(supplyBetween(10, 17, oneHourADay)).toBeCloseTo(7, 12);
    expect(supplyBetween(10, 10, oneHourADay)).toBe(0);
  });
});

describe("whatFits (Moore-Hodgson with pinned applications)", () => {
  it("defers the longest application so the most applications fit", () => {
    const r = whatFits(
      fixture.map((t) => ({ ...t, pinned: false })),
      { today: TODAY, capacity: oneHourADay },
    );
    expect(r.onTime).toEqual(["T1", "T2"]);
    expect(r.deferred).toEqual(["T3"]);
    expect(r.pinnedOverflow).toBe(false);
  });

  it("never defers a pinned application", () => {
    const r = whatFits(
      fixture.map((t) => ({ ...t, pinned: t.id === "T3" })),
      { today: TODAY, capacity: oneHourADay },
    );
    expect(r.onTime).toContain("T3");
    expect(r.deferred).toEqual(["T1"]);
  });

  it("reports when the pinned applications alone do not fit", () => {
    const r = whatFits(
      [{ id: "big", effortHours: 50, due: "2026-11-20", pinned: true }],
      { today: TODAY, capacity: oneHourADay },
    );
    expect(r.pinnedOverflow).toBe(true);
  });

  it("is optimal on small random instances (exhaustive check)", () => {
    for (let seed = 300; seed < 340; seed++) {
      const tasks = randomTasks(seed, 6).map((t) => ({ ...t, effortHours: t.effortHours * 3, pinned: false }));
      const capacity = weeklyCapacity(5);
      const r = whatFits(tasks, { today: TODAY, capacity });
      let best = 0;
      for (let mask = 0; mask < 1 << tasks.length; mask++) {
        const subset = tasks.filter((_, i) => mask & (1 << i));
        if (subset.length > best && demandBoundCheck(subset, { today: TODAY, capacity }).feasible) best = subset.length;
      }
      expect(r.onTime.length).toBe(best);
      expect(demandBoundCheck(tasks.filter((t) => r.onTime.includes(t.id)), { today: TODAY, capacity }).feasible).toBe(true);
    }
  });
});
