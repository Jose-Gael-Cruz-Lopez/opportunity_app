import { describe, expect, it } from "vitest";
import {
  AskResponseSchema,
  ReadinessExplainResponseSchema,
  StatementFeedbackResponseSchema,
  type ReadinessExplainModelOutput,
} from "@shared/contracts";
import { createAi, createMockProvider, MemoryLedger, type AiOptions, type MockStep } from "./index";
import type { FetchLike } from "./gemini";
import type { AiLogFields } from "./types";
import readinessOk from "./fixtures/recorded/interactions-readiness-ok.json";
import { ADULT_VIEWER, MINOR_VIEWER, SAMPLE_PROFILE, SAMPLE_PROGRAM_SOURCES, SAMPLE_REPORT } from "./fixtures/sample";

const NOW = Date.parse("2026-11-11T16:00:00Z");
const clock = { now: () => NOW };

function setup(steps: MockStep[], extra: Partial<AiOptions> = {}) {
  const provider = createMockProvider(steps);
  const logs: { event: string; fields: AiLogFields }[] = [];
  const ledger = new MemoryLedger();
  const ai = createAi(
    { GEMINI_API_KEY: "placeholder" },
    { provider, ledger, clock, nonce: () => "n0nce0000000000000000000", log: (event, fields) => logs.push({ event, fields }), ...extra },
  );
  return { ai, provider, logs, ledger };
}

const goodReadiness: ReadinessExplainModelOutput = {
  summary: "You meet the class-year rule. Your main open item is two recommendation letters.",
  points: [
    { part: "eligibility", text: "The program is open to first- and second-year students.", sourceIds: ["s1"] },
    { part: "requirements", text: "You still need two recommendation letters.", sourceIds: ["s1", "s2", "s9"] },
    { part: "competitiveness", text: "There is no band because counts are not published.", sourceIds: ["s99"] },
  ],
  suggestions: [{ text: "Ask two faculty members this month.", nextActionId: "act.recommenders", sourceIds: [] }],
  caveats: [],
};

const readinessArgs = {
  viewer: ADULT_VIEWER,
  report: SAMPLE_REPORT,
  profile: SAMPLE_PROFILE,
  request: { focus: "overview" as const, question: null },
  programSources: SAMPLE_PROGRAM_SOURCES,
  programName: "Sample Summer Research Program",
};

describe("createAi without a key", () => {
  it("returns the deterministic report explanation with status unavailable", async () => {
    const ai = createAi({}, { clock, log: () => {} });
    expect(ai.available).toBe(false);
    expect(ai.model).toBeNull();
    const res = await ai.explainReadiness(readinessArgs);
    expect(ReadinessExplainResponseSchema.safeParse(res).success).toBe(true);
    expect(res.meta).toMatchObject({ status: "unavailable", degradedReason: "no_api_key", fallback: true, provider: "none" });
    expect(res.points.map((p) => p.part)).toEqual(["eligibility", "requirements", "competitiveness", "next_actions"]);
    expect(res.suggestions[0]?.nextActionId).toBe("act.recommenders");
  });

  it("honours the kill switch even with a key", async () => {
    const { provider } = setup([]);
    const ai = createAi({ GEMINI_API_KEY: "placeholder", AI_DISABLED: "true" }, { provider, clock, log: () => {} });
    const res = await ai.ask({ viewer: ADULT_VIEWER, request: { question: "When does it close?", programSlug: null }, sources: SAMPLE_PROGRAM_SOURCES, programRefs: [] });
    expect(res.meta.degradedReason).toBe("disabled");
    expect(provider.calls).toHaveLength(0);
  });

  it("ignores a GEMINI_MODEL outside the allowlist", () => {
    const ai = createAi({ GEMINI_API_KEY: "placeholder", GEMINI_MODEL: "gemini-2.5-flash" }, { clock, log: () => {} });
    expect(ai.model).toBe("gemini-3.5-flash-lite");
  });
});

