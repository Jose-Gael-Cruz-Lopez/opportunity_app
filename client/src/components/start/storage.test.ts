import { describe, expect, it } from "vitest";
import {
  DRAFT_KEY,
  STORAGE_KEY,
  clearDraft,
  clearProgress,
  draftFileName,
  loadDraft,
  saveDraft,
  emptyProgress,
  loadProgress,
  parseProgress,
  sanitizeAnswers,
  saveProgress,
  serializeProgress,
  type KeyValueStore,
  type SavedProgress,
} from "./storage";

const NOW = new Date("2026-11-11T15:00:00Z");

function memoryStore(): KeyValueStore & { data: Map<string, string> } {
  const data = new Map<string, string>();
  return {
    data,
    getItem: (k) => data.get(k) ?? null,
    setItem: (k, v) => void data.set(k, v),
    removeItem: (k) => void data.delete(k),
  };
}

function progress(patch: Partial<SavedProgress> = {}): SavedProgress {
  return { ...emptyProgress(NOW), ...patch };
}

describe("sanitizeAnswers", () => {
  it("keeps plain answers and skips (null)", () => {
    expect(sanitizeAnswers({ looking_for: ["internships"], class_year: "first_year", pay: null })).toEqual({
      looking_for: ["internships"],
      class_year: "first_year",
      pay: null,
    });
  });

  it("drops question ids that look sensitive, even if a caller passes them", () => {
    const out = sanitizeAnswers({ citizenship: "us_citizen", firstGen: "yes", pellStatus: "recipient", genderIdentity: "x", major: "computing" });
    expect(out).toEqual({ major: "computing" });
  });

  it("drops ids the quiz marked private", () => {
    expect(sanitizeAnswers({ o2_private: "x", q1: "a" }, new Set(["o2_private"]))).toEqual({ q1: "a" });
  });

  it("drops values that are objects, long strings or odd ids", () => {
    const out = sanitizeAnswers({ q1: { nested: true }, q2: "x".repeat(201), "bad id!": "a", q3: [1, 2], q4: 3 });
    expect(out).toEqual({ q4: 3 });
  });
});

describe("serialize and parse", () => {
  it("round-trips a valid progress object", () => {
    const p = progress({
      stage: "door",
      quizAnswers: { q1: "a", q2: ["x", "y"] },
      quizOrder: ["q1", "q2"],
      resumeSource: "pdf",
      chosenProgramId: "5a3e0001-0000-4000-8000-000001000000",
      doneStepIds: ["save"],
      filters: { tiers: ["strong"], paidOnly: true, remoteOnly: false, types: ["internships"] },
      reminder: { date: "2026-11-12", time: "17:00", place: "library" },
    });
    expect(parseProgress(serializeProgress(p))).toEqual(p);
  });

  it("never writes resume text or private answers, whatever the object holds", () => {
    const dirty = { ...progress(), resumeText: "Jane Doe jane@example.com", privateAnswers: { citizenship: "f1" } } as unknown as SavedProgress;
    const raw = serializeProgress(dirty);
    expect(raw).not.toContain("jane");
    expect(raw).not.toContain("citizenship");
    expect(raw).not.toContain("f1");
  });

  it("keeps only order entries that still have answers", () => {
    const raw = serializeProgress(progress({ quizAnswers: { q1: "a" }, quizOrder: ["q1", "private_q", "q9"] }));
    expect(JSON.parse(raw).quizOrder).toEqual(["q1"]);
  });

  it("rejects junk, other versions and unknown stages", () => {
    expect(parseProgress(null)).toBeNull();
    expect(parseProgress("{not json")).toBeNull();
    expect(parseProgress(JSON.stringify({ v: 2, stage: "quiz" }))).toBeNull();
    expect(parseProgress(JSON.stringify({ v: 1, stage: "admin" }))).toBeNull();
  });

  it("repairs bad fields instead of failing", () => {
    const p = parseProgress(JSON.stringify({ v: 1, stage: "quiz", resumeSource: "fax", reminder: { date: "tomorrow", time: "5pm" }, filters: "x" }));
    expect(p?.resumeSource).toBeNull();
    expect(p?.reminder).toBeNull();
    expect(p?.filters).toEqual({ tiers: [], paidOnly: false, remoteOnly: false, types: [] });
  });
});

describe("store wrappers", () => {
  it("saves, loads and clears under one key", () => {
    const store = memoryStore();
    expect(saveProgress(store, progress({ stage: "resume" }))).toBe(true);
    expect(store.data.has(STORAGE_KEY)).toBe(true);
    expect(loadProgress(store)?.stage).toBe("resume");
    clearProgress(store);
    expect(loadProgress(store)).toBeNull();
  });

  it("fails soft when storage throws or is missing", () => {
    const throwing: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("quota");
      },
      removeItem: () => {
        throw new Error("blocked");
      },
    };
    expect(saveProgress(throwing, progress())).toBe(false);
    expect(loadProgress(throwing)).toBeNull();
    expect(() => clearProgress(throwing)).not.toThrow();
    expect(saveProgress(null, progress())).toBe(false);
    expect(loadProgress(null)).toBeNull();
  });
});

describe("opt-in draft on this device", () => {
  it("keeps the draft under its own key, never in the autosave, and forgets it with everything else", () => {
    const store = memoryStore();
    saveProgress(store, progress({ stage: "door" }));
    expect(saveDraft(store, { programId: "p1", text: "I want to build tools for my town." })).toBe(true);
    expect(store.data.get(STORAGE_KEY)).not.toContain("build tools");
    expect(loadDraft(store)).toEqual({ programId: "p1", text: "I want to build tools for my town." });
    clearDraft(store);
    expect(loadDraft(store)).toBeNull();
    saveDraft(store, { programId: "p1", text: "x" });
    clearProgress(store);
    expect(store.data.has(DRAFT_KEY)).toBe(false);
  });

  it("rejects malformed values and caps the length", () => {
    const store = memoryStore();
    store.setItem(DRAFT_KEY, "{bad json");
    expect(loadDraft(store)).toBeNull();
    store.setItem(DRAFT_KEY, JSON.stringify({ programId: 3, text: "x" }));
    expect(loadDraft(store)).toBeNull();
    saveDraft(store, { programId: "p", text: "a".repeat(5000) });
    expect(loadDraft(store)?.text.length).toBe(800);
    expect(loadDraft(null)).toBeNull();
  });

  it("names the download after the program only", () => {
    expect(draftFileName("Sample: Civic Data Internship (2027)")).toBe("sample-civic-data-internship-2027-why-this-program.txt");
    expect(draftFileName("***")).toBe("application-why-this-program.txt");
  });
});
