import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { FORBIDDEN_STUDENT_SCORE_FIELDS, RecordCitationSchema } from "@shared/contracts";
import { collectPropertyNames } from "@shared/contracts/json-schema";
import { jsonSchemaFor } from "../schema";
import { RULED_CARD, SENSITIVE_CARD, TEST_NOW, TEST_ORIGIN, testRegistry } from "../testing/fixtures";
import { ELIGIBILITY_NOTICE, SENSITIVE_REFUSAL } from "../config";
import { MCP_TOOLS, ToolError, checkEligibilityTool, getProgramTool, listDeadlinesTool, searchProgramsTool, type ToolContext, type ToolDef } from "./index";
import { precheckEligibilityArgs } from "./check-eligibility";

function ctx(): ToolContext {
  return { registry: testRegistry(), origin: TEST_ORIGIN, now: TEST_NOW };
}

/** Parses input like the SDK does, then runs the handler. */
async function call<I extends z.ZodTypeAny, O extends z.ZodTypeAny>(tool: ToolDef<I, O>, args: unknown, c: ToolContext = ctx()) {
  const parsed = tool.input.parse(args);
  const run = await tool.run(parsed, c);
  // Every output must satisfy the declared output schema (the SDK re-checks structuredContent).
  tool.output.parse(run.output);
  return run;
}

function expectCompleteCitation(citation: unknown): void {
  const { citeAs, ...rest } = citation as { citeAs: string };
  expect(RecordCitationSchema.safeParse(rest).success).toBe(true);
  expect(citeAs.length).toBeGreaterThan(10);
}

