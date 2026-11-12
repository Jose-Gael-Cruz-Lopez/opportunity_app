import { READINESS_CONFIG } from "./config";
import { jeffreysInterval, type Interval } from "./math/intervals";
import type { StageOdds } from "../contracts/registry";
import type { CountKind, CountStage } from "../taxonomy";

/**
 * Official odds: arithmetic on official_publication counts, never a model (plan 7.5.2, D2).
 * Each stage shows k of n, the year, the source and a natural frequency. A multi-stage funnel
 * (campus nomination, then national award) is shown stage by stage: the program-level product
 * P(nominated) × P(award | nominated) equals awards ÷ entry pool and is shown only as that
 * official ratio, never as a personal probability, because campus quotas and pools differ.
 */

/** The main chain, in order. Alternates are a side stage and never part of a transition. */
export const FUNNEL_ORDER: readonly CountStage[] = ["campus_applicants", "applicants", "nominees", "finalists", "awards"];

export interface OfficialCountRow {
  readonly stage: CountStage;
  readonly count: number;
  readonly kind: CountKind;
  readonly provenance: "official_publication" | "owner_reported";
  readonly cycleYear: number;
  readonly sourceUrl: string;
  readonly verifiedAt: string;
  readonly verifiedBy: string;
}

const KIND_RANK: Record<CountKind, number> = { exact: 0, approx: 1, lower_bound: 2 };

/**
 * The kind of a ratio k/n: an exact count over a lower-bound pool is an upper bound on the
 * rate ("at most"); anything else that is not exact over exact is approximate.
 */
export function ratioKind(numerator: CountKind, denominator: CountKind): CountKind {
  if (numerator === "exact" && denominator === "exact") return "exact";
  if (numerator === "exact" && denominator === "lower_bound") return "lower_bound";
  return "approx";
}

function officialByYear(rows: readonly OfficialCountRow[]): Map<number, Map<CountStage, OfficialCountRow>> {
  const byYear = new Map<number, Map<CountStage, OfficialCountRow>>();
  // Only published counts feed odds: an owner-reported pool must never make a program look less crowded.
  const official = rows
    .filter((r) => r.provenance === "official_publication" && Number.isFinite(r.count) && r.count >= 0)
    .slice()
    .sort(
      (a, b) =>
        KIND_RANK[a.kind] - KIND_RANK[b.kind] ||
        (a.verifiedAt > b.verifiedAt ? -1 : a.verifiedAt < b.verifiedAt ? 1 : 0) ||
        a.count - b.count,
    );
  for (const row of official) {
    const stages = byYear.get(row.cycleYear) ?? new Map<CountStage, OfficialCountRow>();
    if (!stages.has(row.stage)) stages.set(row.stage, row);
    byYear.set(row.cycleYear, stages);
  }
  return byYear;
}

/** StageOdds for consecutive official stages with both counts, newest year first. */
export function officialStageOdds(rows: readonly OfficialCountRow[]): StageOdds[] {
  const out: StageOdds[] = [];
  const byYear = officialByYear(rows);
  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    const stages = byYear.get(year)!;
    const present = FUNNEL_ORDER.filter((s) => stages.has(s));
    for (let i = 0; i + 1 < present.length; i++) {
      const from = stages.get(present[i]!)!;
      const to = stages.get(present[i + 1]!)!;
      if (from.count <= 0 || to.count > from.count) continue; // malformed pair: never display
      out.push({
        fromStage: from.stage,
        toStage: to.stage,
        cycleYear: year,
        numerator: to.count,
        denominator: from.count,
        denominatorKind: ratioKind(to.kind, from.kind),
        sourceUrl: to.sourceUrl,
        verifiedAt: to.verifiedAt,
        verifiedBy: to.verifiedBy,
      });
    }
  }
  return out;
}

export interface EntryAccess {
  readonly k: number;
  readonly n: number;
  readonly kind: CountKind;
  readonly stage: CountStage;
  readonly year: number;
}

