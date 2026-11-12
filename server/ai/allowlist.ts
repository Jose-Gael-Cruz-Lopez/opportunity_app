import {
  findSensitiveKeys,
  MAJOR_FAMILY_LABELS,
  type ReadinessReport,
  type StudentProfile,
} from "@shared/contracts";
import { mentionsSensitiveTerm } from "./redact";

/**
 * What may describe a student inside a prompt. This is an ALLOWLIST: a field reaches the model
 * only if it is named here, so a field added to StudentProfile later stays out until someone
 * decides it is safe and adds it. SensitiveAnswers have no entry and cannot have one: the type is
 * browser-only and `assertPromptSafe` rejects any status or identity key that slips in.
 *
 * Deliberately excluded: institutionId (identifies a person in small schools), birthYearMonth
 * (age is only used for the access gate), residenceState and timeZone (location), minorCip (adds
 * nothing to an explanation), and GPA unless the program states a GPA criterion.
 */

export const PROMPT_PROFILE_FIELDS = [
  "classYear",
  "expectedGraduationTerm",
  "institutionLevel",
  "enrollmentIntensity",
  "transferIntent",
  "majorFamily",
  "majorCip",
  "interestTags",
  "preferredOpportunityTypes",
  "priorExperience",
  "weeklyPrepHours",
] as const satisfies readonly (keyof StudentProfile)[];

export type PromptProfileField = (typeof PROMPT_PROFILE_FIELDS)[number];

/** Fields allowed only when the caller says the program states a criterion on them. */
export const CONDITIONAL_PROFILE_FIELDS = ["gpaBand"] as const satisfies readonly (keyof StudentProfile)[];

export type PromptProfile = Partial<Pick<StudentProfile, PromptProfileField | "gpaBand">>;

export interface ProfileOptions {
  /** True only when the program's rule set states a GPA criterion. */
  readonly includeGpaBand?: boolean;
}

/**
 * Copies allowlisted, non-empty fields. Free-text interest tags that touch status or identity
 * vocabulary are dropped whole (a tag is too short to mask usefully).
 */
