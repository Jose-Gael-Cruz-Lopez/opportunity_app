import { z } from "zod";
import { READINESS_CONFIG } from "./config";
import {
  epochDayOf,
  isoFromEpochDay,
  nthWeekdayOfMonth,
  sameMonthDayInYear,
  sameWeekdayNear,
  usThanksgiving,
  weekdayOfEpochDay,
  type IsoDate,
} from "./calendar";
import { wilsonLowerBound } from "./math/intervals";
import { studentTQuantile } from "./math/special";
import type { Prediction } from "../contracts/registry";
import type { PredictionLabel } from "../taxonomy";
import { daysInMonth, formatIsoDate, isLeapYear, parseIsoDate } from "../time/iso";
import { isValidTimeZone, localDateTimeToInstant } from "../time/zones";

/**
 * Cycle prediction (plan 7.6.1): when the next opening, closing or decision is expected, as
 * p10 / p50 / p90 dates with a label. Pure and versioned; the first method that applies wins:
 *   1. official_rule  a Curator-verified rule ("last Friday in January, 5:00 p.m. CT"):
 *                     width 0 when restated this cycle, 6 days and at most medium when carried over;
 *   2. inferred_rule  the same rule read from 3+ consistent exact past cycles (never from 2:
 *                     30 Jan 2026 and 29 Jan 2027 fit both "last Friday" and "Friday nearest the 29th");
 *   3. fixed_date     the two latest cycles share a month and day: width 6 + padding;
 *   4. seasonal       (opt-in) recency-weighted circular mean with a Student-t interval, 3+ cycles;
 *   5. weekday_shift  same weekday nearest the same date: width 14 (tight) or 42, + padding;
 *   6. curator_month  an evidenced month (medium) or 7. curator_estimate (±7 days, at most low).
 * Padding is twice the mean half-width of the history intervals. Labels follow the 80% width
 * (high ≤ 14 days, medium ≤ 42, else low) and stay at most medium until the method has 50 scored
 * predictions with a one-sided 90% Wilson lower bound on coverage of at least 0.70. Split-conformal
 * widths per method and opportunity type replace the judgment widths once 20 residuals exist.
 */

export const CYCLE_EVENT_KINDS = ["opens", "closes", "campus_internal", "priority_round", "decision_expected", "program_start"] as const;
export const CycleEventKindSchema = z.enum(CYCLE_EVENT_KINDS);
export type CycleEventKind = z.infer<typeof CycleEventKindSchema>;

const RuleCommon = {
  event: CycleEventKindSchema,
  /** "HH:MM" in `timeZone`, when the page states a time. */
  localTime: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/).nullable().default(null),
  timeZone: z.string().max(64).nullable().default(null),
  /** "11:59 pm, your time zone": the instant depends on the applicant. */
  applicantLocal: z.boolean().default(false),
  /** False when rollover copied the rule and the new cycle's page has not restated it yet. */
  restatedThisCycle: z.boolean(),
};

export const DateRuleSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("fixed_date"), month: z.number().int().min(1).max(12), day: z.number().int().min(1).max(31), ...RuleCommon }).strict(),
  z.object({ kind: z.literal("nth_weekday"), month: z.number().int().min(1).max(12), weekday: z.number().int().min(1).max(7), nth: z.number().int().min(1).max(5), ...RuleCommon }).strict(),
  z.object({ kind: z.literal("last_weekday"), month: z.number().int().min(1).max(12), weekday: z.number().int().min(1).max(7), ...RuleCommon }).strict(),
  z.object({ kind: z.literal("offset"), anchor: z.literal("us_thanksgiving"), offsetDays: z.number().int().min(-120).max(120), ...RuleCommon }).strict(),
]);
export type DateRule = z.infer<typeof DateRuleSchema>;
export type DateRuleInput = z.input<typeof DateRuleSchema>;

