import {
  ReadinessExplainModelOutputSchema,
  ReadinessExplainResponseSchema,
  type AiMeta,
  type AiSource,
  type ReadinessExplainModelOutput,
  type ReadinessExplainRequest,
  type ReadinessExplainResponse,
  type ReadinessReport,
  type StudentProfile,
} from "@shared/contracts";
import { describePromptProfile, renderReadinessFacts, selectPromptProfile } from "../allowlist";
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
  type PromptRoute,
} from "./common";

/**
 * readiness.explain.v1: explains the deterministic ReadinessReport (four parts) in plain words,
 * with each point citing the Novus report (s1) or a program source. It never decides anything:
 * the report is the single source of truth, and the fallback renders the same report as text.
 */

export interface ReadinessExplainInput {
  readonly report: ReadinessReport;
  readonly profile: StudentProfile;
  readonly request: ReadinessExplainRequest;
  /** Official program text (requirements, essay prompts), with URLs, chosen by the caller. */
  readonly programSources: readonly AiSourceInput[];
  readonly programName?: string;
  /** True only when the program's rules state a GPA criterion. */
  readonly includeGpaBand?: boolean;
}

const SENSITIVE_QUESTION_CAVEAT =
  "Questions about personal status or identity criteria are answered by the check on your device and the official rules, not by the assistant.";
const ON_DEVICE_CAVEAT = "Some criteria are checked only on your device, and Novus never sees your answers.";

const SYSTEM = [
  COMMON_RULES,
  "",
  "Task: explain a student's readiness report for one program. The report has exactly four parts: eligibility (with reasons), requirements (a checklist naming each gap), competitiveness (a band, or a status saying why there is none) and next actions.",
  "Source s1 is the Novus readiness report. Other sources are official program text.",
  "summary: two or three sentences on where the student stands and the single most useful next step.",
  "points: one to eight short points, each tagged with the part it explains and citing at least one source id.",
  "suggestions: up to four concrete steps. Use the bracketed next-action id from the report as nextActionId when the step matches one, otherwise an empty string.",
  "caveats: limits the student should know (for example, that requirements are unverified); may be empty.",
  "Describe a competitiveness band only with the words in the report. Official counts are about the program, never about the student.",
].join("\n");

function prepareQuestion(input: ReadinessExplainInput): { text: string | null; declined: boolean } {
  const q = input.request.question;
  if (!q) return { text: null, declined: false };
  if (isSensitiveEligibilityQuestion(q)) return { text: null, declined: true };
  return { text: redactStudentText(q).text, declined: false };
}

function hasOnDeviceRules(report: ReadinessReport): boolean {
  const e = report.eligibility;
  return e.sensitiveEvaluated || e.rules.some((r) => r.sensitive) || e.pending.some((p) => p.sensitive);
}

function build(input: ReadinessExplainInput, nonce: string): BuiltPrompt {
  const reportSource: AiSourceInput = {
    kind: "readiness_report",
    title: `Novus readiness report${input.programName ? ` for ${input.programName}` : ""}`,
    url: null,
    programSlug: input.report.programSlug,
    text: renderReadinessFacts(input.report),
    retrievedOn: input.report.generatedAt.slice(0, 10),
  };
  const sources = assignSourceIds([reportSource, ...input.programSources]);
  const profileLines = describePromptProfile(
    selectPromptProfile(input.profile, { includeGpaBand: input.includeGpaBand === true }),
  );
  const q = prepareQuestion(input);
  const parts = [
    "SOURCES",
    renderSources(sources, nonce),
    "",
    "STUDENT (non-sensitive profile facts the student chose to share)",
    fence("PROFILE", profileLines.length > 0 ? profileLines.join("\n") : "No profile details shared.", nonce),
    "",
    `FOCUS: ${input.request.focus}`,
  ];
  if (q.text) parts.push("", "STUDENT QUESTION", fence("QUESTION", q.text, nonce));
  return { input: parts.join("\n"), sources };
}

