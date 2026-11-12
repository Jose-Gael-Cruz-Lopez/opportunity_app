import type { ReactNode } from "react";
import {
  AlertTriangle,
  ArrowUpCircle,
  CheckCircle2,
  CircleDot,
  Clock,
  FlaskConical,
  Lock,
  PauseCircle,
  Users,
  XCircle,
  type LucideIcon,
} from "lucide-react";
import { dueLabel, STATE_LABELS } from "./model";

/** Status chips carry an icon AND a word (never colour alone); surfaces are solid. */

type Tone = "late" | "soon" | "good" | "done" | "sample" | undefined;

export function Chip({ icon: Icon, tone, children, title }: { icon: LucideIcon; tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className="cn-chip" data-tone={tone} title={title}>
      <Icon aria-hidden="true" />
      {children}
    </span>
  );
}

const STATE_ICON: Record<string, { icon: LucideIcon; tone?: Tone }> = {
  open: { icon: CircleDot },
  claimed: { icon: Lock, tone: "soon" },
  second_review: { icon: Users, tone: "soon" },
  approved: { icon: CheckCircle2, tone: "good" },
  applied: { icon: CheckCircle2, tone: "good" },
  apply_failed: { icon: AlertTriangle, tone: "late" },
  rejected: { icon: XCircle, tone: "done" },
  snoozed: { icon: PauseCircle, tone: "done" },
  escalated: { icon: ArrowUpCircle, tone: "late" },
};

export function StateChip({ state }: { state: string }) {
  const s = STATE_ICON[state] ?? { icon: CircleDot };
  return (
    <Chip icon={s.icon} tone={s.tone}>
      {STATE_LABELS[state] ?? state}
    </Chip>
  );
}

export function DueChip({ dueAt, now }: { dueAt: string | null; now: number }) {
  const d = dueLabel(dueAt, now);
  return (
    <Chip icon={d.tone === "late" ? AlertTriangle : Clock} tone={d.tone === "late" ? "late" : d.tone === "soon" ? "soon" : undefined}>
      {d.text}
    </Chip>
  );
}

export function SampleChip() {
  return (
    <Chip icon={FlaskConical} tone="sample" title="Sample record: not a real program">
      Sample
    </Chip>
  );
}

export function Btn({
  children,
  onClick,
  disabled,
  primary,
  kbd,
  type = "button",
}: {
  children: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  primary?: boolean;
  kbd?: string;
  type?: "button" | "submit";
}) {
  return (
    <button type={type} className="cn-btn" data-primary={primary ? "" : undefined} onClick={onClick} disabled={disabled}>
      {children}
      {kbd ? <kbd aria-hidden="true">{kbd}</kbd> : null}
    </button>
  );
}
