import type { ProgramCard } from "@shared/contracts";
import type { AiSourceInput } from "@server/ai";
import { programSources } from "./readiness";
import type { ReadinessSource } from "./ports";

/**
 * Retrieval for Ask Novus. The model answers only from these sources, so they are built from
 * published registry records (cards or one program's record), never from anything about the
 * student. Card text keeps the published values verbatim (dates as published, official URLs) so
 * the assistant's date and citation checks can match them.
 */

/** Cards passed to the model for an open question (judgment: enough context, small prompt). */
export const ASK_MAX_CARDS = 5;

function cardText(card: ProgramCard): string {
  const lines: string[] = [];
  if (card.isSample) lines.push("SAMPLE RECORD: invented for demonstration, not a real program.");
  lines.push(`${card.name}, offered by ${card.organizationName}. Cycle ${card.cycleKey}, status ${card.status.replace(/_/g, " ")}.`);
  if (card.summary) lines.push(card.summary);
  if (card.opportunityTypes.length > 0) lines.push(`Types: ${card.opportunityTypes.map((t) => t.replace(/_/g, " ")).join(", ")}.`);
  if (card.opensOn) lines.push(`Opens on ${card.opensOn}.`);
  for (const d of card.deadlines) {
    const when = d.localDate ?? (d.windowStart && d.windowEnd ? `${d.windowStart} to ${d.windowEnd}` : d.precision);
    const time = d.localTime ? ` ${d.localTime}` : "";
    lines.push(`Deadline (${d.kind.replace(/_/g, " ")}${d.basis === "official" ? "" : `, ${d.basis}`}): ${when}${time}.`);
  }
  if (card.classYears.length > 0) lines.push(`Class years: ${card.classYears.map((y) => y.replace(/_/g, " ")).join(", ")}.`);
  for (const rule of card.rules?.rules ?? []) lines.push(`Eligibility as officially stated: ${rule.officialText}`);
  lines.push(`Verification: ${card.verification.state.replace(/_/g, " ")}${card.verification.verifiedOn ? ` on ${card.verification.verifiedOn}` : ""}.`);
  return lines.join("\n");
}

export function cardSources(cards: readonly ProgramCard[], origin: string): AiSourceInput[] {
  const base = origin.replace(/\/$/, "");
  return cards.slice(0, ASK_MAX_CARDS).map((card) => ({
    kind: "novus_record" as const,
    title: `${card.name}: Novus record`.slice(0, 200),
    url: `${base}/programs/${card.slug}`,
    programSlug: card.slug,
    text: cardText(card),
    retrievedOn: null,
  }));
}

export function cardRefs(cards: readonly ProgramCard[]): { slug: string; name: string }[] {
  return cards.slice(0, ASK_MAX_CARDS).map((c) => ({ slug: c.slug, name: c.name.slice(0, 200) }));
}

/** Sources and refs for a question about one named program. */
export function programAskContext(source: ReadinessSource, origin: string): { sources: AiSourceInput[]; programRefs: { slug: string; name: string }[] } {
  return {
    sources: programSources(source, origin),
    programRefs: [{ slug: source.program.slug, name: source.program.name.slice(0, 200) }],
  };
}
