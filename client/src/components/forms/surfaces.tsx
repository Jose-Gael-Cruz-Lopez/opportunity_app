import type { ComponentPropsWithoutRef, CSSProperties, ElementType, ReactNode } from "react";
import { cn } from "@/lib/utils";
import { daysLeftLabel, rulerPosition, rulerTicks, type RulerInput } from "./ruler";
import "./theme.css";

/**
 * Surfaces for the Novus app look: the page ground, glass panels, Doto numerals, stat tiles and
 * the countdown ruler card. Glass is decoration only: every panel has a solid fallback (see
 * theme.css), and no text depends on blur for contrast.
 */

/**
 * Page wrapper: scopes the tokens and type for these pages. Inside the app the shell draws the
 * ground, padding and scrolling; `standalone` paints this page's own ground (previews, tests).
 */
export function PageShell({
  children,
  className,
  labelledBy,
  standalone = false,
}: {
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  standalone?: boolean;
}) {
  return (
    <div className={cn("nvp", standalone && "nvp-page min-h-screen px-4 py-6 sm:px-6 lg:px-10", className)} aria-labelledby={labelledBy}>
      <div className="mx-auto w-full max-w-6xl pb-16">{children}</div>
    </div>
  );
}

type GlassProps<T extends ElementType> = {
  as?: T;
  iris?: boolean;
  className?: string;
  children?: ReactNode;
  style?: CSSProperties;
} & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children" | "style">;

export function GlassPanel<T extends ElementType = "section">({ as, iris, className, children, ...rest }: GlassProps<T>) {
  const Tag = (as ?? "section") as ElementType;
  return (
    <Tag className={cn("nvp-glass", iris && "nvp-iris", className)} {...rest}>
      {children}
    </Tag>
  );
}

/** Dot-matrix display numerals. The visual text is hidden from screen readers in favour of `label`. */
export function DotNumber({ value, label, className }: { value: ReactNode; label: string; className?: string }) {
  return (
    <span className={cn("nvp-dot", className)} role="img" aria-label={label}>
      <span aria-hidden="true">{value}</span>
    </span>
  );
}

export function StatTile({
  icon,
  label,
  value,
  suffix,
  dark,
  children,
}: {
  icon: ReactNode;
  label: string;
  value: number | string;
  suffix?: string;
  dark?: boolean;
  /** Decorative micro-chart; hidden from assistive tech. */
  children?: ReactNode;
}) {
  return (
    <div className={cn("nvp-glass nvp-stat", dark && "nvp-stat-dark")}>
      <div className="flex items-center gap-3">
        <span className="nvp-stat-ring" aria-hidden="true">
          {icon}
        </span>
        <span className="text-[15px] leading-tight">{label}</span>
      </div>
      <div className="flex items-end justify-between gap-2">
        <span className="nvp-stat-num">
          {value}
          {suffix ? <small>{suffix}</small> : null}
        </span>
        {children ? <span aria-hidden="true">{children}</span> : null}
      </div>
    </div>
  );
}

function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  const month = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"][m - 1];
  return `${d} ${month}`;
}

/** The countdown ruler card: big Doto day count, ruler with today's marker, open and due ends. */
export function CountdownCard({
  eyebrow,
  dueCaption,
  className,
  ...input
}: RulerInput & { eyebrow: string; dueCaption?: string; className?: string }) {
  const pos = rulerPosition(input);
  const ticks = rulerTicks();
  const words = daysLeftLabel(pos.daysLeft);
  const rulerLabel = pos.openedKnown
    ? `Day ${pos.dayOfWindow} of a ${pos.windowDays}-day application window`
    : `${words}; opening date not known`;
  return (
    <GlassPanel as="article" className={cn("flex flex-col items-center rounded-[36px] px-5 pb-5 pt-6 text-center", className)}>
      <span className="text-[15px] text-[color:var(--nvp-ink-2)]">{eyebrow}</span>
      <div className="flex flex-1 flex-col items-center justify-center gap-3 py-6">
        <DotNumber
          value={Math.max(0, pos.daysLeft)}
          label={words}
          className="text-[88px] leading-[0.82] text-[color:var(--nvp-cream)] sm:text-[104px]"
        />
        <span className="text-[13.5px] text-[color:var(--nvp-ink-3)]">
          {pos.daysLeft >= 0 ? "days left" : words}
          {dueCaption ? ` · ${dueCaption}` : ""}
        </span>
      </div>
      <div className="nvp-ruler" style={{ "--at": `${(pos.fraction * 100).toFixed(1)}%` } as CSSProperties} role="img" aria-label={rulerLabel}>
        {ticks.map((major, i) => (
          <span key={i} className={cn("nvp-tk", major && "nvp-mj")} />
        ))}
      </div>
      <div className="nvp-ruler-ends" aria-hidden="true">
        <span>{pos.openedKnown && input.opensOn ? `Opened ${shortDate(input.opensOn)}` : "Opening not known"}</span>
        <span>Due {shortDate(input.dueOn)}</span>
      </div>
    </GlassPanel>
  );
}

/** Marks data that is sample content, so nothing invented reads as verified. */
export function SampleNotice({ children }: { children?: ReactNode }) {
  return (
    <p className="nvp-meta mt-2 inline-flex items-center gap-2 rounded-full border border-[color:var(--nvp-line)] px-3 py-1" role="note">
      <span aria-hidden="true" className="inline-block h-2 w-2 rounded-full bg-[color:var(--nvp-warn)]" />
      {children ?? "Sample data: the Novus API is not connected, so this page shows made-up examples."}
    </p>
  );
}