describe("age gate", () => {
  it("exposes minAge 18 and never calls the model for a minor", async () => {
    const { ai, provider } = setup([{ json: goodReadiness }]);
    expect(ai.minAge).toBe(18);
    expect(ai.checkAccess(MINOR_VIEWER)).toEqual({ allowed: false, reason: "under_min_age" });
    const res = await ai.explainReadiness({ ...readinessArgs, viewer: MINOR_VIEWER });
    expect(res.meta).toMatchObject({ status: "unavailable", degradedReason: "disabled", fallback: true });
    expect(provider.calls).toHaveLength(0);
  });
});

describe("readiness explanation", () => {
  it("maps valid output, drops unknown source ids and points that cite nothing", async () => {
    const { ai, provider, ledger } = setup([{ json: goodReadiness }]);
    const res = await ai.explainReadiness(readinessArgs);
    expect(res.meta).toMatchObject({ status: "ok", degradedReason: null, fallback: false, provider: "gemini" });
    expect(res.points).toHaveLength(2); // the s99-only point is dropped
    expect(res.points[1]?.sourceIds).toEqual(["s1", "s2"]);
    expect(res.citations.map((c) => c.sourceId)).toEqual(["s1", "s2"]);
    expect(res.citations[1]?.url).toBe("https://example.org/sample-program/apply");
    expect(res.suggestions[0]).toMatchObject({ nextActionId: "act.recommenders", sourceIds: ["s1"] });
    expect(provider.calls).toHaveLength(1);
    expect(ledger.entries).toHaveLength(1);
  });

  it("keeps sensitive answers, excluded profile fields and the nonce boundary in order", async () => {
    const { ai, provider } = setup([{ json: goodReadiness }]);
    await ai.explainReadiness({ ...readinessArgs, request: { focus: "requirements", question: "What should I do first? email me at me@example.org" } });
    const sent = provider.calls[0];
    expect(sent).toBeDefined();
    const text = `${sent?.systemInstruction}\n${sent?.input}`;
    for (const leaked of ["SECRET-SENSITIVE", "11111111-2222", "2006-05", "LGBTQ", "3_5_to_3_74", "me@example.org", "residenceState", "CA\n"]) {
      expect(text).not.toContain(leaked);
    }
    expect(text).toContain("<<<BEGIN SOURCE s1 n0nce0000000000000000000>>>");
    // Prefix-stable layout: sources come before the student's own data and question.
    expect(sent!.input.indexOf("SOURCES")).toBeLessThan(sent!.input.indexOf("STUDENT"));
  });

  it("repairs once when the model states a chance, then succeeds", async () => {
    const bad = { ...goodReadiness, summary: "You have a 70% chance of being accepted." };
    const { ai, provider, logs } = setup([{ json: bad }, { json: goodReadiness }]);
    const res = await ai.explainReadiness(readinessArgs);
    expect(res.meta.status).toBe("ok");
    expect(provider.calls).toHaveLength(2);
    expect(provider.calls[1]?.input).toContain("YOUR PREVIOUS ANSWER WAS REJECTED");
    expect(logs.some((l) => l.event === "ai.output_rejected")).toBe(true);
  });

  it("falls back after a failed repair", async () => {
    const { ai } = setup([{ text: "not json" }, { json: { summary: "x" } }]);
    const res = await ai.explainReadiness(readinessArgs);
    expect(res.meta).toMatchObject({ status: "degraded", degradedReason: "validation_failed", fallback: true });
    expect(ReadinessExplainResponseSchema.safeParse(res).success).toBe(true);
  });

  it("rejects a date that no source states", async () => {
    const bad = { ...goodReadiness, summary: "Apply by March 3 to be safe." };
    const { ai } = setup([{ json: bad }, { json: bad }]);
    const res = await ai.explainReadiness(readinessArgs);
    expect(res.meta.degradedReason).toBe("validation_failed");
  });

  it("degrades on provider errors with the matching reason", async () => {
    for (const [kind, reason] of [
      ["rate_limited", "rate_limited"],
      ["quota_exceeded", "rate_limited"],
      ["timeout", "timeout"],
      ["safety_blocked", "safety_blocked"],
      ["server_error", "provider_error"],
    ] as const) {
      const { ai } = setup([{ error: kind }]);
      const res = await ai.explainReadiness(readinessArgs);
      expect(res.meta).toMatchObject({ status: "degraded", degradedReason: reason, fallback: true });
    }
  });
});

