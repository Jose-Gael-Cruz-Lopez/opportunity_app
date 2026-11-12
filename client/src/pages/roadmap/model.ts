import { ACADEMIC_YEAR_TERM_ORDER } from "@shared/config/product";
import {
  CLASS_YEAR_INDEX,
  type AcademicTerm,
  type ClassYear,
  type NextAction,
  type Roadmap,
  type RoadmapItem,
  type RoadmapItemAction,
  type TermPlan,
} from "@shared/contracts";
import { academicYearStart, daysBetween, parseTermKey, termKeyForDate, compareTermKeys } from "@shared/time";

/**
 * View model for the Roadmap page. The server computes the plan (s07's Roadmap v0); this module
 * only arranges it by academic year and season, folds in readiness next actions that have no
 * roadmap item yet, and applies the student's own actions optimistically. No scoring happens here.
 */

export type PlanItemOrigin = "roadmap" | "next_action";

/** A roadmap item plus what the page needs to act on it. */
export interface PlanItem extends RoadmapItem {
  readonly origin: PlanItemOrigin;
  /** Checklist subject the item resolves (`req:{id}` or `kind:{kind}`), for next-action items. */
  readonly relatesTo: string | null;
  readonly programName: string | null;
}

export type ItemTone = "done" | "soon" | "due" | "plan" | "missed" | "dismissed";

export const TONE_WORDS: Record<ItemTone, string> = {
  done: "Done",
  soon: "Due soon",
  due: "Deadline",
  plan: "Planned",
  missed: "Missed",
  dismissed: "Dismissed",
};

/** Items due within this many days read as "due soon" (PRODUCT.readiness.soonWithinDays). */
export const SOON_DAYS = 14;

export const SEASON_LABELS: Record<AcademicTerm, string> = {
  fall: "Fall",
  winter: "Winter",
  spring: "Spring",
  summer: "Summer",
};

// ---------------------------------------------------------------------------------------------
// Terms and academic years
// ---------------------------------------------------------------------------------------------

/** First calendar year of the academic year a term belongs to: fall-2026 and spring-2027 -> 2026. */
export function academicYearOfTerm(termKey: string): number {
  const t = parseTermKey(termKey);
  if (!t) throw new RangeError(`invalid term key: ${termKey}`);
  return t.term === "fall" ? t.year : t.year - 1;
}

export function academicYearLabel(startYear: number): string {
  return `${startYear}–${String((startYear + 1) % 100).padStart(2, "0")}`;
}

/** The term key for a season of an academic year: (2026, spring) -> spring-2027. */
export function termKeyFor(startYear: number, season: AcademicTerm): string {
  return `${season}-${season === "fall" ? startYear : startYear + 1}`;
}

export function currentTermKey(today: string): string {
  return termKeyForDate(today);
}

/**
 * Year of study (1-based) for an academic year, given the student's class year today. Returns
 * null when the class year has no index (graduate, recent graduate) or is unknown.
 */
export function yearOfStudy(startYear: number, classYear: ClassYear | null, today: string): number | null {
  if (!classYear) return null;
  const idx = CLASS_YEAR_INDEX[classYear];
  if (idx === null) return null;
  const nowStart = academicYearStart(today);
  // An incoming first-year (index 0) starts year 1 in the next academic year.
  const yearNow = Math.max(idx, 1) + (idx === 0 ? -1 : 0);
  return yearNow + (startYear - nowStart);
}

// ---------------------------------------------------------------------------------------------
// Items
// ---------------------------------------------------------------------------------------------

export function fromRoadmapItem(item: RoadmapItem, programName: string | null = null): PlanItem {
  return { ...item, origin: "roadmap", relatesTo: null, programName };
}

