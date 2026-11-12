import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AiMetaSchema,
  AskResponseSchema,
  collectPropertyNames,
  DeadlineSchema,
  EligibilityResultSchema,
  EligibilityRuleSchema,
  EligibilityRuleSetSchema,
  EMPTY_STUDENT_PROFILE,
  ExtractionPageV1Schema,
  findSensitiveKeys,
  FORBIDDEN_STUDENT_SCORE_FIELDS,
  isSensitiveKey,
  JSON_SCHEMA_EXPORTS,
  ProblemDetailsSchema,
  problem,
  issuesFromZod,
  CampusDeadlineSubmissionSchema,
  ProgramListCreateSchema,
  ProgramCycleSchema,
  ProgramSchema,
  READINESS_PARTS,
  ReadinessExplainResponseSchema,
  ReadinessReportSchema,
  SensitiveAnswersSchema,
  StatementFeedbackResponseSchema,
  StudentProfileSchema,
  StudentProfileUpdateSchema,
  toJsonSchema,
  TrackerItemSchema,
  RoadmapSchema,
  SearchResponseSchema,
  EligibilityCheckRequestSchema,
  type EligibilityResult,
  type ReadinessReport,
} from "./index";
import { renderAll } from "./export-json-schema";

// Sample fixtures (synthetic data, not real program facts).
const ID = (n: number) => `0190f0a0-0000-7000-8000-${String(n).padStart(12, "0")}`;
const NOW = "2026-11-11T12:00:00.000Z";

const roundTrip = <S extends z.ZodTypeAny>(schema: S, value: unknown): z.infer<S> => {
  const first = schema.parse(value);
  const second = schema.parse(JSON.parse(JSON.stringify(first)));
  expect(second).toEqual(first);
  return first;
};

const sampleDeadline = {
  id: ID(1),
  programCycleId: ID(2),
  kind: "application",
  scope: "national",
  institutionId: null,
  roundLabel: "",
  basis: "official",
  precision: "exact",
  tzMode: "fixed",
  localDate: "2027-01-29",
  localTime: "17:00",
  windowStart: null,
  windowEnd: null,
  timeZone: "America/Chicago",
  tzSource: "stated",
  dueAt: "2027-01-29T23:00:00.000Z",
  sortAt: "2027-01-29T23:00:00.000Z",
  revision: 1,
  verificationState: "verified",
  withdrawnAt: null,
};

const sampleRuleSet = {
  id: ID(10),
  programCycleId: ID(2),
  version: 1,
  format: "jsonlogic-v1",
  state: "draft",
  coverage: { standing: "encoded", citizenship: "encoded", gpa: "encoded" },
  rules: [
    {
      id: "standing",
      dimension: "standing",
      logic: { in: [{ var: "classYear" }, ["first_year", "second_year"]] },
      fields: ["classYear"],
      sensitive: false,
      officialText: "Open to first- and second-year undergraduates.",
      evidenceKey: "e1",
    },
    {
      id: "gpa",
      dimension: "gpa",
      logic: { ">=": [{ var: "gpaMin" }, 3.0] },
      fields: ["gpaMin"],
      sensitive: false,
      officialText: "A GPA of at least 3.0.",
    },
    {
      id: "citizenship",
      dimension: "citizenship",
      logic: { in: [{ var: "citizenship" }, ["us_citizen", "us_national", "permanent_resident"]] },
      fields: ["citizenship"],
      sensitive: true,
      officialText: "U.S. citizens, nationals and permanent residents.",
      evidenceKey: "e1",
    },
  ],
  evidence: {
    e1: { basis: "snapshot", url: "https://example.org/eligibility", quote: "Sample eligibility sentence.", retrievedOn: "2026-11-10" },
  },
  createdVia: "sample",
};

