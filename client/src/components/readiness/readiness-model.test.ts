import { describe, expect, it, vi } from "vitest";
import { ProgramDetailSchema, ProgramCardSchema } from "@shared/contracts/registry";
import { FORBIDDEN_STUDENT_SCORE_FIELDS, ReadinessReportSchema } from "@shared/contracts/readiness";
import { ReadinessExplainResponseSchema } from "@shared/contracts/ai";
import { TrackerItemSchema, RequirementProgressUpdateSchema } from "@shared/contracts/student";
import { findSensitiveKeys } from "@shared/contracts/sensitive";
import {
  checklistSideNote,
  effectiveDeadlineLine,
  nextActionLimit,
  orderedRules,
  progressUpdate,
  questionLooksPrivate,
  readyLine,
  severityOn,
  subjectKeyFor,
  toggledState,
  visibleNextActions,
  withOverrides,
} from "./readiness-model";
import { applyPrivateAnswers } from "./private-eligibility";
import { confirmationKey, confirmationsFor, createPrivateAnswersStore } from "./private-answers-store";
import { fallbackExplanation } from "./explain";
import { ApiError, fetchReleaseFile, isApiUnavailable, isProblemStatus, loadWithSample, samplesForced } from "./api-client";
import { ROUTES } from "@shared/contracts/routes";
import { LOOK_STORAGE_KEY, parseLook, readStoredLook, storeLook } from "./look";
import { SAMPLE_CARDS, SAMPLE_PROGRAM_DETAIL, SAMPLE_READINESS, SAMPLE_TRACKER } from "./fixtures";

const items = SAMPLE_READINESS.requirements.items;