describe("tool metadata", () => {
  it("lists four tools in a fixed order", () => {
    expect(MCP_TOOLS.map((t) => t.name)).toEqual(["search_programs", "get_program", "list_deadlines", "check_eligibility"]);
  });

  it("rejects unknown input keys (additionalProperties false)", () => {
    for (const tool of MCP_TOOLS) {
      const schema = jsonSchemaFor(tool.input, "input");
      expect(schema.additionalProperties).toBe(false);
    }
  });

  it("has no score, percentage or match field in any output schema", () => {
    for (const tool of MCP_TOOLS) {
      const names = collectPropertyNames(jsonSchemaFor(tool.output, "output"));
      for (const forbidden of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(names).not.toContain(forbidden);
    }
  });

  it("offers no sensitive profile field to assistants", () => {
    const names = collectPropertyNames(jsonSchemaFor(checkEligibilityTool.input, "input"));
    for (const key of ["citizenship", "pell", "firstGeneration", "identity", "veteran", "disability", "institutionId"]) expect(names).not.toContain(key);
  });
});

describe("search_programs", () => {
  it("finds programs by words and cites each one", async () => {
    const run = await call(searchProgramsTool, { query: "coastal ecology" });
    expect(run.output.programs[0]?.slug).toBe("coastal-ecology-reu");
    for (const p of run.output.programs) expectCompleteCitation(p.citation);
    expect(run.output.programs[0]?.citation.novusUrl).toBe(`${TEST_ORIGIN}/programs/coastal-ecology-reu?ref=mcp`);
    expect(run.output.containsSample).toBe(true);
  });

  it("caps a page at 25 and paginates with a cursor", async () => {
    const first = await call(searchProgramsTool, { limit: 25 });
    expect(first.output.programs).toHaveLength(25);
    expect(first.output.nextCursor).not.toBeNull();
    const second = await call(searchProgramsTool, { limit: 25, cursor: first.output.nextCursor });
    const seen = new Set(first.output.programs.map((p) => p.slug));
    expect(second.output.programs.length).toBeGreaterThan(0);
    for (const p of second.output.programs) expect(seen.has(p.slug)).toBe(false);
    expect(() => searchProgramsTool.input.parse({ limit: 26 })).toThrow();
  });

  it("refuses a forged cursor", async () => {
    await expect(call(searchProgramsTool, { cursor: "not-a-cursor" })).rejects.toBeInstanceOf(ToolError);
  });

  it("browses in next-deadline order without a query", async () => {
    const run = await call(searchProgramsTool, { limit: 3 });
    const dates = run.output.programs.map((p) => p.nextDeadline?.localDate ?? "9999");
    expect([...dates].sort()).toEqual(dates);
  });

  it("drops programs whose rules exclude two-year students only when asked", async () => {
    const all = await call(searchProgramsTool, { query: "leadership fellowship", limit: 25 });
    expect(all.output.programs.some((p) => p.slug === RULED_CARD.slug)).toBe(true);
    const cc = await call(searchProgramsTool, { query: "leadership fellowship", limit: 25, open_to_community_college: true });
    expect(cc.output.programs.some((p) => p.slug === RULED_CARD.slug)).toBe(false);
  });

  it("never records sensitive-audience program ids", async () => {
    const run = await call(searchProgramsTool, { query: "pell scholars" });
    expect(run.output.programs.some((p) => p.slug === SENSITIVE_CARD.slug)).toBe(true);
    expect(run.programIds).not.toContain(SENSITIVE_CARD.programId);
  });
});

describe("list_deadlines", () => {
  it("lists national deadlines in time order inside the window", async () => {
    const run = await call(listDeadlinesTool, { within_days: 30, limit: 25 });
    const times = run.output.deadlines.map((d) => Date.parse(d.sortAt ?? ""));
    expect(times.every(Number.isFinite)).toBe(true);
    expect([...times].sort((a, b) => a - b)).toEqual(times);
    expect(times.every((t) => t >= TEST_NOW && t <= TEST_NOW + 30 * 86_400_000)).toBe(true);
    expect(run.output.deadlines.every((d) => d.scope === "national" && d.basis !== "attested")).toBe(true);
    for (const d of run.output.deadlines) expectCompleteCitation(d.citation);
  });

  it("gives applicant-local deadlines no single instant", async () => {
    const run = await call(listDeadlinesTool, { program: RULED_CARD.slug, within_days: 60 });
    const local = run.output.deadlines.find((d) => d.tzMode === "applicant_local");
    expect(local?.dueAt).toBeNull();
    expect(local?.sortAt).not.toBeNull();
    const fixed = run.output.deadlines.find((d) => d.precision === "exact");
    expect(fixed?.dueAt).toMatch(/^2026-12-01T22:00:00/);
  });

  it("labels predicted deadlines and gives them a derivation instead of evidence", async () => {
    const run = await call(listDeadlinesTool, { program: "sample-example-predicted-program", within_days: 60 });
    const d = run.output.deadlines[0];
    expect(d?.label).toBe("predicted, not announced");
    expect(d?.citation.basis).toBe("predicted");
    expect(d?.citation.evidenceUrl).toBeNull();
    expect(d?.citation.derivation?.method).toBe("cycle_prediction");
  });

  it("rejects a window over 120 days", () => {
    expect(() => listDeadlinesTool.input.parse({ within_days: 121 })).toThrow();
  });

  it("never records sensitive-audience program ids", async () => {
    const run = await call(listDeadlinesTool, { within_days: 30, limit: 25 });
    expect(run.output.deadlines.some((d) => d.programSlug === SENSITIVE_CARD.slug)).toBe(true);
    expect(run.programIds).not.toContain(SENSITIVE_CARD.programId);
  });
});

describe("get_program", () => {
  it("returns the program by slug, id or merged slug", async () => {
    for (const ref of ["coastal-ecology-reu", "old-coastal-slug"]) {
      const run = await call(getProgramTool, { program: ref });
      expect(run.output.program.slug).toBe("coastal-ecology-reu");
      expect(run.programIds).toBeNull();
    }
    const byId = await call(getProgramTool, { program: RULED_CARD.programId });
    expect(byId.output.program.slug).toBe(RULED_CARD.slug);
  });

  it("returns eligibility as official text and marks sensitive rules self-check only", async () => {
    const run = await call(getProgramTool, { program: RULED_CARD.slug, include: ["eligibility", "predictions"] });
    const rules = run.output.eligibility?.rules ?? [];
    expect(rules.map((r) => r.id)).toEqual(["standing", "four-year", "citizenship"]);
    expect(rules.find((r) => r.id === "citizenship")?.selfCheckOnly).toBe(true);
    expect(run.output.detailAvailable).toBe(false);
    expect(run.output.program.deadlines.every((d) => d.scope === "national")).toBe(true);
  });

  it("answers an unknown program with a not_found ToolError", async () => {
    await expect(call(getProgramTool, { program: "no-such-program" })).rejects.toMatchObject({ status: "not_found" });
  });
});

describe("check_eligibility", () => {
  it("maps statuses to answers and keeps sensitive criteria as self_check", async () => {
    const run = await call(checkEligibilityTool, {
      programs: [RULED_CARD.slug],
      profile: { classYear: "first_year", institutionLevel: "four_year" },
      as_of: "2026-11-11",
    });
    const r = run.output.results[0];
    expect(r?.answer).toBe("self_check");
    expect(r?.selfCheck.some((s) => s.sensitive && /citizens/.test(s.text))).toBe(true);
    expect(r?.result?.rules.find((x) => x.ruleId === "citizenship")?.verdict).toBe("unknown");
    expect(r?.result?.sensitiveEvaluated).toBe(false);
    expect(run.output.notice).toBe(ELIGIBILITY_NOTICE);
  });

  it("answers no when a non-sensitive rule fails", async () => {
    const run = await call(checkEligibilityTool, { programs: [RULED_CARD.slug], profile: { classYear: "first_year", institutionLevel: "two_year" } });
    expect(run.output.results[0]?.answer).toBe("no");
  });

  it("answers not_fully_checked when Novus has no verified rules", async () => {
    const run = await call(checkEligibilityTool, { programs: ["coastal-ecology-reu"], profile: { classYear: "first_year" } });
    expect(run.output.results[0]?.answer).toBe("not_fully_checked");
  });

  it("reports unknown programs without failing the others", async () => {
    const run = await call(checkEligibilityTool, { programs: ["nope", RULED_CARD.slug], profile: {} });
    expect(run.output.results.map((r) => r.found)).toEqual([false, true]);
  });

  it("never records program ids, only how many were checked", async () => {
    const run = await call(checkEligibilityTool, { programs: [RULED_CARD.slug, "coastal-ecology-reu"], profile: {} });
    expect(run.programIds).toBeNull();
    expect(run.resultCount).toBe(2);
  });

  it("refuses sensitive and unknown profile keys with the Novus message, without echoing them", () => {
    for (const profile of [{ citizenship: "us_citizen" }, { pell: "yes" }, { firstGeneration: true }, { favouriteColour: "blue" }]) {
      const message = precheckEligibilityArgs({ programs: [RULED_CARD.slug], profile });
      expect(message?.startsWith(SENSITIVE_REFUSAL)).toBe(true);
      expect(message).not.toContain("us_citizen");
      expect(message).not.toContain("blue");
    }
    expect(precheckEligibilityArgs({ programs: [RULED_CARD.slug], profile: { classYear: "first_year" } })).toBeNull();
  });

  it("caps the request at 10 programs", () => {
    expect(() => checkEligibilityTool.input.parse({ programs: Array.from({ length: 11 }, (_, i) => `p${i}`), profile: {} })).toThrow();
  });
});
