import { PRODUCT } from "@shared/config/product";
import { addDays } from "@shared/time";
import type { AiCitation, AiMeta, AskResponse } from "@shared/contracts";
import { personalDisclosure } from "@/lib/personal-disclosure";

/**
 * Pure logic for Ask Novus: suggestion tiles, input checks, the "AI is off" states and how answers
 * with citation markers are split for display. Nothing here talks to the network.
 */

// ---------------------------------------------------------------------------------------------
// Suggestions
// ---------------------------------------------------------------------------------------------

export type SuggestionIcon = "calendar" | "users" | "list" | "award";

export interface Suggestion {
  readonly id: string;
  readonly icon: SuggestionIcon;
  readonly question: string;
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

function dayMonth(iso: string): string {
  const [, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTHS[(m ?? 1) - 1]}`;
}

/** Four tiles. The first names a real date three weeks out so it is always a useful question. */
export function suggestions(today: string): Suggestion[] {
  return [
    { id: "before-date", icon: "calendar", question: `What can I apply to before ${dayMonth(addDays(today, 21))}?` },
    { id: "second-years", icon: "users", question: "Which programs take first- and second-year students?" },
    { id: "research-needs", icon: "list", question: "What does a summer research application usually ask for?" },
    { id: "nominations", icon: "award", question: "How do campus nominations work, and when is the campus deadline?" },
  ];
}

// ---------------------------------------------------------------------------------------------
// Input checks
// ---------------------------------------------------------------------------------------------

export type QuestionCheck =
  | { readonly ok: true; readonly question: string }
  | { readonly ok: false; readonly reason: "too_short" | "too_long" | "personal_status"; readonly topic?: string };

/**
 * A question that pairs a sensitive topic with the student describing themselves ("I'm a DACA
 * recipient", "my family's income") is stopped in the browser: the answer would be a
 * SensitiveAnswer, which never leaves the device. Questions about a program's rule ("does it
 * require citizenship?") go through. The detector is shared with the readiness assistant.
 */
export { personalDisclosure } from "@/lib/personal-disclosure";

export function checkQuestion(raw: string): QuestionCheck {
  const question = raw.replace(/\s+/g, " ").trim();
  if (question.length < 3) return { ok: false, reason: "too_short" };
  if (question.length > PRODUCT.ai.maxQuestionChars) return { ok: false, reason: "too_long" };
  const topic = personalDisclosure(question);
  if (topic) return { ok: false, reason: "personal_status", topic };
  return { ok: true, question };
}

// ---------------------------------------------------------------------------------------------
// Assistant state
// ---------------------------------------------------------------------------------------------

export type AssistantState =
  /** The student turned the assistant off on this device. */
  | "off_by_you"
  /** The server has no Gemini key or AI is disabled: answers are plain search results. */
  | "off_on_server"
  /** The model was tried but this answer came from the fallback. */
  | "degraded"
  | "on"
  /** No answer yet, so the server state is not known. */
  | "unknown";

export function assistantState(enabledOnDevice: boolean, lastMeta: AiMeta | null): AssistantState {
  if (!enabledOnDevice) return "off_by_you";
  if (!lastMeta) return "unknown";
  if (lastMeta.status === "ok") return "on";
  if (lastMeta.degradedReason === "no_api_key" || lastMeta.degradedReason === "disabled") return "off_on_server";
  return "degraded";
}

const DEGRADED_WORDS: Record<NonNullable<AiMeta["degradedReason"]>, string> = {
  no_api_key: "The AI assistant is not set up on this server yet.",
  disabled: "The AI assistant is switched off on this server.",
  provider_error: "The AI service had an error.",
  timeout: "The AI service took too long.",
  rate_limited: "You have reached today's limit for AI answers.",
  budget_exceeded: "The AI assistant has reached its budget for today.",
  validation_failed: "The AI answer did not pass Novus's checks.",
  citation_check_failed: "The AI answer quoted something its sources do not say, so Novus did not show it.",
  safety_blocked: "The AI service declined to answer this.",
};

export function degradedMessage(meta: AiMeta): string | null {
  if (meta.status === "ok" || !meta.degradedReason) return null;
  const why = DEGRADED_WORDS[meta.degradedReason];
  return meta.fallback ? `${why} This answer is a plain search of Novus records, not AI.` : why;
}

export const ANSWER_TYPE_WORDS: Record<AskResponse["answerType"], string> = {
  answered: "Answered from sources",
  partial: "Partly answered: the sources do not cover everything",
  not_in_sources: "Not in Novus sources",
  declined_sensitive: "Checked on your device instead",
};

// ---------------------------------------------------------------------------------------------
// Citations in answer text
// ---------------------------------------------------------------------------------------------

export type AnswerSegment =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "cite"; readonly sourceId: string; readonly number: number };

/** Numbers citations in the order the server returned them: s3 might be [1]. */
export function citationNumbers(citations: readonly AiCitation[]): Map<string, number> {
  return new Map(citations.map((c, i) => [c.sourceId, i + 1]));
}

/**
 * Splits answer text on markers like [s1] or [s1, s2]. Markers for ids not in `citations` are
 * dropped rather than shown, since an uncited marker would point at nothing.
 */
export function splitAnswer(answer: string, citations: readonly AiCitation[]): AnswerSegment[] {
  const numbers = citationNumbers(citations);
  const out: AnswerSegment[] = [];
  const re = /\[(s\d{1,3}(?:\s*,\s*s\d{1,3})*)\]/g;
  let last = 0;
  for (const m of answer.matchAll(re)) {
    const start = m.index ?? 0;
    if (start > last) out.push({ kind: "text", text: answer.slice(last, start) });
    for (const id of (m[1] ?? "").split(/\s*,\s*/)) {
      const n = numbers.get(id);
      if (n !== undefined) out.push({ kind: "cite", sourceId: id, number: n });
    }
    last = start + m[0].length;
  }
  if (last < answer.length) out.push({ kind: "text", text: answer.slice(last) });
  // Tidy a space left before a dropped marker at the end of a sentence.
  return out.filter((s) => s.kind === "cite" || s.text.length > 0);
}

/** Reads ?program=slug so a program page can open Ask scoped to that program. */
export function programFromSearch(search: string): string | null {
  const value = new URLSearchParams(search).get("program");
  return value && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value) && value.length <= 120 ? value : null;
}
