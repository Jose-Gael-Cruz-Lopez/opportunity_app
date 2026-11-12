import { describe, expect, it } from "vitest";
import { isSensitiveKey } from "../contracts/sensitive";
import { StudentProfileSchema } from "../contracts/student";
import {
  QUIZ,
  QuizAnswerError,
  answerQuiz,
  applyResumeSignals,
  choosePair,
  createQuizState,
  estimateSeconds,
  nextQuestion,
  plannedQuestions,
  preferencesToProfile,
  quizProgress,
  skipQuestion,
  toPreferences,
  toServerPreferences,
  type QuestionId,
  type QuizState,
} from "./quiz";
import { ServerPreferencesSchema, StudentPreferencesSchema } from "./types";

const NOW = "2026-11-11T15:00:00Z";
const fresh = (programs?: { opportunityTypes: string[] }[]): QuizState =>
  createQuizState({ now: NOW, timeZone: "America/New_York", ...(programs ? { programs } : {}) });

/** Answers every question nextQuestion offers with `pick`, returning the ids shown. */
function walk(state: QuizState, pick: (id: QuestionId, s: QuizState) => unknown): { state: QuizState; asked: QuestionId[] } {
  const asked: QuestionId[] = [];
  for (let i = 0; i < 40; i++) {
    const next = nextQuestion(state);
    if (!next) break;
    asked.push(next.question.id);
    const v = pick(next.question.id, state);
    state = v === undefined ? skipQuestion(state, next.question.id) : answerQuiz(state, next.question.id, v as never);
  }
  return { state, asked };
}

