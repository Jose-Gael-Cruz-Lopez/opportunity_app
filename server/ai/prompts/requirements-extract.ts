import { z } from "zod";
import { ExtractionPageV1Schema, PAGE_KINDS, type AiMeta, type RequirementKind } from "@shared/contracts";
import { PROMPT_LIMITS } from "../config";
import { geminiResponseSchema } from "../schema";
import { isVerbatim, stripLinksAndMarkup } from "../validate";
import { COMMON_RULES, fence, type BuiltPrompt, type FinalizeResult, type PromptRoute } from "./common";

/**
 * requirements.extract.v1: proposes the application requirements stated on one official program
 * page (public data only, no student content). Output reuses extraction.v1's requirement rows.
 * Proposals are drafts for a Curator: each carries flags, and a quote that is not on the page is
 * flagged QUOTE_NOT_ON_PAGE rather than trusted. The pipeline (pipeline/novus_llm) runs the full
 * page extraction; this route serves the Worker-side re-draft a Curator asks for.
 */

export const RequirementsExtractModelOutputSchema = z
  .object({
    page_kind: z.enum(PAGE_KINDS),
    requirements: ExtractionPageV1Schema.shape.requirements,
  })
  .strict();
export type RequirementsExtractModelOutput = z.infer<typeof RequirementsExtractModelOutputSchema>;

export const REQUIREMENT_FLAGS = ["QUOTE_NOT_ON_PAGE", "DETAIL_TOO_LONG", "DETAIL_HAD_LINK_OR_MARKUP", "DUPLICATE"] as const;
export type RequirementFlag = (typeof REQUIREMENT_FLAGS)[number];

export interface ProposedRequirement {
  readonly kind: RequirementKind;
  /** Links and markup stripped; untrusted until a Curator confirms it. */
  readonly detail: string;
  readonly quote: string;
  readonly quoteOnPage: boolean;
  readonly flags: readonly RequirementFlag[];
}

export interface RequirementsExtractResult {
  readonly meta: AiMeta;
  readonly pageKind: (typeof PAGE_KINDS)[number] | null;
  readonly requirements: readonly ProposedRequirement[];
}

export interface RequirementsExtractInput {
  readonly pageText: string;
  readonly pageUrl: string;
  readonly programName: string | null;
  readonly fetchedOn: string | null;
}

const MAX_DETAIL = 200;

const SYSTEM = [
  COMMON_RULES,
  "",
  "Task: list the application requirements stated on one official program page, for a Novus Curator to verify.",
  "page_kind: what the page is (current cycle, next cycle announced, past cycle, program ended, not a program page, or mixed).",
  "requirements: one row per distinct requirement (for example a resume, two recommendation letters, a transcript, an essay, an interview). kind from the enum; detail is a short neutral description under 200 characters with no links; quote is copied exactly from the page text and shows the requirement.",
  "Only list requirements the page states. Do not infer from other programs. An empty list is a valid answer.",
].join("\n");

function build(input: RequirementsExtractInput, nonce: string): BuiltPrompt {
  const head = [`url: ${input.pageUrl}`];
  if (input.programName) head.push(`program: ${input.programName}`);
  if (input.fetchedOn) head.push(`fetched: ${input.fetchedOn}`);
  const text = input.pageText.slice(0, PROMPT_LIMITS.maxPageChars);
  return { input: ["PAGE", fence("PAGE", `${head.join("\n")}\n---\n${text}`, nonce)].join("\n"), sources: [] };
}

function finalize(
  out: RequirementsExtractModelOutput,
  input: RequirementsExtractInput,
  _prompt: BuiltPrompt,
  meta: AiMeta,
): FinalizeResult<RequirementsExtractResult> {
  const seen = new Set<string>();
  const requirements = out.requirements.map((r): ProposedRequirement => {
    const flags: RequirementFlag[] = [];
    const stripped = stripLinksAndMarkup(r.detail);
    if (stripped !== r.detail.trim()) flags.push("DETAIL_HAD_LINK_OR_MARKUP");
    if (stripped.length > MAX_DETAIL) flags.push("DETAIL_TOO_LONG");
    const quoteOnPage = isVerbatim(r.quote, input.pageText);
    if (!quoteOnPage) flags.push("QUOTE_NOT_ON_PAGE");
    const key = `${r.kind}|${stripped.toLowerCase()}`;
    if (seen.has(key)) flags.push("DUPLICATE");
    seen.add(key);
    return { kind: r.kind, detail: stripped.slice(0, MAX_DETAIL), quote: r.quote.slice(0, 2000), quoteOnPage, flags };
  });
  return { ok: true, response: { meta, pageKind: out.page_kind, requirements } };
}

export function requirementsFallback(_input: RequirementsExtractInput, meta: AiMeta): RequirementsExtractResult {
  // No draft: the Curator proceeds by hand, which is the normal path without AI.
  return { meta, pageKind: null, requirements: [] };
}

export const requirementsExtractRoute: PromptRoute<RequirementsExtractInput, RequirementsExtractModelOutput, RequirementsExtractResult> = {
  id: "requirements.extract",
  system: SYSTEM,
  outputSchema: RequirementsExtractModelOutputSchema,
  jsonSchema: geminiResponseSchema(RequirementsExtractModelOutputSchema),
  build,
  finalize,
  fallback: requirementsFallback,
};
