import { Check } from "lucide-react";
import { Link } from "wouter";
import type { RoadmapItem } from "@shared/contracts/roadmap";
import { Panel } from "@/components/app";
import { formatDay } from "@/lib/format";
import { appPaths } from "@/lib/routes";
import type { WeekDay } from "./model";

/**
 * "This week": the week strip and a short checklist from the Roadmap. Checking an item completes
 * it on the Roadmap too (same itemKey), so the two never disagree.
 */
export function PlanCard({
  week,
  items,
  onToggle,
  busyKey,
  className,
}: {
  week: readonly WeekDay[];
  items: readonly RoadmapItem[];
  onToggle: (item: RoadmapItem) => void;
  busyKey: string | null;
  className?: string;
}) {
  const done = items.filter((i) => i.state === "done").length;
  const today = week.find((d) => d.isToday);
  const eventDays = week.filter((d) => d.hasEvent).map((d) => d.name);
  const weekLabel = `Week of ${formatDay(week[0]?.date ?? "")}. Today is ${today?.name ?? ""}.${eventDays.length ? ` Something is due on ${eventDays.join(", ")}.` : ""}`;

  return (
    <Panel as="article" iris className={`flex flex-col gap-[18px] rounded-[34px] px-[18px] pb-[18px] pt-[30px] ${className ?? ""}`} aria-labelledby="plan-title">
      <h2 id="plan-title" className="text-center">
        <span aria-hidden="true" className="nv-dot block text-[clamp(44px,4.2vw,60px)]" style={{ color: "var(--nv-cream)" }}>
          This
          <br />
          week
        </span>
        <span className="sr-only">This week</span>
      </h2>
      <ol className="nv-week" aria-label={weekLabel}>
        {week.map((d) => (
          <li key={d.date} data-today={d.isToday} data-event={d.hasEvent} aria-hidden="true">
            {d.letter}
            <b>{d.day}</b>
          </li>
        ))}
      </ol>
      {items.length === 0 ? (
        <p className="px-1.5 text-[15px] nv-ink-2">Nothing planned this week. Your Roadmap suggests what to start next.</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((item) => {
            const checked = item.state === "done";
            return (
              <li key={item.itemKey}>
                <button
                  type="button"
                  role="checkbox"
                  aria-checked={checked}
                  className="nv-check"
                  disabled={busyKey === item.itemKey}
                  onClick={() => onToggle(item)}
                >
                  <span className="nv-ring" aria-hidden="true">
                    <Check className="h-[15px] w-[15px]" strokeWidth={2.4} />
                  </span>
                  <span className="nv-check-label min-w-0 flex-1">{item.title}</span>
                  {item.dueOn ? <span className="nv-meta text-right">{formatDay(item.dueOn).split(",")[0]}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="mt-auto flex items-center justify-between gap-2 px-1.5 pt-1">
        <span className="nv-meta" aria-live="polite">
          {items.length ? `${done} of ${items.length} done` : ""}
        </span>
        <Link href={appPaths.roadmap} className="nv-link">
          Roadmap
        </Link>
      </div>
    </Panel>
  );
}
