import { describe, expect, it } from "vitest";
import { epochDayOf, isoFromEpochDay } from "./calendar";
import { createRng } from "./math/random";
import {
  applyDateRule,
  conformalWidths,
  DateRuleSchema,
  inferDateRule,
  intervalResidualDays,
  intervalScore,
  kappaForWidth,
  labelForWidth,
  lookupConformal,
  predictCycleEvent,
  predictionLabelGate,
  scorePrediction,
  toPrediction,
  type DateRuleInput,
  type HistoryInterval,
} from "./predict";
import { PredictionSchema } from "../contracts/registry";
import { parseIsoInstant } from "../time/iso";

/*
 * Golden dates (plan 7.6.1 and the planning study, computed with dateutil.rrule on 2026-11-11):
 * Goldwater "the last Friday in January at 5:00 p.m. Central Time" gives 29 Jan 2027 17:00
 * America/Chicago; "the first Tuesday in September" gives 7 Sep 2027; URI's internal Truman
 * deadline "the first Tuesday after Thanksgiving" is Thanksgiving + 5 days.
 */
const lastFridayJan: DateRuleInput = {
  kind: "last_weekday",
  event: "closes",
  month: 1,
  weekday: 5,
  localTime: "17:00",
  timeZone: "America/Chicago",
  restatedThisCycle: true,
};
const firstTuesdaySep: DateRuleInput = { kind: "nth_weekday", event: "opens", month: 9, weekday: 2, nth: 1, restatedThisCycle: true };
const exact = (event: HistoryInterval["event"], date: string, extra: Partial<HistoryInterval> = {}): HistoryInterval => ({
  event,
  cycleYear: Number(date.slice(0, 4)),
  lo: date,
  hi: date,
  ...extra,
});

describe("official date rules", () => {
  it("apply to a year, with the instant when a time and zone are stated", () => {
    const close = applyDateRule(lastFridayJan, 2027);
    expect(close.date).toBe("2027-01-29");
    expect(close.instant).toBe(parseIsoInstant("2027-01-29T23:00:00Z"));
    expect(applyDateRule(firstTuesdaySep, 2027)).toEqual({ date: "2027-09-07", instant: null });
    expect(applyDateRule({ kind: "offset", event: "campus_internal", anchor: "us_thanksgiving", offsetDays: 5, restatedThisCycle: true }, 2026).date).toBe("2026-12-01");
    expect(applyDateRule({ kind: "fixed_date", event: "opens", month: 2, day: 30, restatedThisCycle: true }, 2027).date).toBeNull();
    expect(applyDateRule({ ...lastFridayJan, applicantLocal: true, timeZone: null }, 2027).instant).toBeNull();
  });

  it("validate with zod (workbook and console input)", () => {
    expect(DateRuleSchema.safeParse(lastFridayJan).success).toBe(true);
    expect(DateRuleSchema.safeParse({ ...firstTuesdaySep, nth: 6 }).success).toBe(false);
    expect(DateRuleSchema.safeParse({ ...firstTuesdaySep, kind: "every_other_tuesday" }).success).toBe(false);
  });

  it("predict Goldwater's 2027 deadline and next opening exactly", () => {
    const close = predictCycleEvent({ dateRules: [lastFridayJan] }, "closes", 2027)!;
    expect([close.p10, close.p50, close.p90, close.detail, close.method]).toEqual(["2027-01-29", "2027-01-29", "2027-01-29", "official_rule", "official_rule"]);
    expect(close.instant).toBe(parseIsoInstant("2027-01-29T23:00:00Z"));
    expect(predictCycleEvent({ dateRules: [firstTuesdaySep] }, "opens", 2027)!.p50).toBe("2027-09-07");
  });
});

