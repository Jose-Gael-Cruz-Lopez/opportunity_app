/** Pure helpers for the Readiness view. */
import type { ReadinessReport } from "@shared/contracts/readiness";
import { SlugSchema } from "@shared/contracts/common";

/** The program slug from `?program=` (validated) or, failing that, from the report. */
export function readinessSlugFrom(search: string, reportSlug: string | null): string | null {
  const fromQuery = new URLSearchParams(search.startsWith("?") ? search.slice(1) : search).get("program");
  if (fromQuery && SlugSchema.safeParse(fromQuery).success) return fromQuery;
  return reportSlug;
}

/**
 * The earliest start-by date among checklist items still open, with its label. A date already
 * behind us still shows: it is the most urgent item.
 */
export function nextStartBy(report: ReadinessReport): { date: string; label: string } | null {
  const open = report.requirements.items.filter((i) => (i.state === "gap" || i.state === "in_progress" || i.state === "unknown") && i.startBy);
  if (open.length === 0) return null;
  const first = [...open].sort((a, b) => (a.startBy as string).localeCompare(b.startBy as string))[0];
  if (!first?.startBy) return null;
  return { date: first.startBy, label: first.label };
}
