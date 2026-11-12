import { lastDayOfMonth, parseIsoMonth } from "@shared/time";
import { AI_MIN_AGE } from "./config";

/**
 * The AI minimum-age gate. The Gemini API Additional Terms (effective 2026-03-23) say "You must be
 * 18 years of age or older to use the APIs" and bar use in a service "directed towards or is
 * likely to be accessed by individuals under the age of 18". Novus serves first-year students,
 * some of them 17, so every Gemini-backed feature is limited to students we know are adults.
 * Under-18 or unknown-age students get the deterministic readiness output, which already shows
 * all four parts. The wider question (the app as a whole being "likely to be accessed" by minors)
 * is a founder and counsel decision recorded in docs/ai.md.
 */

export interface AiViewer {
  /** Opaque, stable user id; hashed before it reaches the ledger. Null for staff tooling. */
  readonly userId: string | null;
  /** StudentProfile.birthYearMonth (YYYY-MM); null when the student has not given it. */
  readonly birthYearMonth: string | null;
  /** True when the account is in minor mode for any other reason. */
  readonly minorMode?: boolean;
}

export type AiAccessDecision =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: "age_unknown" | "under_min_age" | "minor_mode" };

/**
 * We only know the birth month, so we assume the birthday is the LAST day of that month: a
 * student counts as 18 only once that is certainly true.
 */
export function checkAiAccess(viewer: AiViewer, todayIso: string, minAge: number = AI_MIN_AGE): AiAccessDecision {
  if (viewer.minorMode) return { allowed: false, reason: "minor_mode" };
  if (!viewer.birthYearMonth) return { allowed: false, reason: "age_unknown" };
  const born = parseIsoMonth(viewer.birthYearMonth);
  if (!born) return { allowed: false, reason: "age_unknown" };
  const adultFrom = lastDayOfMonth(born.year + minAge, born.month);
  return todayIso >= adultFrom ? { allowed: true } : { allowed: false, reason: "under_min_age" };
}