describe("labels (plan 7.6.1's 31-day-month test)", () => {
  const month = { event: "opens" as const, month: 1, evidenced: true };
  const cases = (gatePassed: boolean) => ({
    restated: predictCycleEvent({ dateRules: [{ ...firstTuesdaySep, month: 1 }] }, "opens", 2027, { gatePassed })!,
    carriedOver: predictCycleEvent({ dateRules: [{ ...firstTuesdaySep, month: 1, restatedThisCycle: false }] }, "opens", 2027, { gatePassed })!,
    curatorMonth: predictCycleEvent({ expectedMonths: [month] }, "opens", 2027, { gatePassed })!,
    curatorEstimate: predictCycleEvent({ expectedMonths: [{ ...month, evidenced: false }] }, "opens", 2027, { gatePassed })!,
    fixedDate: predictCycleEvent({ history: [exact("opens", "2026-01-15"), exact("opens", "2025-01-15")] }, "opens", 2027, { gatePassed })!,
    weekdayTight: predictCycleEvent({ history: [exact("opens", "2026-01-13"), exact("opens", "2025-01-14")] }, "opens", 2027, { gatePassed })!,
    weekdayLoose: predictCycleEvent({ history: [exact("opens", "2026-01-13"), exact("opens", "2025-01-28")] }, "opens", 2027, { gatePassed })!,
  });

  it("before the gate passes every method is at most medium", () => {
    const c = cases(false);
    expect(Object.fromEntries(Object.entries(c).map(([k, p]) => [k, [p.widthDays, p.label]]))).toEqual({
      restated: [0, "medium"],
      carriedOver: [6, "medium"],
      curatorMonth: [30, "medium"],
      curatorEstimate: [44, "low"],
      fixedDate: [6, "medium"],
      weekdayTight: [14, "medium"],
      weekdayLoose: [42, "medium"],
    });
  });

  it("after the gate passes the width decides, within each method's cap", () => {
    const c = cases(true);
    expect(Object.fromEntries(Object.entries(c).map(([k, p]) => [k, p.label]))).toEqual({
      restated: "high",
      carriedOver: "medium",
      curatorMonth: "medium",
      curatorEstimate: "low",
      fixedDate: "high",
      weekdayTight: "high",
      weekdayLoose: "medium",
    });
    expect(c.curatorEstimate.method).toBe("curator_estimate");
    expect(c.weekdayTight.detail).toBe("weekday_shift");
  });

  it("κ = 1 − min(1, width / 90), and the label thresholds", () => {
    expect(kappaForWidth(0)).toBe(1);
    expect(kappaForWidth(45)).toBe(0.5);
    expect(kappaForWidth(200)).toBe(0);
    expect([labelForWidth(14), labelForWidth(15), labelForWidth(42), labelForWidth(43)]).toEqual(["high", "medium", "medium", "low"]);
  });

  it("produces the stored contract shape", () => {
    expect(PredictionSchema.safeParse(toPrediction(cases(false).weekdayLoose)).success).toBe(true);
  });
});

describe("history methods", () => {
  it("never infers a rule from two cycles; three consistent cycles make a rule", () => {
    const two = [exact("closes", "2027-01-29"), exact("closes", "2026-01-30")];
    expect(inferDateRule(two, "closes")).toBeNull();
    const three = [...two, exact("closes", "2025-01-31")];
    expect(inferDateRule(three, "closes")).toMatchObject({ kind: "last_weekday", month: 1, weekday: 5 });
    const p = predictCycleEvent({ history: three }, "closes", 2028)!;
    expect([p.p50, p.detail, p.method]).toEqual(["2028-01-28", "inferred_rule", "history"]);
    expect(inferDateRule([exact("opens", "2024-09-03"), exact("opens", "2025-09-02"), exact("opens", "2026-09-01")], "opens")).toMatchObject({
      kind: "nth_weekday",
      nth: 1,
      weekday: 2,
    });
    expect(inferDateRule([exact("opens", "2024-03-01"), exact("opens", "2025-03-01"), exact("opens", "2026-03-01")], "opens")).toMatchObject({
      kind: "fixed_date",
      day: 1,
    });
  });

  it("drops left-censored rows (a list's first commit says when the list began)", () => {
    const history = [exact("opens", "2026-02-04", { leftCensored: true })];
    expect(predictCycleEvent({ history }, "opens", 2027)).toBeNull();
  });

  it("pads intervals by twice the mean half-width of interval observations", () => {
    const history = [
      { event: "opens" as const, cycleYear: 2026, lo: "2026-01-09", hi: "2026-01-17" },
      { event: "opens" as const, cycleYear: 2025, lo: "2025-01-09", hi: "2025-01-17" },
    ];
    const p = predictCycleEvent({ history }, "opens", 2027)!;
    expect(p.detail).toBe("fixed_date");
    expect(p.widthDays).toBe(6 + 8);
  });

  it("the seasonal model (opt-in) handles drifting dates with a Student-t interval", () => {
    const history = [exact("opens", "2023-09-05"), exact("opens", "2024-09-11"), exact("opens", "2025-09-02"), exact("opens", "2026-09-09")];
    const p = predictCycleEvent({ history }, "opens", 2027, { statistical: true })!;
    expect(p.detail).toBe("seasonal");
    expect(p.p10 <= p.p50 && p.p50 <= p.p90).toBe(true);
    expect(Math.abs(epochDayOf(p.p50) - epochDayOf("2027-09-06"))).toBeLessThanOrEqual(7);
    // Without the opt-in, the same history uses the weekday shift.
    expect(predictCycleEvent({ history }, "opens", 2027)!.detail).toBe("weekday_shift");
  });

  it("returns null when nothing is known ('dates not yet known')", () => {
    expect(predictCycleEvent({}, "opens", 2027)).toBeNull();
  });

  it("p10 ≤ p50 ≤ p90 and determinism over random histories (property)", () => {
    const rng = createRng(77);
    for (let i = 0; i < 300; i++) {
      const anchor = epochDayOf("2026-01-01") + rng.int(330);
      const history: HistoryInterval[] = Array.from({ length: rng.int(5) }, (_, k) => {
        const lo = isoFromEpochDay(anchor - 365 * (k + 1) + rng.int(15) - 7);
        const hi = rng.bernoulli(0.3) ? isoFromEpochDay(epochDayOf(lo) + rng.int(10)) : lo;
        return { event: "opens", cycleYear: Number(lo.slice(0, 4)), lo, hi };
      });
      const opts = { gatePassed: rng.bernoulli(0.5), statistical: rng.bernoulli(0.5) };
      const p = predictCycleEvent({ history, expectedMonths: [{ event: "opens", month: 1 + rng.int(12), evidenced: rng.bernoulli(0.5) }] }, "opens", 2027, opts)!;
      expect(p.p10 <= p.p50 && p.p50 <= p.p90, JSON.stringify(history)).toBe(true);
      expect(p.kappa).toBeGreaterThanOrEqual(0);
      expect(predictCycleEvent({ history: [...history].reverse(), expectedMonths: [] }, "opens", 2027, opts)).toEqual(
        predictCycleEvent({ history, expectedMonths: [] }, "opens", 2027, opts),
      );
    }
  });
});

