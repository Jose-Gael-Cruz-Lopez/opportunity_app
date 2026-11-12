import type { LucideIcon } from "lucide-react";
import { Panel } from "./Panel";

/**
 * A stat tile: icon ring, two-line label, a number and an optional small mark drawn from real
 * values (bars for a series, dots for "n of total"). The marks are decorative repeats of the
 * number, so they are aria-hidden; the tile's text carries the meaning. Counts describe the
 * student's own activity, never a rating of the student.
 */
export interface StatTileProps {
  icon: LucideIcon;
  label: string;
  value: number;
  /** "of 4" style suffix. */
  of?: number;
  /** Small bar series, e.g. deadlines per week. */
  bars?: readonly number[];
  /** Dot grid: `on` of `total` dots filled (capped at 16). */
  dots?: { on: number; total: number };
  dark?: boolean;
}

const MAX_DOTS = 16;

function Bars({ values }: { values: readonly number[] }) {
  const max = Math.max(1, ...values);
  const width = 66;
  const step = values.length > 1 ? (width - 8) / (values.length - 1) : 0;
  return (
    <svg className="nv-spark" viewBox="0 0 66 26" aria-hidden="true" focusable="false">
      <path d={values.map((v, i) => `M${(4 + i * step).toFixed(1)} 24V${(24 - (v / max) * 20).toFixed(1)}`).join("")} />
    </svg>
  );
}

function Dots({ on, total }: { on: number; total: number }) {
  const count = Math.min(MAX_DOTS, Math.max(total, 1));
  return (
    <span className="nv-dotgrid" aria-hidden="true">
      {Array.from({ length: count }, (_, i) => (
        <i key={i} data-on={i < on} />
      ))}
    </span>
  );
}

export function StatTile({ icon: Icon, label, value, of, bars, dots, dark }: StatTileProps) {
  const [first, ...rest] = label.split(" ");
  return (
    <Panel tone={dark ? "dark" : "default"} className="nv-stat">
      <div className="flex items-center gap-3">
        <span className="nv-st-ring" aria-hidden="true">
          <Icon className="h-[19px] w-[19px]" strokeWidth={1.3} />
        </span>
        <span className="text-[15px] leading-[1.1]">
          {first}
          <br />
          {rest.join(" ")}
        </span>
      </div>
      <div className="flex items-end justify-between gap-2.5">
        <span className="nv-st-num">
          {value}
          {of !== undefined ? <small>of {of}</small> : null}
        </span>
        {bars && bars.length > 1 ? <Bars values={bars} /> : dots ? <Dots on={dots.on} total={dots.total} /> : null}
      </div>
    </Panel>
  );
}
