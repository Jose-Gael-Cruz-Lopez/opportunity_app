import { describe, expect, it } from "vitest";
import { DISCLOSURE, DISCLOSURE_DIMENSIONS, release, type CountRow } from "../../disclosure";
import { COUNT_STAGES, INSTITUTION_LEVELS, OUTCOME_DECISIONS, OUTCOME_STAGES, OUTCOME_TIERS } from "../../taxonomy";
import { FUNNEL_ORDER } from "../odds";
import {
  COUNT_STAGE_CODES,
  COUNTED_TIER_CODES,
  FUNNEL_STAGE_CODES,
  INSTITUTION_LEVEL_CODES,
  NO_PRIVATE_CONFIG,
  OUTCOME_DECISION_CODES,
  OUTCOME_STAGE_ORDER,
  OUTCOME_TIER_CODES,
  OutcomeSummarySchema,
  addMonthsIso,
  assessCycleQuality,
  bandDisplayStatus,
  consecutiveTransitions,
  decisionWindowClosed,
  furthestStage,
  giveToGetAccess,
  inDecisionWindow,
  isCalendarDate,
  outcomeEditable,
  outcomePromptDueOn,
  qualityFlags,
  structuralIssues,
  summaryCountRows,
  tierWeight,
  transitionResult,
  validateOutcomeReport,
  weekStartOf,
  type OutcomeFacts,
  type QualityReportRow,
  type SummaryReport,
  type ValidationContext,
} from "./index";

const TODAY = "2027-04-20";
const CYCLE = { decisionWindowStart: "2027-03-20", decisionWindowEnd: "2027-04-01", rollingDecisions: false, classYears: ["second_year", "third_year"] };

function facts(partial: Partial<OutcomeFacts> = {}): OutcomeFacts {
  return { stages: [{ stage: "submitted", on: "2027-01-29" }], decision: null, decidedOn: null, ...partial };
}

function ctx(partial: Partial<ValidationContext> = {}): ValidationContext {
  return {
    today: TODAY,
    cycle: CYCLE,
    roundDeadline: "2027-01-29",
    nominationRequired: false,
    snapshotClassYear: "second_year",
    otherReportsThisSeason: 0,
    privateConfig: NO_PRIVATE_CONFIG,
    ...partial,
  };
}

describe("vocabulary mirrors shared/taxonomy and shared/disclosure", () => {
  it("keeps every local list equal to its original", () => {
    expect([...OUTCOME_STAGE_ORDER]).toEqual([...OUTCOME_STAGES]);
    expect([...OUTCOME_DECISION_CODES]).toEqual([...OUTCOME_DECISIONS]);
    expect([...OUTCOME_TIER_CODES]).toEqual([...OUTCOME_TIERS]);
    expect([...COUNTED_TIER_CODES]).toEqual([...DISCLOSURE.countedTiers]);
    expect([...COUNT_STAGE_CODES]).toEqual([...COUNT_STAGES]);
    expect([...FUNNEL_STAGE_CODES]).toEqual([...FUNNEL_ORDER]);
    expect([...INSTITUTION_LEVEL_CODES]).toEqual([...INSTITUTION_LEVELS]);
    expect([...DISCLOSURE_DIMENSIONS.decision]).toEqual([...OUTCOME_DECISION_CODES]);
    expect([...DISCLOSURE_DIMENSIONS.stage]).toEqual([...OUTCOME_STAGE_ORDER]);
  });

  it("weighs self-reported reports at zero and counts from institution email up", () => {
    expect(tierWeight("self_reported")).toBe(0);
    expect(tierWeight("institution_email")).toBe(0.6);
    expect(tierWeight("letter_checked")).toBe(0.8);
    expect(tierWeight("official_list")).toBe(1);
    expect(tierWeight("made_up")).toBe(0);
  });
});

