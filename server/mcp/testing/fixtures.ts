import { EligibilityRuleSetSchema, type EligibilityRuleSet, type ProgramCard, type ProgramDetail, type ReleaseArtifact } from "@shared/contracts";
import { SAMPLE_CARDS, SAMPLE_NOW, sampleCard, sampleDeadline } from "@shared/matching/fixtures/sample-cards";
import { registryFromArtifact, type McpRegistry } from "../registry";

/**
 * SAMPLE DATA for server/mcp tests. Every program is fictional, every URL is on example.org and
 * every card has isSample: true. Nothing here describes a real program.
 */

export const TEST_NOW = SAMPLE_NOW; // 2026-11-11 12:00 America/New_York
export const TEST_ORIGIN = "https://novus.example.org";

/** A synthetic rule set: first or second year, four-year school only, plus a sensitive citizenship rule. */
export const SAMPLE_RULES: EligibilityRuleSet = EligibilityRuleSetSchema.parse({
  id: "00000000-0000-4000-8000-00000000a101",
  programCycleId: "5a000000-0000-4000-8000-000000000901",
  version: 2,
  format: "jsonlogic-v1",
  state: "verified",
  coverage: {
    standing: "encoded",
    enrollment: "encoded",
    transfer: "no_restriction",
    gpa: "no_restriction",
    citizenship: "encoded",
    pell: "no_restriction",
    institution: "no_restriction",
    field: "no_restriction",
    identity: "no_restriction",
    age: "no_restriction",
    residency: "no_restriction",
    first_gen: "no_restriction",
    prior_award: "no_restriction",
    team: "no_restriction",
    host_enrollment: "no_restriction",
  },
  rules: [
    {
      id: "standing",
      dimension: "standing",
      logic: { in: [{ var: "classYear" }, ["first_year", "second_year"]] },
      fields: ["classYear"],
      sensitive: false,
      officialText: "Sample rule: open to first- and second-year undergraduates.",
    },
    {
      id: "four-year",
      dimension: "enrollment",
      logic: { "==": [{ var: "institutionLevel" }, "four_year"] },
      fields: ["institutionLevel"],
      sensitive: false,
      officialText: "Sample rule: enrolled at a four-year college or university.",
    },
    {
      id: "citizenship",
      dimension: "citizenship",
      logic: { in: [{ var: "citizenship" }, ["us_citizen", "us_national", "permanent_resident"]] },
      fields: ["citizenship"],
      sensitive: true,
      officialText: "Sample rule: open to U.S. citizens, nationals and permanent residents.",
    },
  ],
  hash: "a".repeat(64),
  createdVia: "sample",
  verifiedAt: "2026-11-01T15:00:00Z",
  verifiedBy: "sample-curator",
});

export const RULED_CARD: ProgramCard = sampleCard(901, {
  slug: "sample-example-leadership-fellowship",
  name: "Sample Example Leadership Fellowship",
  organizationName: "Example Foundation (sample)",
  summary: "Sample program: a summer leadership fellowship for early undergraduates.",
  opportunityTypes: ["undergraduate_fellowship"],
  classYears: ["first_year", "second_year"],
  deadlines: [
    sampleDeadline({ date: "2026-12-01", precision: "exact", time: "17:00" }),
    sampleDeadline({ date: "2026-12-05", tzMode: "applicant_local" }),
    sampleDeadline({ date: "2026-11-25", scope: "campus", kind: "campus_internal", basis: "attested" }),
  ],
  rules: SAMPLE_RULES,
  flags: { paid: true, nominationRequired: false },
});

export const SENSITIVE_CARD: ProgramCard = sampleCard(902, {
  slug: "sample-example-pell-scholars",
  name: "Sample Example Pell Scholars Award",
  organizationName: "Example Trust (sample)",
  opportunityTypes: ["national_scholarship"],
  deadlines: [sampleDeadline({ date: "2026-11-28" })],
  flags: { sensitiveAudience: true },
});

export const PREDICTED_CARD: ProgramCard = sampleCard(903, {
  slug: "sample-example-predicted-program",
  name: "Sample Example Predicted Program",
  organizationName: "Example Institute (sample)",
  status: "expected",
  deadlines: [
    {
      ...sampleDeadline({ date: "2026-12-10", basis: "predicted" }),
      precision: "window",
      localDate: null,
      windowStart: "2026-12-10",
      windowEnd: "2026-12-20",
    },
  ],
  prediction: { p10: "2026-12-10", p50: "2026-12-15", p90: "2026-12-20", label: "medium", method: "history" },
});

export const TEST_CARDS: readonly ProgramCard[] = [...SAMPLE_CARDS, RULED_CARD, SENSITIVE_CARD, PREDICTED_CARD];

export const TEST_ARTIFACT: ReleaseArtifact = {
  v: 1,
  release: 7,
  generatedAt: "2026-11-11T12:00:00Z",
  cards: [...TEST_CARDS],
  merged: { "old-coastal-slug": "coastal-ecology-reu" },
  containsSample: true,
};

export function testRegistry(details: Record<string, ProgramDetail> = {}): McpRegistry {
  return registryFromArtifact(TEST_ARTIFACT, async (_release, slug) => details[slug] ?? null);
}