describe("scoring, the label gate and conformal widths", () => {
  it("covers when [p10, p90] overlaps the observed interval; error from its midpoint", () => {
    const p = { p10: "2027-01-20", p50: "2027-01-25", p90: "2027-01-30" };
    expect(scorePrediction(p, { lo: "2027-01-29", hi: "2027-02-05" })).toEqual({ covered: true, absErrorDays: 7.5 });
    expect(scorePrediction(p, { lo: "2027-02-01", hi: "2027-02-01" }).covered).toBe(false);
    expect(intervalResidualDays("2027-01-25", { lo: "2027-01-20", hi: "2027-01-30" })).toBe(0);
    expect(intervalResidualDays("2027-01-25", { lo: "2027-01-28", hi: "2027-01-30" })).toBe(3);
    expect(intervalResidualDays("2027-01-25", { lo: "2027-01-20", hi: "2027-01-22" })).toBe(-3);
  });

  it("Gneiting-Raftery interval score at α = 0.2 penalises width and misses", () => {
    expect(intervalScore("2027-01-10", "2027-01-20", "2027-01-15")).toBe(10);
    expect(intervalScore("2027-01-10", "2027-01-20", "2027-01-25")).toBe(10 + 10 * 5);
    expect(intervalScore("2027-01-10", "2027-01-20", "2027-01-05")).toBe(10 + 10 * 5);
  });

  it("the gate needs 50 scored predictions and a one-sided 90% Wilson lower bound ≥ 0.70", () => {
    const scored = (n: number, covered: number) => Array.from({ length: n }, (_, i) => ({ covered: i < covered }));
    expect(predictionLabelGate(scored(50, 45)).passes).toBe(true);
    expect(predictionLabelGate(scored(49, 49)).passes).toBe(false);
    expect(predictionLabelGate(scored(50, 37)).passes).toBe(false);
  });

  it("split-conformal widths per method and type, with a pooled fallback", () => {
    const rng = createRng(3);
    const residuals = Array.from({ length: 60 }, (_, i) => ({
      method: "fixed_date" as const,
      stratum: i < 25 ? "fellowship" : "internship",
      residualDays: Math.round(rng.normal() * 4),
    }));
    const table = conformalWidths(residuals);
    expect(table.get("fixed_date|fellowship")!.n).toBe(25);
    expect(table.get("fixed_date|internship")!.n).toBe(35);
    expect(table.get("fixed_date|*")!.n).toBe(60);
    expect(lookupConformal(table, "fixed_date", "scholarship")).toBe(table.get("fixed_date|*"));
    expect(lookupConformal(table, "weekday_shift", "fellowship")).toBeNull();
    const w = table.get("fixed_date|*")!;
    expect(w.qLo).toBeLessThanOrEqual(0);
    expect(w.qHi).toBeGreaterThanOrEqual(0);
    // With a table, the fixed-date method uses the calibrated offsets instead of judgment widths.
    const history = [exact("opens", "2026-01-15"), exact("opens", "2025-01-15")];
    const p = predictCycleEvent({ history }, "opens", 2027, { conformal: table, stratum: "fellowship" })!;
    const f = table.get("fixed_date|fellowship")!;
    expect(epochDayOf(p.p10) - epochDayOf(p.p50)).toBe(Math.floor(f.qLo));
    expect(epochDayOf(p.p90) - epochDayOf(p.p50)).toBe(Math.ceil(f.qHi));
  });

  it("split-conformal widths reach about 80% coverage on fresh residuals", () => {
    const rng = createRng(9);
    const draw = () => Math.round(rng.normal() * 6 + (rng.bernoulli(0.1) ? 10 : 0));
    const table = conformalWidths(Array.from({ length: 400 }, () => ({ method: "weekday_shift" as const, stratum: "fellowship", residualDays: draw() })));
    const w = table.get("weekday_shift|fellowship")!;
    let covered = 0;
    for (let i = 0; i < 4000; i++) {
      const r = draw();
      if (r >= w.qLo && r <= w.qHi) covered++;
    }
    expect(covered / 4000).toBeGreaterThan(0.76);
    expect(covered / 4000).toBeLessThan(0.88);
  });
});