export function itemTone(item: RoadmapItem, today: string): ItemTone {
  if (item.state === "done") return "done";
  if (item.state === "dismissed") return "dismissed";
  if (item.state === "missed") return "missed";
  const date = item.startBy ?? item.dueOn;
  if (item.dueOn && daysBetween(today, item.dueOn) < 0) return "missed";
  if (date && daysBetween(today, date) <= SOON_DAYS) return "soon";
  if (item.kind === "apply" && item.dueOn) return "due";
  return "plan";
}

const KIND_ORDER: Record<RoadmapItem["kind"], number> = { apply: 0, prepare: 1, milestone: 2 };

/** Pinned first, then by the date that matters (start-by, then due), then kind and title. */
export function compareItems(a: RoadmapItem, b: RoadmapItem): number {
  if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
  const da = a.startBy ?? a.dueOn ?? "9999-12-31";
  const db = b.startBy ?? b.dueOn ?? "9999-12-31";
  if (da !== db) return da < db ? -1 : 1;
  if (a.kind !== b.kind) return KIND_ORDER[a.kind] - KIND_ORDER[b.kind];
  return a.title.localeCompare(b.title);
}

export function termItems(plan: TermPlan): RoadmapItem[] {
  return [...plan.apply, ...plan.prepare, ...plan.milestones];
}

// ---------------------------------------------------------------------------------------------
// Next actions from readiness reports
// ---------------------------------------------------------------------------------------------

export interface NextActionContext {
  readonly programCycleId: string;
  readonly programSlug: string;
  readonly programName: string | null;
  readonly cycleKey: string;
  readonly actions: readonly NextAction[];
}

/** A roadmap item key for a next action that has none; stable so actions stay idempotent. */
export function nextActionItemKey(programCycleId: string, actionId: string): string {
  const clean = (s: string) => s.replace(/[^A-Za-z0-9_.-]/g, "_");
  return `prep:${clean(programCycleId).slice(0, 36)}:${clean(actionId).slice(0, 70)}`;
}

export function nextActionToItem(ctx: NextActionContext, action: NextAction, today: string): PlanItem {
  const date = action.dueOn ?? today;
  return {
    itemKey: nextActionItemKey(ctx.programCycleId, action.id),
    kind: "prepare",
    term: termKeyForDate(date),
    title: action.label,
    detail: action.detail,
    programId: null,
    programSlug: ctx.programSlug,
    programCycleId: ctx.programCycleId,
    cycleKey: ctx.cycleKey,
    dueOn: action.dueOn,
    startBy: null,
    dateConfidence: action.dueOn ? "estimated" : "unknown",
    state: "open",
    pinned: false,
    reasonCodes: [`NEXT_ACTION_${action.source.toUpperCase()}`],
    source: "rule",
    origin: "next_action",
    relatesTo: action.relatesTo,
    programName: ctx.programName,
  };
}

export interface PlanTerm {
  readonly term: string;
  readonly items: readonly PlanItem[];
  readonly more: number;
  readonly capacityWarning: string | null;
}

export interface Plan {
  readonly terms: readonly PlanTerm[];
  readonly changedSinceLastVisit: ReadonlySet<string>;
}

/**
 * Builds the page's plan: roadmap terms, plus next actions whose roadmapItemKey is missing from
 * the roadmap. An action linked to an existing item adds nothing (the item already shows it).
 */
export function buildPlan(
  roadmap: Roadmap,
  contexts: readonly NextActionContext[],
  today: string,
  programNames: ReadonlyMap<string, string> = new Map(),
): Plan {
  const byTerm = new Map<string, { items: PlanItem[]; more: number; capacityWarning: string | null }>();
  const known = new Set<string>();
  for (const t of roadmap.terms) {
    const items = termItems(t).map((i) => fromRoadmapItem(i, (i.programSlug && programNames.get(i.programSlug)) ?? null));
    items.forEach((i) => known.add(i.itemKey));
    byTerm.set(t.term, { items, more: t.more, capacityWarning: t.capacityWarning });
  }
  for (const ctx of contexts) {
    for (const action of ctx.actions) {
      if (action.roadmapItemKey && known.has(action.roadmapItemKey)) continue;
      const item = nextActionToItem(ctx, action, today);
      if (known.has(item.itemKey)) continue;
      known.add(item.itemKey);
      const slot = byTerm.get(item.term) ?? { items: [], more: 0, capacityWarning: null };
      slot.items.push(item);
      byTerm.set(item.term, slot);
    }
  }
  const terms = [...byTerm.entries()]
    .sort(([a], [b]) => compareTermKeys(a, b))
    .map(([term, slot]) => ({ term, items: [...slot.items].sort(compareItems), more: slot.more, capacityWarning: slot.capacityWarning }));
  return { terms, changedSinceLastVisit: new Set(roadmap.changedSinceLastVisit) };
}