function finalize(
  out: ReadinessExplainModelOutput,
  input: ReadinessExplainInput,
  prompt: BuiltPrompt,
  meta: AiMeta,
): FinalizeResult<ReadinessExplainResponse> {
  const ids = knownIds(prompt.sources);
  const sourceText = joinSourceText(prompt.sources);
  const actionIds = new Set(input.report.nextActions.map((a) => a.id));
  const issues: string[] = [];
  const textIssues = (label: string, text: string): string[] => {
    const found = findScoreClaims(text, { banAllPercent: true }).map((k) => `${label}: ${k} about the student is not allowed`);
    for (const d of unsupportedDates(text, sourceText)) found.push(`${label}: date ${d} is not in any source`);
    return found;
  };

  issues.push(...textIssues("summary", out.summary));
  if (out.summary.trim().length === 0) issues.push("summary is empty");

  const points = out.points
    .map((p) => ({ part: p.part, text: clampText(p.text, 800), sourceIds: p.sourceIds.filter((id) => ids.has(id)) }))
    .filter((p, i) => {
      const bad = textIssues(`points.${i}`, p.text);
      if (p.sourceIds.length === 0) bad.push(`points.${i}: cites no supplied source`);
      issues.push(...bad.map((b) => `${b} (dropped)`));
      return bad.length === 0 && p.text.length > 0;
    })
    .slice(0, 12);

  const suggestions = out.suggestions
    .map((s) => {
      const nextActionId = actionIds.has(s.nextActionId) ? s.nextActionId : null;
      let sourceIds = s.sourceIds.filter((id) => ids.has(id));
      // A step tied to a report action is grounded in the report even if the model forgot s1.
      if (sourceIds.length === 0 && nextActionId) sourceIds = ["s1"];
      return { text: clampText(s.text, 400), nextActionId, sourceIds };
    })
    .filter((s, i) => {
      const bad = textIssues(`suggestions.${i}`, s.text);
      if (s.sourceIds.length === 0) bad.push(`suggestions.${i}: cites no supplied source`);
      issues.push(...bad.map((b) => `${b} (dropped)`));
      return bad.length === 0 && s.text.length > 0;
    })
    .slice(0, 6);

  const caveats = out.caveats
    .map((c) => clampText(c, 300))
    .filter((c) => c.length > 0 && findScoreClaims(c, { banAllPercent: true }).length === 0);
  const q = prepareQuestion(input);
  if (q.declined) caveats.unshift(SENSITIVE_QUESTION_CAVEAT);

  const summaryBroken = issues.some((i) => i.startsWith("summary"));
  if (summaryBroken) return { ok: false, reason: "validation_failed", issues };
  if (points.length === 0) return { ok: false, reason: "citation_check_failed", issues: [...issues, "no point survived the citation check"] };

  const cited = [...points.flatMap((p) => p.sourceIds), ...suggestions.flatMap((s) => s.sourceIds)];
  const candidate = {
    programCycleId: input.report.programCycleId,
    meta,
    summary: clampText(out.summary, 1200),
    points,
    suggestions,
    caveats: caveats.slice(0, 5),
    citations: citationsFor(cited, prompt.sources, 20),
  };
  const parsed = ReadinessExplainResponseSchema.safeParse(candidate);
  if (!parsed.success) {
    return { ok: false, reason: "validation_failed", issues: parsed.error.issues.slice(0, 5).map((i) => `${i.path.join(".")}: ${i.message}`) };
  }
  return { ok: true, response: parsed.data };
}

// ---------------------------------------------------------------------------------------------
// Deterministic fallback: the same report, rendered by templates.
// ---------------------------------------------------------------------------------------------

const ELIGIBILITY_COPY: Record<ReadinessReport["eligibility"]["status"], string> = {
  eligible: "Based on the rules Novus has checked, you meet this program's listed eligibility requirements.",
  conditional: "You may be eligible. A few items are still open, and each one is listed in your readiness report.",
  unknown: "Novus has not checked every eligibility rule for this program yet, so confirm the rules on the official page.",
  not_eligible: "Based on the rules Novus has checked, at least one listed requirement is not met. The reason is shown in your readiness report.",
};