describe("inDecisionWindow", () => {
  it("accepts 7 days before a curated window to 21 days after its end", () => {
    expect(inDecisionWindow(CYCLE, "2027-03-13", TODAY)).toMatchObject({ ok: true, basis: "curated" });
    expect(inDecisionWindow(CYCLE, "2027-03-12", TODAY)).toMatchObject({ ok: false, reason: "before_window" });
    expect(inDecisionWindow(CYCLE, "2027-04-22", "2027-05-30")).toMatchObject({ ok: true });
    expect(inDecisionWindow(CYCLE, "2027-04-23", "2027-05-30")).toMatchObject({ ok: false, reason: "after_window" });
  });

  it("never accepts a future date", () => {
    expect(inDecisionWindow(CYCLE, "2027-04-21", TODAY)).toMatchObject({ ok: false, reason: "future" });
    expect(inDecisionWindow({ decisionWindowStart: null, decisionWindowEnd: null }, "2027-04-21", TODAY)).toMatchObject({ ok: false, reason: "future" });
  });

  it("falls back to the round deadline, then to anything up to today", () => {
    const none = { decisionWindowStart: null, decisionWindowEnd: null };
    expect(inDecisionWindow(none, "2027-01-28", TODAY, "2027-01-29")).toMatchObject({ ok: false, basis: "round_deadline", reason: "before_round_deadline" });
    expect(inDecisionWindow(none, "2027-02-10", TODAY, "2027-01-29")).toMatchObject({ ok: true, basis: "round_deadline" });
    expect(inDecisionWindow(none, "2026-02-10", TODAY)).toMatchObject({ ok: true, basis: "unbounded" });
  });

  it("rejects impossible dates", () => {
    expect(isCalendarDate("2027-02-30")).toBe(false);
    expect(inDecisionWindow(CYCLE, "2027-02-30", TODAY)).toMatchObject({ ok: false, reason: "invalid_date" });
  });

  it("dates the prompt, the window close and the edit window", () => {
    expect(outcomePromptDueOn(CYCLE)).toBe("2027-04-04");
    expect(outcomePromptDueOn({ decisionWindowStart: null, decisionWindowEnd: null })).toBeNull();
    expect(decisionWindowClosed(CYCLE, "2027-04-22")).toBe(false);
    expect(decisionWindowClosed(CYCLE, "2027-04-23")).toBe(true);
    expect(decisionWindowClosed({ decisionWindowStart: null, decisionWindowEnd: null }, "2030-01-01")).toBe(false);
    expect(outcomeEditable("2027-03-01", "2027-04-30")).toBe(true);
    expect(outcomeEditable("2027-03-01", "2027-05-01")).toBe(false);
    expect(outcomeEditable(null, "2030-01-01")).toBe(true);
    expect(weekStartOf("2027-04-01")).toBe("2027-03-29");
  });
});

describe("stage mapping (plan 7.5.1)", () => {
  const nominated = facts({ stages: [{ stage: "submitted", on: "2027-01-10" }, { stage: "campus_nominated", on: "2027-01-20" }] });

  it("counts declined offers as selections and leaves withdrawals out", () => {
    expect(transitionResult({ ...nominated, decision: "declined_offer", decidedOn: "2027-03-27" }, "nominees", "awards", false)).toBe("pass");
    expect(transitionResult({ ...nominated, decision: "accepted", decidedOn: "2027-03-27" }, "nominees", "awards", false)).toBe("pass");
    expect(transitionResult({ ...nominated, decision: "rejected", decidedOn: "2027-03-27" }, "nominees", "awards", false)).toBe("fail");
    expect(transitionResult({ ...nominated, decision: "withdrew", decidedOn: "2027-03-27" }, "nominees", "awards", true)).toBeNull();
    expect(transitionResult(nominated, "nominees", "awards", true)).toBeNull();
  });

  it("reads no_response as not selected only once the window has passed", () => {
    const silent = { ...nominated, decision: "no_response" as const, decidedOn: null };
    expect(transitionResult(silent, "nominees", "awards", false)).toBeNull();
    expect(transitionResult(silent, "nominees", "awards", true)).toBe("fail");
  });

  it("maps the campus round and finalists", () => {
    const notNominated = facts({ stages: [{ stage: "submitted", on: "2027-01-10" }, { stage: "not_nominated", on: "2027-01-20" }] });
    expect(transitionResult(notNominated, "campus_applicants", "nominees", false)).toBe("fail");
    expect(transitionResult(nominated, "campus_applicants", "nominees", false)).toBe("pass");
    expect(transitionResult(notNominated, "nominees", "awards", true)).toBeNull();
    const interviewed = facts({ stages: [{ stage: "submitted", on: "2027-01-10" }, { stage: "interview_invited", on: "2027-02-01" }], decision: "rejected", decidedOn: "2027-03-01" });
    expect(transitionResult(interviewed, "applicants", "finalists", false)).toBe("pass");
    expect(transitionResult(interviewed, "finalists", "awards", false)).toBe("fail");
    expect(transitionResult(facts({ decision: "rejected", decidedOn: "2027-03-01" }), "applicants", "finalists", false)).toBe("fail");
    expect(furthestStage(interviewed)).toBe("interview_invited");
    expect(furthestStage(notNominated)).toBe("not_nominated");
    expect(consecutiveTransitions(["awards", "campus_applicants", "nominees"])).toEqual([
      { from: "campus_applicants", to: "nominees" },
      { from: "nominees", to: "awards" },
    ]);
  });
});

