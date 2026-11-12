import { beforeAll, describe, expect, it } from "vitest";
import * as React from "react";
import { createElement, type ComponentType } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { OutcomeReportCreateSchema, type OutcomeReport } from "@shared/contracts/advisor";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import type { TrackerItem } from "@shared/contracts/student";
import { OFFICIAL_BASE_RATE_ONLY_NOTE, type OutcomeSummary } from "@shared/readiness/outcomes";
import {
  fieldForPath,
  formIssues,
  formToFacts,
  initialFormState,
  decisionWindowFor,
  outcomePromptState,
  toCreateBody,
  type OutcomeFormState,
} from "./model";
import { sampleReport } from "./api";

// vitest compiles TSX with the classic runtime; expose React before importing components.
let OutcomeForm: ComponentType<Record<string, unknown>>;
let OutcomePrompt: ComponentType<Record<string, unknown>>;
let OutcomeSummaryView: ComponentType<Record<string, unknown>>;
beforeAll(async () => {
  (globalThis as { React?: typeof React }).React = React;
  const prompt = await import("./OutcomePrompt");
  const panel = await import("./OutcomeSummaryPanel");
  OutcomeForm = prompt.OutcomeForm as unknown as ComponentType<Record<string, unknown>>;
  OutcomePrompt = prompt.OutcomePrompt as unknown as ComponentType<Record<string, unknown>>;
  OutcomeSummaryView = panel.OutcomeSummaryView as unknown as ComponentType<Record<string, unknown>>;
});

const TODAY = "2027-04-20";
const CYCLE_ID = "0193a1b2-0000-7000-8000-000000000001";
const ITEM: TrackerItem = {
  id: "0193a1b2-0000-7000-8000-0000000000aa",
  programCycleId: CYCLE_ID,
  programSlug: "sample-summer-research-fellowship",
  cycleKey: "summer-2027",
  status: "decided",
  statusSource: "student",
  ownCampusDeadline: null,
  submittedOn: "2027-01-20",
  nameInMessages: true,
  createdAt: "2026-11-11T00:00:00.000Z",
  updatedAt: "2027-04-01T00:00:00.000Z",
  version: 3,
};
const FLAGS = { sensitiveAudience: false, nominationRequired: false };
const WINDOW = { decisionWindowStart: "2027-03-20", decisionWindowEnd: "2027-04-01" };

function render(node: React.ReactElement): string {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(createElement(QueryClientProvider, { client }, node));
}

describe("outcomePromptState", () => {
  it("never asks about status-defined programs", () => {
    expect(outcomePromptState({ item: ITEM, flags: { ...FLAGS, sensitiveAudience: true }, today: TODAY })).toEqual({ mode: "hidden", reason: "sensitive_program" });
    expect(
      outcomePromptState({ item: ITEM, flags: { ...FLAGS, sensitiveAudience: true }, existing: { decidedOn: "2027-04-01" }, today: TODAY }).mode,
    ).toBe("hidden");
  });

  it("opens at the decision step, or 3 days after the expected decision while submitted", () => {
    expect(outcomePromptState({ item: ITEM, flags: FLAGS, today: TODAY })).toEqual({ mode: "ask", reason: "decided" });
    const submitted = { ...ITEM, status: "submitted" as const };
    expect(outcomePromptState({ item: submitted, flags: FLAGS, window: WINDOW, today: "2027-04-03" }).mode).toBe("hidden");
    expect(outcomePromptState({ item: submitted, flags: FLAGS, window: WINDOW, today: "2027-04-04" }).mode).toBe("ask");
    expect(outcomePromptState({ item: submitted, flags: FLAGS, window: null, today: "2030-01-01" }).mode).toBe("hidden");
    expect(outcomePromptState({ item: { ...ITEM, status: "applying" }, flags: FLAGS, today: TODAY }).mode).toBe("hidden");
  });

  it("offers edits for 60 days after the decision, then locks", () => {
    expect(outcomePromptState({ item: ITEM, flags: FLAGS, existing: { decidedOn: "2027-03-01" }, today: "2027-04-30" }).mode).toBe("edit");
    expect(outcomePromptState({ item: ITEM, flags: FLAGS, existing: { decidedOn: "2027-03-01" }, today: "2027-05-01" }).mode).toBe("locked");
  });
});