/** The date (and instant, when a time and zone are stated) a rule gives in a calendar year. */
export function applyDateRule(rule: DateRuleInput, year: number): { readonly date: IsoDate | null; readonly instant: number | null } {
  let date: IsoDate | null = null;
  switch (rule.kind) {
    case "fixed_date":
      date = rule.day <= daysInMonth(year, rule.month) ? formatIsoDate({ year, month: rule.month, day: rule.day }) : null;
      break;
    case "nth_weekday":
      date = nthWeekdayOfMonth(year, rule.month, rule.weekday, rule.nth);
      break;
    case "last_weekday":
      date = nthWeekdayOfMonth(year, rule.month, rule.weekday, -1);
      break;
    case "offset":
      date = isoFromEpochDay(epochDayOf(usThanksgiving(year)) + rule.offsetDays);
      break;
  }
  if (date === null) return { date, instant: null };
  const zone = rule.timeZone ?? null;
  const time = rule.localTime ?? null;
  const instant = !rule.applicantLocal && zone && time && isValidTimeZone(zone) ? localDateTimeToInstant(date, time, zone) : null;
  return { date, instant };
}

export interface HistoryInterval {
  readonly event: CycleEventKind;
  readonly cycleYear: number;
  /** Interval bounds of the observation (exact: lo = hi; first seen open: [last seen closed, seen]). */
  readonly lo: IsoDate;
  readonly hi: IsoDate;
  /** First seen in a list's first commit: says when the list began, not when the program opened. */
  readonly leftCensored?: boolean;
}

export interface ExpectedMonth {
  readonly event: CycleEventKind;
  readonly month: number;
  /** The page states the month, or it matches the last verified event. */
  readonly evidenced: boolean;
}

export interface ConformalWidth {
  readonly qLo: number;
  readonly qHi: number;
  readonly n: number;
}

/** Split-conformal width offsets by `${method}|${stratum}` and pooled by `${method}|*`. */
export type ConformalWidthTable = ReadonlyMap<string, ConformalWidth>;

export interface CycleInputs {
  readonly dateRules?: readonly DateRuleInput[];
  readonly history?: readonly HistoryInterval[];
  readonly expectedMonths?: readonly ExpectedMonth[];
}

export interface PredictOptions {
  /** True once the label gate has passed for this event kind (50 scored, Wilson bound ≥ 0.70). */
  readonly gatePassed?: boolean;
  readonly conformal?: ConformalWidthTable | null;
  /** Opportunity-type stratum for conformal widths, e.g. "fellowship". */
  readonly stratum?: string;
  /** Enables the seasonal statistical method (plan 7.6.2's data trigger). */
  readonly statistical?: boolean;
  /** Type-level variance of the offset in days² for the seasonal method's 3 pseudo-cycles. */
  readonly typeVarianceDays2?: number;
}

export type PredictionDetailMethod =
  | "official_rule"
  | "inferred_rule"
  | "fixed_date"
  | "seasonal"
  | "weekday_shift"
  | "curator_month"
  | "curator_estimate";

export interface CyclePrediction {
  readonly event: CycleEventKind;
  readonly year: number;
  readonly p10: IsoDate;
  readonly p50: IsoDate;
  readonly p90: IsoDate;
  readonly widthDays: number;
  readonly label: PredictionLabel;
  readonly method: Prediction["method"];
  readonly detail: PredictionDetailMethod;
  /** s06's numeric confidence κ = 1 − min(1, width/90). */
  readonly kappa: number;
  /** The exact instant for official rules that state a time and zone. */
  readonly instant: number | null;
}

const LABEL_ORDER: readonly PredictionLabel[] = ["low", "medium", "high"];

export function labelForWidth(widthDays: number): PredictionLabel {
  const { highMaxDays, mediumMaxDays } = READINESS_CONFIG.prediction.labels;
  return widthDays <= highMaxDays ? "high" : widthDays <= mediumMaxDays ? "medium" : "low";
}

function capLabel(label: PredictionLabel, cap: PredictionLabel): PredictionLabel {
  return LABEL_ORDER.indexOf(label) <= LABEL_ORDER.indexOf(cap) ? label : cap;
}

export function kappaForWidth(widthDays: number): number {
  return 1 - Math.min(1, widthDays / READINESS_CONFIG.prediction.kappaDays);
}

const CONTRACT_METHOD: Record<PredictionDetailMethod, Prediction["method"]> = {
  official_rule: "official_rule",
  inferred_rule: "history",
  fixed_date: "history",
  seasonal: "history",
  weekday_shift: "history",
  curator_month: "curator_month",
  curator_estimate: "curator_estimate",
};

