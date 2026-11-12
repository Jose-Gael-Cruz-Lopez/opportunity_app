import { cn } from "@/lib/utils";

/** The Novus mark: a small glowing tile with the initial, plus the dot-matrix wordmark. */
export function BrandMark({ className }: { className?: string }) {
  return (
    <span className={cn("nv-mark nv-glowbg", className)} aria-hidden="true">
      n
    </span>
  );
}

export function Brand({ className }: { className?: string }) {
  return (
    <span className={cn("flex items-center gap-2.5", className)}>
      <BrandMark />
      <span className="nv-word" aria-hidden="true">
        NOVUS
      </span>
      <span className="sr-only">Novus</span>
    </span>
  );
}
