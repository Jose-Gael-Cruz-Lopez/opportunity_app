/**
 * Building blocks of the glass look: the page ground, glass panels, dot-matrix numbers, the
 * countdown ruler, stat tiles, banners and the look switch. Dot-matrix (Doto) text is decorative,
 * so every Doto number is aria-hidden and repeated in plain words for assistive technology.
 */
import { type ComponentPropsWithoutRef, type CSSProperties, type ElementType, type ReactNode } from "react";
import { Link } from "wouter";
import "./novus.css";
import { appPaths, signInThenReturn } from "@/lib/routes";
import { useLookPrefs } from "@/components/forms/look";
import { LOOKS, type Look } from "./look";
import type { RulerPosition } from "./format";

// ---------------------------------------------------------------------------------------------
// Icons (inline, stroke-based, decorative unless labelled)
// ---------------------------------------------------------------------------------------------

const PATHS = {
  check: "M5 12.5l4.2 4.2L19 7",
  x: "M6 6l12 12M18 6L6 18",
  lock: "M7 11V8a5 5 0 0110 0v3M5.5 11h13v9h-13z",
  out: "M14 5h5v5M19 5l-8 8M18 14v5H5V6h5",
  star: "M12 4l2.4 5 5.4.6-4 3.7 1.1 5.4L12 16l-4.9 2.7 1.1-5.4-4-3.7 5.4-.6z",
  cal: "M5 7h14v13H5zM5 11h14M9 4v5M15 4v5",
  flag: "M6 21V4M6 4h11l-2 4 2 4H6",
  map: "M9 5l-5 2v12l5-2 6 2 5-2V5l-5 2-6-2zM9 5v12M15 7v12",
  plus: "M12 5v14M5 12h14",
  chev: "M9 6l6 6-6 6",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
  doc: "M7 3h7l4 4v14H7zM14 3v4h4",
  leaf: "M5 19c0-8 6-14 14-14 0 8-6 14-14 14zM5 19l7-7",
  info: "M12 8h.01M11 12h1v5h1M12 21a9 9 0 100-18 9 9 0 000 18z",
  trash: "M5 7h14M10 7V4h4v3M7 7l1 13h8l1-13",
} as const;
export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "nvr-icon", label }: { name: IconName; className?: string; label?: string }) {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={label ? undefined : true}
      role={label ? "img" : undefined}
      aria-label={label}
      focusable="false"
    >
      <path d={PATHS[name]} />
    </svg>
  );
}

// ---------------------------------------------------------------------------------------------
// Page, glass and type
// ---------------------------------------------------------------------------------------------

/**
 * Each screen renders inside one; it scopes every token under `.nvr`. Inside the app the shell's
 * `.nv-main` already draws the ground and the 16 px gutters, so the page adds neither (a second
 * gutter left phones about 296 px of content). `standalone` paints this page's own ground and
 * padding, for previews and tests, as forms/surfaces.tsx PageShell does.
 */
export function NvPage({ children, labelledBy, standalone = false }: { children: ReactNode; labelledBy?: string; standalone?: boolean }) {
  return (
    <div className={standalone ? "nvr nvr-page" : "nvr nvr-in-shell"} aria-labelledby={labelledBy}>
      <div className="nvr-content">{children}</div>
    </div>
  );
}

export function Glass<T extends ElementType = "section">({
  as,
  className = "",
  iris = false,
  children,
  ...rest
}: { as?: T; className?: string; iris?: boolean; children: ReactNode } & Omit<ComponentPropsWithoutRef<T>, "as" | "className" | "children">) {
  const Tag = (as ?? "section") as ElementType;
  return (
    <Tag className={`nvr-glass ${iris ? "nvr-iris" : ""} ${className}`.trim()} {...rest}>
      {children}
    </Tag>
  );
}