function build(
  event: CycleEventKind,
  year: number,
  p10: IsoDate,
  p50: IsoDate,
  p90: IsoDate,
  detail: PredictionDetailMethod,
  opts: PredictOptions,
  extra: { cap?: PredictionLabel; instant?: number | null } = {},
): CyclePrediction {
  const widthDays = epochDayOf(p90) - epochDayOf(p10);
  let label = labelForWidth(widthDays);
  if (extra.cap) label = capLabel(label, extra.cap);
  if (!opts.gatePassed) label = capLabel(label, "medium");
  return { event, year, p10, p50, p90, widthDays, label, method: CONTRACT_METHOD[detail], detail, kappa: kappaForWidth(widthDays), instant: extra.instant ?? null };
}

function symmetric(p50: IsoDate, width: number): { p10: IsoDate; p90: IsoDate } {
  const day = epochDayOf(p50);
  return { p10: isoFromEpochDay(day - Math.floor(width / 2)), p90: isoFromEpochDay(day + Math.ceil(width / 2)) };
}

function withWidths(
  p50: IsoDate,
  judgmentWidth: number,
  method: "fixed_date" | "weekday_shift" | "seasonal",
  opts: PredictOptions,
): { p10: IsoDate; p90: IsoDate } {
  const conformal = opts.conformal ? lookupConformal(opts.conformal, method, opts.stratum ?? "*") : null;
  if (!conformal) return symmetric(p50, judgmentWidth);
  const day = epochDayOf(p50);
  return { p10: isoFromEpochDay(day + Math.floor(conformal.qLo)), p90: isoFromEpochDay(day + Math.ceil(conformal.qHi)) };
}

function midpoint(h: HistoryInterval): IsoDate {
  const lo = epochDayOf(h.lo);
  const hi = epochDayOf(h.hi);
  return isoFromEpochDay(Math.floor((Math.min(lo, hi) + Math.max(lo, hi)) / 2));
}

function halfWidth(h: HistoryInterval): number {
  return Math.abs(epochDayOf(h.hi) - epochDayOf(h.lo)) / 2;
}

function monthDay(date: IsoDate): string {
  return date.slice(5);
}

/** Usable history for one event, newest first, left-censored rows dropped. */
export function historyFor(history: readonly HistoryInterval[], event: CycleEventKind): HistoryInterval[] {
  return history
    .filter((h) => h.event === event && !h.leftCensored && parseIsoDate(h.lo) && parseIsoDate(h.hi))
    .slice()
    .sort((a, b) => b.cycleYear - a.cycleYear || (a.lo < b.lo ? 1 : -1));
}

/** Reads an nth-weekday, last-weekday or fixed-date rule from 3+ consistent exact cycles. */
export function inferDateRule(history: readonly HistoryInterval[], event: CycleEventKind): DateRuleInput | null {
  const exact = historyFor(history, event).filter((h) => h.lo === h.hi);
  if (exact.length < 3) return null;
  const recent = exact.slice(0, Math.min(exact.length, 5));
  const parsed = recent.map((h) => parseIsoDate(h.lo)!);
  const sameMonth = parsed.every((d) => d.month === parsed[0]!.month);
  if (!sameMonth) return null;
  const month = parsed[0]!.month;
  const common = { event, localTime: null, timeZone: null, applicantLocal: false, restatedThisCycle: false };
  if (parsed.every((d) => d.day === parsed[0]!.day)) return { kind: "fixed_date", month, day: parsed[0]!.day, ...common };
  const weekdays = recent.map((h) => weekdayOfEpochDay(epochDayOf(h.lo)));
  if (!weekdays.every((w) => w === weekdays[0])) return null;
  const weekday = weekdays[0]!;
  if (recent.every((h, i) => nthWeekdayOfMonth(parsed[i]!.year, month, weekday, -1) === h.lo)) return { kind: "last_weekday", month, weekday, ...common };
  const nth = Math.ceil(parsed[0]!.day / 7);
  if (recent.every((h, i) => nthWeekdayOfMonth(parsed[i]!.year, month, weekday, nth) === h.lo)) return { kind: "nth_weekday", month, weekday, nth, ...common };
  return null;
}