describe("caps", () => {
  it("enforces the per-user daily cap", async () => {
    const { ai, provider } = setup([{ json: goodReadiness }, { json: goodReadiness }], {
      routes: { "readiness.explain": { dailyPerUser: 1 } },
    });
    expect((await ai.explainReadiness(readinessArgs)).meta.status).toBe("ok");
    const second = await ai.explainReadiness(readinessArgs);
    expect(second.meta.degradedReason).toBe("rate_limited");
    expect(provider.calls).toHaveLength(1);
  });

  it("enforces the monthly route cap before calling", async () => {
    const { ai, provider } = setup([{ json: goodReadiness }], { routes: { "readiness.explain": { monthlyCapMicros: 10 } } });
    const res = await ai.explainReadiness(readinessArgs);
    expect(res.meta.degradedReason).toBe("budget_exceeded");
    expect(provider.calls).toHaveLength(0);
  });
});

describe("statement feedback", () => {
  const statement =
    "I am a DACA recipient and my email is me@example.org. In my lab course I designed a protocol to measure enzyme activity, " +
    "and I want to keep doing research on marine ecosystems this summer with a mentor who can guide me.";

  it("redacts before the prompt, drops non-verbatim excerpts and reports the redaction", async () => {
    const { ai, provider } = setup([
      {
        json: {
          overall: "Clear motivation; add one concrete result from your lab work.",
          strengths: [{ aspect: "specificity", comment: "Names a concrete protocol.", excerpt: "designed a protocol to measure enzyme activity" }],
          improvements: [
            { aspect: "evidence_of_impact", comment: "Say what you found.", excerpt: "an invented sentence", suggestion: "Add the result in one sentence." },
          ],
          promptCoverage: [],
          sourceIds: ["s1"],
        },
      },
    ]);
    const res = await ai.statementFeedback({
      viewer: ADULT_VIEWER,
      request: { programCycleId: null, essayPrompt: null, statement, wordLimit: 20, focus: [] },
      programSources: SAMPLE_PROGRAM_SOURCES,
    });
    expect(StatementFeedbackResponseSchema.safeParse(res).success).toBe(true);
    expect(res.redactionApplied).toBe(true);
    expect(res.overLimit).toBe(true);
    expect(res.strengths[0]?.excerpt).toBe("designed a protocol to measure enzyme activity");
    expect(res.improvements[0]?.excerpt).toBeNull();
    const sent = provider.calls[0]?.input ?? "";
    expect(sent).not.toContain("DACA");
    expect(sent).not.toContain("me@example.org");
  });

  it("never returns a grade: a graded answer is repaired, then falls back", async () => {
    const graded = {
      overall: "I would give this a B+ overall.",
      strengths: [],
      improvements: [{ aspect: "clarity", comment: "Tighten.", excerpt: "", suggestion: "Cut words." }],
      promptCoverage: [],
      sourceIds: [],
    };
    const { ai, logs } = setup([{ json: graded }, { json: graded }]);
    const res = await ai.statementFeedback({
      viewer: ADULT_VIEWER,
      request: { programCycleId: null, essayPrompt: null, statement, wordLimit: null, focus: [] },
      programSources: [],
    });
    expect(res.meta).toMatchObject({ status: "degraded", degradedReason: "validation_failed" });
    expect(res.overall).not.toContain("B+");
    expect(JSON.stringify(logs)).not.toContain("enzyme");
  });
});