// ---------------------------------------------------------------------------------------------
// Layout: years by season
// ---------------------------------------------------------------------------------------------

export interface SeasonCell {
  readonly season: AcademicTerm;
  readonly term: string;
  readonly items: readonly PlanItem[];
  readonly more: number;
  readonly capacityWarning: string | null;
  readonly isNow: boolean;
  readonly isPast: boolean;
}

export interface YearRow {
  readonly startYear: number;
  readonly label: string;
  readonly yearOfStudy: number | null;
  readonly isPast: boolean;
  readonly seasons: readonly SeasonCell[];
}

/**
 * Lays the plan out as academic years with one cell per season. Winter shows only when some term
 * in the plan is a winter term, since most US calendars have none.
 */
export function layoutYears(plan: Plan, opts: { today: string; classYear: ClassYear | null }): YearRow[] {
  if (plan.terms.length === 0) return [];
  const now = currentTermKey(opts.today);
  const withWinter = plan.terms.some((t) => parseTermKey(t.term)?.term === "winter");
  const seasons = ACADEMIC_YEAR_TERM_ORDER.filter((s) => withWinter || s !== "winter");
  const years = plan.terms.map((t) => academicYearOfTerm(t.term));
  const first = Math.min(...years, academicYearStart(opts.today));
  const last = Math.max(...years);
  const lookup = new Map(plan.terms.map((t) => [t.term, t]));
  const rows: YearRow[] = [];
  for (let y = first; y <= last; y++) {
    const cells = seasons.map((season): SeasonCell => {
      const term = termKeyFor(y, season);
      const t = lookup.get(term);
      return {
        season,
        term,
        items: t?.items ?? [],
        more: t?.more ?? 0,
        capacityWarning: t?.capacityWarning ?? null,
        isNow: term === now,
        isPast: compareTermKeys(term, now) < 0,
      };
    });
    rows.push({
      startYear: y,
      label: academicYearLabel(y),
      yearOfStudy: yearOfStudy(y, opts.classYear, opts.today),
      isPast: cells.every((c) => c.isPast),
      seasons: cells,
    });
  }
  return rows;
}

/**
 * "This season": open items in the current term, plus pinned open items and anything whose
 * start-by or due date falls within the next 45 days, so a January deadline whose work starts
 * in November shows up now. Ordered by compareItems; capped for the card.
 */
export function thisSeason(plan: Plan, today: string, limit = 6): PlanItem[] {
  const now = currentTermKey(today);
  const horizon = 45;
  const picked: PlanItem[] = [];
  for (const t of plan.terms) {
    for (const item of t.items) {
      if (item.state === "dismissed" || item.state === "missed") continue;
      const date = item.startBy ?? item.dueOn;
      const soon = date !== null && daysBetween(today, date) <= horizon && daysBetween(today, item.dueOn ?? date) >= 0;
      if (t.term === now || item.pinned || soon) picked.push(item);
    }
  }
  return picked.sort(compareItems).slice(0, limit);
}

export interface PlanStats {
  readonly openThisSeason: number;
  readonly doneThisSeason: number;
  readonly dueWithin30: number;
  readonly pinned: number;
}