describe("QUIZ spec", () => {
  it("has unique ids and 16 definitions, at most 15 of which are asked (two of three pairs)", () => {
    const ids = QUIZ.questions.map((q) => q.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toHaveLength(16);
    expect(QUIZ.maxPairs).toBe(2);
  });

  it("uses every question type the onboarding needs", () => {
    const kinds = new Set(QUIZ.questions.map((q) => q.kind));
    for (const k of ["single", "multi", "slider", "short_text", "this_or_that", "resume"]) expect(kinds.has(k as never)).toBe(true);
  });

  it("asks nothing sensitive: no id, option value or prompt touches a status or identity category", () => {
    const banned = /citizen|immigra|visa|daca|undocumented|income|pell|disab|race|ethnic|gender|sexual|orientation|religio|first[- ]?gen|veteran|military|foster|health condition|pronoun/i;
    for (const q of QUIZ.questions) {
      expect(isSensitiveKey(q.id)).toBe(false);
      expect(banned.test(q.prompt)).toBe(false);
      expect(banned.test(q.help ?? "")).toBe(false);
      for (const o of q.options ?? []) {
        expect(isSensitiveKey(o.value)).toBe(false);
        expect(banned.test(o.label)).toBe(false);
      }
    }
  });

  it("fits the five-minute budget on the longest path, with 12 to 15 questions", () => {
    // Longest path: internships + research (two informative pairs), no resume, goal "specific".
    const { state, asked } = walk(fresh(), (id) => {
      const answers: Partial<Record<QuestionId, unknown>> = {
        looking_for: ["internships", "research"],
        interests: ["software"],
        resume: "none",
        skills: ["python"],
        class_year: "first_year",
        major: "computing",
        pair_style: "build",
        pair_length: "long",
        pair_value: "experience",
        timing: ["next_summer"],
        location: "remote",
        pay: "must",
        weekly_hours: 4,
        experience: ["independent_project"],
        goal: "specific",
        target: "Riverbend",
      };
      return answers[id];
    });
    expect(asked.length).toBeGreaterThanOrEqual(12);
    expect(asked.length).toBeLessThanOrEqual(15);
    expect(estimateSeconds(state, asked)).toBeLessThanOrEqual(QUIZ.budgetSeconds);
  });
});

describe("state machine", () => {
  it("starts with the value-first question and is immutable", () => {
    const s0 = fresh();
    expect(nextQuestion(s0)?.question.id).toBe("looking_for");
    const s1 = answerQuiz(s0, "looking_for", ["internships"]);
    expect(s0.answers).toEqual({});
    expect(s1.answers.looking_for).toEqual(["internships"]);
    expect(nextQuestion(s1)?.question.id).toBe("interests");
  });

  it("validates answers", () => {
    const s = fresh();
    expect(() => answerQuiz(s, "class_year", "fifth_grade")).toThrow(QuizAnswerError);
    expect(() => answerQuiz(s, "looking_for", ["internships", "research", "fellowships", "scholarships"])).toThrow(QuizAnswerError);
    expect(() => answerQuiz(s, "looking_for", "internships")).toThrow(QuizAnswerError);
    expect(() => answerQuiz(s, "weekly_hours", 0)).toThrow(QuizAnswerError);
    expect(() => answerQuiz(s, "weekly_hours", 11)).toThrow(QuizAnswerError);
    expect(answerQuiz(s, "weekly_hours", 3.4).answers.weekly_hours).toBe(3);
  });

  it("lets a real pick override an exclusive option", () => {
    const s = answerQuiz(fresh(), "looking_for", ["not_sure", "research"]);
    expect(s.answers.looking_for).toEqual(["research"]);
    expect(answerQuiz(fresh(), "experience", ["none_yet"]).answers.experience).toEqual(["none_yet"]);
  });

  it("drops a short answer that carries contact details instead of keeping it", () => {
    for (const bad of ["me@school.edu", "call 555 123 4567", "https://x.example/me", "@myhandle", "ID 20391847"]) {
      const s = answerQuiz(answerQuiz(fresh(), "goal", "specific"), "target", bad);
      expect(s.answers.target).toBeUndefined();
      expect(s.skipped).toContain("target");
    }
    const ok = answerQuiz(fresh(), "target", "  Riverbend   City Lab ");
    expect(ok.answers.target).toBe("Riverbend City Lab");
  });

  it("asks the target question only when the goal is specific", () => {
    const base = answerQuiz(fresh(), "goal", "explore");
    expect(plannedQuestions(base)).not.toContain("target");
    expect(plannedQuestions(answerQuiz(base, "goal", "specific"))).toContain("target");
  });

  it("skips timing, location and pay for a scholarships-only student", () => {
    const { asked } = walk(fresh(), (id) => (id === "looking_for" ? ["scholarships"] : undefined));
    expect(asked).not.toContain("timing");
    expect(asked).not.toContain("location");
    expect(asked).not.toContain("pay");
  });

  it("shows endowed progress that ends exactly at the last step", () => {
    const s0 = fresh();
    expect(quizProgress(s0).step).toBe(2);
    const { state } = walk(s0, () => undefined);
    const p = quizProgress(state);
    expect(p.step).toBe(p.of);
  });
});

describe("adaptive pairs", () => {
  it("asks the pair that best splits the candidates", () => {
    const s = answerQuiz(fresh(), "looking_for", ["internships", "research"]);
    // Internships are "build", research is "investigate": an even split.
    expect(choosePair(s)).toBe("pair_style");
  });

  it("skips a pair when the split is worse than 20/80", () => {
    const programs = [
      ...Array.from({ length: 9 }, () => ({ opportunityTypes: ["summer_internship"] })),
      { opportunityTypes: ["research_program"] },
    ];
    const s = answerQuiz(fresh(programs), "looking_for", ["internships", "research"]);
    expect(choosePair(s)).not.toBe("pair_style");
  });

  it("asks at most two pairs and none once the student moves past them", () => {
    const { asked } = walk(fresh(), (id) => {
      if (id === "looking_for") return ["not_sure"];
      if (id.startsWith("pair_")) return "either";
      return undefined;
    });
    expect(asked.filter((id) => id.startsWith("pair_")).length).toBeLessThanOrEqual(2);
  });

  it("asks no pair for a research-only student (every research type sits on one side)", () => {
    const { asked } = walk(fresh(), (id) => (id === "looking_for" ? ["research"] : undefined));
    expect(asked.some((id) => id.startsWith("pair_"))).toBe(false);
  });
});

describe("resume prefill", () => {
  const signals = {
    skills: ["Python", { label: "SQL", confirmed: true }, { label: "Underwater basket weaving" }, { label: "Java", confirmed: false }],
    fields: ["Computing"],
    coursework: ["Intro to Statistics"],
    experienceTypes: ["job", "project"],
    graduationYear: 2030,
  };

  it("turns signals into confirmations, not answers", () => {
    const s = applyResumeSignals(fresh(), signals, "pdf");
    expect(s.answers.resume).toBe("pdf");
    expect(s.prefill.class_year).toBe("first_year");
    expect(s.prefill.major).toBe("computing");
    expect(s.prefill.experience).toEqual(["independent_project", "paid_work"]); // taxonomy order
    expect(s.prefill.skills).toEqual(expect.arrayContaining(["python", "sql", "statistics", "x:underwater basket weaving"]));
    expect(s.prefill.skills).not.toContain("java");
    expect(s.answers.class_year).toBeUndefined();

    const answered = answerQuiz(answerQuiz(s, "looking_for", ["internships"]), "interests", []);
    const next = nextQuestion(answered);
    expect(next?.question.id).toBe("skills");
    expect(next?.mode).toBe("confirm");
    expect(next?.options?.[0]?.hint).toBe("From your resume");
  });

  it("replaces suggestions when a new resume arrives and clears them for 'I don't have one'", () => {
    const first = applyResumeSignals(fresh(), signals, "pdf");
    const second = applyResumeSignals(first, { skills: ["Excel"] }, "paste");
    expect(second.prefill.class_year).toBeUndefined();
    expect(second.prefill.skills).toEqual(["excel"]);
    const none = answerQuiz(first, "resume", "none");
    expect(none.prefill).toEqual({});
    expect(none.signals).toBeNull();
    expect(toPreferences(none).hasResume).toBe(false);
    // The same through applyResumeSignals, whatever signals come along with "none".
    expect(applyResumeSignals(first, signals, "none")).toEqual(none);
  });

  it("builds the pair pool only from programs still on offer", () => {
    const programs = [
      ...Array.from({ length: 5 }, () => ({ opportunityTypes: ["summer_internship"], status: "closed" })),
      { opportunityTypes: ["summer_internship"], status: "open" },
      { opportunityTypes: ["research_program"], status: "open" },
    ];
    const s = answerQuiz(fresh(programs), "looking_for", ["internships", "research"]);
    expect(s.pool).toHaveLength(2);
    expect(choosePair(s)).toBe("pair_style");
    // Expected cycles count only when matching could show them: opening within 30 days.
    const expected = createQuizState({
      now: NOW,
      timeZone: "America/New_York",
      programs: [
        { opportunityTypes: ["research_program"], status: "expected", opensOn: "2026-11-25" },
        { opportunityTypes: ["research_program"], status: "expected", opensOn: "2027-03-01" },
        { opportunityTypes: ["research_program"], status: "expected", opensOn: null, prediction: { p10: "2026-12-01" } },
        { opportunityTypes: ["research_program"], status: "expected", opensOn: null, prediction: null },
      ],
    });
    expect(expected.pool).toHaveLength(2);
  });

  it("accepts a prefilled unlisted skill as an answer", () => {
    const s = applyResumeSignals(fresh(), signals, "pdf");
    expect(answerQuiz(s, "skills", ["x:underwater basket weaving", "python"]).answers.skills).toEqual(["x:underwater basket weaving", "python"]);
  });

  it("keeps unconfirmed resume skills out of skillsConfirmed but available to matching", () => {
    const prefs = toPreferences(applyResumeSignals(fresh(), signals, "pdf"));
    expect(prefs.skillsConfirmed).toBe(false);
    expect(prefs.skills).toContain("python");
    expect(prefs.classYear).toBeNull(); // a suggestion is not an answer
    expect(prefs.hasResume).toBe(true);
  });
});

describe("preferences", () => {
  it("maps answers and validates against the strict schemas", () => {
    let s = fresh();
    s = answerQuiz(s, "looking_for", ["internships", "scholarships"]);
    s = answerQuiz(s, "interests", ["climate"]);
    s = answerQuiz(s, "class_year", "second_year");
    s = answerQuiz(s, "major", "life_sciences");
    s = answerQuiz(s, "pair_style", "investigate");
    s = answerQuiz(s, "timing", ["anytime"]);
    s = answerQuiz(s, "pay", "must");
    s = answerQuiz(s, "goal", "specific");
    s = answerQuiz(s, "target", "Harborview");
    const prefs = toPreferences(s);
    expect(prefs.categories).toEqual(["internships", "scholarships"]);
    expect(prefs.opportunityTypes).toContain("summer_internship");
    expect(prefs.opportunityTypes).toContain("private_scholarship");
    expect(prefs.leanings).toEqual({ style: "investigate", length: null, value: null });
    expect(prefs.timing).toEqual([]);
    expect(prefs.weeklyHours).toBe(3);
    expect(StudentPreferencesSchema.parse(prefs)).toEqual(prefs);

    const server = toServerPreferences(prefs);
    expect("target" in server).toBe(false);
    expect(ServerPreferencesSchema.parse(server)).toEqual(server);
    // The server schema refuses the device-only answer and any status key.
    expect(ServerPreferencesSchema.safeParse(prefs).success).toBe(false);
    expect(ServerPreferencesSchema.safeParse({ ...server, citizenship: "us_citizen" }).success).toBe(false);
  });

  it("builds a valid StudentProfile with only non-sensitive fields", () => {
    const prefs = toPreferences(answerQuiz(answerQuiz(fresh(), "class_year", "first_year"), "weekly_hours", 6));
    const profile = preferencesToProfile(prefs);
    expect(StudentProfileSchema.parse(profile)).toEqual(profile);
    expect(profile.weeklyPrepHours).toBe(6);
  });
});
