import type { ReactNode } from "react";
import type { Countdown } from "@/lib/deadlines";
import { formatDay, formatLocalTime, formatShortDate } from "@/lib/format";
import { cn } from "@/lib/utils";
import { DotNumber } from "./DotNumber";
import { Panel } from "./Panel";

const TICKS = 25;
const MAJOR_EVERY = 6;

/**
 * Countdown ruler card: days left in Doto above a ruler whose marker sits at today inside the
 * application window. Everything Doto shows is repeated in plain text.
 */
export function CountdownCard({
  eyebrow,
  countdown,
  footer,
  className,
  headingId,
}: {
  eyebrow: ReactNode;
  countdown: Countdown;
  footer?: ReactNode;
  className?: string;
  headingId?: string;
}) {
  const due = `${formatDay(countdown.dueDate)}${countdown.dueTime ? `, ${formatLocalTime(countdown.dueTime)}` : ""}${countdown.timeZoneLabel ? ` ${countdown.timeZoneLabel}` : ""}`;
  const daysWord = countdown.daysLeft === 1 ? "day" : "days";
  return (
    <Panel as="article" className={cn("nv-duecard", className)} aria-labelledby={headingId}>
      <h2 id={headingId} className="text-[15px] nv-ink-2 font-medium">
        {eyebrow}
      </h2>
      <div className="flex flex-1 flex-col items-center justify-center gap-3.5 py-7">
        <DotNumber className="nv-due-num" value={countdown.daysLeft} label={`${countdown.daysLeft} ${daysWord} left`} />
        <span className="text-[13.5px] nv-ink-3">
          <span aria-hidden="true">{daysWord} left · </span>
          <span className="sr-only">Due </span>
          {due}
        </span>
      </div>
      <div
        className="nv-ruler"
        style={{ ["--at" as string]: `${(countdown.progress * 100).toFixed(1)}%` }}
        role="img"
        aria-label={`Day ${countdown.dayOfWindow} of a ${countdown.windowDays}-day application window`}
      >
        {Array.from({ length: TICKS }, (_, i) => (
          <i key={i} className="nv-tk" data-major={i % MAJOR_EVERY === 0 || i === TICKS - 1} />
        ))}
      </div>
      <div className="mt-2 flex w-full justify-between nv-meta" aria-hidden="true">
        <span>Opened {formatShortDate(countdown.openedOn)}</span>
        <span>Due {formatShortDate(countdown.dueDate)}</span>
      </div>
      {footer ? <div className="mt-4 w-full">{footer}</div> : null}
    </Panel>
  );
}