describe("fixtures are valid, labelled sample data", () => {
  it("parse against the shared contracts", () => {
    expect(ProgramDetailSchema.safeParse(SAMPLE_PROGRAM_DETAIL).success).toBe(true);
    expect(ReadinessReportSchema.safeParse(SAMPLE_READINESS).success).toBe(true);
    for (const c of SAMPLE_CARDS) expect(ProgramCardSchema.safeParse(c).success).toBe(true);
    for (const t of SAMPLE_TRACKER) expect(TrackerItemSchema.safeParse(t).success).toBe(true);
  });

  it("are marked as sample and point at example.org", () => {
    expect(SAMPLE_PROGRAM_DETAIL.program.isSample).toBe(true);
    expect(SAMPLE_CARDS.every((c) => c.isSample)).toBe(true);
    const text = JSON.stringify([SAMPLE_PROGRAM_DETAIL, SAMPLE_READINESS, SAMPLE_CARDS]);
    for (const url of text.match(/https?:\/\/[^"]+/g) ?? []) expect(url).toMatch(/^https:\/\/example\.org/);
  });

  it("carry no score field and no sensitive key", () => {
    const keys = JSON.stringify(SAMPLE_READINESS);
    for (const f of FORBIDDEN_STUDENT_SCORE_FIELDS) expect(keys).not.toContain(`"${f}":`);
    expect(findSensitiveKeys(SAMPLE_TRACKER)).toEqual([]);
  });
});

describe("checklist", () => {
  it("keys progress by requirement id or reusable kind", () => {
    expect(subjectKeyFor(items[0]!)).toMatch(/^req:[0-9a-f-]{36}$/);
    expect(subjectKeyFor(items[3]!)).toBe("kind:resume");
    const body = progressUpdate(items[0]!, "met");
    expect(RequirementProgressUpdateSchema.safeParse(body).success).toBe(true);
  });

  it("toggles between ready and in progress", () => {
    expect(toggledState("gap")).toBe("met");
    expect(toggledState("unknown")).toBe("met");
    expect(toggledState("met")).toBe("in_progress");
  });

  it("applies on-screen overrides and counts what is ready", () => {
    expect(readyLine(items)).toBe("2 of 4 ready");
    const ticked = withOverrides(items, new Map([[items[0]!.key, "met"]]));
    expect(readyLine(ticked)).toBe("3 of 4 ready");
    expect(ticked[0]?.gap).toBeNull();
    expect(readyLine([...items, { ...items[0]!, key: "x", state: "not_applicable" }])).toBe("2 of 4 ready");
  });

  it("recomputes severity for today and words the side note", () => {
    expect(severityOn("2027-01-05", "2026-11-11")).toBe("planned");
    expect(severityOn("2026-11-20", "2026-11-11")).toBe("soon");
    expect(severityOn("2026-11-01", "2026-11-11")).toBe("late");
    expect(severityOn(null, "2026-11-11")).toBeNull();
    expect(checklistSideNote(items[0]!, "2026-11-11").text).toBe("Planned · by Tue 5 Jan");
    expect(checklistSideNote(items[0]!, "2027-01-10")).toEqual({ text: "Start now · by Tue 5 Jan", severity: "late" });
    expect(checklistSideNote(items[2]!, "2026-11-11").text).toBe("Ready");
  });

  it("explains where start-by dates count from", () => {
    expect(effectiveDeadlineLine(SAMPLE_READINESS)).toBe("Start-by dates count back from application deadline, Thu 28 Jan 2027.");
    const estimated = { ...SAMPLE_READINESS, requirements: { ...SAMPLE_READINESS.requirements, effectiveDeadline: { date: "2026-12-01", basis: "estimated" as const, scope: "campus" as const, label: "Campus deadline" } } };
    expect(effectiveDeadlineLine(estimated)).toMatch(/estimated: confirm with your campus representative/);
  });
});

describe("next actions", () => {
  it("drops the private-check action once the rule is answered on the device, and caps the list", () => {
    const before = visibleNextActions(SAMPLE_READINESS.nextActions, SAMPLE_READINESS.eligibility, 5);
    expect(before.map((a) => a.id)).toContain("answer-citizenship");
    const decided = applyPrivateAnswers(SAMPLE_READINESS.eligibility, SAMPLE_PROGRAM_DETAIL.ruleSet, { citizenship: "us_citizen" });
    const after = visibleNextActions(SAMPLE_READINESS.nextActions, decided, 5);
    expect(after.map((a) => a.id)).not.toContain("answer-citizenship");
    expect(visibleNextActions(SAMPLE_READINESS.nextActions, decided, nextActionLimit("card"))).toHaveLength(3);
    expect(nextActionLimit("detail")).toBe(5);
  });

  it("orders eligibility rows with open and failed rules first", () => {
    expect(orderedRules(SAMPLE_READINESS.eligibility)[0]?.ruleId).toBe("citizenship");
  });
});

describe("assistant safeguards", () => {
  it("flags questions that carry status or identity details", () => {
    expect(questionLooksPrivate("Can I apply on a student visa?")).toBe(true);
    expect(questionLooksPrivate("I am a first generation student, does that help?")).toBe(true);
    expect(questionLooksPrivate("When should I ask for letters?")).toBe(false);
    expect(questionLooksPrivate("How long should the statement be?")).toBe(false);
  });

  it("builds a valid fallback explanation from the report alone", () => {
    const e = fallbackExplanation(SAMPLE_READINESS, "unavailable", new Date("2026-11-11T12:00:00Z"));
    expect(ReadinessExplainResponseSchema.safeParse(e).success).toBe(true);
    expect(e.meta.fallback).toBe(true);
    expect(e.suggestions[0]?.nextActionId).toBe("ask-recommenders");
    expect(JSON.stringify(e)).not.toMatch(/\d+%/);
  });
});

describe("private answers store", () => {
  it("holds answers in memory and clears them after the idle timeout", () => {
    vi.useFakeTimers();
    const store = createPrivateAnswersStore(1000);
    const seen: number[] = [];
    store.subscribe(() => seen.push(1));
    store.setAnswer("citizenship", "us_citizen");
    expect(store.getSnapshot().answers).toEqual({ citizenship: "us_citizen" });
    vi.advanceTimersByTime(900);
    store.setConfirmed(confirmationKey("cycle-a", "standing"), true);
    vi.advanceTimersByTime(900);
    expect(store.getSnapshot().answers.citizenship).toBe("us_citizen");
    vi.advanceTimersByTime(200);
    expect(store.getSnapshot().answers).toEqual({});
    expect(store.getSnapshot().confirmed.size).toBe(0);
    expect(seen.length).toBe(3);
    vi.useRealTimers();
  });

  it("scopes confirmations to one program cycle", () => {
    const all = new Set([confirmationKey("a", "standing"), confirmationKey("b", "gpa")]);
    expect([...confirmationsFor(all, "a")]).toEqual(["standing"]);
  });

  it("never touches Web Storage", () => {
    const store = createPrivateAnswersStore(1000);
    const spy = vi.fn();
    const g = globalThis as { localStorage?: unknown; sessionStorage?: unknown };
    g.localStorage = new Proxy({}, { get: spy });
    g.sessionStorage = new Proxy({}, { get: spy });
    store.setAnswer("pell", "recipient");
    store.clear();
    expect(spy).not.toHaveBeenCalled();
    delete g.localStorage;
    delete g.sessionStorage;
  });
});

describe("api client (adapter over lib/api)", () => {
  it("tells a missing API from a real answer", () => {
    expect(isApiUnavailable(new ApiError("network", "down"))).toBe(true);
    expect(isApiUnavailable(new ApiError("not_api", "html", { status: 404 }))).toBe(true);
    const notFound = new ApiError("problem", "Not found", { status: 404, problem: { type: "about:blank", title: "Not found", status: 404, code: "not_found" } });
    expect(isApiUnavailable(notFound)).toBe(false);
    expect(isProblemStatus(notFound, 404)).toBe(true);
    expect(isProblemStatus(new ApiError("not_api", "html", { status: 404 }), 404)).toBe(false);
    expect(isApiUnavailable(new ApiError("problem", "Sign in", { status: 401 }))).toBe(false);
  });

  it("forces samples only in fixtures mode", () => {
    expect(samplesForced("fixtures")).toBe(true);
    expect(samplesForced("auto")).toBe(false);
    expect(samplesForced("live")).toBe(false);
  });

  it("falls back to the sample only when the mode allows it and the API is missing", async () => {
    const down = () => Promise.reject(new ApiError("network", "down"));
    await expect(loadWithSample(down, () => 1, "auto")).resolves.toEqual({ data: 1, sample: true });
    await expect(loadWithSample(down, () => 1, "live")).rejects.toThrow("down");
    const denied = () => Promise.reject(new ApiError("problem", "no", { status: 403 }));
    await expect(loadWithSample(denied, () => 1, "auto")).rejects.toBeInstanceOf(ApiError);
    await expect(loadWithSample(() => Promise.resolve(2), () => 1, "auto")).resolves.toEqual({ data: 2, sample: false });
    await expect(loadWithSample(() => Promise.resolve(2), () => 1, "fixtures")).resolves.toEqual({ data: 1, sample: true });
  });

  it("reads release files and reports an HTML answer as a missing API", async () => {
    const html = () => Promise.resolve(new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    await expect(fetchReleaseFile(ROUTES.releasePointer, { fetcher: html })).rejects.toMatchObject({ kind: "not_api" });
    const ok = () => Promise.resolve(new Response(JSON.stringify({ hello: 1 }), { status: 200, headers: { "content-type": "application/json" } }));
    await expect(fetchReleaseFile(ROUTES.releasePointer, { fetcher: ok })).resolves.toEqual({ hello: 1 });
  });
});

describe("look", () => {
  it("defaults to Ember and survives storage that throws", () => {
    expect(parseLook("meadow")).toBe("meadow");
    expect(parseLook("anything")).toBe("ember");
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    expect(readStoredLook(throwing)).toBe("ember");
    expect(() => storeLook(throwing, "meadow")).not.toThrow();
    const map = new Map<string, string>();
    const mem = { getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v) };
    storeLook(mem, "meadow");
    expect(map.get(LOOK_STORAGE_KEY)).toBe("meadow");
    expect(readStoredLook(mem)).toBe("meadow");
  });
});