/** Counts of the student's own tasks (never a score about the student). */
export function planStats(plan: Plan, today: string): PlanStats {
  const now = currentTermKey(today);
  let openThisSeason = 0;
  let doneThisSeason = 0;
  let dueWithin30 = 0;
  let pinned = 0;
  for (const t of plan.terms) {
    for (const item of t.items) {
      if (item.pinned && item.state === "open") pinned++;
      if (t.term === now && item.state === "open") openThisSeason++;
      if (t.term === now && item.state === "done") doneThisSeason++;
      if (item.state === "open" && item.dueOn) {
        const d = daysBetween(today, item.dueOn);
        if (d >= 0 && d <= 30) dueWithin30++;
      }
    }
  }
  return { openThisSeason, doneThisSeason, dueWithin30, pinned };
}

/** The soonest open apply deadline, for the countdown card. */
export function nextDeadline(plan: Plan, today: string): PlanItem | null {
  let best: PlanItem | null = null;
  for (const t of plan.terms) {
    for (const item of t.items) {
      if (item.kind !== "apply" || item.state !== "open" || !item.dueOn) continue;
      if (daysBetween(today, item.dueOn) < 0) continue;
      if (!best || (best.dueOn as string) > item.dueOn) best = item;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------------------------
// Student actions
// ---------------------------------------------------------------------------------------------

export function applyActionToItem<T extends RoadmapItem>(item: T, action: RoadmapItemAction["action"]): T {
  switch (action) {
    case "pin":
      return { ...item, pinned: true };
    case "unpin":
      return { ...item, pinned: false };
    case "dismiss":
      return { ...item, state: "dismissed", pinned: false };
    case "restore":
      return { ...item, state: "open" };
    case "complete":
      return { ...item, state: "done" };
    case "reopen":
      return { ...item, state: "open" };
  }
}

/** Applies an action to one item of a Roadmap (optimistic cache update). */
export function applyActionToRoadmap(roadmap: Roadmap, itemKey: string, action: RoadmapItemAction["action"]): Roadmap {
  const touch = (items: RoadmapItem[]) => items.map((i) => (i.itemKey === itemKey ? applyActionToItem(i, action) : i));
  return {
    ...roadmap,
    terms: roadmap.terms.map((t) => ({ ...t, apply: touch(t.apply), prepare: touch(t.prepare), milestones: touch(t.milestones) })),
  };
}

/** The action a checkbox toggle means for an item. */
export function toggleAction(item: RoadmapItem): RoadmapItemAction["action"] {
  return item.state === "done" ? "reopen" : "complete";
}

/** Subject keys RequirementProgress accepts; next actions that resolve one complete through it. */
export function requirementSubject(relatesTo: string | null): string | null {
  if (!relatesTo) return null;
  return /^(req:[0-9a-f-]{36}|kind:[a-z_]+)$/.test(relatesTo) ? relatesTo : null;
}

// ---------------------------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------------------------

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export function shortDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  if (!y || !m || !d) return iso;
  return `${d} ${MONTHS[m - 1]}`;
}

/** One line under an item: what date and how sure we are of it. */
export function itemDateLine(item: RoadmapItem): string | null {
  const parts: string[] = [];
  if (item.startBy) parts.push(`Start by ${shortDate(item.startBy)}`);
  if (item.dueOn) parts.push(`${item.kind === "apply" ? "Due" : "By"} ${shortDate(item.dueOn)}`);
  if (parts.length === 0) return null;
  const sure: Record<RoadmapItem["dateConfidence"], string> = {
    official: "",
    estimated: " (estimate)",
    expected: " (expected; may change)",
    unknown: " (date not yet known)",
  };
  return parts.join(" · ") + sure[item.dateConfidence];
}

export function itemAccessibleName(item: PlanItem, today: string): string {
  const tone = TONE_WORDS[itemTone(item, today)];
  const date = itemDateLine(item);
  return [item.title, tone, date].filter(Boolean).join(", ");
}
