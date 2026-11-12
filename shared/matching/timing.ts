import type { DeadlineView, ProgramCard } from "../contracts/registry";
import { addDays, compareIsoDates, computeSortAt, daysBetween, isIsoDate, isValidTimeZone, localDateIn, resolveDeadlineForViewer } from "../time";
import { MATCHING_CONFIG } from "./config";

/**
 * Timing for order v0 (plan 6.6.1) and the effective deadline it orders by (plan 6.4.5).
 *
 * The plan puts `effectiveDeadline` in shared/eligibility; that module does not export one yet,
 * so this is the step logic ordering needs, kept pure and small. ProgramCard carries no per-program
 * campus lead times, so E1 and E2 use the published defaults (70 and 42 days) from the readiness
 * config. When eligibility ships the canonical function, this file should delegate to it.
 */

/** 0 start now, 1 start soon, 2 tight, 3 later (also rolling and opening soon), 4 plan ahead, 5 closed. */
export const TIMING_BUCKETS = ["start_now", "start_soon", "tight", "later", "plan_ahead", "closed"] as const;
export type TimingBucketName = (typeof TIMING_BUCKETS)[number];
export type TimingBucket = 0 | 1 | 2 | 3 | 4 | 5;

export const SECTIONS = ["act_now", "plan_ahead", "closed", "not_eligible"] as const;
export type Section = (typeof SECTIONS)[number];

/** Which step of the effective-deadline ladder applies. */
export type DeadlineStep = "campus" | "e1" | "e2" | "national" | "none";
/** Why the campus date is uncertain, when it is (nomination-gated cycles only). */
export type CampusUncertainty = "e1" | "e2" | "national";

export interface OpeningWindow {
  readonly date: string;
  /** True when the date comes from a prediction rather than an announced opening. */
  readonly predicted: boolean;
  readonly p10: string | null;
  readonly p90: string | null;
}

export interface TimingInfo {
  readonly bucket: TimingBucket;
  readonly bucketName: TimingBucketName;
  readonly section: Exclude<Section, "not_eligible">;
  /** The date the student is working toward, in their zone. */
  readonly effectiveDate: string | null;
  readonly step: DeadlineStep;
  /** The next national submission date, for copy ("national deadline Jan 29"). */
  readonly nationalDate: string | null;
  readonly campusUncertain: CampusUncertainty | null;
  readonly daysLeft: number | null;
  readonly prepDays: number | null;
  readonly startBy: string | null;
  readonly tight: boolean;
  readonly rolling: boolean;
  readonly opening: OpeningWindow | null;
  /** Internal sort key (days until start-by, deadline or opening); never sent to clients. */
  readonly sortDays: number;
}

export interface TimingContext {
  readonly now: number;
  readonly today: string;
  readonly timeZone: string;
  /** Known campus dates for this cycle: the student's private date and verified campus rows. */
  readonly campusDates?: readonly string[];
}

/** Kinds that are a national submission step. Recommendation and supplemental rows ride on prepDays. */
const NATIONAL_KINDS: ReadonlySet<DeadlineView["kind"]> = new Set(["application", "priority_round", "interest_form"]);
const CAMPUS_KINDS: ReadonlySet<DeadlineView["kind"]> = new Set(["campus_internal", "nomination"]);

/** Sorts undated items after every dated one inside a bucket. */
const UNDATED_SORT_DAYS = 100_000;

interface DatedDeadline {
  readonly date: string;
  readonly instant: number | null;
}

/** The deadline's date on the viewer's clock, or null for rolling and TBD rows. */
export function deadlineLocalDate(d: DeadlineView, timeZone: string): DatedDeadline | null {
  if (d.precision === "rolling" || d.precision === "tbd") return null;
  const viewer = resolveDeadlineForViewer(d, timeZone);
  if (viewer.instant !== null) return { date: localDateIn(viewer.instant, timeZone), instant: viewer.instant };
  // Month-only and window rows have no single instant; order them by their sort instant.
  const sortAt = computeSortAt(d);
  if (sortAt !== null) return { date: localDateIn(sortAt, timeZone), instant: null };
  return viewer.viewerLocalDate && isIsoDate(viewer.viewerLocalDate) ? { date: viewer.viewerLocalDate, instant: null } : null;
}

function isUpcoming(d: DatedDeadline, ctx: TimingContext): boolean {
  if (d.instant !== null) return d.instant >= ctx.now;
  return compareIsoDates(d.date, ctx.today) >= 0;
}

function earliest(dates: readonly string[]): string | null {
  let best: string | null = null;
  for (const date of dates) if (best === null || compareIsoDates(date, best) < 0) best = date;
  return best;
}

function bucketName(bucket: TimingBucket): TimingBucketName {
  return TIMING_BUCKETS[bucket];
}

function sectionFor(bucket: TimingBucket): TimingInfo["section"] {
  if (bucket <= 3) return "act_now";
  return bucket === 4 ? "plan_ahead" : "closed";
}

function baseInfo(card: ProgramCard): Omit<TimingInfo, "bucket" | "bucketName" | "section" | "sortDays"> {
  return {
    effectiveDate: null,
    step: "none",
    nationalDate: null,
    campusUncertain: null,
    daysLeft: null,
    prepDays: card.prepDays,
    startBy: null,
    tight: false,
    rolling: false,
    opening: null,
  };
}

function withBucket(info: Omit<TimingInfo, "bucket" | "bucketName" | "section" | "sortDays">, bucket: TimingBucket, sortDays: number): TimingInfo {
  return { ...info, bucket, bucketName: bucketName(bucket), section: sectionFor(bucket), sortDays };
}

