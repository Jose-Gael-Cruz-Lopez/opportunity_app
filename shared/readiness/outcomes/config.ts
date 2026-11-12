import type { OutcomeTierCode } from "./vocab";

/**
 * Public methodology values for Outcome reports (plan 7.8, 9.5). All judgment unless a comment
 * names a source. Anti-abuse cut-offs (the over-count fraction, the seasonal cap per account, burst
 * and weight-cut parameters) are deliberately NOT here: the repository is public, and published
 * cut-offs let attackers stay just under each check. They come from the private D1 `config`
 * table at run time as an `OutcomePrivateConfig`, and every check that needs one is skipped
 * (never guessed) when it is missing.
 */
export const OUTCOMES_CONFIG = {
  /** Tier weights for calibration, n_eff and band fits only (plan 7.8 table). */
  tierWeights: {
    self_reported: 0,
    institution_email: 0.6,
    letter_checked: 0.8,
    email_authenticated: 1,
    official_list: 1,
  } satisfies Record<OutcomeTierCode, number>,
  window: {
    /** inDecisionWindow accepts dates from 7 days before a curated window... */
    daysBefore: 7,
    /** ...to 21 days after its end, never in the future. */
    daysAfter: 21,
  },
  /** One prompt 3 days after the expected decision date (s01 F-05, plan 9.5.1). */
  promptAfterDays: 3,
  /** Edits close 60 days after the decision (plan 9.5.1). */
  editWindowDays: 60,
  /** Outcome-derived history: 10 distinct counted accounts naming one 7-day window (plan 7.8). */
  history: { minAccounts: 10, windowDays: 7 },
  /** A decision more than 21 days from the week most counted reports name is flagged (plan 7.8). */
  modalWeekToleranceDays: 21,
  /** Give-to-get: a contribution unlocks 12 months; a pledge until 30 days after the window (9.5.2). */
  giveToGet: { contributionMonths: 12, pledgeDaysAfterWindow: 30 },
  /** Usefulness and representativeness gates for bands (plan 7.5.5 step 3). */
  representativeness: { maxShareGap: 0.1, minAdmits: 20 },
} as const;

/** Private, audited values from the D1 `config` table (keys under `outcomes.anomaly.*`). */
export interface OutcomePrivateConfig {
  /** Counted accepted reports above this fraction of the official award count hold the cycle. */
  readonly overCountFraction: number | null;
  /** Reports per account per season beyond which a report is flagged. */
  readonly seasonalCap: number | null;
}

export const PRIVATE_CONFIG_KEYS = {
  overCountFraction: "outcomes.anomaly.freeze_ratio",
  seasonalCap: "outcomes.anomaly.seasonal_cap",
} as const;

export const NO_PRIVATE_CONFIG: OutcomePrivateConfig = { overCountFraction: null, seasonalCap: null };

export function tierWeight(tier: string): number {
  return (OUTCOMES_CONFIG.tierWeights as Record<string, number>)[tier] ?? 0;
}
