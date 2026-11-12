import { describe, expect, it } from "vitest";
import {
  buildFunnel,
  currentStageFor,
  entryAccess,
  formatCount,
  naturalFrequency,
  officialRateInterval,
  officialStageOdds,
  ratioKind,
  stageOddsSentence,
  transitionForStudent,
  type OfficialCountRow,
} from "./odds";
import { StageOddsSchema } from "../contracts/registry";

/*
 * Official counts recorded in plan 07 §7.5.1 (each checked on the official page on 2026-11-09):
 * Goldwater 2026 press release, Truman 2026 press release, Udall news 13 May 2026, Boren statistics.
 * They are the plan's own test fixtures for officialStageOdds and entryAccess (ticket S07-020).
 */
const verified = { verifiedAt: "2026-11-09", verifiedBy: "Novus Curator AB" } as const;
const row = (stage: OfficialCountRow["stage"], count: number, sourceUrl: string, extra: Partial<OfficialCountRow> = {}): OfficialCountRow => ({
  stage,
  count,
  kind: "exact",
  provenance: "official_publication",
  cycleYear: 2026,
  sourceUrl,
  ...verified,
  ...extra,
});
const GOLDWATER = "https://goldwaterscholarship.gov/2026-awards-press-release/";
const goldwater: OfficialCountRow[] = [
  row("campus_applicants", 5000, GOLDWATER, { kind: "lower_bound" }),
  row("nominees", 1485, GOLDWATER),
  row("awards", 454, GOLDWATER),
];
const truman: OfficialCountRow[] = [row("nominees", 781, "https://www.truman.gov/2026PressRelease"), row("awards", 55, "https://www.truman.gov/2026PressRelease")];
const udall: OfficialCountRow[] = [row("nominees", 383, "https://udall.gov/News/NewsArchive/13221"), row("awards", 65, "https://udall.gov/News/NewsArchive/13221")];

describe("official stage odds (plan 7.5.2)", () => {
  it("builds consecutive stage pairs from official counts only", () => {
    const odds = officialStageOdds(goldwater);
    expect(odds.map((o) => [o.fromStage, o.toStage, o.numerator, o.denominator, o.denominatorKind])).toEqual([
      ["campus_applicants", "nominees", 1485, 5000, "lower_bound"],
      ["nominees", "awards", 454, 1485, "exact"],
    ]);
    for (const o of odds) expect(StageOddsSchema.safeParse(o).success).toBe(true);
  });

  it("ignores owner_reported rows, so a paying owner cannot look less crowded", () => {
    const withOwner = [...goldwater, row("nominees", 300, GOLDWATER, { provenance: "owner_reported" })];
    expect(officialStageOdds(withOwner)).toEqual(officialStageOdds(goldwater));
    expect(entryAccess(withOwner, { nominationGated: true })).toEqual(entryAccess(goldwater, { nominationGated: true }));
  });

  it("orders years newest first and skips malformed pairs", () => {
    const odds = officialStageOdds([...truman, row("nominees", 700, "https://example.org/sample", { cycleYear: 2025 }), row("awards", 900, "https://example.org/sample", { cycleYear: 2025 })]);
    expect(odds.map((o) => o.cycleYear)).toEqual([2026]);
  });

  it("entry access: awards over the pool a student enters, null with nominee counts only", () => {
    expect(entryAccess(goldwater, { nominationGated: true })).toEqual({ k: 454, n: 5000, kind: "lower_bound", stage: "campus_applicants", year: 2026 });
    expect(entryAccess(truman, { nominationGated: true })).toBeNull();
    expect(entryAccess(udall, { nominationGated: true })).toBeNull();
  });

  it("ratio kinds: a lower-bound pool makes the rate an upper bound", () => {
    expect(ratioKind("exact", "exact")).toBe("exact");
    expect(ratioKind("exact", "lower_bound")).toBe("lower_bound");
    expect(ratioKind("approx", "exact")).toBe("approx");
    expect(ratioKind("lower_bound", "exact")).toBe("approx");
  });
});

