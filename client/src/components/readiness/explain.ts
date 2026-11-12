/**
 * The deterministic explanation shown when the readiness assistant is unavailable (no API, no
 * Gemini key, or a provider error). It restates the four parts in plain words from the report
 * itself, so the screen degrades to something useful rather than an error. It never invents a
 * fact: every sentence is built from report fields.
 */
import type { ReadinessExplainResponse } from "@shared/contracts/ai";
import type { ReadinessReport } from "@shared/contracts/readiness";
import {
  BAND_LABELS,
  COMPETITIVENESS_HEADLINES,
  ELIGIBILITY_STATUS_LABELS,
  INSUFFICIENT_REASON_COPY,
  formatShortDate,
} from "./format";

const clip = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max - 1)}…`);

export function eligibilitySentence(report: ReadinessReport): string {
  const e = report.eligibility;
  const open = e.pending.length;
  if (e.status === "eligible") return "Every listed eligibility rule is met.";
  if (e.status === "not_eligible") return "At least one eligibility rule is not met for this cycle; the reasons are listed beside each rule.";
  if (e.status === "conditional") return `${ELIGIBILITY_STATUS_LABELS.conditional} ${open === 1 ? "one item is" : `${open} items are`} left for you to check, some of them privately on this device.`;
  return "Novus has not checked every rule yet, so compare the official page before you apply.";
}

export function requirementsSentence(report: ReadinessReport): string {
  const r = report.requirements;
  if (!r.checked) return "Novus has not checked this program's requirements yet; the official page lists them.";
  const gaps = r.items.filter((i) => i.state === "gap" || i.state === "unknown");
  const first = [...gaps].filter((i) => i.startBy).sort((a, b) => (a.startBy as string).localeCompare(b.startBy as string))[0];
  if (gaps.length === 0) return "Everything on the checklist is ready or in progress.";
  const startNote = first?.startBy ? ` Start "${first.label}" by ${formatShortDate(first.startBy)}.` : "";
  return `${gaps.length === 1 ? "One item still needs" : `${gaps.length} items still need`} work.${startNote}`;
}

export function competitivenessSentence(report: ReadinessReport): string {
  const c = report.competitiveness;
  if (c.status === "available" && c.band) return `${BAND_LABELS[c.band]} for this program. ${c.basis.summary}`;
  if (c.status === "insufficient_data") return `${COMPETITIVENESS_HEADLINES.insufficient_data}. ${INSUFFICIENT_REASON_COPY[c.reason ?? ""] ?? ""}`.trim();
  if (c.status === "official_odds_only") return `Only the program's official selection numbers are shown. ${c.basis.summary}`;
  return "This program does not select competitively.";
}

/** A ReadinessExplainResponse built without the model (meta.fallback = true). */
export function fallbackExplanation(report: ReadinessReport, status: "degraded" | "unavailable", now: Date = new Date()): ReadinessExplainResponse {
  const points = [
    { part: "eligibility" as const, text: clip(eligibilitySentence(report), 800), sourceIds: [] },
    { part: "requirements" as const, text: clip(requirementsSentence(report), 800), sourceIds: [] },
    { part: "competitiveness" as const, text: clip(competitivenessSentence(report), 800), sourceIds: [] },
  ];
  const suggestions = report.nextActions.slice(0, 3).map((a) => ({
    text: clip(a.dueOn ? `${a.label} by ${formatShortDate(a.dueOn)}.` : `${a.label}.`, 400),
    nextActionId: a.id,
    sourceIds: [],
  }));
  return {
    programCycleId: report.programCycleId,
    meta: {
      provider: "none",
      model: null,
      promptVersion: "client-fallback-v1",
      status,
      degradedReason: "disabled",
      generatedAt: now.toISOString(),
      fallback: true,
    },
    summary: clip(`${eligibilitySentence(report)} ${requirementsSentence(report)}`, 1200),
    points,
    suggestions,
    caveats: ["The assistant is not available, so this summary restates your report without it. Check dates on the official page."],
    citations: [],
  };
}
