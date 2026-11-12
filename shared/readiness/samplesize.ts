/**
 * Sample-size checks that decide whether a band model may exist at all.
 *
 *   van Houwelingen shrinkage  S = (LR χ² − P) / LR χ²             (needs S ≥ 0.9, i.e. χ² ≥ 30 for P = 3)
 *   Cox-Snell R²               R² = 1 − exp(−LR χ² / n)
 *   Riley et al. 2020, crit. 1 n ≥ P / ((S − 1) · ln(1 − R²_adj / S)),  S = 0.9
 *   Riley et al. 2020, crit. 3 n ≥ (1.96 / δ)² φ (1 − φ)            (met by official counts, not reports)
 * For P = 3, criterion 1 asks for about 240 outcomes at R² = 0.106, 525 at 0.05 and 1,335 at 0.02,
 * which is why the coefficients are pooled within an OpportunityType and stage and never fitted
 * per program.
 */

export function vanHouwelingenShrinkage(lrChi2: number, parameters: number): number {
  return lrChi2 > 0 ? (lrChi2 - parameters) / lrChi2 : -Infinity;
}

export function coxSnellR2(lrChi2: number, n: number): number {
  return n > 0 ? 1 - Math.exp(-Math.max(0, lrChi2) / n) : 0;
}

/** The largest Cox-Snell R² a binary outcome with prevalence φ allows. */
export function maxCoxSnellR2(prevalence: number): number {
  const phi = Math.min(1 - 1e-12, Math.max(1e-12, prevalence));
  const lnLNull = phi * Math.log(phi) + (1 - phi) * Math.log(1 - phi);
  return 1 - Math.exp(2 * lnLNull);
}

/** Riley criterion 1: the n that keeps expected shrinkage at `shrinkage` for P parameters. */
export function rileyMinimumN(parameters: number, r2cs: number, shrinkage = 0.9): number {
  if (!(r2cs > 0) || r2cs >= shrinkage) return Infinity;
  return Math.ceil(parameters / ((shrinkage - 1) * Math.log(1 - r2cs / shrinkage)));
}

/** Riley criterion 3: n for estimating the overall risk within ±margin. */
export function rileyMeanRiskN(prevalence: number, margin = 0.05): number {
  return Math.ceil((1.96 / margin) ** 2 * prevalence * (1 - prevalence));
}
