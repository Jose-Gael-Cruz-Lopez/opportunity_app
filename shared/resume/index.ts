/**
 * shared/resume: on-device resume parsing, redaction and signals for Novus onboarding.
 *
 * Pure TypeScript with no runtime dependencies beyond zod, so the browser (ideally in a Web
 * Worker) and the Hono Worker import the same detectors. The PDF and DOCX readers live in
 * shared/resume/readers and are imported from there, so the server never pulls them in.
 *
 * Privacy contract (see types.ts): ParsedResume, RedactionItem, SensitiveHit and PiiHit hold the
 * student's own words and stay on the device. Only `redactForAi(...).text`, after the student
 * sees it and consents, and `toProfileSignals(...)`, which holds closed-vocabulary values only,
 * may leave it.
 */

export * from "./types";
export { parseResumeText } from "./parse";
export {
  redactForAi,
  scanAiText,
  AI_TEXT_MAX_CHARS,
  AI_PLACEHOLDERS,
  REMOVED_PLACEHOLDER,
  type AiTextIssue,
  type AiTextScan,
} from "./redact";
export { detectSensitive, hasSensitive, SENSITIVE_REASON } from "./sensitive";
export { detectPii, redactPii, PII_PLACEHOLDERS, type PiiOptions } from "./pii";
export { normalizeSkills, lookupSkill, mineSkills, isKnownSkillName } from "./skills";
export {
  toProfileSignals,
  ProfileSignalsSchema,
  inferClassYear,
  primaryEducation,
  SIGNAL_LIMITS,
  type ProfileSignalsOptions,
} from "./signals";
export { findDates, parseDateRange, type DateMatch } from "./dates";
export { matchMajor, matchMajors, type MajorMatch } from "./majors";
export { normalizeText } from "./text";