const sampleEligibility: EligibilityResult = {
  verdict: "unknown",
  status: "conditional",
  rules: [
    {
      ruleId: "standing",
      dimension: "standing",
      group: "all",
      verdict: "met",
      sensitive: false,
      reasonCode: "ELIGIBLE_STANDING",
      reason: "You are a second-year student.",
      officialText: "Open to first- and second-year undergraduates.",
      missingFields: [],
      resolver: null,
      evidenceKey: "e1",
      evidence: null,
    },
    {
      ruleId: "citizenship",
      dimension: "citizenship",
      group: "all",
      verdict: "unknown",
      sensitive: true,
      reasonCode: "SENSITIVE_ON_DEVICE",
      reason: "Check this rule privately on your device.",
      officialText: "U.S. citizens, nationals and permanent residents.",
      missingFields: ["citizenship"],
      resolver: "student",
      evidenceKey: "e1",
      evidence: null,
    },
  ],
  pending: [
    {
      id: "citizenship",
      kind: "rule",
      dimension: "citizenship",
      sensitive: true,
      resolver: "student",
      selfCheckText: "Eligible if you are a U.S. citizen, national or permanent resident.",
    },
  ],
  nomination: null,
  ruleSet: { id: ID(10), version: 1, hash: null },
  basedOnListedRequirements: false,
  asOf: "2026-11-11",
  sensitiveEvaluated: false,
};

const sampleReport: ReadinessReport = {
  programCycleId: ID(2),
  programSlug: "sample-scholars-program",
  cycleKey: "summer-2027",
  algoVersion: "readiness-v1",
  generatedAt: NOW,
  eligibility: sampleEligibility,
  requirements: {
    checked: true,
    effectiveDeadline: { date: "2027-01-29", basis: "official", scope: "national", label: "Application deadline" },
    items: [
      {
        key: ID(20),
        requirementId: ID(20),
        kind: "recommendation",
        label: "Two letters of recommendation",
        quantity: 2,
        state: "gap",
        gap: "Ask two recommenders",
        startBy: "2027-01-06",
        severity: "planned",
        effortHours: 2,
        leadDays: 21,
        evidence: null,
      },
    ],
  },
  competitiveness: {
    status: "insufficient_data",
    band: null,
    reason: "no_official_counts",
    basis: {
      kind: "none",
      summary: "The program has not published applicant counts.",
      stageOdds: [],
      currentStage: null,
      factors: [],
      reportsBanded: null,
      nEff: null,
      cycles: [],
      modelVersion: null,
      methodologyUrl: null,
    },
  },
  nextActions: [
    {
      id: "ask-recommenders",
      label: "Ask two recommenders",
      detail: null,
      dueOn: "2027-01-06",
      severity: "planned",
      source: "gap",
      roadmapItemKey: "apply:sample:summer-2027",
      relatesTo: ID(20),
    },
  ],
};

describe("round trips", () => {
  it("registry entities", () => {
    roundTrip(DeadlineSchema, sampleDeadline);
    roundTrip(ProgramSchema, {
      id: ID(3),
      slug: "sample-scholars-program",
      name: "Sample Scholars Program",
      organizationId: ID(4),
      summary: "Sample data for tests.",
      officialUrl: "https://example.org/program",
      recurrence: "annual",
      lifecycle: "active",
      opportunityTypes: ["national_scholarship"],
      sensitiveAudience: false,
      identityAudience: [],
      isPublished: true,
      isSample: true,
      version: 1,
    });
    roundTrip(ProgramCycleSchema, {
      id: ID(2),
      programId: ID(3),
      cycleKey: "summer-2027",
      termLabel: "Summer 2027",
      cycleModel: "term",
      status: "open",
      statusChangedAt: NOW,
      statusChangedBy: "Novus Curator AB",
      timeZone: "America/Chicago",
      opensOn: "2026-09-01",
      predictedOpensOn: null,
      predictionLabel: null,
      decisionWindowStart: null,
      decisionWindowEnd: null,
      decisionsReleasedOn: null,
      eventStart: null,
      eventEnd: null,
      applicationUrl: "https://example.org/apply",
      pellDisplacement: "unknown",
      applicationFeeCents: null,
      participantCostCents: null,
      compensation: { kind: "award", amountCents: 750000, period: "year" },
      verificationState: "verified",
      lastVerifiedAt: NOW,
      verifiedBy: "Novus Curator AB",
      sourceCheckedAt: null,
      rolledOverFromId: null,
      version: 3,
    });
  });

  it("rule set, eligibility result and readiness report", () => {
    roundTrip(EligibilityRuleSetSchema, sampleRuleSet);
    roundTrip(EligibilityResultSchema, sampleEligibility);
    roundTrip(ReadinessReportSchema, sampleReport);
  });

  it("student records", () => {
    roundTrip(StudentProfileSchema, { ...EMPTY_STUDENT_PROFILE, classYear: "second_year", majorCip: "11.0701", timeZone: "America/Denver" });
    roundTrip(TrackerItemSchema, {
      id: ID(30),
      programCycleId: ID(2),
      programSlug: "sample-scholars-program",
      cycleKey: "summer-2027",
      status: "applying",
      statusSource: "student",
      ownCampusDeadline: "2026-12-01",
      submittedOn: null,
      nameInMessages: true,
      createdAt: NOW,
      updatedAt: NOW,
      version: 2,
    });
  });
});

