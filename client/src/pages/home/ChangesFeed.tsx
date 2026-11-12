import { Link } from "wouter";
import { Panel } from "@/components/app";
import { formatAgo } from "@/lib/format";
import type { FeedRow } from "./model";

/** "Changed this week": registry changes to programs the student tracks. */
export function ChangesFeed({ rows, now, className }: { rows: readonly FeedRow[]; now: number; className?: string }) {
  return (
    <Panel as="article" className={`rounded-[28px] px-6 py-[22px] ${className ?? ""}`} aria-labelledby="feed-title">
      <div className="flex items-baseline justify-between gap-3">
        <h2 id="feed-title" className="nv-sec-title">
          Changed this week
        </h2>
        <span className="nv-meta">Programs you track</span>
      </div>
      {rows.length === 0 ? (
        <p className="mt-3 text-sm nv-ink-2">No changes yet. When a program you track moves a date or updates its rules, it shows up here.</p>
      ) : (
        <ul className="mt-2.5">
          {rows.map((row) => (
            <li key={row.id} className="nv-feed-row">
              <span className="nv-fd" data-tone={row.tone === "warn" ? "warn" : undefined} aria-hidden="true" />
              <span className="min-w-0">
                {row.tone === "warn" ? <span className="sr-only">Needs a look: </span> : null}
                {row.href ? (
                  <Link href={row.href} className="hover:underline">
                    {row.title}
                  </Link>
                ) : (
                  row.title
                )}
              </span>
              <span className="nv-meta whitespace-nowrap">{formatAgo(row.createdAt, now)}</span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
