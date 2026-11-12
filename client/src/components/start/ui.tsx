import type { HTMLAttributes, MouseEvent, ReactNode } from "react";
import { STAGE_LABELS, progressFraction, timeLeftLabel, type Stage } from "./flow";
import { TIER_LABELS, type Tier } from "./normalize";

/** Small presentational pieces shared by the onboarding screens (Ember look, start.css). */

export function Glass({ children, className = "", as: Tag = "section", ...rest }: { children: ReactNode; className?: string; as?: "section" | "div" | "article" } & HTMLAttributes<HTMLElement>) {
  return (
    <Tag className={`st-glass ${className}`} {...rest}>
      {children}
    </Tag>
  );
}

export function Kicker({ children }: { children: ReactNode }) {
  return <p className="st-kicker">{children}</p>;
}

export function Note({ children, tone }: { children: ReactNode; tone?: "warn" }) {
  return (
    <div className="st-note" data-tone={tone} role="note">
      <span aria-hidden="true">{tone === "warn" ? "!" : "i"}</span>
      <div>{children}</div>
    </div>
  );
}

export function SampleBadge() {
  return (
    <span className="st-sample" title="Sample data for the onboarding demo, not a real listing">
      Sample
    </span>
  );
}

export function TierTag({ tier }: { tier: Tier }) {
  return (
    <span className="st-tag" data-tier={tier}>
      <span className="st-led" aria-hidden="true" />
      {TIER_LABELS[tier]}
    </span>
  );
}

export function StatusTag({ tone, children }: { tone?: "warn" | "bad" | "off"; children: ReactNode }) {
  return (
    <span className="st-tag" data-tone={tone}>
      <span className="st-led" aria-hidden="true" />
      {children}
    </span>
  );
}

/** An on/off switch with role="switch", so screen readers announce its state. */
export function Toggle({ checked, onChange, children, id }: { checked: boolean; onChange: (v: boolean) => void; children: ReactNode; id?: string }) {
  return (
    <button type="button" id={id} role="switch" aria-checked={checked} className="st-toggle" onClick={() => onChange(!checked)}>
      <span className="st-sw" aria-hidden="true" />
      <span>{children}</span>
    </button>
  );
}

export function Chip({ pressed, onClick, children, label }: { pressed?: boolean; onClick: (e: MouseEvent<HTMLButtonElement>) => void; children: ReactNode; label?: string }) {
  return (
    <button type="button" className="st-chip" aria-pressed={pressed} aria-label={label} onClick={onClick}>
      {children}
    </button>
  );
}

/** Progress bar plus "about N min left"; the numbers come from flow.ts budgets. */
export function ProgressHeader({ stage, within, label }: { stage: Stage; within: number; label?: string }) {
  const pct = Math.round(progressFraction(stage, within) * 100);
  return (
    <div className="st-progress">
      <div className="st-progress-row">
        <span className="st-meta">{label ?? STAGE_LABELS[stage]}</span>
        <span className="st-meta" aria-live="polite">
          {timeLeftLabel(stage, within)}
        </span>
      </div>
      <div className="st-bar" role="progressbar" aria-label="Onboarding progress" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
        <i style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

export { shortDate } from "./wording";

/**
 * Removing a chip unmounts the button that had focus. Before it goes, move focus to the next
 * chip (or the previous one), or to `fallbackId` (the "Add" input) when it was the last one.
 */
export function focusAfterChipRemoval(button: HTMLButtonElement, fallbackId: string): void {
  const sibling = [button.nextElementSibling, button.previousElementSibling].find(
    (el): el is HTMLButtonElement => el instanceof HTMLButtonElement,
  );
  const target = sibling ?? button.ownerDocument.getElementById(fallbackId);
  target?.focus();
}
