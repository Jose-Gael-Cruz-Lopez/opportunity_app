/**
 * Read-time settings for stored band models. Judgment values unless a comment names a source.
 */
export const BANDS_STORE_CONFIG = {
  /**
   * `bands.fit` refits on the first day of each month. A model older than this has missed at
   * least one monthly refit and possibly two, so readiness stops using it (judgment: one missed
   * run is tolerated, a second is not).
   */
  maxModelAgeDays: 62,
} as const;
