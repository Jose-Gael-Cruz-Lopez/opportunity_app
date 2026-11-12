import { describe, expect, it } from "vitest";
import { SAMPLE_PROGRAM_DETAIL } from "@/components/readiness/fixtures";
import { buildProgramView, compensationLine, costLines, countdownFor } from "./model";

const NOW = Date.parse("2026-11-11T17:00:00.000Z");

describe("buildProgramView", () => {
  const view = buildProgramView(SAMPLE_PROGRAM_DETAIL, NOW, "America/Chicago", false);

  it("shows the deadline in the official zone and on the viewer's clock", () => {
    expect(view.deadline?.officialText).toBe("Thu 28 Jan 2027, 11:59 PM EST");
    expect(view.deadline?.viewerText).toBe("(10:59 PM your time)");
  });

  it("counts down with a ruler across the application window", () => {
    expect(view.countdown).toEqual({ value: "78", unit: "days left", spoken: "78 days left" });
    expect(view.ruler?.startLabel).toBe("Opened 27 Aug");
    expect(view.ruler?.endLabel).toBe("Due 28 Jan");
    expect(view.ruler?.position.label).toBe("Day 76 of a 154-day application window");
  });

  it("tags the status, types, cycle and sample label", () => {
    const labels = view.tags.map((t) => t.label);
    expect(labels).toHaveLength(5);
    expect(labels[0]).toBe("Open");
    expect(labels[3]).toBe("2026-27 cycle");
    expect(labels[4]).toBe("Sample data");
    expect(view.tags[0]?.tone).toBe("live");
    expect(view.tags.at(-1)?.sample).toBe(true);
    expect(view.sample).toBe(true);
  });

  it("links to the official application, the calendar and the public page", () => {
    // Sample records skip the /out redirect, which only exists for real cycles.
    expect(view.applyHref).toBe("https://example.org/sample-coastal/apply");
    expect(view.calendarHref).toBe("/cal/p/sample-coastal-research-scholars.ics");
    expect(view.publicHref).toBe("/programs/sample-coastal-research-scholars");
    const real = buildProgramView({ ...SAMPLE_PROGRAM_DETAIL, program: { ...SAMPLE_PROGRAM_DETAIL.program, isSample: false } }, NOW, "UTC", false);
    expect(real.applyHref).toBe(`/out/${SAMPLE_PROGRAM_DETAIL.cycle.id}`);
  });

  it("states verification, money and timing in words", () => {
    expect(view.verifiedLine).toBe("Verified 4 Nov 2026 by Curator AB");
    expect(view.gives).toEqual(["$7,500 stipend in total"]);
    expect(view.costs).toEqual(["No application fee", "No cost to take part"]);
    expect(view.when[0]).toBe("Runs 1 Jun to 6 Aug 2027");
  });

  it("drops the countdown for closed cycles and explains expected ones", () => {
    const closed = buildProgramView({ ...SAMPLE_PROGRAM_DETAIL, cycle: { ...SAMPLE_PROGRAM_DETAIL.cycle, status: "closed" } }, NOW, "UTC", false);
    expect(closed.countdown).toBeNull();
    const expected = buildProgramView(
      { ...SAMPLE_PROGRAM_DETAIL, deadlines: [], cycle: { ...SAMPLE_PROGRAM_DETAIL.cycle, status: "expected", opensOn: null }, prediction: { p10: "2027-08-15", p50: "2027-08-27", p90: "2027-09-10", label: "medium", method: "history" } },
      NOW,
      "UTC",
      false,
    );
    expect(expected.openingLine).toBe("Expected to open around 27 Aug 2027 (medium confidence)");
    expect(expected.countdown).toBeNull();
  });
});

describe("helpers", () => {
  it("words countdowns", () => {
    expect(countdownFor(1)).toEqual({ value: "1", unit: "day left", spoken: "1 day left" });
    expect(countdownFor(0)?.unit).toBe("due today");
    expect(countdownFor(-1)).toBeNull();
    expect(countdownFor(null)).toBeNull();
  });

  it("words compensation and costs", () => {
    expect(compensationLine(null)).toBeNull();
    expect(compensationLine({ kind: "none", amountCents: null, period: null })).toBeNull();
    expect(compensationLine({ kind: "tuition", amountCents: null, period: null })).toBe("Tuition support");
    expect(compensationLine({ kind: "salary_hourly", amountCents: 2000, period: "hour" })).toBe("$20 pay an hour");
    const cycle = { ...SAMPLE_PROGRAM_DETAIL.cycle, applicationFeeCents: 2500, participantCostCents: null, pellDisplacement: "possible" as const };
    expect(costLines(cycle)).toEqual(["Application fee $25", "The award may reduce other financial aid; ask your aid office"]);
  });
});
