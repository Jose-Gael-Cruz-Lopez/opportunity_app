import { z } from "zod";
import type { AiMeta } from "@shared/contracts";
import { EXPERIENCE_KINDS, MAJOR_FAMILIES, type ExperienceKind, type MajorFamily } from "@shared/taxonomy";
import { AI_TEXT_MAX_CHARS, parseResumeText, scanAiText, toProfileSignals } from "@shared/resume";
import { mentionsSensitiveTerm } from "../redact";
import { geminiResponseSchema } from "../schema";
import { normalizeForMatch } from "../validate";
import { COMMON_RULES, fence, type BuiltPrompt, type FinalizeResult, type Precheck, type PromptRoute } from "./common";

/**
 * resume.extract.v1: reads the redacted, student-approved resume text from onboarding and lists
 * matching signals in a closed shape (skills, fields of study, coursework keywords, experience
 * kinds). Nothing else is asked for and nothing else is kept.
 *
 * Privacy: the text has already passed the browser's redactForAi, the student's preview and
 * consent, and the route's server guard. This route checks it again with @shared/resume's
 * scanAiText and server/ai's own status lexicon before any model call (precheck), and refuses to
 * run on a hit. Every string the model returns must appear in the text it was given and pass the
 * same detectors, so the model cannot add a name, a contact detail or a status term.
 *
 * Without a key (or on any failure) the deterministic fallback runs @shared/resume's parser and
 * signal extractor on the same redacted text: the student gets the same kind of chips, labelled
 * as not read by AI.
 */

export const RESUME_EXTRACT_LIMITS = { skills: 30, fields: 4, coursework: 20, experience: EXPERIENCE_KINDS.length, termChars: 60 } as const;

const Term = z.string().min(1).max(RESUME_EXTRACT_LIMITS.termChars);

export const ResumeExtractModelOutputSchema = z
  .object({
    skills: z.array(Term).max(RESUME_EXTRACT_LIMITS.skills),
    fields: z.array(z.enum(MAJOR_FAMILIES)).max(RESUME_EXTRACT_LIMITS.fields),
    courseworkKeywords: z.array(Term).max(RESUME_EXTRACT_LIMITS.coursework),
    experienceKinds: z.array(z.enum(EXPERIENCE_KINDS)).max(RESUME_EXTRACT_LIMITS.experience),
  })
  .strict();
export type ResumeExtractModelOutput = z.infer<typeof ResumeExtractModelOutputSchema>;

export interface ResumeProfile {
  readonly skills: readonly string[];
  readonly fields: readonly MajorFamily[];
  readonly courseworkKeywords: readonly string[];
  readonly experienceKinds: readonly ExperienceKind[];
}

export interface ResumeExtractInput {
  /** Redacted, allowlisted text the student approved; at most AI_TEXT_MAX_CHARS characters. */
  readonly redactedText: string;
}

export interface ResumeExtractResult {
  readonly meta: AiMeta;
  /** "model": read by Gemini; "deterministic": the on-server parser; "refused": the text failed the guard. */
  readonly source: "model" | "deterministic" | "refused";
  readonly profile: ResumeProfile;
}

const EMPTY_PROFILE: ResumeProfile = { skills: [], fields: [], courseworkKeywords: [], experienceKinds: [] };

/** True when the text is safe to hand to a model: no contact detail, identifier or status term. */
export function resumeTextIsClean(text: string): boolean {
  if (typeof text !== "string" || text.length === 0 || text.length > AI_TEXT_MAX_CHARS) return false;
  return scanAiText(text).ok && !mentionsSensitiveTerm(text);
}

const SYSTEM = [
  COMMON_RULES,
  "",
  "Task: read a student's resume text and list signals Novus uses to suggest programs.",
  "The text was redacted on the student's device: placeholders such as [email], [name], [link] and [removed] mark content taken out for privacy. Never guess what they were and never mention them.",
  "skills: tools, languages, methods and techniques the text names (for example Python, SQL, CAD, data analysis), each copied exactly as written in the text. At most 30.",
  "fields: the fields of study from the enum that the text's major or coursework shows. Empty if none.",
  "courseworkKeywords: short course subjects copied exactly from the text (for example Statistics, Organic Chemistry). At most 20.",
  "experienceKinds: the kinds of experience the text describes, from the enum (internship, research, paid work, leadership, community service, teaching or tutoring, competitions, independent projects, insight programs).",
  "Never list a person, organization, school, place, award, date, number or anything about personal status. Never write sentences. Never rate the student or the resume.",
].join("\n");

