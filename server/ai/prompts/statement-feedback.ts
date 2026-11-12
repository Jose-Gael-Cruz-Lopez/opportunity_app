import {
  StatementFeedbackModelOutputSchema,
  StatementFeedbackResponseSchema,
  type AiMeta,
  type FeedbackAspect,
  type StatementFeedbackModelOutput,
  type StatementFeedbackRequest,
  type StatementFeedbackResponse,
} from "@shared/contracts";
import { redactStudentText } from "../redact";
import { geminiResponseSchema } from "../schema";
import { clampText, findScoreClaims, isVerbatim } from "../validate";
import {
  assignSourceIds,
  citationsFor,
  COMMON_RULES,
  fence,
  knownIds,
  renderSources,
  type AiSourceInput,
  type BuiltPrompt,
  type FinalizeResult,
  type PromptRoute,
} from "./common";

/**
 * statement.feedback.v1: feedback on a personal statement or essay against the program's prompt,
 * organised by a fixed rubric of aspects. Feedback only: no grade, score, rating or prediction.
 * The statement is redacted (contact details, ids, status and identity vocabulary) before it is
 * placed in the prompt; excerpts the model quotes must be verbatim from that redacted text.
 */

export interface StatementFeedbackInput {
  readonly request: StatementFeedbackRequest;
  /** The program's official essay prompt and instructions, if known. */
  readonly programSources: readonly AiSourceInput[];
}

/** The rubric the model is asked to use; every aspect is a lens, none is scored. */
export const RUBRIC: Readonly<Record<FeedbackAspect, string>> = {
  fit_to_prompt: "Does the statement answer every part of the prompt it was written for?",
  specificity: "Are claims backed by concrete examples, actions and details rather than general statements?",
  structure: "Is there a clear opening, a logical order and an ending that connects back to the program?",
  clarity: "Are sentences easy to follow, with no ambiguous or overloaded sentences?",
  evidence_of_impact: "Does the writer show what they did and what changed because of it?",
  voice: "Does it sound like a real student rather than a template, without clichés?",
  mechanics: "Spelling, grammar and punctuation problems that distract a reader.",
  length: "Is the length appropriate for the stated word limit?",
};

const SYSTEM = [
  COMMON_RULES,
  "",
  "Task: give feedback on a student's application statement for a program.",
  "Use this rubric of aspects. Each is a lens for comments, never a score:",
  ...Object.entries(RUBRIC).map(([k, v]) => `- ${k}: ${v}`),
  "overall: two to four sentences on what works and the most valuable change. No grade, score, rating, percentage or prediction of success.",
  "strengths: up to four, each with the aspect, a comment and an excerpt copied exactly from the statement (a short phrase, at most 25 words).",
  "improvements: up to six, each with the aspect, a comment, an excerpt copied exactly from the statement, and a concrete suggestion. Do not rewrite the whole statement.",
  "promptCoverage: split the program's prompt into its parts and say for each whether the statement addresses it (yes, partly, no) with a short note. Empty if no prompt was given.",
  "sourceIds: the ids of program sources you relied on; may be empty.",
  "Text such as [status or identity detail] or [email] marks content removed for privacy. Do not guess what it was, and do not comment on it.",
].join("\n");

function countWords(text: string): number {
  return text.trim().split(/\s+/).filter(Boolean).length;
}

interface Prepared {
  readonly statement: string;
  readonly essayPrompt: string | null;
  readonly redactionApplied: boolean;
}

function prepare(input: StatementFeedbackInput): Prepared {
  const st = redactStudentText(input.request.statement);
  const ep = input.request.essayPrompt ? redactStudentText(input.request.essayPrompt) : null;
  return { statement: st.text, essayPrompt: ep?.text ?? null, redactionApplied: st.applied || (ep?.applied ?? false) };
}

function build(input: StatementFeedbackInput, nonce: string): BuiltPrompt {
  const sources = assignSourceIds(input.programSources);
  const p = prepare(input);
  const r = input.request;
  const parts = ["SOURCES", sources.length > 0 ? renderSources(sources, nonce) : "No program sources supplied.", ""];
  parts.push("ESSAY PROMPT (as the student entered it)", fence("ESSAY_PROMPT", p.essayPrompt ?? "Not provided.", nonce), "");
  parts.push(`WORD LIMIT: ${r.wordLimit ?? "not stated"}`);
  parts.push(`WORD COUNT: ${countWords(r.statement)}`);
  parts.push(`FOCUS ASPECTS: ${r.focus.length > 0 ? r.focus.join(", ") : "all"}`, "");
  parts.push("STATEMENT", fence("STATEMENT", p.statement, nonce));
  return { input: parts.join("\n"), sources };
}