describe("form to request body", () => {
  const filled = (patch: Partial<OutcomeFormState>): OutcomeFormState => ({ ...initialFormState(ITEM), ...patch });

  it("builds a strict create body with stages in order and no sensitive keys", () => {
    const body = toCreateBody(filled({ campus: "nominated", interview: "interviewed", interviewOn: "2027-03-02", result: "admitted_declined", decidedOn: "2027-04-01" }), CYCLE_ID);
    expect(OutcomeReportCreateSchema.safeParse(body).success).toBe(true);
    expect(body.stages.map((s) => s.stage)).toEqual(["submitted", "campus_nominated", "interview_invited", "interviewed"]);
    expect(body).toMatchObject({ decision: "declined_offer", decidedOn: "2027-04-01" });
    expect(findSensitiveKeys(body)).toEqual([]);
  });

  it("sends no decision while waiting and drops a stray date", () => {
    expect(formToFacts(filled({ result: "waiting", decidedOn: "2027-04-01" }))).toMatchObject({ decision: null, decidedOn: null });
  });

  it("checks the same rules as the server and points errors at fields", () => {
    const state = filled({ interview: "invited", interviewOn: "2027-01-01", result: "admitted", decidedOn: "" });
    const issues = formIssues(state, TODAY);
    expect(issues.map((i) => fieldForPath(i.path, state)).sort()).toEqual(["decidedOn", "interviewOn"]);
    expect(formIssues(filled({ result: "not_selected", decidedOn: "2027-04-01" }), TODAY)).toEqual([]);
  });

  it("round-trips an existing report into the form", () => {
    const existing: OutcomeReport = sampleReport(toCreateBody(filled({ waitlisted: true, result: "not_selected", decidedOn: "2027-04-02" }), CYCLE_ID), "2027-04-03T00:00:00.000Z");
    const state = initialFormState(ITEM, existing);
    expect(state).toMatchObject({ waitlisted: true, result: "not_selected", decidedOn: "2027-04-02", submittedOn: "2027-01-20" });
    expect(existing.tier).toBe("self_reported");
  });
});

describe("components render", () => {
  it("renders the form with labelled fields and the privacy note", () => {
    const html = render(createElement(OutcomeForm, { item: ITEM, card: { name: "Sample", isSample: true, flags: { ...FLAGS, nominationRequired: true } }, existing: null, today: TODAY }));
    expect(html).toContain("When did you apply?");
    expect(html).toContain("Campus nomination");
    expect(html).toContain("never ask for names, scores or private answers");
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\d+\s*%/);
  });

  it("renders nothing for status-defined programs", () => {
    const html = render(createElement(OutcomePrompt, { item: ITEM, card: { name: "Sample", isSample: true, flags: { ...FLAGS, sensitiveAudience: true } }, today: TODAY }));
    expect(html).toBe("");
  });

  it("shows released labels only, and 'Official base rate only' until bands pass", () => {
    const summary: OutcomeSummary = {
      programSlug: "sample-summer-research-fellowship",
      audience: "public",
      asOf: TODAY,
      countedTiers: ["institution_email"],
      cycles: [
        {
          cycleKey: "summer-2027",
          held: false,
          reports: { period: "summer-2027", suppressed: false, total: "25", cells: [] },
          decisions: { period: "summer-2027", suppressed: false, total: "25", cells: [{ key: "accepted", label: "fewer than 10" }, { key: "rejected", label: "15" }] },
          furthestStage: { period: "summer-2027", suppressed: true, reason: "single_category" },
          timeline: [],
        },
        { cycleKey: "summer-2026", held: true, reports: { period: "summer-2026", suppressed: true, reason: "held" }, decisions: { period: "summer-2026", suppressed: true, reason: "held" }, furthestStage: { period: "summer-2026", suppressed: true, reason: "held" }, timeline: [] },
      ],
      bands: { status: "official_base_rate_only", note: OFFICIAL_BASE_RATE_ONLY_NOTE },
      isSample: true,
    };
    const html = render(createElement(OutcomeSummaryView, { summary }));
    expect(html).toContain("Official base rate only.");
    expect(html.match(/Official base rate only/g)).toHaveLength(1);
    expect(html).toContain("fewer than 10");
    expect(html).toContain("Sample data");
    expect(html).toContain("paused while Novus checks them");
    // Visible text only (style attributes carry "100%").
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/\d+\s*%|chance|match score/i);
  });
});

describe("outcome prompt inputs", () => {
  it("asks nothing while the program card is unknown (it might be status-defined)", () => {
    expect(outcomePromptState({ item: ITEM, flags: null, today: TODAY })).toEqual({ mode: "hidden", reason: "unknown_program" });
    expect(outcomePromptState({ item: ITEM, today: TODAY }).mode).toBe("hidden");
  });

  it("takes the decision window only from the tracked cycle", () => {
    const cycle = { id: "cyc_1", decisionWindowStart: "2027-03-15", decisionWindowEnd: "2027-04-01" };
    expect(decisionWindowFor(cycle, "cyc_1")).toEqual({ decisionWindowStart: "2027-03-15", decisionWindowEnd: "2027-04-01" });
    expect(decisionWindowFor(cycle, "cyc_2")).toBeNull();
    expect(decisionWindowFor(null, "cyc_1")).toBeNull();
    // With the window, a submitted card asks 3 days after the expected decision date.
    const submitted = { ...ITEM, status: "submitted" as const };
    const window = decisionWindowFor(cycle, "cyc_1");
    expect(outcomePromptState({ item: submitted, flags: FLAGS, window, today: "2027-04-03" }).mode).toBe("hidden");
    expect(outcomePromptState({ item: submitted, flags: FLAGS, window, today: "2027-04-04" }).mode).toBe("ask");
  });
});