describe("validators", () => {
  it("refuses reports that cannot be true, with fixed messages", () => {
    expect(structuralIssues({ stages: [], decision: null, decidedOn: null }, TODAY)).toEqual([{ path: "stages", message: "Start with when you submitted" }]);
    const issues = structuralIssues(
      {
        stages: [
          { stage: "submitted", on: "2027-02-10" },
          { stage: "campus_nominated", on: "2027-01-20" },
          { stage: "interviewed", on: "2027-05-01" },
        ],
        decision: "accepted",
        decidedOn: null,
      },
      TODAY,
    );
    expect(issues.map((i) => i.path).sort()).toEqual(["decidedOn", "stages.1.on", "stages.2.on"]);
    expect(issues.find((i) => i.path === "stages.2.on")?.message).toBe("That date is still in the future");
    expect(structuralIssues(facts({ decision: null, decidedOn: "2027-03-01" }), TODAY)[0]?.path).toBe("decidedOn");
    expect(structuralIssues(facts({ stages: [{ stage: "submitted", on: null }, { stage: "not_nominated", on: null }], decision: "accepted", decidedOn: "2027-03-01" }), TODAY)).toHaveLength(1);
    expect(structuralIssues(facts({ stages: [{ stage: "submitted", on: null }, { stage: "campus_nominated", on: null }, { stage: "not_nominated", on: null }] }), TODAY)[0]?.message).toBe(
      "Choose nominated or not nominated, not both",
    );
    expect(structuralIssues(facts({ decision: "accepted", decidedOn: "2027-01-01" }), TODAY)[0]?.message).toBe("The decision is dated before an earlier step");
    // no_response may come without a date ("I never heard back").
    expect(structuralIssues(facts({ decision: "no_response", decidedOn: null }), TODAY)).toEqual([]);
  });

  it("never echoes submitted values in messages", () => {
    const issues = structuralIssues({ stages: [{ stage: "submitted", on: "not-a-date-<script>" }], decision: null, decidedOn: null }, TODAY);
    expect(JSON.stringify(issues)).not.toContain("script");
  });

  it("flags awards without a nomination, early decisions, out-of-window dates and class years", () => {
    const award = facts({ decision: "accepted", decidedOn: "2027-01-15" });
    const flags = qualityFlags(award, ctx({ nominationRequired: true, snapshotClassYear: "first_year" }));
    expect(flags).toEqual(["award_without_nomination", "class_standing_not_admitted", "decision_before_round_close", "decision_outside_window"]);
    expect(qualityFlags(award, ctx({ cycle: { ...CYCLE, rollingDecisions: true } }))).not.toContain("decision_before_round_close");
    expect(validateOutcomeReport(facts({ decision: "rejected", decidedOn: "2027-03-28" }), ctx())).toEqual({ ok: true, flags: [] });
  });

  it("applies the seasonal cap only when the private config sets one", () => {
    const f = facts();
    expect(qualityFlags(f, ctx({ otherReportsThisSeason: 50 }))).toEqual([]);
    expect(qualityFlags(f, ctx({ otherReportsThisSeason: 3, privateConfig: { overCountFraction: null, seasonalCap: 3 } }))).toEqual(["seasonal_cap"]);
  });
});