describe("natural frequencies", () => {
  it("reads the plan's fixtures in words, never as percentages", () => {
    expect(naturalFrequency(454, 1485, "exact")).toBe("about 3 in 10");
    expect(naturalFrequency(55, 781, "exact")).toBe("about 7 in 100");
    expect(naturalFrequency(65, 383, "exact")).toBe("about 2 in 10");
    expect(naturalFrequency(97, 232, "exact")).toBe("about 4 in 10");
    expect(naturalFrequency(193, 592, "exact")).toBe("about 3 in 10");
  });

  it("upper bounds read 'at most' and never understate the bound", () => {
    // 454 / 5,000 = 9.08%: "at most 10 in 100" simplifies to "at most 1 in 10".
    expect(naturalFrequency(454, 5000, "lower_bound")).toBe("at most 1 in 10");
    expect(naturalFrequency(70, 1000, "lower_bound")).toBe("at most 7 in 100");
    expect(naturalFrequency(306, 1000, "lower_bound")).toBe("at most 4 in 10");
  });

  it("handles the edges", () => {
    expect(naturalFrequency(1, 1000, "exact")).toBe("fewer than 1 in 100");
    expect(naturalFrequency(97, 1000, "exact")).toBe("about 1 in 10");
    expect(naturalFrequency(99, 100, "exact")).toBe("nearly all");
    expect(naturalFrequency(1, 0, "exact")).toBe("unknown");
  });

  it("writes one sentence per stage with k of n and the year", () => {
    const [campus, national] = officialStageOdds(goldwater);
    expect(stageOddsSentence(national!)).toBe("In 2026, 454 of 1,485 nominees won: about 3 in 10.");
    expect(stageOddsSentence(campus!)).toBe("In 2026, 1,485 of more than 5,000 campus applicants were nominated: at most 3 in 10.");
    expect(formatCount(1234567)).toBe("1,234,567");
  });

  it("keeps an internal Jeffreys interval for official rates", () => {
    const [, national] = officialStageOdds(goldwater);
    const interval = officialRateInterval(national!);
    expect(interval.lo).toBeLessThan(454 / 1485);
    expect(interval.hi).toBeGreaterThan(454 / 1485);
  });
});

describe("funnels and the student's stage", () => {
  it("shows the funnel stage by stage with a program-level overall ratio", () => {
    const funnel = buildFunnel(officialStageOdds(goldwater), { nominationGated: true });
    expect(funnel.year).toBe(2026);
    expect(funnel.steps).toHaveLength(2);
    expect(funnel.campusStage).toBe("official");
    // P(nominated) × P(award | nominated) telescopes to awards ÷ pool, an upper bound here.
    expect(funnel.overall).toEqual({ k: 454, n: 5000, kind: "lower_bound", frequency: "at most 1 in 10" });
  });

  it("marks the campus stage as set by the campus when only national counts exist", () => {
    const funnel = buildFunnel(officialStageOdds(truman), { nominationGated: true });
    expect(funnel.campusStage).toBe("set_by_campus");
    expect(funnel.overall).toBeNull();
    expect(buildFunnel(officialStageOdds(truman), { nominationGated: false }).campusStage).toBe("not_applicable");
  });

  it("gives a campus applicant the national stage, labelled conditional, never the campus rate", () => {
    const odds = officialStageOdds(goldwater);
    expect(currentStageFor(null, true)).toBe("campus_applicants");
    expect(currentStageFor(null, false)).toBe("applicants");
    const t = transitionForStudent(odds, "campus_applicants", { nominationGated: true })!;
    expect([t.odds.fromStage, t.odds.toStage, t.conditional]).toEqual(["nominees", "awards", true]);
    const nominee = transitionForStudent(odds, "nominees", { nominationGated: true })!;
    expect(nominee.conditional).toBe(false);
    expect(transitionForStudent([], "applicants")).toBeNull();
  });
});
