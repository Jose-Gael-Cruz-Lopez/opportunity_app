import { Check, Lock, Minus, TriangleAlert } from "lucide-react";
import type { EligibilityHint } from "@/lib/eligibility-hint";
import type { CardStatus } from "@/lib/deadlines";
import { cn } from "@/lib/utils";

/** Status tag ("12 days left", "Opens Dec 1", "Closed"). The LED colour is backed by the words. */
export function StatusTag({ status, className }: { status: Pick<CardStatus, "tone" | "label">; className?: string }) {
  return (
    <span className={cn("nv-tag", className)} data-tone={status.tone}>
      <span className="nv-led" aria-hidden="true" />
      {status.label}
    </span>
  );
}

const HINT_ICON = {
  open_to_you: Check,
  check_privately: Lock,
  check_major: TriangleAlert,
  not_your_year: Minus,
  unknown: Minus,
} as const;

/** Eligibility chip: icon plus words, never colour alone, never a score. */
export function EligibilityChip({ hint, className }: { hint: EligibilityHint; className?: string }) {
  const Icon = HINT_ICON[hint.kind];
  return (
    <span className={cn("nv-elig", className)} data-tone={hint.tone === "good" ? undefined : hint.tone} title={hint.detail}>
      <Icon aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.2} />
      {hint.label}
      <span className="sr-only">. {hint.detail}</span>
    </span>
  );
}

/** "Sample" label for any record with isSample (rule 7). */
export function SampleTag({ className }: { className?: string }) {
  return (
    <span className={cn("nv-tag nv-tag-light", className)} title="Sample data for the prototype, not a real program">
      Sample
    </span>
  );
}