describe("ask", () => {
  it("declines a status-eligibility question without calling the model", async () => {
    const { ai, provider } = setup([]);
    const res = await ai.ask({
      viewer: ADULT_VIEWER,
      request: { question: "Can I apply if I am undocumented?", programSlug: null },
      sources: SAMPLE_PROGRAM_SOURCES,
      programRefs: [],
    });
    expect(res.answerType).toBe("declined_sensitive");
    expect(provider.calls).toHaveLength(0);
    expect(AskResponseSchema.safeParse(res).success).toBe(true);
  });

  it("answers with citations to supplied sources only", async () => {
    const { ai } = setup([
      { json: { answer: "Applications close February 1, 2027.", answerType: "answered", sourceIds: ["s1", "s7"], followUps: ["What letters are needed?"] } },
    ]);
    const res = await ai.ask({
      viewer: ADULT_VIEWER,
      request: { question: "When do applications close?", programSlug: "sample-summer-research-program" },
      sources: SAMPLE_PROGRAM_SOURCES,
      programRefs: [{ slug: "sample-summer-research-program", name: "Sample Summer Research Program" }],
    });
    expect(res.meta.status).toBe("ok");
    expect(res.citations.map((c) => c.sourceId)).toEqual(["s1"]);
  });

  it("falls back to listing the retrieved records when citations fail twice", async () => {
    const uncited = { answer: "It closes soon.", answerType: "answered", sourceIds: ["s9"], followUps: [] };
    const { ai } = setup([{ json: uncited }, { json: uncited }]);
    const res = await ai.ask({ viewer: ADULT_VIEWER, request: { question: "When does it close?", programSlug: null }, sources: SAMPLE_PROGRAM_SOURCES, programRefs: [] });
    expect(res.meta.degradedReason).toBe("citation_check_failed");
    expect(res.answerType).toBe("partial");
    expect(res.citations).toHaveLength(1);
  });
});

describe("requirements extraction", () => {
  it("flags quotes that are not on the page and strips links", async () => {
    const { ai } = setup([
      {
        json: {
          page_kind: "current_cycle",
          requirements: [
            { kind: "resume", detail: "A resume", quote: "Submit a resume" },
            { kind: "recommendation", detail: "Two letters, see https://example.org/x", quote: "three letters from anyone" },
          ],
        },
      },
    ]);
    const res = await ai.extractRequirements({
      pageText: SAMPLE_PROGRAM_SOURCES[0]!.text,
      pageUrl: "https://example.org/sample-program/apply",
      programName: "Sample Summer Research Program",
      fetchedOn: "2026-11-01",
    });
    expect(res.pageKind).toBe("current_cycle");
    expect(res.requirements[0]).toMatchObject({ quoteOnPage: true, flags: [] });
    expect(res.requirements[1]?.flags).toEqual(expect.arrayContaining(["QUOTE_NOT_ON_PAGE", "DETAIL_HAD_LINK_OR_MARKUP"]));
    expect(res.requirements[1]?.detail).not.toContain("https://");
  });
});

describe("end to end over the Gemini transport (fake fetch, recorded-shape fixture)", () => {
  it("sends store:false with the key header and returns a validated explanation", async () => {
    const bodies: Record<string, unknown>[] = [];
    const headers: Record<string, string>[] = [];
    const fakeFetch: FetchLike = async (_url, init) => {
      bodies.push(JSON.parse(init.body) as Record<string, unknown>);
      headers.push(init.headers);
      return new Response(JSON.stringify(readinessOk), { status: 200 });
    };
    const ledger = new MemoryLedger();
    const ai = createAi(
      { GEMINI_API_KEY: "PLACEHOLDER_NOT_A_KEY" },
      { fetch: fakeFetch, clock, ledger, log: () => {}, sleep: async () => {}, random: () => 0.5 },
    );
    const res = await ai.explainReadiness(readinessArgs);
    expect(res.meta).toMatchObject({ status: "ok", model: "gemini-3.5-flash-lite", provider: "gemini" });
    expect(bodies[0]?.store).toBe(false);
    expect(headers[0]?.["x-goog-api-key"]).toBe("PLACEHOLDER_NOT_A_KEY");
    // 1820 in * 0.30 + (160 + 40) out * 2.50 = 546 + 500 micro-USD
    expect(ledger.entries[0]?.costMicros).toBe(1046);
  });
});
