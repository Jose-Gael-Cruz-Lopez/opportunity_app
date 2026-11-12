import {
  AskModelOutputSchema,
  AskResponseSchema,
  type AiMeta,
  type AskModelOutput,
  type AskRequest,
  type AskResponse,
} from "@shared/contracts";
import { isSensitiveEligibilityQuestion, redactStudentText } from "../redact";
import { geminiResponseSchema } from "../schema";
import { clampText, findScoreClaims, unsupportedDates } from "../validate";
import {
  assignSourceIds,
  citationsFor,
  COMMON_RULES,
  fence,
  joinSourceText,
  knownIds,
  renderSources,
  type AiSourceInput,
  type BuiltPrompt,
  type FinalizeResult,
  type Precheck,
  type PromptRoute,
} from "./common";

/**
 * ask.answer.v1 ("Ask Novus"): answers a question about programs using only the program records
 * the caller retrieved (shared/matching search) and official source text. The model never sees
 * the student's profile here. Questions asking Novus to judge a status or identity criterion are
 * declined before any call and pointed to the on-device check.
 */

export interface AskInput {
  readonly request: AskRequest;
  /** Retrieved Novus records and official text, most relevant first. */
  readonly sources: readonly AiSourceInput[];
  readonly programRefs: readonly { readonly slug: string; readonly name: string }[];
}

const SYSTEM = [
  COMMON_RULES,
  "",
  "Task: answer a student's question about opportunities using only the supplied program sources.",
  "answer: at most 150 words, plain text, no links. State dates exactly as the sources state them.",
  "answerType: answered if the sources fully answer it, partial if only in part, not_in_sources if they do not.",
  "sourceIds: every source id the answer relies on; at least one unless answerType is not_in_sources.",
  "followUps: up to three short follow-up questions the student might ask next; may be empty.",
  "If the question asks whether the student personally qualifies under a status or identity rule, answer not_in_sources and say the rule can be checked privately on their device.",
].join("\n");

const DECLINED_ANSWER =
  "Novus does not judge status or identity criteria. Use the private eligibility check on your device, which never sends your answers to Novus, and read the official rule on the program page.";
const NOT_IN_SOURCES_ANSWER = "Novus does not have a verified record that answers this yet. Try searching for a program by name.";

function precheck(input: AskInput): Precheck<AskResponse> {
  if (isSensitiveEligibilityQuestion(input.request.question)) {
    return {
      proceed: false,
      response: (meta) =>
        AskResponseSchema.parse({ meta, answer: DECLINED_ANSWER, answerType: "declined_sensitive", citations: [], programRefs: refs(input), followUps: [] }),
    };
  }
  if (input.sources.length === 0) {
    return {
      proceed: false,
      response: (meta) =>
        AskResponseSchema.parse({ meta, answer: NOT_IN_SOURCES_ANSWER, answerType: "not_in_sources", citations: [], programRefs: [], followUps: [] }),
    };
  }
  return { proceed: true };
}

function refs(input: AskInput): AskResponse["programRefs"] {
  return input.programRefs.slice(0, 10).map((r) => ({ slug: r.slug, name: r.name.slice(0, 200) }));
}

function build(input: AskInput, nonce: string): BuiltPrompt {
  const sources = assignSourceIds(input.sources);
  const question = redactStudentText(input.request.question).text;
  const parts = ["SOURCES", renderSources(sources, nonce), "", "QUESTION", fence("QUESTION", question, nonce)];
  return { input: parts.join("\n"), sources };
}

function finalize(out: AskModelOutput, input: AskInput, prompt: BuiltPrompt, meta: AiMeta): FinalizeResult<AskResponse> {
  const issues: string[] = [];
  const ids = knownIds(prompt.sources);
  const sourceText = joinSourceText(prompt.sources);
  const claims = findScoreClaims(out.answer, { banAllPercent: false });
  if (claims.length > 0) issues.push(`answer: ${claims.join(", ")} about the student is not allowed`);
  for (const d of unsupportedDates(out.answer, sourceText)) issues.push(`answer: date ${d} is not in any source`);
  if (out.answer.trim() === "") issues.push("answer is empty");
  if (issues.length > 0) return { ok: false, reason: "validation_failed", issues };

  const cited = out.sourceIds.filter((id) => ids.has(id));
  const unknown = out.sourceIds.filter((id) => !ids.has(id));
  const citations = citationsFor(cited, prompt.sources, 10);
  if (out.answerType !== "not_in_sources" && citations.length === 0) {
    return { ok: false, reason: "citation_check_failed", issues: [`answer cites no supplied source${unknown.length ? ` (unknown: ${unknown.join(", ")})` : ""}`] };
  }
  const followUps = out.followUps
    .map((f) => clampText(f, 200))
    .filter((f) => f.length > 0 && findScoreClaims(f, { banAllPercent: false }).length === 0)
    .slice(0, 4);
  const parsed = AskResponseSchema.safeParse({
    meta,
    answer: clampText(out.answer, 2000),
    answerType: out.answerType,
    citations,
    programRefs: refs(input),
    followUps,
  });
  if (!parsed.success) {
    return { ok: false, reason: "validation_failed", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, response: parsed.data };
}

/** Without a model: list the retrieved records so the student can read them directly. */
export function askFallback(input: AskInput, meta: AiMeta): AskResponse {
  const pre = precheck(input);
  if (!pre.proceed) return pre.response(meta);
  const sources = assignSourceIds(input.sources).slice(0, 5);
  const titles = sources.map((s) => s.title).join("; ");
  return AskResponseSchema.parse({
    meta,
    answer: clampText(`The assistant is not available right now. These Novus records match your question: ${titles}.`, 2000),
    answerType: "partial",
    citations: citationsFor(
      sources.map((s) => s.id),
      sources,
      10,
    ),
    programRefs: refs(input),
    followUps: [],
  });
}

export const askRoute: PromptRoute<AskInput, AskModelOutput, AskResponse> = {
  id: "ask.answer",
  system: SYSTEM,
  outputSchema: AskModelOutputSchema,
  jsonSchema: geminiResponseSchema(AskModelOutputSchema),
  precheck,
  build,
  finalize,
  fallback: askFallback,
};
