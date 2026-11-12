import type { ProgramCard } from "@shared/contracts/registry";
import type { StudentProfile } from "@shared/contracts/student";

/**
 * The eligibility chip on cards. It uses only non-sensitive profile fields (class year and major
 * family) and the card's audience flags; status and identity questions are never inferred here.
 * Programs defined by such questions get "Check privately", which leads to the on-device check.
 *
 * This is a hint for browsing, not the verdict: the program page runs the full rule set
 * (shared/eligibility) and shows clause-level reasons. Never a score or percentage.
 */

export type EligibilityHintKind = "open_to_you" | "check_privately" | "check_major" | "not_your_year" | "unknown";
export type EligibilityHintTone = "good" | "warn" | "off";

export interface EligibilityHint {
  readonly kind: EligibilityHintKind;
  readonly tone: EligibilityHintTone;
  readonly label: string;
  /** One sentence for the tooltip and screen readers. */
  readonly detail: string;
}

const HINTS: Record<EligibilityHintKind, Omit<EligibilityHint, "kind">> = {
  open_to_you: { tone: "good", label: "Open to your year", detail: "Your class year and field match this program's published rules." },
  check_privately: { tone: "warn", label: "Check privately", detail: "This program has a status or identity rule. Answer it on this device; the answer is never sent." },
  check_major: { tone: "warn", label: "Check the major rule", detail: "This program lists specific fields of study. Check that yours counts." },
  not_your_year: { tone: "off", label: "Not your year yet", detail: "This program takes students in other class years. It may fit you later." },
  unknown: { tone: "off", label: "Not checked yet", detail: "Add your class year and major to see whether this program is open to you." },
};

export function eligibilityHint(card: Pick<ProgramCard, "classYears" | "majorFamilies" | "flags">, profile: Pick<StudentProfile, "classYear" | "majorFamily"> | null | undefined): EligibilityHint {
  const make = (kind: EligibilityHintKind): EligibilityHint => ({ kind, ...HINTS[kind] });
  const year = profile?.classYear ?? null;
  if (year && card.classYears.length > 0 && !card.classYears.includes(year)) return make("not_your_year");
  if (card.flags.sensitiveAudience || card.flags.identityAudience) return make("check_privately");
  if (!year) return make("unknown");
  const major = profile?.majorFamily ?? null;
  if (card.majorFamilies.length > 0 && (!major || !card.majorFamilies.includes(major))) return make("check_major");
  return make("open_to_you");
}
