import { ELIGIBILITY_FIELDS, type EligibilityDimension, type EligibilityFieldKey } from "../contracts/eligibility";

/**
 * Reason codes and their copy. One table, so the browser, email, REST and MCP word a reason the
 * same way; golden/reason-templates.json mirrors it for the Python pipeline (a test keeps the two
 * equal). Templates take `{name}` parameters. Sensitive reasons never name the student's answer:
 * on the server they only point to the official rule.
 */
export const REASON_TEMPLATES = {
  MET: "Meets this rule: {officialText}",
  NOT_MET: "Does not meet this rule: {officialText}",
  MISSING_FIELD: "Eligible if you meet this rule: {officialText} Add {fields} to check it.",
  STRADDLES_LIMIT: "Eligible if you meet this rule: {officialText} Your answer is a range that crosses the limit.",
  PROFILE_CONFLICT: "Eligible if you meet this rule: {officialText} Your class year and graduation term disagree; check both.",
  CALENDAR_CONVERSION: "Check how the program counts your remaining terms: {officialText}",
  BORDERLINE_FIELD: "Check whether your major qualifies: {officialText}",
  PARTICIPATION_UNCONFIRMED: "Ask your campus whether it can nominate you: {officialText}",
  SENSITIVE_ON_DEVICE: "Check this rule yourself on your device: {officialText}",
  SENSITIVE_UNANSWERED: "Eligible if you meet this rule: {officialText}",
  CONTEXT_MISSING: "Not fully checked: Novus is missing a date or school detail this rule needs. See the official page.",
  RULE_ERROR: "Not fully checked: this rule could not be evaluated. See the official page.",
  UNDETERMINED: "Not fully checked: {officialText}",
  ATTESTATION_ON_DEVICE: "Confirm this yourself: {officialText}",
  ATTESTATION_UNANSWERED: "Eligible if you meet this rule: {officialText}",
  ATTESTATION_CONFIRMED: "You confirmed: {officialText}",
  ATTESTATION_DECLINED: "You said this does not apply: {officialText}",
  COVERAGE_NOT_REVIEWED: "Not fully checked: Novus has not reviewed the {dimension} rules yet. See the official page.",
  COVERAGE_ENCODED_EMPTY: "Not fully checked: the {dimension} rules are incomplete. See the official page.",
  GROUP_EMPTY: "Not fully checked: the options for {label} are incomplete. See the official page.",
  RULE_SET_MISSING: "Not fully checked: Novus has no reviewed eligibility rules for this cycle yet. See the official page.",
} as const;

export type ReasonCode = keyof typeof REASON_TEMPLATES;
export const REASON_CODES = Object.keys(REASON_TEMPLATES) as ReasonCode[];

/** "Eligible if ..." texts for pending items, keyed like REASON_TEMPLATES. */
export const SELF_CHECK_TEMPLATES = {
  rule: "Eligible if you meet this rule: {officialText}",
  rule_novus: "Not fully checked: {officialText} See the official page.",
  attestation: "Eligible if you meet this rule: {officialText}",
  coverage: "Not fully checked: Novus has not reviewed the {dimension} rules yet. See the official page.",
  group: "Not fully checked: the options for {label} are incomplete. See the official page.",
  rule_set_missing: "Not fully checked: Novus has no reviewed eligibility rules for this cycle yet. See the official page.",
} as const;

export const DIMENSION_LABELS: Record<EligibilityDimension, string> = {
  standing: "class standing",
  enrollment: "enrollment",
  transfer: "transfer",
  gpa: "GPA",
  citizenship: "citizenship",
  pell: "financial need",
  institution: "institution",
  field: "field of study",
  identity: "community",
  age: "age",
  residency: "residency",
  first_gen: "first-generation",
  prior_award: "prior award",
  team: "team",
  host_enrollment: "host enrollment",
};

/** Contract limit for reason and self-check text. */
export const MAX_TEXT = 400;

export function renderTemplate(template: string, params: Readonly<Record<string, string>>): string {
  const text = template.replace(/\{([a-zA-Z]+)\}/g, (_, name: string) => params[name] ?? "").replace(/\s+/g, " ").trim();
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT - 3).trimEnd()}...`;
}

export function renderReason(code: ReasonCode, params: Readonly<Record<string, string>>): string {
  return renderTemplate(REASON_TEMPLATES[code], params);
}

/** "your GPA band and your graduation term": labels of the missing fields, never their values. */
export function describeFields(fields: readonly EligibilityFieldKey[]): string {
  const labels = [...new Set(fields)].map((f) => (ELIGIBILITY_FIELDS as Record<string, { label: string }>)[f]?.label.toLowerCase() ?? f);
  if (labels.length <= 1) return labels[0] ?? "the missing answer";
  return `${labels.slice(0, -1).join(", ")} and ${labels[labels.length - 1]}`;
}

/** Ensures official text ends as a sentence so templates that append text read cleanly. */
export function sentence(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}
