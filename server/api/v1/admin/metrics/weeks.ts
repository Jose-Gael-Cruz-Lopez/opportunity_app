/**
 * UTC weeks starting Monday. A week index counts whole weeks since Monday 1970-01-05, so SQL
 * (`(at - WEEK_EPOCH_MS) / WEEK_MS` in integer arithmetic) and TypeScript agree on every boundary.
 */

export const DAY_MS = 86_400_000;
export const WEEK_MS = 7 * DAY_MS;
/** Monday 1970-01-05T00:00:00Z. */
export const WEEK_EPOCH_MS = 4 * DAY_MS;

export function weekIndex(ms: number): number {
  return Math.floor((ms - WEEK_EPOCH_MS) / WEEK_MS);
}

export function weekStartMs(index: number): number {
  return WEEK_EPOCH_MS + index * WEEK_MS;
}

/** YYYY-MM-DD of the week's Monday. */
export function weekStartDate(index: number): string {
  return new Date(weekStartMs(index)).toISOString().slice(0, 10);
}

/** Start of the UTC day containing `ms`. */
export function dayStartMs(ms: number): number {
  return Math.floor(ms / DAY_MS) * DAY_MS;
}