describe("deadline invariants mirror the table CHECKs", () => {
  const bad = (patch: Record<string, unknown>) => DeadlineSchema.safeParse({ ...sampleDeadline, ...patch }).success;
  it("rejects invalid combinations", () => {
    expect(bad({ tzMode: "applicant_local" })).toBe(false); // applicant-local rows store no zone
    expect(bad({ tzMode: "applicant_local", timeZone: null, dueAt: null })).toBe(true);
    expect(bad({ dueAt: null })).toBe(false); // fixed exact rows need due_at
    expect(bad({ precision: "window", basis: "official", windowStart: "2027-01-01", windowEnd: "2027-02-01", localTime: null, dueAt: null })).toBe(false);
    expect(bad({ scope: "campus" })).toBe(false); // campus rows name an institution
    expect(bad({ basis: "attested" })).toBe(false); // attested rows are campus rows
    expect(bad({ precision: "month_only", localDate: "2027-01-29", localTime: null, dueAt: null })).toBe(false);
    expect(bad({ precision: "month_only", localDate: "2027-01", localTime: null, dueAt: null })).toBe(true);
    expect(bad({ localDate: "2027-02-30" })).toBe(false);
  });
});

describe("privacy by construction", () => {
  it("StudentProfile rejects every sensitive key", () => {
    for (const key of ["citizenship", "immigrationStatus", "pell", "householdIncome", "firstGeneration", "race", "gender", "disability", "veteran", "fosterCare"]) {
      const result = StudentProfileUpdateSchema.safeParse({ classYear: "first_year", [key]: "x" });
      expect(result.success, key).toBe(false);
    }
    expect(EligibilityCheckRequestSchema.safeParse({ programs: ["sample"], profile: { citizenship: "us_citizen" } }).success).toBe(false);
  });

  it("student-owned schemas have no sensitive property names", () => {
    for (const schema of [StudentProfileSchema, TrackerItemSchema, ReadinessReportSchema, RoadmapSchema]) {
      const names = collectPropertyNames(toJsonSchema(schema));
      expect(names.filter(isSensitiveKey)).toEqual([]);
    }
  });

  it("findSensitiveKeys finds nested keys without false positives", () => {
    expect(findSensitiveKeys({ profile: { usCitizen: true, isFirstGen: false }, items: [{ greenCard: 1 }] })).toEqual([
      "profile.usCitizen",
      "profile.isFirstGen",
      "items[0].greenCard",
    ]);
    expect(findSensitiveKeys({ traceId: 1, httpsUrl: "x", sensitiveAudience: true, identityAudience: [], gradient: 1 })).toEqual([]);
  });

  it("SensitiveAnswers validates on the device and is never exported as JSON Schema", () => {
    expect(SensitiveAnswersSchema.safeParse({ citizenship: "f1", identity: { race_ethnicity: ["asian"] } }).success).toBe(true);
    expect(SensitiveAnswersSchema.safeParse({ identity: { race_ethnicity: ["not_a_value"] } }).success).toBe(false);
    expect(Object.keys(JSON_SCHEMA_EXPORTS).some((k) => /sensitive/i.test(k))).toBe(false);
    expect(Object.values(JSON_SCHEMA_EXPORTS)).not.toContain(SensitiveAnswersSchema);
  });

  it("server-side results keep sensitive rules unknown", () => {
    const leaked = {
      ...sampleEligibility,
      rules: sampleEligibility.rules.map((r) => (r.sensitive ? { ...r, verdict: "met" as const } : r)),
    };
    expect(EligibilityResultSchema.safeParse(leaked).success).toBe(false);
    expect(EligibilityResultSchema.safeParse({ ...leaked, sensitiveEvaluated: true }).success).toBe(true);
  });
});

