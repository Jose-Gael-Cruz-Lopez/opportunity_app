import { describe, expect, it } from "vitest";
import { AskRequestSchema, AskResponseSchema, type AiCitation, type AiMeta } from "@shared/contracts";
import { sampleAskResponse } from "./fixtures";
import {
  assistantState,
  checkQuestion,
  citationNumbers,
  degradedMessage,
  personalDisclosure,
  programFromSearch,
  splitAnswer,
  suggestions,
} from "./model";

const meta = (over: Partial<AiMeta> = {}): AiMeta => ({
  provider: "gemini",
  model: "example-model",
  promptVersion: "ask-v1",
  status: "ok",
  degradedReason: null,
  generatedAt: "2026-11-11T12:00:00Z",
  fallback: false,
  ...over,
});

const cite = (id: string): AiCitation => ({ sourceId: id, kind: "novus_record", title: id, url: null, quote: null });

describe("suggestions", () => {
  it("offers four questions, the first with a date three weeks out", () => {
    const s = suggestions("2026-11-11");
    expect(s).toHaveLength(4);
    expect(s[0]?.question).toBe("What can I apply to before 2 Dec?");
    for (const t of s) expect(AskRequestSchema.safeParse({ question: t.question }).success).toBe(true);
  });
});

describe("personal disclosure", () => {
  it("stops first-person statements of a sensitive status", () => {
    expect(personalDisclosure("I'm a DACA recipient, can I apply?")).toBe("citizenship or immigration status");
    expect(personalDisclosure("My family's income is low. What scholarships fit?")).toBe("income or financial aid status");
    expect(personalDisclosure("I am first-gen, which programs help?")).toBe("first-generation status");
    expect(personalDisclosure("As a Latina in CS, what should I apply to?")).toBe("race or ethnicity");
    expect(personalDisclosure("I have ADHD, will that matter?")).toBe("disability or health");
  });

  it("lets questions about a program's own rules through", () => {
    expect(personalDisclosure("Does the program require US citizenship?")).toBeNull();
    expect(personalDisclosure("Which programs accept permanent residents?")).toBeNull();
    expect(personalDisclosure("Is the stipend counted as income?")).toBeNull();
    // First person in one sentence, the topic in another: allowed.
    expect(personalDisclosure("I'm a sophomore. Is citizenship required?")).toBeNull();
  });
});

describe("checkQuestion", () => {
  it("normalises whitespace and enforces length", () => {
    expect(checkQuestion("  what   is open?  ")).toEqual({ ok: true, question: "what is open?" });
    expect(checkQuestion(" a ")).toMatchObject({ ok: false, reason: "too_short" });
    expect(checkQuestion("x".repeat(1001))).toMatchObject({ ok: false, reason: "too_long" });
    expect(checkQuestion("I'm undocumented, what can I do?")).toMatchObject({ ok: false, reason: "personal_status" });
  });
});

describe("assistant state", () => {
  it("separates the device switch, a server without a key and a one-off failure", () => {
    expect(assistantState(false, meta())).toBe("off_by_you");
    expect(assistantState(true, null)).toBe("unknown");
    expect(assistantState(true, meta())).toBe("on");
    expect(assistantState(true, meta({ provider: "none", status: "unavailable", degradedReason: "no_api_key", fallback: true }))).toBe("off_on_server");
    expect(assistantState(true, meta({ status: "degraded", degradedReason: "timeout", fallback: true }))).toBe("degraded");
  });

  it("explains degraded answers and says when the text is not AI", () => {
    expect(degradedMessage(meta())).toBeNull();
    expect(degradedMessage(meta({ status: "unavailable", degradedReason: "no_api_key", fallback: true }))).toMatch(/not set up.*plain search/);
    expect(degradedMessage(meta({ status: "degraded", degradedReason: "rate_limited", fallback: false }))).toBe(
      "You have reached today's limit for AI answers.",
    );
  });
});

describe("citations in answers", () => {
  it("numbers citations in order and replaces markers", () => {
    const cites = [cite("s3"), cite("s1")];
    expect([...citationNumbers(cites)]).toEqual([
      ["s3", 1],
      ["s1", 2],
    ]);
    expect(splitAnswer("Closes in May [s1]. Paid [s3, s1].", cites)).toEqual([
      { kind: "text", text: "Closes in May " },
      { kind: "cite", sourceId: "s1", number: 2 },
      { kind: "text", text: ". Paid " },
      { kind: "cite", sourceId: "s3", number: 1 },
      { kind: "cite", sourceId: "s1", number: 2 },
      { kind: "text", text: "." },
    ]);
  });

  it("drops markers that point at no citation and keeps plain text intact", () => {
    expect(splitAnswer("Open now [s9].", [cite("s1")])).toEqual([
      { kind: "text", text: "Open now " },
      { kind: "text", text: "." },
    ]);
    expect(splitAnswer("No markers here", [])).toEqual([{ kind: "text", text: "No markers here" }]);
  });
});

describe("program scope", () => {
  it("accepts only slug-shaped program params", () => {
    expect(programFromSearch("?program=sample-program")).toBe("sample-program");
    expect(programFromSearch("?program=Bad Slug")).toBeNull();
    expect(programFromSearch("")).toBeNull();
  });
});

describe("sample answers", () => {
  it("match the Ask contract, show the no-key state and cite only example.org", () => {
    for (const q of ["What closes soon?", "How do campus nominations work?"]) {
      const r = sampleAskResponse(q, "2026-11-11T12:00:00Z");
      const parsed = AskResponseSchema.safeParse(r);
      expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
      expect(assistantState(true, r.meta)).toBe("off_on_server");
      for (const c of r.citations) expect(c.url).toMatch(/^https:\/\/example\.org\//);
      for (const p of r.programRefs) expect(p.slug).toMatch(/^sample-/);
    }
  });
});