export function selectPromptProfile(profile: StudentProfile, opts: ProfileOptions = {}): PromptProfile {
  const out: Record<string, unknown> = {};
  for (const key of PROMPT_PROFILE_FIELDS) {
    const value = profile[key];
    if (value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    out[key] = value;
  }
  if (Array.isArray(out.interestTags)) {
    const safe = (out.interestTags as string[]).filter((t) => !mentionsSensitiveTerm(t));
    if (safe.length > 0) out.interestTags = safe;
    else delete out.interestTags;
  }
  if (opts.includeGpaBand && profile.gpaBand) out.gpaBand = profile.gpaBand;
  assertPromptSafe(out);
  return out as PromptProfile;
}

/** Plain-language lines for the prompt; labels, not raw codes, where the code is opaque. */
export function describePromptProfile(p: PromptProfile): string[] {
  const lines: string[] = [];
  if (p.classYear) lines.push(`Class year: ${p.classYear.replace(/_/g, " ")}`);
  if (p.expectedGraduationTerm) lines.push(`Expected graduation term: ${p.expectedGraduationTerm}`);
  if (p.institutionLevel) lines.push(`Institution level: ${p.institutionLevel.replace(/_/g, " ")}`);
  if (p.enrollmentIntensity) lines.push(`Enrollment: ${p.enrollmentIntensity.replace(/_/g, " ")}`);
  if (p.transferIntent) lines.push(`Transfer plans: ${p.transferIntent.replace(/_/g, " ")}`);
  if (p.majorFamily) lines.push(`Major family: ${MAJOR_FAMILY_LABELS[p.majorFamily]}`);
  if (p.majorCip) lines.push(`Major CIP code: ${p.majorCip}`);
  if (p.gpaBand) lines.push(`GPA band: ${p.gpaBand}`);
  if (p.interestTags?.length) lines.push(`Interests: ${p.interestTags.join(", ")}`);
  if (p.preferredOpportunityTypes?.length) {
    lines.push(`Preferred opportunity types: ${p.preferredOpportunityTypes.map((t) => t.replace(/-/g, " ")).join(", ")}`);
  }
  if (p.priorExperience?.length) lines.push(`Prior experience: ${p.priorExperience.map((e) => e.replace(/_/g, " ")).join(", ")}`);
  if (p.weeklyPrepHours !== undefined && p.weeklyPrepHours !== null) {
    lines.push(`Hours a week for applications: ${p.weeklyPrepHours}`);
  }
  return lines;
}

export class PromptSafetyError extends Error {
  constructor(readonly paths: readonly string[]) {
    // Paths only: the values are exactly what must not be logged.
    super(`prompt context carries sensitive keys: ${paths.join(", ")}`);
    this.name = "PromptSafetyError";
  }
}

/** Throws when any key anywhere in the value looks like a status or identity answer. */
export function assertPromptSafe(value: unknown): void {
  const paths = findSensitiveKeys(value);
  if (paths.length > 0) throw new PromptSafetyError(paths);
}

// ---------------------------------------------------------------------------------------------
// Readiness report -> prompt facts
// ---------------------------------------------------------------------------------------------

const ON_DEVICE_LINE = "One criterion is checked only on the student's device and is not shared with Novus.";

/**
 * Renders the deterministic ReadinessReport as plain facts for the prompt. Sensitive rules and
 * pending items are reduced to a neutral line with no dimension, verdict or text, so even a report
 * evaluated in the browser cannot leak a status answer through this path. Numbers here are about
 * programs (k of n official counts, dates, quantities), never about the student.
 */
export function renderReadinessFacts(report: ReadinessReport): string {
  const lines: string[] = [];
  const e = report.eligibility;
  const sensitiveTouched = e.sensitiveEvaluated || e.rules.some((r) => r.sensitive) || e.pending.some((p) => p.sensitive);
  lines.push("ELIGIBILITY");
  // An overall status computed with sensitive answers would reveal them, so it is withheld.
  lines.push(`Overall status: ${e.sensitiveEvaluated ? "checked on the student's device" : e.status.replace(/_/g, " ")}`);
  if (e.basedOnListedRequirements) lines.push("Note: the status rests only on requirements the program lists.");
  let onDevice = 0;
  for (const r of e.rules) {
    if (r.sensitive) {
      onDevice++;
      continue;
    }
    lines.push(`- Rule ${r.ruleId} (${r.dimension.replace(/_/g, " ")}): ${r.verdict.replace(/_/g, " ")}. Reason: ${r.reason}`);
    if (r.officialText) lines.push(`  Official text: ${r.officialText}`);
    if (r.missingFields.length > 0) lines.push(`  Missing profile fields: ${r.missingFields.join(", ")}`);
  }
  for (const p of e.pending) {
    if (p.sensitive) {
      onDevice++;
      continue;
    }
    lines.push(`- Open item ${p.id} (resolved by ${p.resolver}): ${p.selfCheckText}`);
  }
  if (onDevice > 0 || sensitiveTouched) lines.push(`- ${ON_DEVICE_LINE}`);
  if (e.nomination) lines.push("- The program requires a campus nomination.");

  lines.push("", "REQUIREMENTS");
  const req = report.requirements;
  if (!req.checked) lines.push("Requirements not yet checked by Novus: see the official page.");
  if (req.effectiveDeadline) {
    lines.push(`Deadline used for planning: ${req.effectiveDeadline.date} (${req.effectiveDeadline.basis}, ${req.effectiveDeadline.label})`);
  }
  for (const item of req.items) {
    const parts = [`- ${item.key}: ${item.label} (x${item.quantity}) is ${item.state.replace(/_/g, " ")}`];
    if (item.gap) parts.push(`gap: ${item.gap}`);
    if (item.startBy) parts.push(`start by ${item.startBy}`);
    if (item.severity) parts.push(`timing: ${item.severity}`);
    lines.push(parts.join("; "));
  }

  lines.push("", "COMPETITIVENESS");
  const c = report.competitiveness;
  lines.push(`Status: ${c.status.replace(/_/g, " ")}${c.band ? `; band: ${c.band.replace(/_/g, " ")}` : ""}${c.reason ? `; reason: ${c.reason.replace(/_/g, " ")}` : ""}`);
  lines.push(`Basis (${c.basis.kind.replace(/_/g, " ")}): ${c.basis.summary}`);
  for (const o of c.basis.stageOdds) {
    // Program-level official counts stated as "k of n", never turned into a rate.
    lines.push(
      `- Official count ${o.cycleYear}: ${o.numerator} of ${o.denominator} ${o.denominatorKind.replace(/_/g, " ")} moved from ${o.fromStage.replace(/_/g, " ")} to ${o.toStage.replace(/_/g, " ")} (${o.sourceUrl})`,
    );
  }
  for (const f of c.basis.factors) lines.push(`- Factor ${f.code}: ${f.label} (${f.direction})`);

  lines.push("", "NEXT ACTIONS");
  for (const a of report.nextActions) {
    const due = a.dueOn ? `, due ${a.dueOn}` : "";
    lines.push(`- [${a.id}] ${a.label}${due}${a.detail ? `: ${a.detail}` : ""}`);
  }
  return lines.join("\n");
}