/** Day of year (1-based) and the year's length. */
function dayOfYear(date: IsoDate): { doy: number; length: number; year: number } {
  const d = parseIsoDate(date)!;
  const jan1 = epochDayOf(`${String(d.year).padStart(4, "0")}-01-01`);
  return { doy: epochDayOf(date) - jan1 + 1, length: isLeapYear(d.year) ? 366 : 365, year: d.year };
}

/**
 * The seasonal method (plan 7.6.2, simplified): recency weights 0.7^age, a circular weighted mean
 * of day of year as anchor, a weighted trend from 4 cycles (slope prior sd 3 days a year), a
 * variance pooled with 3 pseudo-cycles of the type variance, and Student-t quantiles with
 * 2 + n degrees of freedom.
 */
function seasonalPrediction(h: readonly HistoryInterval[], year: number, typeVariance: number): { p10: number; p50: number; p90: number } | null {
  if (h.length < 3) return null;
  const decay = READINESS_CONFIG.level0.decay;
  const newest = h[0]!.cycleYear;
  const points = h.map((x) => {
    const mid = midpoint(x);
    const { doy, length, year: y } = dayOfYear(mid);
    return { angle: (2 * Math.PI * (doy - 1)) / length, doy, length, year: y, w: Math.pow(decay, newest - x.cycleYear) };
  });
  const sw = points.reduce((acc, p) => acc + p.w, 0);
  const cosMean = points.reduce((acc, p) => acc + p.w * Math.cos(p.angle), 0) / sw;
  const sinMean = points.reduce((acc, p) => acc + p.w * Math.sin(p.angle), 0) / sw;
  let anchorAngle = Math.atan2(sinMean, cosMean);
  if (anchorAngle < 0) anchorAngle += 2 * Math.PI;
  const anchorDoy = (anchorAngle / (2 * Math.PI)) * 365.25 + 1;
  const deltas = points.map((p) => {
    let d = p.doy - anchorDoy;
    while (d > p.length / 2) d -= p.length;
    while (d <= -p.length / 2) d += p.length;
    return d;
  });
  const xbar = points.reduce((acc, p) => acc + p.w * p.year, 0) / sw;
  const trend = points.length >= 4;
  const slopePriorPrecision = 1 / 9;
  let a = deltas.reduce((acc, d, i) => acc + points[i]!.w * d, 0) / sw;
  let b = 0;
  const sxx = points.reduce((acc, p) => acc + p.w * (p.year - xbar) ** 2, 0);
  if (trend) {
    const sxy = points.reduce((acc, p, i) => acc + p.w * (p.year - xbar) * deltas[i]!, 0);
    // Posterior mean of the slope under N(0, 3²), with the type variance standing in for σ².
    b = sxy / (sxx + slopePriorPrecision * typeVariance);
    a = deltas.reduce((acc, d, i) => acc + points[i]!.w * (d - b * (points[i]!.year - xbar)), 0) / sw;
  }
  const rss = deltas.reduce((acc, d, i) => acc + points[i]!.w * (d - a - b * (points[i]!.year - xbar)) ** 2, 0);
  const s2 = (3 * typeVariance + rss) / (3 + points.length - 1);
  const varB = trend ? 1 / (sxx / s2 + slopePriorPrecision) : 0;
  const scale = Math.sqrt(s2 * (1 + 1 / sw) + (year - xbar) ** 2 * varB);
  const t = studentTQuantile(0.9, 2 + points.length);
  const center = epochDayOf(`${String(year).padStart(4, "0")}-01-01`) + (anchorDoy - 1) + a + b * (year - xbar);
  return { p10: Math.floor(center - t * scale), p50: Math.round(center), p90: Math.ceil(center + t * scale) };
}