function row(i: number, partial: Partial<QualityReportRow> = {}): QualityReportRow {
  return {
    id: `r${i}`,
    accountKey: `a${i}`,
    tier: "institution_email",
    qualityState: "ok",
    flagCodes: [],
    snapshotClassYear: "second_year",
    roundDeadline: "2027-01-29",
    otherReportsThisSeason: 0,
    stages: [{ stage: "submitted", on: "2027-01-20" }],
    decision: "accepted",
    decidedOn: "2027-03-29",
    ...partial,
  };
}

describe("assessCycleQuality", () => {
  it("holds a cycle only when counted selections exceed the private fraction of official awards", () => {
    const reports = Array.from({ length: 12 }, (_, i) => row(i));
    const base = { today: TODAY, cycle: CYCLE, nominationRequired: false, reports, officialAwards: 20 };
    expect(assessCycleQuality({ ...base, privateConfig: NO_PRIVATE_CONFIG }).hold).toBeNull();
    expect(assessCycleQuality({ ...base, privateConfig: { overCountFraction: 0.5, seasonalCap: null } }).hold).toEqual({ reason: "over_count" });
    expect(assessCycleQuality({ ...base, privateConfig: { overCountFraction: 0.7, seasonalCap: null } }).hold).toBeNull();
    // A self_reported excess never holds anything.
    const selfReported = reports.map((r) => ({ ...r, tier: "self_reported" }));
    expect(assessCycleQuality({ ...base, reports: selfReported, privateConfig: { overCountFraction: 0.1, seasonalCap: null } }).hold).toBeNull();
  });

  it("drafts a decision week only from 10 distinct counted accounts", () => {
    const nine = Array.from({ length: 9 }, (_, i) => row(i));
    const base = { today: TODAY, cycle: CYCLE, nominationRequired: false, officialAwards: null, privateConfig: NO_PRIVATE_CONFIG };
    expect(assessCycleQuality({ ...base, reports: nine }).historyDraft).toBeNull();
    // Same account twice does not count twice.
    expect(assessCycleQuality({ ...base, reports: [...nine, row(9, { accountKey: "a0", id: "dup" })] }).historyDraft).toBeNull();
    expect(assessCycleQuality({ ...base, reports: [...nine, row(9)] }).historyDraft).toEqual({ weekStart: "2027-03-29", accounts: 10 });
  });

  it("flags decisions far from the modal week when no curated window exists, adding to existing codes", () => {
    const cycle = { decisionWindowStart: null, decisionWindowEnd: null, rollingDecisions: false, classYears: [] };
    const reports = [...Array.from({ length: 6 }, (_, i) => row(i)), row(99, { decidedOn: "2027-02-10", flagCodes: ["seasonal_cap"] })];
    const out = assessCycleQuality({ today: TODAY, cycle, nominationRequired: false, reports, officialAwards: null, privateConfig: NO_PRIVATE_CONFIG });
    expect(out.flagUpdates).toEqual([{ id: "r99", flagCodes: ["decision_week_outlier", "seasonal_cap"] }]);
    expect(out.counts.flagged).toBe(1);
    expect(out.counts.byFlag).toEqual({ decision_week_outlier: 1, seasonal_cap: 1 });
  });
});

describe("give-to-get", () => {
  it("unlocks for 12 months after any contribution, whatever it says", () => {
    expect(giveToGetAccess({ today: TODAY, contributedOn: ["2026-05-01"], pledgedWindowEnds: [] })).toEqual({ unlocked: true, until: "2027-05-01", basis: "contribution" });
    expect(giveToGetAccess({ today: TODAY, contributedOn: ["2026-04-01"], pledgedWindowEnds: [] }).unlocked).toBe(false);
    expect(giveToGetAccess({ today: TODAY, contributedOn: [], pledgedWindowEnds: ["2027-04-01"] })).toEqual({ unlocked: true, until: "2027-05-01", basis: "pledge" });
    expect(giveToGetAccess({ today: TODAY, contributedOn: ["2027-05-01"], pledgedWindowEnds: [null] }).unlocked).toBe(false);
    expect(addMonthsIso("2028-02-29", 12)).toBe("2029-02-28");
  });
});

