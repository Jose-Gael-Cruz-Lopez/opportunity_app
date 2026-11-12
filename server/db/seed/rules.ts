import type { ClassYear, IdentityCategory, UsState } from "../../../shared/taxonomy";
import type { EligibilityRule } from "../../../shared/contracts/eligibility";

/**
 * Small builders for sample JsonLogic rules. Each rule names the catalogue fields it reads, and
 * rules that read SensitiveAnswers are marked `sensitive` so only the browser evaluates them.
 * `officialText` here is sample wording, not any real program's rule.
 */

type RuleInput = Omit<EligibilityRule, "group" | "asOf" | "borderline" | "evidenceKey"> &
  Partial<Pick<EligibilityRule, "group" | "asOf" | "borderline" | "evidenceKey">>;

function rule(r: RuleInput): EligibilityRule {
  return { group: "all", asOf: "today", borderline: [], evidenceKey: null, ...r };
}

export function standing(years: readonly ClassYear[], text: string, evidenceKey = "e1"): EligibilityRule {
  return rule({
    id: "standing",
    dimension: "standing",
    logic: { in: [{ var: "classYear" }, [...years]] },
    fields: ["classYear"],
    sensitive: false,
    officialText: text,
    evidenceKey,
  });
}

/** Semester range at program start (for awards defined by study left, not class year). */
export function semestersLeft(min: number, max: number, text: string, evidenceKey = "e1"): EligibilityRule {
  return rule({
    id: "standing",
    dimension: "standing",
    logic: { and: [{ ">=": [{ var: "semestersRemaining" }, min] }, { "<=": [{ var: "semestersRemaining" }, max] }] },
    fields: ["semestersRemaining"],
    sensitive: false,
    asOf: "program_start",
    officialText: text,
    evidenceKey,
  });
}

export function fullTime(text = "Sample rule: enrolled full time.", evidenceKey = "e2"): EligibilityRule {
  return rule({
    id: "enrollment",
    dimension: "enrollment",
    logic: { "==": [{ var: "enrollmentIntensity" }, "full_time"] },
    fields: ["enrollmentIntensity"],
    sensitive: false,
    officialText: text,
    evidenceKey,
  });
}

export function institutionLevel(levels: readonly ("two_year" | "four_year" | "other")[], text: string, evidenceKey = "e2"): EligibilityRule {
  return rule({
    id: "institution_level",
    dimension: "enrollment",
    logic: { in: [{ var: "institutionLevel" }, [...levels]] },
    fields: ["institutionLevel"],
    sensitive: false,
    officialText: text,
    evidenceKey,
  });
}

export function gpaAtLeast(min: number, evidenceKey = "e3"): EligibilityRule {
  return rule({
    id: "gpa",
    dimension: "gpa",
    logic: { ">=": [{ var: "gpaMin" }, min] },
    fields: ["gpaMin"],
    sensitive: false,
    officialText: `Sample rule: cumulative GPA of at least ${min.toFixed(2)} on a 4.00 scale.`,
    evidenceKey,
  });
}

/** Citizenship is a SensitiveAnswer: the rule is evaluated on the device only. */
export function citizenship(values: readonly string[], text: string, evidenceKey = "e4"): EligibilityRule {
  return rule({
    id: "citizenship",
    dimension: "citizenship",
    logic: { in: [{ var: "citizenship" }, [...values]] },
    fields: ["citizenship"],
    sensitive: true,
    officialText: text,
    evidenceKey,
  });
}

export function majorCip(prefixes2: readonly string[], text: string, borderline: readonly string[] = [], evidenceKey = "e5"): EligibilityRule {
  return rule({
    id: "field",
    dimension: "field",
    logic: { in: [{ substr: [{ var: "majorCip" }, 0, 2] }, [...prefixes2]] },
    fields: ["majorCip"],
    sensitive: false,
    borderline: [...borderline],
    officialText: text,
    evidenceKey,
  });
}

export function residency(states: readonly UsState[], text: string, evidenceKey = "e6"): EligibilityRule {
  return rule({
    id: "residency",
    dimension: "residency",
    logic: { in: [{ var: "residenceState" }, [...states]] },
    fields: ["residenceState"],
    sensitive: false,
    officialText: text,
    evidenceKey,
  });
}

export function minAge(years: number, evidenceKey = "e7"): EligibilityRule {
  return rule({
    id: "age",
    dimension: "age",
    logic: { ">=": [{ var: "ageAtAsOf" }, years] },
    fields: ["ageAtAsOf"],
    sensitive: false,
    asOf: "program_start",
    officialText: `Sample rule: at least ${years} years old when the program starts.`,
    evidenceKey,
  });
}

export function participates(evidenceKey = "e8"): EligibilityRule {
  return rule({
    id: "participation",
    dimension: "institution",
    logic: { "==": [{ var: "institutionParticipates" }, true] },
    fields: ["institutionParticipates"],
    sensitive: false,
    officialText: "Sample rule: your institution must be a participating campus that can nominate you.",
    evidenceKey,
  });
}

export function atInstitution(institutionId: string, text: string, evidenceKey = "e8"): EligibilityRule {
  return rule({
    id: "institution",
    dimension: "institution",
    logic: { "==": [{ var: "institutionId" }, institutionId] },
    fields: ["institutionId"],
    sensitive: false,
    officialText: text,
    evidenceKey,
  });
}

/** Pell and first-generation answers are SensitiveAnswers (browser only). */
export function pellRecipient(group = "all", evidenceKey = "e9"): EligibilityRule {
  return rule({
    id: "pell",
    dimension: "pell",
    group,
    logic: { "==": [{ var: "pell" }, "recipient"] },
    fields: ["pell"],
    sensitive: true,
    officialText: "Sample rule: receives a Federal Pell Grant.",
    evidenceKey,
  });
}

export function firstGeneration(group = "all", evidenceKey = "e10"): EligibilityRule {
  return rule({
    id: "first_gen",
    dimension: "first_gen",
    group,
    logic: { "==": [{ var: "firstGeneration" }, "yes"] },
    fields: ["firstGeneration"],
    sensitive: true,
    officialText: "Sample rule: first in the family to attend a four-year college.",
    evidenceKey,
  });
}

export function identityIncludes(category: IdentityCategory, value: string, text: string, evidenceKey = "e11"): EligibilityRule {
  const field = `identity.${category}` as EligibilityRule["fields"][number];
  return rule({
    id: `identity_${category}`,
    dimension: "identity",
    logic: { in: [value, { var: field }] },
    fields: [field],
    sensitive: true,
    officialText: text,
    evidenceKey,
  });
}