/** Plan 7.6.1's predictV0 with the inferred-rule, seasonal and conformal refinements. */
export function predictCycleEvent(inputs: CycleInputs, event: CycleEventKind, year: number, opts: PredictOptions = {}): CyclePrediction | null {
  const widths = READINESS_CONFIG.prediction.widths;
  const rule = (inputs.dateRules ?? []).find((r) => r.event === event);
  if (rule) {
    const applied = applyDateRule(rule, year);
    if (applied.date) {
      const width = rule.restatedThisCycle ? widths.restated : widths.carriedOver;
      const { p10, p90 } = symmetric(applied.date, width);
      return build(event, year, p10, applied.date, p90, "official_rule", opts, {
        cap: rule.restatedThisCycle ? undefined : "medium",
        instant: applied.instant,
      });
    }
  }

  const h = historyFor(inputs.history ?? [], event);
  const pad = h.length > 0 ? 2 * (h.reduce((s, x) => s + halfWidth(x), 0) / h.length) : 0;
  const inferred = inferDateRule(h, event);
  if (inferred) {
    const applied = applyDateRule(inferred, year);
    if (applied.date) {
      const { p10, p90 } = symmetric(applied.date, widths.carriedOver);
      return build(event, year, p10, applied.date, p90, "inferred_rule", opts, { cap: "medium" });
    }
  }
  if (h.length >= 2 && monthDay(midpoint(h[0]!)) === monthDay(midpoint(h[1]!))) {
    const p50 = sameMonthDayInYear(midpoint(h[0]!), year);
    const { p10, p90 } = withWidths(p50, widths.fixedDate + pad, "fixed_date", opts);
    return build(event, year, p10, p50, p90, "fixed_date", opts);
  }
  if (opts.statistical && h.length >= 3) {
    const seasonal = seasonalPrediction(h, year, opts.typeVarianceDays2 ?? 49);
    if (seasonal) {
      const p50 = isoFromEpochDay(seasonal.p50);
      const conformal = opts.conformal ? lookupConformal(opts.conformal, "seasonal", opts.stratum ?? "*") : null;
      const p10 = conformal ? isoFromEpochDay(seasonal.p50 + Math.floor(conformal.qLo)) : isoFromEpochDay(seasonal.p10);
      const p90 = conformal ? isoFromEpochDay(seasonal.p50 + Math.ceil(conformal.qHi)) : isoFromEpochDay(seasonal.p90);
      return build(event, year, p10, p50, p90, "seasonal", opts);
    }
  }
  if (h.length >= 1) {
    const newest = midpoint(h[0]!);
    const newestYear = parseIsoDate(newest)!.year;
    const tight = h.length >= 2 && Math.abs(epochDayOf(sameWeekdayNear(midpoint(h[1]!), newestYear)) - epochDayOf(newest)) <= 7;
    const p50 = sameWeekdayNear(newest, year);
    const { p10, p90 } = withWidths(p50, (tight ? widths.weekdayTight : widths.weekdayLoose) + pad, "weekday_shift", opts);
    return build(event, year, p10, p50, p90, "weekday_shift", opts);
  }

  const month = (inputs.expectedMonths ?? []).find((m) => m.event === event);
  if (month) {
    const first = formatIsoDate({ year, month: month.month, day: 1 });
    const last = formatIsoDate({ year, month: month.month, day: daysInMonth(year, month.month) });
    const mid = isoFromEpochDay(Math.floor((epochDayOf(first) + epochDayOf(last)) / 2));
    if (month.evidenced) return build(event, year, first, mid, last, "curator_month", opts);
    const pad7 = widths.curatorEstimatePad;
    return build(event, year, isoFromEpochDay(epochDayOf(first) - pad7), mid, isoFromEpochDay(epochDayOf(last) + pad7), "curator_estimate", opts, { cap: "low" });
  }
  return null;
}

/** The contract shape stored on cycles and cards. */
export function toPrediction(p: CyclePrediction): Prediction {
  return { p10: p.p10, p50: p.p50, p90: p.p90, label: p.label, method: p.method };
}

// ---------------------------------------------------------------------------------------------
// Scoring, the label gate and conformal widths.
// ---------------------------------------------------------------------------------------------

export interface ObservedEvent {
  readonly lo: IsoDate;
  readonly hi: IsoDate;
}