function build(input: ResumeExtractInput, nonce: string): BuiltPrompt {
  return { input: ["RESUME TEXT", fence("RESUME", input.redactedText.slice(0, AI_TEXT_MAX_CHARS), nonce)].join("\n"), sources: [] };
}

function precheck(input: ResumeExtractInput): Precheck<ResumeExtractResult> {
  if (resumeTextIsClean(input.redactedText)) return { proceed: true };
  // Defence in depth: the route already refused this with 422; never send it anywhere.
  return { proceed: false, response: (meta) => ({ meta, source: "refused", profile: EMPTY_PROFILE }) };
}

/** Keeps distinct, clean terms that appear in the text (whole words, case-insensitive). */
function groundedTerms(terms: readonly string[], text: string, max: number): { kept: string[]; invented: number } {
  const haystack = ` ${normalizeForMatch(text).replace(/[^a-z0-9+#.]+/g, " ")} `;
  const kept: string[] = [];
  const seen = new Set<string>();
  let invented = 0;
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, " ").trim();
    const key = normalizeForMatch(term).replace(/[^a-z0-9+#.]+/g, " ").trim();
    if (!key || seen.has(key)) continue;
    if (!haystack.includes(` ${key} `)) {
      invented++;
      continue;
    }
    if (!resumeTextIsClean(term) || /\[[a-z]+\]/i.test(term)) continue;
    seen.add(key);
    kept.push(term.slice(0, RESUME_EXTRACT_LIMITS.termChars));
    if (kept.length >= max) break;
  }
  return { kept, invented };
}

function finalize(out: ResumeExtractModelOutput, input: ResumeExtractInput, _prompt: BuiltPrompt, meta: AiMeta): FinalizeResult<ResumeExtractResult> {
  const skills = groundedTerms(out.skills, input.redactedText, RESUME_EXTRACT_LIMITS.skills);
  const coursework = groundedTerms(out.courseworkKeywords, input.redactedText, RESUME_EXTRACT_LIMITS.coursework);
  const invented = skills.invented + coursework.invented;
  const listed = out.skills.length + out.courseworkKeywords.length;
  // A few paraphrases are dropped quietly; an answer that is mostly invented is retried once.
  if (listed > 0 && invented * 2 > listed) {
    return { ok: false, reason: "validation_failed", issues: ["list only terms copied exactly from the resume text"] };
  }
  return {
    ok: true,
    response: {
      meta,
      source: "model",
      profile: {
        skills: skills.kept,
        fields: [...new Set(out.fields)].filter((f) => f !== "undeclared").slice(0, RESUME_EXTRACT_LIMITS.fields),
        courseworkKeywords: coursework.kept,
        experienceKinds: EXPERIENCE_KINDS.filter((k) => out.experienceKinds.includes(k)),
      },
    },
  };
}

/** The deterministic reading: @shared/resume's parser and closed-vocabulary signals. */
export function deterministicResumeProfile(redactedText: string, now: Date = new Date()): ResumeProfile {
  if (!resumeTextIsClean(redactedText)) return EMPTY_PROFILE;
  try {
    const signals = toProfileSignals(parseResumeText({ text: redactedText, now }), { now });
    return {
      skills: signals.skills.slice(0, RESUME_EXTRACT_LIMITS.skills),
      fields: signals.fields.filter((f) => f !== "undeclared").slice(0, RESUME_EXTRACT_LIMITS.fields),
      courseworkKeywords: signals.coursework.slice(0, RESUME_EXTRACT_LIMITS.coursework),
      experienceKinds: EXPERIENCE_KINDS.filter((k) => signals.experienceTypes.includes(k)),
    };
  } catch {
    return EMPTY_PROFILE;
  }
}

export function resumeExtractFallback(input: ResumeExtractInput, meta: AiMeta): ResumeExtractResult {
  return { meta, source: "deterministic", profile: deterministicResumeProfile(input.redactedText, new Date(meta.generatedAt)) };
}

export const resumeExtractRoute: PromptRoute<ResumeExtractInput, ResumeExtractModelOutput, ResumeExtractResult> = {
  id: "resume.extract",
  system: SYSTEM,
  outputSchema: ResumeExtractModelOutputSchema,
  jsonSchema: geminiResponseSchema(ResumeExtractModelOutputSchema),
  precheck,
  build,
  finalize,
  fallback: resumeExtractFallback,
};