function competitivenessText(report: ReadinessReport): string {
  const c = report.competitiveness;
  switch (c.status) {
    case "available":
      return `Competitiveness band: ${(c.band ?? "").replace(/_/g, " ")}. ${c.basis.summary}`;
    case "official_odds_only":
      return `Novus shows only the program's official counts here. ${c.basis.summary}`;
    case "insufficient_data":
      return `Novus does not have enough data to place this program in a band yet${c.reason ? ` (${c.reason.replace(/_/g, " ")})` : ""}.`;
    case "not_applicable":
      return "A competitiveness band does not apply to this program.";
  }
}

function requirementsText(report: ReadinessReport): string {
  const r = report.requirements;
  if (!r.checked) return "Novus has not checked this program's requirements yet; see the official page.";
  const open = r.items.filter((i) => i.state === "gap" || i.state === "unknown");
  if (open.length === 0) return "Every requirement Novus checked is met or in progress.";
  return open
    .slice(0, 4)
    .map((i) => `${i.label}: ${i.gap ?? "still to confirm"}${i.startBy ? ` (start by ${i.startBy})` : ""}.`)
    .join(" ");
}

export function readinessFallback(input: ReadinessExplainInput, meta: AiMeta): ReadinessExplainResponse {
  const { report } = input;
  const actions = report.nextActions.slice(0, 3);
  const eligibility = hasOnDeviceRules(report)
    ? `${ELIGIBILITY_COPY[report.eligibility.status]} Some criteria are checked only on your device.`
    : ELIGIBILITY_COPY[report.eligibility.status];
  const pointsByPart = {
    eligibility: { part: "eligibility" as const, text: clampText(eligibility, 800), sourceIds: ["s1"] },
    requirements: { part: "requirements" as const, text: clampText(requirementsText(report), 800), sourceIds: ["s1"] },
    competitiveness: { part: "competitiveness" as const, text: clampText(competitivenessText(report), 800), sourceIds: ["s1"] },
    next_actions: {
      part: "next_actions" as const,
      text: clampText(
        actions.length > 0
          ? `Next: ${actions.map((a) => `${a.label}${a.dueOn ? ` (by ${a.dueOn})` : ""}`).join("; ")}.`
          : "There are no open next actions for this program.",
        800,
      ),
      sourceIds: ["s1"],
    },
  };
  const order = ["eligibility", "requirements", "competitiveness", "next_actions"] as const;
  const focus = input.request.focus;
  const sorted = focus === "overview" ? order : [focus, ...order.filter((p) => p !== focus)];
  const caveats: string[] = [];
  if (prepareQuestion(input).declined) caveats.push(SENSITIVE_QUESTION_CAVEAT);
  if (hasOnDeviceRules(report)) caveats.push(ON_DEVICE_CAVEAT);
  if (report.eligibility.basedOnListedRequirements) caveats.push("The eligibility result rests only on requirements the program lists.");
  if (!report.requirements.checked) caveats.push("Requirements are not yet verified by Novus.");
  const s1: AiSource = {
    id: "s1",
    kind: "readiness_report",
    title: "Novus readiness report",
    url: null,
    programSlug: report.programSlug,
    text: "",
    retrievedOn: null,
  };
  return ReadinessExplainResponseSchema.parse({
    programCycleId: report.programCycleId,
    meta,
    summary: clampText(eligibility, 1200),
    points: sorted.map((p) => pointsByPart[p]),
    suggestions: actions.map((a) => ({ text: clampText(a.label, 400), nextActionId: a.id.slice(0, 80), sourceIds: ["s1"] })),
    caveats: caveats.slice(0, 5).map((c) => clampText(c, 300)),
    citations: citationsFor(["s1"], [s1], 20),
  });
}

export const readinessExplainRoute: PromptRoute<ReadinessExplainInput, ReadinessExplainModelOutput, ReadinessExplainResponse> = {
  id: "readiness.explain",
  system: SYSTEM,
  outputSchema: ReadinessExplainModelOutputSchema,
  jsonSchema: geminiResponseSchema(ReadinessExplainModelOutputSchema),
  build,
  finalize,
  fallback: readinessFallback,
};