describe("eligibility rules", () => {
  const rule = sampleRuleSet.rules[0]!;
  it("requires declared, catalogued fields and allowed operators", () => {
    expect(EligibilityRuleSchema.safeParse(rule).success).toBe(true);
    expect(EligibilityRuleSchema.safeParse({ ...rule, logic: { "==": [{ var: "notAField" }, 1] } }).success).toBe(false);
    expect(EligibilityRuleSchema.safeParse({ ...rule, logic: { "==": [{ var: "gpaMin" }, 3] } }).success).toBe(false);
    expect(EligibilityRuleSchema.safeParse({ ...rule, logic: { method: [{ var: "classYear" }, "toString"] } }).success).toBe(false);
  });

  it("forces the sensitive flag to match the fields", () => {
    const citizenship = sampleRuleSet.rules[2]!;
    expect(EligibilityRuleSchema.safeParse({ ...citizenship, sensitive: false }).success).toBe(false);
    expect(EligibilityRuleSchema.safeParse({ ...rule, sensitive: true }).success).toBe(false);
  });

  it("verified rule sets carry a hash and verifier; launch dimensions are never none_stated", () => {
    expect(EligibilityRuleSetSchema.safeParse({ ...sampleRuleSet, state: "verified" }).success).toBe(false);
    expect(
      EligibilityRuleSetSchema.safeParse({
        ...sampleRuleSet,
        state: "verified",
        hash: "a".repeat(64),
        verifiedAt: NOW,
        verifiedBy: "Novus Curator AB",
      }).success,
    ).toBe(true);
    expect(EligibilityRuleSetSchema.safeParse({ ...sampleRuleSet, coverage: { gpa: "none_stated" } }).success).toBe(false);
    expect(EligibilityRuleSetSchema.safeParse({ ...sampleRuleSet, rules: [rule, rule] }).success).toBe(false);
  });
});

describe("readiness has four parts and no score", () => {
  it("has exactly the four parts beside its metadata", () => {
    const meta = ["programCycleId", "programSlug", "cycleKey", "algoVersion", "generatedAt"];
    expect(Object.keys(ReadinessReportSchema.shape).sort()).toEqual([...meta, ...READINESS_PARTS].sort());
  });

  it("rejects an added score field", () => {
    expect(ReadinessReportSchema.safeParse({ ...sampleReport, readinessScore: 72 }).success).toBe(false);
  });

  it("no student-facing schema names a score, percent or match number", () => {
    const studentFacing = [
      ReadinessReportSchema,
      EligibilityResultSchema,
      StudentProfileSchema,
      RoadmapSchema,
      SearchResponseSchema,
      ReadinessExplainResponseSchema,
      StatementFeedbackResponseSchema,
      AskResponseSchema,
    ];
    const forbidden = new Set<string>(FORBIDDEN_STUDENT_SCORE_FIELDS);
    for (const schema of studentFacing) {
      const names = collectPropertyNames(toJsonSchema(schema));
      expect(names.filter((n) => forbidden.has(n))).toEqual([]);
    }
  });

  it("a band appears only when status is available", () => {
    const c = sampleReport.competitiveness;
    expect(ReadinessReportSchema.safeParse({ ...sampleReport, competitiveness: { ...c, band: "typical" } }).success).toBe(false);
    expect(
      ReadinessReportSchema.safeParse({ ...sampleReport, competitiveness: { ...c, status: "available", band: "typical", reason: null } }).success,
    ).toBe(true);
  });
});

