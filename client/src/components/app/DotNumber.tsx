import { cn } from "@/lib/utils";

/**
 * Dot-matrix display text (Doto). Doto is decorative and hard to read for some people, so the
 * visual is aria-hidden and the same information is always present as plain text.
 */
export function DotNumber({ value, label, className }: { value: string | number; label: string; className?: string }) {
  return (
    <span className={cn("inline-block", className)}>
      <span aria-hidden="true" className="nv-dot">
        {value}
      </span>
      <span className="sr-only">{label}</span>
    </span>
  );
}
