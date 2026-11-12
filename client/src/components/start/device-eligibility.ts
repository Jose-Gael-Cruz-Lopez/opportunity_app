import type { EligibilityRuleSet, ProgramCard, SensitiveAnswers, StudentProfile } from "@shared/contracts";
import { SensitiveAnswersSchema } from "@shared/contracts";
import { buildEvalContext } from "@shared/eligibility";
// BROWSER ONLY: the one evaluator that reads SensitiveAnswers. Nothing under server/ imports it
// (shared/eligibility/privacy-boundary.test.ts walks the graph to prove it).
import { evaluateWithAnswers } from "@shared/eligibility/sensitive";
import { defaultEligibility, type EligibilityAdapter, type EligibilityOutcome } from "@shared/onboarding";
import type { EligibilityRow, PrivateAnswers, PrivateField } from "./readiness-view";

/** Fields the private screen can answer (readiness-view.ts's PRIVATE_FIELDS; kept here to avoid an import cycle). */
const PRIVATE_FIELDS: readonly PrivateField[] = ["citizenship", "pell", "firstGeneration"];

/**
 * On-device eligibility for /app/start: @shared/eligibility/sensitive's evaluateWithAnswers with
 * the private answers the student typed into this tab (citizenship, Pell, first generation).
 *
 * - The answers come from React memory and go into an AnswerBox inside evaluateWithAnswers,
 *   whose toJSON throws, so they cannot be serialized by accident. Results are frozen and refuse
 *   to serialize too: they are rendered and dropped, never sent, stored or logged.
 * - The evaluator is the shared engine itself (strong Kleene logic), so the device never
 *   contradicts the server: it only resolves rules the server left "unknown".
 * - Any failure (an answer outside the vocabulary, a rule the engine cannot read) falls back to
 *   the server-safe evaluator, which leaves private rules as "Eligible if ..." checks. Nothing
 *   ever turns an unknown into "eligible".
 */

/** The private answers as SensitiveAnswers; values outside the vocabulary are dropped, not guessed. */
export function toSensitiveAnswers(priv: PrivateAnswers): SensitiveAnswers {
  const draft: Record<string, string> = {};
  for (const f of PRIVATE_FIELDS) {
    const v = priv[f];
    if (typeof v === "string" && v) draft[f] = v;
  }
  const parsed = SensitiveAnswersSchema.safeParse(draft);
  if (parsed.success) return parsed.data;
  // Keep each answer that is valid on its own.
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(draft)) if (SensitiveAnswersSchema.safeParse({ [k]: v }).success) out[k] = v;
  return out as SensitiveAnswers;
}

function hasAnswers(priv: PrivateAnswers | null | undefined): priv is PrivateAnswers {
  return !!priv && PRIVATE_FIELDS.some((f) => typeof priv[f] === "string" && priv[f] !== "");
}

/**
 * An EligibilityAdapter for findMatches that also reads the private answers on this device.
 * Without answers it is exactly the shared default (server-safe engine).
 */
export function deviceEligibilityAdapter(priv: PrivateAnswers | null | undefined): EligibilityAdapter {
  if (!hasAnswers(priv)) return defaultEligibility;
  const answers = toSensitiveAnswers(priv);
  return (card: ProgramCard, profile: StudentProfile, asOf: string): EligibilityOutcome => {
    if (card.rules === null) return defaultEligibility(card, profile, asOf);
    try {
      const context = buildEvalContext({ deadlines: card.deadlines.map((d) => ({ ...d, institutionId: null })) });
      const result = evaluateWithAnswers(card.rules, profile, { answers, asOf, context });
      // Copy only what onboarding reads; the frozen result itself is dropped here.
      return {
        status: result.status,
        pending: result.pending.map((p) => ({ id: p.id, sensitive: p.sensitive, resolver: p.resolver, selfCheckText: p.selfCheckText })),
      };
    } catch {
      return defaultEligibility(card, profile, asOf);
    }
  };
}

/**
 * The readiness preview's eligibility rows from the shared engine: one row per rule with the
 * verdict, whether it was checked privately, and which private answers it still needs. Returns
 * null when the engine cannot evaluate (the caller then uses its conservative reading).
 */
export function deviceEligibilityRows(
  rules: EligibilityRuleSet | null,
  classYear: string | null,
  priv: PrivateAnswers,
  today: string,
): EligibilityRow[] | null {
  if (!rules) return [];
  try {
    const profile = { classYear: classYear as StudentProfile["classYear"] };
    const result = evaluateWithAnswers(rules, profile, { answers: toSensitiveAnswers(priv), asOf: today });
    const officialText = new Map(rules.rules.map((r) => [r.id, r.officialText]));
    return result.rules.map((r) => ({
      id: r.ruleId,
      text: officialText.get(r.ruleId) ?? r.officialText,
      verdict: r.verdict === "met" ? "met" : r.verdict === "not_met" ? "not_met" : "unknown",
      private: r.sensitive,
      needs: r.missingFields.filter((f): f is PrivateField => (PRIVATE_FIELDS as readonly string[]).includes(f) && !priv[f as PrivateField]),
    }));
  } catch {
    return null;
  }
}