function finalize(
  out: StatementFeedbackModelOutput,
  input: StatementFeedbackInput,
  prompt: BuiltPrompt,
  meta: AiMeta,
): FinalizeResult<StatementFeedbackResponse> {
  const p = prepare(input);
  const issues: string[] = [];
  const clean = (label: string, text: string): boolean => {
    const claims = findScoreClaims(text, { banAllPercent: true });
    if (claims.length > 0) issues.push(`${label}: ${claims.join(", ")} is not allowed in feedback`);
    return claims.length === 0;
  };
  // Excerpts that are not verbatim are dropped (comment kept): a misquote must never be shown
  // to a student as their own words.
  const excerpt = (text: string): string | null => {
    const t = text.trim();
    return t.length > 0 && isVerbatim(t, p.statement) ? clampText(t, 300) : null;
  };

  if (!clean("overall", out.overall) || out.overall.trim() === "") {
    return { ok: false, reason: "validation_failed", issues: issues.length > 0 ? issues : ["overall is empty"] };
  }
  const strengths = out.strengths
    .filter((s, i) => clean(`strengths.${i}`, s.comment))
    .map((s) => ({ aspect: s.aspect, comment: clampText(s.comment, 600), excerpt: excerpt(s.excerpt) }))
    .slice(0, 6);
  const improvements = out.improvements
    .filter((s, i) => clean(`improvements.${i}`, `${s.comment} ${s.suggestion}`))
    .map((s) => ({
      aspect: s.aspect,
      comment: clampText(s.comment, 600),
      excerpt: excerpt(s.excerpt),
      suggestion: clampText(s.suggestion, 600),
    }))
    .slice(0, 8);
  const promptCoverage = out.promptCoverage
    .filter((c, i) => clean(`promptCoverage.${i}`, c.note))
    .map((c) => ({ promptPart: clampText(c.promptPart, 300), addressed: c.addressed, note: clampText(c.note, 400) }))
    .slice(0, 8);
  if (strengths.length + improvements.length === 0) {
    return { ok: false, reason: "validation_failed", issues: [...issues, "no usable strengths or improvements"] };
  }
  const ids = knownIds(prompt.sources);
  const wordCount = countWords(input.request.statement);
  const limit = input.request.wordLimit;
  const parsed = StatementFeedbackResponseSchema.safeParse({
    meta,
    wordCount,
    wordLimit: limit,
    overLimit: limit === null ? null : wordCount > limit,
    overall: clampText(out.overall, 1200),
    strengths,
    improvements,
    promptCoverage,
    citations: citationsFor(out.sourceIds.filter((id) => ids.has(id)), prompt.sources, 10),
    redactionApplied: p.redactionApplied,
  });
  if (!parsed.success) {
    return { ok: false, reason: "validation_failed", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, response: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Deterministic fallback: checks Novus can make without a model.
// ---------------------------------------------------------------------------------------------

const LONG_SENTENCE_WORDS = 40;

export function statementFallback(input: StatementFeedbackInput, meta: AiMeta): StatementFeedbackResponse {
  const r = input.request;
  const p = prepare(input);
  const wordCount = countWords(r.statement);
  const overLimit = r.wordLimit === null ? null : wordCount > r.wordLimit;
  const improvements: StatementFeedbackResponse["improvements"] = [];
  if (overLimit && r.wordLimit !== null) {
    improvements.push({
      aspect: "length",
      comment: `The statement has ${wordCount} words and the limit is ${r.wordLimit}.`,
      excerpt: null,
      suggestion: `Cut about ${wordCount - r.wordLimit} words; start with sentences that repeat a point.`,
    });
  }
  // Long sentences, quoted from the redacted text so nothing sensitive is echoed back.
  const sentences = p.statement.split(/(?<=[.!?])\s+/).filter((s) => countWords(s) > LONG_SENTENCE_WORDS);
  for (const s of sentences.slice(0, 2)) {
    improvements.push({
      aspect: "clarity",
      comment: `This sentence has ${countWords(s)} words, which is hard to follow in one read.`,
      excerpt: clampText(s, 300),
      suggestion: "Split it into two or three sentences, one idea each.",
    });
  }
  const paragraphs = r.statement.split(/\n\s*\n/).filter((x) => x.trim().length > 0).length;
  if (paragraphs <= 1 && wordCount > 250) {
    improvements.push({
      aspect: "structure",
      comment: "The statement is one block of text.",
      excerpt: null,
      suggestion: "Break it into paragraphs: an opening, two or three body paragraphs, and a closing that ties back to the program.",
    });
  }
  return StatementFeedbackResponseSchema.parse({
    meta,
    wordCount,
    wordLimit: r.wordLimit,
    overLimit,
    overall:
      "Written feedback is not available right now. These checks are made by Novus without AI; try again later for comments on content.",
    strengths: [],
    improvements: improvements.slice(0, 8),
    promptCoverage: [],
    citations: [],
    redactionApplied: p.redactionApplied,
  });
}

export const statementFeedbackRoute: PromptRoute<StatementFeedbackInput, StatementFeedbackModelOutput, StatementFeedbackResponse> = {
  id: "statement.feedback",
  system: SYSTEM,
  outputSchema: StatementFeedbackModelOutputSchema,
  jsonSchema: geminiResponseSchema(StatementFeedbackModelOutputSchema),
  build,
  finalize,
  fallback: statementFallback,
};