/** Covered when [p10, p90] overlaps the event's interval; error from the interval's midpoint. */
export function scorePrediction(p: Pick<CyclePrediction, "p10" | "p50" | "p90">, observed: ObservedEvent): { readonly covered: boolean; readonly absErrorDays: number } {
  const covered = p.p10 <= observed.hi && p.p90 >= observed.lo;
  const mid = (epochDayOf(observed.lo) + epochDayOf(observed.hi)) / 2;
  return { covered, absErrorDays: Math.abs(epochDayOf(p.p50) - mid) };
}

/** Signed residual of an interval-censored observation: 0 if p50 is inside it, else the gap to the nearer edge. */
export function intervalResidualDays(p50: IsoDate, observed: ObservedEvent): number {
  const c = epochDayOf(p50);
  const lo = epochDayOf(observed.lo);
  const hi = epochDayOf(observed.hi);
  if (c < lo) return lo - c;
  if (c > hi) return hi - c;
  return 0;
}

/** Gneiting-Raftery interval score at α (0.2 for an 80% interval), in days; lower is better. */
export function intervalScore(p10: IsoDate, p90: IsoDate, observed: IsoDate, alpha = 0.2): number {
  const l = epochDayOf(p10);
  const u = epochDayOf(p90);
  const y = epochDayOf(observed);
  return u - l + (2 / alpha) * Math.max(0, l - y) + (2 / alpha) * Math.max(0, y - u);
}

export interface LabelGate {
  readonly n: number;
  readonly covered: number;
  readonly wilsonLower: number;
  readonly passes: boolean;
}

/** The label gate: at least 50 scored predictions and a one-sided 90% Wilson lower bound ≥ 0.70. */
export function predictionLabelGate(scored: readonly { readonly covered: boolean }[]): LabelGate {
  const { minScored, minWilsonLower, wilsonLevel } = READINESS_CONFIG.prediction.gate;
  const n = scored.length;
  const covered = scored.filter((s) => s.covered).length;
  const wilsonLower = wilsonLowerBound(covered, n, wilsonLevel);
  return { n, covered, wilsonLower, passes: n >= minScored && wilsonLower >= minWilsonLower };
}

export interface PredictionResidual {
  readonly method: "fixed_date" | "weekday_shift" | "seasonal";
  /** Opportunity-type stratum ("fellowship", "research", ...). */
  readonly stratum: string;
  readonly residualDays: number;
}

function conformalOffsets(residuals: readonly number[], alpha: number): ConformalWidth {
  const sorted = residuals.slice().sort((a, b) => a - b);
  const n = sorted.length;
  const kLo = Math.floor((n + 1) * (alpha / 2));
  const kHi = Math.ceil((n + 1) * (1 - alpha / 2));
  return {
    qLo: kLo >= 1 ? sorted[kLo - 1]! : -Infinity,
    qHi: kHi <= n ? sorted[kHi - 1]! : Infinity,
    n,
  };
}

/**
 * Mondrian split-conformal widths: per method × stratum when it has at least 20 residuals, and
 * pooled across strata per method as the fallback (`method|*`); below that the judgment widths stay.
 */
export function conformalWidths(residuals: readonly PredictionResidual[], opts: { alpha?: number; minPerStratum?: number } = {}): ConformalWidthTable {
  const alpha = opts.alpha ?? READINESS_CONFIG.prediction.conformal.alpha;
  const min = opts.minPerStratum ?? READINESS_CONFIG.prediction.conformal.minPerStratum;
  const groups = new Map<string, number[]>();
  for (const r of residuals) {
    if (!Number.isFinite(r.residualDays)) continue;
    for (const key of [`${r.method}|${r.stratum}`, `${r.method}|*`]) groups.set(key, [...(groups.get(key) ?? []), r.residualDays]);
  }
  const table = new Map<string, ConformalWidth>();
  for (const [key, values] of [...groups.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (values.length < min) continue;
    const offsets = conformalOffsets(values, alpha);
    if (Number.isFinite(offsets.qLo) && Number.isFinite(offsets.qHi)) table.set(key, offsets);
  }
  return table;
}

export function lookupConformal(table: ConformalWidthTable, method: string, stratum: string): ConformalWidth | null {
  return table.get(`${method}|${stratum}`) ?? table.get(`${method}|*`) ?? null;
}
