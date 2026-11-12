/**
 * Report periods: a calendar month ("2026-11") or quarter ("2026-Q4"), as UTC half-open ranges.
 * Reports are monthly in the pilot (plan 10.4.2); quarters serve term reviews.
 */

export interface PeriodRange {
  readonly period: string;
  readonly startMs: number;
  readonly endMs: number;
}

export function parsePeriod(period: string): PeriodRange | null {
  const month = /^(\d{4})-(\d{2})$/.exec(period);
  if (month) {
    const year = Number(month[1]);
    const m = Number(month[2]);
    if (m < 1 || m > 12) return null;
    return { period, startMs: Date.UTC(year, m - 1, 1), endMs: Date.UTC(year, m, 1) };
  }
  const quarter = /^(\d{4})-Q([1-4])$/.exec(period);
  if (quarter) {
    const year = Number(quarter[1]);
    const q = Number(quarter[2]);
    return { period, startMs: Date.UTC(year, (q - 1) * 3, 1), endMs: Date.UTC(year, q * 3, 1) };
  }
  return null;
}

/** The month containing an instant, e.g. for the default progress period. */
export function monthOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** Reports describe the past or the period in progress, never the future. */
export function isFuturePeriod(range: PeriodRange, nowMs: number): boolean {
  return range.startMs > nowMs;
}