describe("AI contracts", () => {
  const meta = { provider: "gemini", model: "gemini-model", promptVersion: "ask-v1", status: "ok", degradedReason: null, generatedAt: NOW, fallback: false };
  it("answers must cite sources", () => {
    const base = { meta, answer: "Sample answer.", answerType: "answered", citations: [], programRefs: [], followUps: [] };
    expect(AskResponseSchema.safeParse(base).success).toBe(false);
    expect(
      AskResponseSchema.safeParse({
        ...base,
        citations: [{ sourceId: "s1", kind: "program_page", title: "Sample page", url: "https://example.org", quote: "Sample." }],
      }).success,
    ).toBe(true);
    expect(AskResponseSchema.safeParse({ ...base, answerType: "not_in_sources" }).success).toBe(true);
  });

  it("explanations may cite only listed sources", () => {
    const resp = {
      programCycleId: ID(2),
      meta,
      summary: "Sample.",
      points: [{ part: "eligibility", text: "Sample.", sourceIds: ["s2"] }],
      suggestions: [],
      caveats: [],
      citations: [{ sourceId: "s1", kind: "readiness_report", title: "Report", url: null, quote: null }],
    };
    expect(ReadinessExplainResponseSchema.safeParse(resp).success).toBe(false);
    expect(ReadinessExplainResponseSchema.safeParse({ ...resp, points: [{ ...resp.points[0], sourceIds: ["s1"] }] }).success).toBe(true);
  });

  it("degraded meta names a reason", () => {
    expect(AiMetaSchema.safeParse({ ...meta, status: "unavailable" }).success).toBe(false);
    expect(AiMetaSchema.safeParse({ ...meta, provider: "none", model: null, status: "unavailable", degradedReason: "no_api_key", fallback: true }).success).toBe(true);
  });
});

describe("JSON Schema export", () => {
  it("converts every exported schema deterministically", () => {
    const a = renderAll();
    const b = renderAll();
    expect([...a.entries()]).toEqual([...b.entries()]);
    expect(a.size).toBe(Object.keys(JSON_SCHEMA_EXPORTS).length + 1);
  });

  it("extraction.v1 fits structured-output limits: no unions, nothing optional", () => {
    const schema = toJsonSchema(ExtractionPageV1Schema, { mode: "output" });
    const text = JSON.stringify(schema);
    expect(text).not.toContain('"anyOf"');
    expect(text).not.toContain('"oneOf"');
    const countOptional = (node: unknown): number => {
      if (Array.isArray(node)) return node.reduce((n: number, x) => n + countOptional(x), 0);
      if (node === null || typeof node !== "object") return 0;
      const obj = node as { properties?: Record<string, unknown>; required?: string[] };
      const own = obj.properties ? Object.keys(obj.properties).filter((k) => !(obj.required ?? []).includes(k)).length : 0;
      return own + Object.values(obj).reduce((n: number, x) => n + countOptional(x), 0);
    };
    expect(countOptional(schema)).toBe(0);
  });

  it("emits formats for refined strings", () => {
    const s = toJsonSchema(DeadlineSchema) as { properties: Record<string, { anyOf?: { format?: string }[] }> };
    expect(s.properties.dueAt?.anyOf?.[0]?.format).toBe("date-time");
    expect(s.properties.windowStart?.anyOf?.[0]?.format).toBe("date");
  });
});

describe("problem details", () => {
  it("builds valid RFC 9457 documents", () => {
    const p = problem("consent_required", { requestId: "req-1" });
    expect(ProblemDetailsSchema.parse(p).status).toBe(409);
    expect(p.type).toBe("/problems/consent-required");
  });

  it("validation issues never echo submitted values", () => {
    const secret = "my-secret-text";
    const cases = [
      CampusDeadlineSubmissionSchema.safeParse({
        programSlug: "goldwater",
        cycleKey: "ay-2026-27",
        kind: secret,
        localDate: secret,
        localTime: null,
        timeZone: secret,
        sourceUrl: null,
        note: null,
      }),
      ProgramListCreateSchema.safeParse({ title: "List", visibility: "SECRET_VALUE_ECHO", [secret + " key"]: 1 }),
    ];
    for (const parsed of cases) {
      expect(parsed.success).toBe(false);
      if (parsed.success) continue;
      const issues = issuesFromZod(parsed.error);
      expect(issues.length).toBeGreaterThan(0);
      const text = JSON.stringify(issues);
      expect(text).not.toContain(secret);
      expect(text).not.toContain("SECRET_VALUE_ECHO");
      expect(text).not.toContain("received");
    }
    const enumIssue = issuesFromZod(cases[0]!.error!).find((i) => i.path === "kind");
    expect(enumIssue).toEqual({ path: "kind", message: "Not an allowed value" });
  });

  it("reports identifier-shaped unknown keys by name", () => {
    const parsed = ProgramListCreateSchema.safeParse({ title: "List", extra_field: 1 });
    expect(parsed.success).toBe(false);
    expect(issuesFromZod(parsed.error!)).toEqual([{ path: "extra_field", message: "Unrecognized key" }]);
  });
});