/**
 * Awards ÷ the pool a student enters (campus applicants for nomination-gated programs, else
 * applicants), from the latest year with both. Null when only nominee counts exist.
 */
export function entryAccess(rows: readonly OfficialCountRow[], opts: { nominationGated: boolean }): EntryAccess | null {
  const entry: CountStage = opts.nominationGated ? "campus_applicants" : "applicants";
  const byYear = officialByYear(rows);
  for (const year of [...byYear.keys()].sort((a, b) => b - a)) {
    const stages = byYear.get(year)!;
    const pool = stages.get(entry);
    const awards = stages.get("awards");
    if (!pool || !awards || pool.count <= 0 || awards.count > pool.count) continue;
    return { k: awards.count, n: pool.count, kind: ratioKind(awards.kind, pool.kind), stage: entry, year };
  }
  return null;
}

/** "1,485" without depending on the runtime's locale data. */
export function formatCount(n: number): string {
  return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

const STAGE_NOUNS: Record<CountStage, string> = {
  campus_applicants: "campus applicants",
  applicants: "applicants",
  nominees: "nominees",
  finalists: "finalists",
  awards: "award winners",
  alternates: "alternates",
};

const TRANSITION_VERBS: Record<CountStage, string> = {
  campus_applicants: "applied on campus",
  applicants: "applied",
  nominees: "were nominated",
  finalists: "became finalists",
  awards: "won",
  alternates: "became alternates",
};

export function stageNoun(stage: CountStage): string {
  return STAGE_NOUNS[stage];
}

/**
 * A natural frequency for a program-level rate: "about 3 in 10" from p ≥ 0.1, else "about 7 in
 * 100". An upper bound (lower-bound pool) reads "at most" and rounds up so it never understates
 * the bound; whole tens simplify ("at most 10 in 100" reads "at most 1 in 10").
 */
export function naturalFrequency(k: number, n: number, kind: CountKind): string {
  if (n <= 0) return "unknown";
  const p = Math.min(1, Math.max(0, k / n));
  if (kind === "lower_bound") {
    if (p >= 0.1) return `at most ${Math.min(10, Math.ceil(p * 10 - 1e-9))} in 10`;
    const per100 = Math.max(1, Math.ceil(p * 100 - 1e-9));
    return per100 % 10 === 0 ? `at most ${per100 / 10} in 10` : `at most ${per100} in 100`;
  }
  if (p >= 0.95) return "nearly all";
  if (p >= 0.1) return `about ${Math.round(p * 10)} in 10`;
  const per100 = Math.round(p * 100);
  if (per100 === 0) return "fewer than 1 in 100";
  return per100 === 10 ? "about 1 in 10" : `about ${per100} in 100`;
}

/** "In 2026, 454 of 1,485 nominees won: about 3 in 10." */
export function stageOddsSentence(o: StageOdds): string {
  const freq = naturalFrequency(o.numerator, o.denominator, o.denominatorKind);
  const pool = o.denominatorKind === "lower_bound" ? `more than ${formatCount(o.denominator)}` : o.denominatorKind === "approx" ? `about ${formatCount(o.denominator)}` : formatCount(o.denominator);
  return `In ${o.cycleYear}, ${formatCount(o.numerator)} of ${pool} ${STAGE_NOUNS[o.fromStage]} ${TRANSITION_VERBS[o.toStage]}: ${freq}.`;
}

/** Internal 80% Jeffreys interval for an official rate (never displayed; ±1.5 points at Goldwater's size). */
export function officialRateInterval(o: Pick<StageOdds, "numerator" | "denominator">, level = READINESS_CONFIG.odds.intervalLevel): Interval {
  return jeffreysInterval(o.numerator, o.denominator, level);
}

export interface FunnelStep {
  readonly odds: StageOdds;
  readonly frequency: string;
  readonly sentence: string;
}

export interface Funnel {
  readonly year: number | null;
  readonly steps: readonly FunnelStep[];
  /** "set_by_campus": a nomination-gated program without official campus counts; Novus does not estimate it. */
  readonly campusStage: "official" | "set_by_campus" | "not_applicable";
  /** Program-level awards ÷ entry pool when the year's chain reaches from entry to awards. */
  readonly overall: { readonly k: number; readonly n: number; readonly kind: CountKind; readonly frequency: string } | null;
}

/** The latest year's official funnel, stage by stage. */
export function buildFunnel(stageOdds: readonly StageOdds[], opts: { nominationGated: boolean }): Funnel {
  const year = stageOdds.reduce<number | null>((y, o) => (y === null || o.cycleYear > y ? o.cycleYear : y), null);
  const steps = stageOdds
    .filter((o) => o.cycleYear === year)
    .slice()
    .sort((a, b) => FUNNEL_ORDER.indexOf(a.fromStage) - FUNNEL_ORDER.indexOf(b.fromStage))
    .map((odds) => ({ odds, frequency: naturalFrequency(odds.numerator, odds.denominator, odds.denominatorKind), sentence: stageOddsSentence(odds) }));
  const hasCampus = steps.some((s) => s.odds.fromStage === "campus_applicants");
  const campusStage = !opts.nominationGated ? "not_applicable" : hasCampus ? "official" : "set_by_campus";
  const entry: CountStage = opts.nominationGated ? "campus_applicants" : "applicants";
  let overall: Funnel["overall"] = null;
  const first = steps[0];
  const last = steps[steps.length - 1];
  const chained = steps.every((s, i) => i === 0 || steps[i - 1]!.odds.toStage === s.odds.fromStage);
  if (first && last && chained && first.odds.fromStage === entry && last.odds.toStage === "awards") {
    const kinds = steps.map((s) => s.odds.denominatorKind);
    const kind: CountKind = kinds.every((k) => k === "exact") ? "exact" : kinds.every((k) => k !== "approx") ? "lower_bound" : "approx";
    overall = { k: last.odds.numerator, n: first.odds.denominator, kind, frequency: naturalFrequency(last.odds.numerator, first.odds.denominator, kind) };
  }
  return { year, steps, campusStage, overall };
}

/** The student's stage: as reported on their tracker, else the stage they enter at. */
export function currentStageFor(studentStage: CountStage | null | undefined, nominationGated: boolean): CountStage {
  return studentStage ?? (nominationGated ? "campus_applicants" : "applicants");
}

export interface StudentTransition {
  readonly odds: StageOdds;
  /** True when the student has not reached `odds.fromStage` yet ("if nominated"). */
  readonly conditional: boolean;
}

/**
 * The official transition that applies to the student now: the one leaving their stage, or for
 * a campus applicant of a nomination-gated program, the national stage labelled "if nominated".
 * The campus stage itself is never shown as the student's odds: a national pool count says
 * nothing about one campus's quota and applicants (plan 7.5.2, "set by your campus").
 */
export function transitionForStudent(
  stageOdds: readonly StageOdds[],
  currentStage: CountStage,
  opts: { nominationGated?: boolean } = {},
): StudentTransition | null {
  const year = stageOdds.reduce<number | null>((y, o) => (y === null || o.cycleYear > y ? o.cycleYear : y), null);
  const latest = stageOdds.filter((o) => o.cycleYear === year && !(opts.nominationGated && o.fromStage === "campus_applicants"));
  const exact = latest.find((o) => o.fromStage === currentStage);
  if (exact) return { odds: exact, conditional: false };
  const position = FUNNEL_ORDER.indexOf(currentStage);
  const later = latest
    .filter((o) => FUNNEL_ORDER.indexOf(o.fromStage) > position)
    .sort((a, b) => FUNNEL_ORDER.indexOf(a.fromStage) - FUNNEL_ORDER.indexOf(b.fromStage));
  return later[0] ? { odds: later[0], conditional: true } : null;
}