describe("aggregates go through shared/disclosure (k >= 5)", () => {
  const report = (i: number, partial: Partial<SummaryReport> = {}): SummaryReport => ({
    tier: "institution_email",
    qualityState: "ok",
    stages: [{ stage: "submitted", on: "2027-01-20" }, ...(i % 2 ? [{ stage: "campus_nominated" as const, on: "2027-01-25" }] : [])],
    decision: i % 3 === 0 ? "accepted" : "rejected",
    decidedOn: "2027-03-29",
    ...partial,
  });

  it("releases nothing below five counted reports and ignores uncounted or flagged ones", () => {
    const four = [0, 1, 2, 3].map((i) => report(i));
    const extra = [report(4, { tier: "self_reported" }), report(5, { qualityState: "flagged" })];
    const rows = summaryCountRows([...four, ...extra], "ay-2026-27");
    expect(rows.total[0]?.n).toBe(4);
    const [total] = release(rows.total as CountRow[], { audience: "public", grain: "cycle", dims: [] });
    expect(total).toEqual({ period: "ay-2026-27", suppressed: true, reason: "below_min_total" });
  });

  it("bands totals and hides small cells with complements", () => {
    const reports = Array.from({ length: 23 }, (_, i) => report(i));
    const rows = summaryCountRows(reports, "ay-2026-27");
    const [total] = release(rows.total as CountRow[], { audience: "public", grain: "cycle", dims: [] });
    expect(total).toMatchObject({ suppressed: false, total: "25" });
    const [decisions] = release(rows.decisions as CountRow[], { audience: "public", grain: "cycle", dims: ["decision"] });
    expect(decisions?.suppressed).toBe(false);
    const labels = decisions && !decisions.suppressed ? Object.fromEntries(decisions.cells.map((c) => [c.key, c.label])) : {};
    // 8 accepted (< 10) reads "fewer than 10"; zero-filled categories read the same way.
    expect(labels.accepted).toBe("fewer than 10");
    expect(labels.withdrew).toBe("fewer than 10");
    expect(Object.values(labels).every((l) => !/^\d$/.test(l))).toBe(true);
    const timeline = release(rows.timeline as CountRow[], { audience: "public", grain: "month", dims: [] });
    expect(timeline).toEqual([{ period: "2027-03", suppressed: false, total: "25", cells: [] }]);
  });

  it("parses a summary built from released tables", () => {
    const parsed = OutcomeSummarySchema.safeParse({
      programSlug: "sample-program",
      audience: "public",
      asOf: "2027-04-20",
      countedTiers: [...COUNTED_TIER_CODES],
      cycles: [
        {
          cycleKey: "ay-2026-27",
          held: false,
          reports: { period: "ay-2026-27", suppressed: true, reason: "below_min_total" },
          decisions: { period: "ay-2026-27", suppressed: true, reason: "below_min_total" },
          furthestStage: { period: "ay-2026-27", suppressed: true, reason: "below_min_total" },
          timeline: [],
        },
      ],
      bands: { status: bandDisplayStatus(null), note: "x" },
      isSample: true,
    });
    expect(parsed.success).toBe(true);
  });
});

describe("band display status", () => {
  const pass = { pooled: true, heldOut: "pass" as const, representativeness: true, fairness: true, usefulness: true, approved: true };
  it("is official base rate only until every gate passes", () => {
    expect(bandDisplayStatus(null)).toBe("official_base_rate_only");
    expect(bandDisplayStatus(pass)).toBe("live");
    for (const key of ["pooled", "representativeness", "fairness", "usefulness", "approved"] as const) {
      expect(bandDisplayStatus({ ...pass, [key]: false })).toBe("official_base_rate_only");
    }
    expect(bandDisplayStatus({ ...pass, heldOut: "fail_skill" })).toBe("official_base_rate_only");
    expect(bandDisplayStatus({ ...pass, heldOut: "not_evaluated" })).toBe("official_base_rate_only");
  });
});