/** A dot-matrix number with a plain-text twin for screen readers. */
export function DotNumber({ value, spoken, className = "", style }: { value: string | number; spoken: string; className?: string; style?: CSSProperties }) {
  return (
    <>
      <span className={`nvr-dot ${className}`.trim()} style={style} aria-hidden="true">
        {value}
      </span>
      <span className="nvr-sr">{spoken}</span>
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Countdown ruler and stat tile
// ---------------------------------------------------------------------------------------------

const TICKS = 31;

/** A ruler of ticks with a lit marker at today's place in the application window. */
export function CountdownRuler({ position, startLabel, endLabel, width }: { position: RulerPosition; startLabel: string; endLabel: string; width?: number }) {
  const style = { "--nv-at": `${(position.fraction * 100).toFixed(1)}%`, width } as CSSProperties;
  return (
    <div style={{ width: width ?? "100%" }}>
      <div className="nvr-ruler" style={style} role="img" aria-label={position.label}>
        {Array.from({ length: TICKS }, (_, i) => (
          <i key={i} data-major={i % 5 === 0 ? "" : undefined} />
        ))}
      </div>
      <div className="nvr-ruler-ends" aria-hidden="true">
        <span>{startLabel}</span>
        <span>{endLabel}</span>
      </div>
    </div>
  );
}

export function StatTile({ label, value, spoken, note }: { label: string; value: string | number; spoken: string; note?: ReactNode }) {
  return (
    <Glass as="div" className="nvr-stat">
      <span className="nvr-label">{label}</span>
      <div>
        <DotNumber value={value} spoken={spoken} className="nvr-stat-num" />
        {note ? <p className="nvr-meta" style={{ marginTop: 6 }}>{note}</p> : null}
      </div>
    </Glass>
  );
}

// ---------------------------------------------------------------------------------------------
// Banners, skeletons, part headings
// ---------------------------------------------------------------------------------------------

export function SampleBanner({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <p className="nvr-banner" role="note" style={{ marginBottom: 18 }}>
      <Icon name="info" />
      <span>
        <strong>Sample data.</strong> The API is not reachable, so this screen shows invented programs, dates and counts for review. Nothing here describes a real program.
      </span>
    </p>
  );
}

export function ErrorBanner({ title, detail, onRetry }: { title: string; detail?: string; onRetry?: () => void }) {
  return (
    <div className="nvr-banner" data-tone="error" role="alert">
      <Icon name="info" />
      <div style={{ flex: 1 }}>
        <strong>{title}</strong>
        {detail ? <p className="nvr-body">{detail}</p> : null}
      </div>
      {onRetry ? (
        <button type="button" className="nvr-mini" onClick={onRetry}>
          Try again
        </button>
      ) : null}
    </div>
  );
}

/**
 * Signed out is a normal state, not an error: a neutral panel (no role="alert") with a way
 * forward. `next` is the in-app path to come back to after signing in.
 */
export function SignInPrompt({ title, detail, next }: { title: string; detail?: string; next: string }) {
  return (
    <div className="nvr-banner" role="status">
      <Icon name="info" />
      <div style={{ flex: 1 }}>
        <strong>{title}</strong>
        {detail ? <p className="nvr-body">{detail}</p> : null}
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 12 }}>
          <Link className="nvr-btn" href={appHref(signInThenReturn(next))}>
            Sign in
          </Link>
          <Link className="nvr-mini" href={appHref(appPaths.start)} style={{ alignSelf: "center" }}>
            New here? Get started
          </Link>
        </div>
      </div>
    </div>
  );
}

export function Skeleton({ height = 160, label = "Loading" }: { height?: number; label?: string }) {
  return <div className="nvr-skeleton" style={{ minHeight: height }} role="status" aria-label={label} />;
}

/** Panel heading with its part label ("Part 1 · Eligibility"). */
export function PartHeading({ id, title, part, level = 3 }: { id: string; title: string; part?: string; level?: 2 | 3 }) {
  const H = level === 2 ? "h2" : "h3";
  return (
    <div className="nvr-panel-head">
      <H id={id} className={level === 2 ? "nvr-h2" : "nvr-h3"}>
        {title}
      </H>
      {part ? <span className="nvr-label nvr-part">{part}</span> : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Look switch
// ---------------------------------------------------------------------------------------------

/**
 * The look comes from the shell's LookProvider (design/), so this switch and the top-bar switch
 * always agree. Outside the provider (tests, previews) it falls back to the same storage key.
 */
export function useLook(): [Look, (look: Look) => void] {
  const prefs = useLookPrefs();
  return [prefs.look, prefs.setLook];
}

const LOOK_LABELS: Record<Look, string> = { ember: "Ember", meadow: "Meadow" };

export function LookToggle() {
  const [look, setLook] = useLook();
  return (
    <div className="nvr-looks" role="group" aria-label="Look">
      {LOOKS.map((l) => (
        <button key={l} type="button" aria-pressed={look === l} onClick={() => setLook(l)}>
          <i className="nvr-swatch" data-look={l} aria-hidden="true" />
          {LOOK_LABELS[l]}
        </button>
      ))}
    </div>
  );
}

/** Builds an absolute in-app href that works with or without a nested wouter base of /app. */
export function appHref(path: string): string {
  return `~/app${path.startsWith("/") ? path : `/${path}`}`;
}
