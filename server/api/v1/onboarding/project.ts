import type { OpportunityTypeSlug } from "@shared/contracts";
import { isCleanTerm } from "./guard";
import type { AiResumeProfile } from "./schemas";
import { AiResumeProfileSchema, toExperienceKinds } from "./schemas";
import type { CatalogEntry, FirstDoorChoice, MatchSet, MatchTier } from "./ports";

/**
 * Response projections. Each builds the response field by field from the engine's output instead
 * of passing objects through, so an internal value (an RRF score, a debug field) can never reach
 * the student even if the engine adds one later. Rule 4: tiers, reasons and counts only.
 */

export interface MatchCard {
  readonly programId: string;
  readonly slug: string;
  readonly name: string;
  readonly opportunityTypes: readonly OpportunityTypeSlug[];
  /** Sample programs must be labelled in the UI. */
  readonly isSample: boolean;
  readonly tier: MatchTier;
  readonly reasons: readonly string[];
  readonly feasibility: { readonly startBy: string; readonly daysLeft: number; readonly enoughTime: boolean };
  readonly requirementsMet: { readonly met: number; readonly total: number };
}

const TIERS: readonly MatchTier[] = ["strong", "good", "stretch"];
const MAX_REASONS = 3;

export function projectMatches(matches: MatchSet, catalog: readonly CatalogEntry[], k: number): MatchCard[] {
  const byId = new Map(catalog.map((e) => [e.program.id, e.program]));
  const cards: MatchCard[] = [];
  const seen = new Set<string>();
  for (const item of matches.items) {
    const program = byId.get(item.programId);
    // Unknown ids, duplicates and invalid tiers are dropped rather than trusted.
    if (!program || seen.has(item.programId) || !TIERS.includes(item.tier)) continue;
    seen.add(item.programId);
    cards.push({
      programId: program.id,
      slug: program.slug,
      name: program.name,
      opportunityTypes: [...program.opportunityTypes],
      isSample: program.isSample,
      tier: item.tier,
      reasons: item.reasons.slice(0, MAX_REASONS).map((r) => String(r).slice(0, 160)),
      feasibility: {
        startBy: String(item.feasibility.startBy),
        daysLeft: Math.trunc(item.feasibility.daysLeft),
        enoughTime: item.feasibility.enoughTime === true,
      },
      requirementsMet: {
        met: Math.max(0, Math.trunc(item.requirementsMet.met)),
        total: Math.max(0, Math.trunc(item.requirementsMet.total)),
      },
    });
    if (cards.length >= k) break;
  }
  // Stable tier order (strong, good, stretch) while keeping the engine's order inside a tier.
  return cards
    .map((card, i) => ({ card, i }))
    .sort((a, b) => TIERS.indexOf(a.card.tier) - TIERS.indexOf(b.card.tier) || a.i - b.i)
    .map(({ card }) => card);
}

export interface FirstDoorOptionOut {
  readonly programId: string;
  readonly rationale: string;
}

/** Up to three first-door options, each pointing at a card in the same response. */
export function projectFirstDoor(choice: FirstDoorChoice, cards: readonly MatchCard[]): FirstDoorOptionOut[] {
  const ids = new Set(cards.map((c) => c.programId));
  const out: FirstDoorOptionOut[] = [];
  for (const option of choice.options) {
    if (!ids.has(option.programId) || out.some((o) => o.programId === option.programId)) continue;
    out.push({ programId: option.programId, rationale: String(option.rationale).slice(0, 160) });
    if (out.length === 3) break;
  }
  return out;
}

/** Keeps distinct, guard-clean, non-empty terms in first-seen order (case-insensitive). */
export function cleanTerms(terms: readonly string[], max: number): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = raw.replace(/\s+/g, " ").trim();
    const key = term.toLowerCase();
    if (!term || term.length > 60 || seen.has(key) || !isCleanTerm(term)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= max) break;
  }
  return out;
}

/**
 * Validates and cleans model output. Model output is untrusted: it may invent a sensitive
 * organisation or echo a contact detail, so every string is re-checked and dropped on any hit.
 * Returns null when the output does not match the schema at all.
 */
export function sanitizeAiProfile(raw: unknown): AiResumeProfile | null {
  const parsed = AiResumeProfileSchema.safeParse(raw);
  if (!parsed.success) return null;
  return {
    skills: cleanTerms(parsed.data.skills, 60),
    fields: cleanTerms(parsed.data.fields, 10),
    courseworkKeywords: cleanTerms(parsed.data.courseworkKeywords, 40),
    experienceKinds: toExperienceKinds(parsed.data.experienceKinds),
  };
}