/** Expected cycles: Act now only when the opening is announced or predicted with confidence within 30 days. */
function expectedTiming(card: ProgramCard, ctx: TimingContext): TimingInfo {
  const info = baseInfo(card);
  const soon = MATCHING_CONFIG.timing.openingSoonDays;
  if (card.opensOn) {
    const days = Math.max(0, daysBetween(ctx.today, card.opensOn));
    const opening: OpeningWindow = { date: card.opensOn, predicted: false, p10: null, p90: null };
    return withBucket({ ...info, opening }, days <= soon ? 3 : 4, days);
  }
  const p = card.prediction;
  if (p) {
    const opening: OpeningWindow = { date: p.p50, predicted: true, p10: p.p10, p90: p.p90 };
    const toP10 = daysBetween(ctx.today, p.p10);
    const windowLive = compareIsoDates(p.p90, ctx.today) >= 0;
    const confident = p.label === "medium" || p.label === "high";
    const days = Math.max(0, toP10);
    return withBucket({ ...info, opening }, confident && windowLive && toP10 <= soon ? 3 : 4, days);
  }
  return withBucket(info, 4, UNDATED_SORT_DAYS);
}

interface StepChoice {
  readonly date: string | null;
  readonly step: DeadlineStep;
  readonly uncertain: CampusUncertainty | null;
}

/** The effective-deadline ladder of plan 6.4.5, steps 1 to 5. */
function chooseStep(card: ProgramCard, national: string | null, campusUpcoming: string | null, campusPassed: boolean, today: string): StepChoice {
  if (campusUpcoming) return { date: campusUpcoming, step: "campus", uncertain: null };
  if (!card.flags.nominationRequired) return { date: national, step: national ? "national" : "none", uncertain: null };
  if (!national) return { date: null, step: "none", uncertain: null };
  if (campusPassed) return { date: national, step: "national", uncertain: "national" };
  const e1 = addDays(national, -MATCHING_CONFIG.timing.campusL80Days);
  if (compareIsoDates(e1, today) >= 0) return { date: e1, step: "e1", uncertain: "e1" };
  const e2 = addDays(national, -MATCHING_CONFIG.timing.campusL50Days);
  if (compareIsoDates(e2, today) >= 0) return { date: e2, step: "e2", uncertain: "e2" };
  return { date: national, step: "national", uncertain: "national" };
}

function openTiming(card: ProgramCard, ctx: TimingContext): TimingInfo {
  const info = baseInfo(card);
  const nationalDates: string[] = [];
  const campusDates: string[] = [];
  let campusPassed = false;
  let anyDated = false;

  for (const d of card.deadlines) {
    const dated = deadlineLocalDate(d, ctx.timeZone);
    if (!dated) continue;
    const isCampus = d.scope === "campus" || CAMPUS_KINDS.has(d.kind);
    if (!isCampus && !NATIONAL_KINDS.has(d.kind)) continue;
    anyDated = true;
    if (!isUpcoming(dated, ctx)) {
      if (isCampus) campusPassed = true;
      continue;
    }
    (isCampus ? campusDates : nationalDates).push(dated.date);
  }
  for (const own of ctx.campusDates ?? []) {
    if (!isIsoDate(own)) continue;
    if (compareIsoDates(own, ctx.today) >= 0) campusDates.push(own);
    else campusPassed = true;
  }

  const national = earliest(nationalDates);
  const choice = chooseStep(card, national, earliest(campusDates), campusPassed, ctx.today);
  if (!choice.date) {
    // Open with nothing dated (or only rolling rows) is rolling; open with every date passed is closed.
    if (anyDated) return withBucket({ ...info, nationalDate: national }, 5, UNDATED_SORT_DAYS);
    return withBucket({ ...info, rolling: true }, 3, UNDATED_SORT_DAYS);
  }

  const daysLeft = daysBetween(ctx.today, choice.date);
  const p = card.prepDays;
  const hasPrep = p !== null && p > 0;
  const startByDays = hasPrep ? daysLeft - p : daysLeft;
  const tight = hasPrep && startByDays < 0;
  const cfg = MATCHING_CONFIG.timing;
  let bucket: TimingBucket = tight ? 2 : startByDays <= cfg.startNowDays ? 0 : startByDays <= cfg.startSoonDays ? 1 : 3;
  // An uncertain campus date leads the list instead of reading as tight (plan 6.4.5), but only
  // once it is inside the Act now horizon; months ahead it stays with the other later items.
  if (choice.uncertain && bucket !== 3) bucket = 0;

  return withBucket(
    {
      ...info,
      effectiveDate: choice.date,
      step: choice.step,
      nationalDate: national,
      campusUncertain: choice.uncertain,
      daysLeft,
      startBy: hasPrep ? addDays(choice.date, -p) : null,
      tight: tight && !choice.uncertain,
    },
    bucket,
    startByDays,
  );
}

/** Timing for one card at `ctx.now` in the student's zone. */
export function computeTiming(card: ProgramCard, ctx: TimingContext): TimingInfo {
  switch (card.status) {
    case "expected":
      return expectedTiming(card, ctx);
    case "open":
    case "relaunched":
      return openTiming(card, ctx);
    default:
      return withBucket(baseInfo(card), 5, UNDATED_SORT_DAYS);
  }
}

/** Builds a timing context from an instant and an optional zone (falls back to the product zone). */
export function timingContext(now: number, timeZone: string | null | undefined, campusDates?: readonly string[]): TimingContext {
  const zone = timeZone && isValidTimeZone(timeZone) ? timeZone : MATCHING_CONFIG.fallbackTimeZone;
  return { now, today: localDateIn(now, zone), timeZone: zone, ...(campusDates ? { campusDates } : {}) };
}
