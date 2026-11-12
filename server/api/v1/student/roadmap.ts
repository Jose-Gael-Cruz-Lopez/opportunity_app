import type { Roadmap, RoadmapItem, StudentProfile, TermPlan } from "@shared/contracts";
import { applyItemKey, prepDays, resolveEffectiveDeadline, type EffectiveDeadline } from "@shared/readiness";
import { addDays, compareTermKeys, enumerateTerms, localDateIn, termKeyForDate } from "@shared/time";
import type { RoadmapActionRecord, RoadmapPlanStep, TrackedCycle } from "./ports";

/**
 * The Roadmap, computed on read from the student's tracked cycles (plan: only the student's own
 * pin, dismiss and complete actions are stored). Each tracked cycle becomes one Apply item in the
 * term of its effective deadline, the same date readiness counts back from, so the Roadmap and
 * the readiness report never disagree about when something is due.
 *
 * Prepare items come from the student's own first-door plan (the steps onboarding stored with
 * their titles and due dates), keyed `prep:{programId}:{cycleKey}:{stepId}` like the rows the
 * first door wrote, so stored pins and states apply and step reminders land on a page that shows
 * the step. They appear only while the cycle is tracked. Template milestones and template Prepare
 * items need curated RoadmapTemplates, which do not exist yet; until they do, none are invented.
 */

export const ROADMAP_ALGO_VERSION = "roadmap-v0.1.0";
/** Open, unpinned Apply items shown per term before the rest are counted in `more` (judgment). */
export const DEFAULT_APPLY_ITEMS_PER_TERM = 4;
/** A missed item stays visible this many days after its deadline unless pinned. */
export const MISSED_VISIBLE_DAYS = 30;

export interface RoadmapInput {
  readonly tracked: readonly TrackedCycle[];
  readonly actions: ReadonlyMap<string, RoadmapActionRecord>;
  readonly lastShownItemKeys: readonly string[];
  readonly templateKey: string | null;
  readonly profile: Pick<StudentProfile, "institutionId">;
  readonly now: number;
  readonly timeZone: string;
  readonly applyItemsPerTerm?: number;
  /** The first-door plan's steps; only steps of tracked cycles become Prepare items. */
  readonly planSteps?: readonly RoadmapPlanStep[];
}

export interface RoadmapResult {
  readonly roadmap: Roadmap;
  /** Every item key placed in the plan (saved as the visit, for "changed since last visit"). */
  readonly shownKeys: readonly string[];
}

function dateConfidence(eff: EffectiveDeadline | null): RoadmapItem["dateConfidence"] {
  if (!eff) return "unknown";
  switch (eff.basis) {
    case "official":
    case "attested":
    case "student_entered":
      return eff.approximate ? "estimated" : "official";
    case "estimated":
      return "estimated";
    case "predicted":
      return "expected";
  }
}

function itemState(t: TrackedCycle, stored: RoadmapActionRecord | undefined, eff: EffectiveDeadline | null): RoadmapItem["state"] {
  if (stored && stored.state !== "open") return stored.state;
  if (t.item.status === "submitted" || t.item.status === "decided") return "done";
  if (eff?.closed) return "missed";
  return "open";
}

function nominationGated(t: TrackedCycle): boolean {
  return t.requirements.some((r) => r.kind === "campus_nomination") || t.deadlines.some((d) => d.kind === "nomination");
}

interface Placed {
  readonly item: RoadmapItem;
  /** Sort key inside a term: due date, then title. */
  readonly sortDate: string;
}

/** One Apply item for a tracked cycle, or null when it should not appear. */
export function applyItemFor(t: TrackedCycle, input: RoadmapInput, today: string, currentTerm: string): Placed | null {
  if (t.item.status === "not_applying") return null;
  const gated = nominationGated(t);
  const eff = resolveEffectiveDeadline({
    deadlines: t.deadlines,
    now: input.now,
    studentTimeZone: input.timeZone,
    studentInstitutionId: input.profile.institutionId,
    ownCampusDeadline: t.item.ownCampusDeadline,
    nominationGated: gated,
  });
  const itemKey = applyItemKey(t.program.id, t.cycle.cycleKey);
  const stored = input.actions.get(itemKey);
  const state = itemState(t, stored, eff);
  const pinned = stored?.pinned ?? false;
  const dueOn = eff?.date ?? null;
  if (state === "missed" && !pinned && dueOn !== null && addDays(dueOn, MISSED_VISIBLE_DAYS) < today) return null;

  const placeOn = dueOn ?? t.cycle.opensOn ?? t.cycle.predictedOpensOn ?? today;
  const ownTerm = termKeyForDate(placeOn);
  // Anything due before this term surfaces in the current term once, not in a past one.
  const term = compareTermKeys(ownTerm, currentTerm) < 0 ? currentTerm : ownTerm;
  const lead = prepDays(t.requirements, { nominationGated: gated });
  const startBy = dueOn !== null && lead !== null ? addDays(dueOn, -lead) : null;

  const reasonCodes = ["tracked"];
  if (t.program.isSample) reasonCodes.push("sample_record");
  if (eff?.scope === "campus") reasonCodes.push("campus_deadline");
  if (dueOn === null) reasonCodes.push("deadline_not_announced");

  const item: RoadmapItem = {
    itemKey,
    kind: "apply",
    term,
    title: t.program.name.slice(0, 200),
    detail: (eff?.label ?? "Deadline not announced yet; Novus will alert you when it is.").slice(0, 400),
    programId: t.program.id,
    programSlug: t.program.slug,
    programCycleId: t.cycle.id,
    cycleKey: t.cycle.cycleKey,
    dueOn,
    startBy,
    dateConfidence: dateConfidence(eff),
    state,
    pinned,
    reasonCodes: reasonCodes.slice(0, 8),
    source: "student",
  };
  return { item, sortDate: dueOn ?? "9999-12-31" };
}

/** Step kinds that are not Prepare items: `submit` is the cycle's Apply item. */
const NOT_PREPARE: ReadonlySet<string> = new Set(["submit"]);

/** Prepare items from the first-door plan, for cycles the student still tracks. */
export function prepareItemsFor(input: RoadmapInput, today: string, currentTerm: string): Placed[] {
  const out: Placed[] = [];
  const byCycle = new Map(input.tracked.map((t) => [t.cycle.id, t]));
  for (const step of input.planSteps ?? []) {
    if (NOT_PREPARE.has(step.kind)) continue;
    const t = byCycle.get(step.programCycleId);
    if (!t || t.program.id !== step.programId || t.item.status === "not_applying") continue;
    const itemKey = `prep:${t.program.id}:${t.cycle.cycleKey}:${step.stepId}`;
    const stored = input.actions.get(itemKey);
    const finished = t.item.status === "submitted" || t.item.status === "decided";
    const state: RoadmapItem["state"] = stored && stored.state !== "open" ? stored.state : finished ? "done" : "open";
    const pinned = stored?.pinned ?? false;
    // Finished or dismissed steps fade out like missed Apply items, unless pinned.
    if (state !== "open" && !pinned && step.due !== null && addDays(step.due, MISSED_VISIBLE_DAYS) < today) continue;
    const ownTerm = termKeyForDate(step.due ?? today);
    const term = compareTermKeys(ownTerm, currentTerm) < 0 ? currentTerm : ownTerm;
    const reasonCodes = ["FIRST_DOOR"];
    if (t.program.isSample) reasonCodes.push("sample_record");
    out.push({
      item: {
        itemKey,
        kind: "prepare",
        term,
        title: step.title.slice(0, 200),
        detail: null,
        programId: t.program.id,
        programSlug: t.program.slug,
        programCycleId: t.cycle.id,
        cycleKey: t.cycle.cycleKey,
        dueOn: step.due,
        startBy: null,
        // Plan dates are scheduled backward from the deadline, so they are estimates.
        dateConfidence: step.due ? "estimated" : "unknown",
        state,
        pinned,
        reasonCodes,
        source: "student",
      },
      sortDate: step.due ?? "9999-12-31",
    });
  }
  return out;
}

function compareItems(a: Placed, b: Placed): number {
  if (a.item.pinned !== b.item.pinned) return a.item.pinned ? -1 : 1;
  if (a.sortDate !== b.sortDate) return a.sortDate < b.sortDate ? -1 : 1;
  return a.item.title.localeCompare(b.item.title) || a.item.itemKey.localeCompare(b.item.itemKey);
}

/** Splits one term's Apply items into shown items and a hidden count, honouring pins. */
export function capTerm(items: readonly Placed[], cap: number): { shown: RoadmapItem[]; more: number; openCount: number } {
  const sorted = [...items].sort(compareItems);
  const shown: RoadmapItem[] = [];
  let openShown = 0;
  let more = 0;
  for (const p of sorted) {
    const counts = p.item.state === "open" || p.item.state === "missed";
    if (!counts || p.item.pinned) {
      shown.push(p.item);
      if (counts) openShown++;
    } else if (openShown < cap) {
      shown.push(p.item);
      openShown++;
    } else {
      more++;
    }
  }
  return { shown, more, openCount: openShown + more };
}

function capacityWarning(openCount: number, cap: number): string | null {
  if (openCount <= cap) return null;
  return `You are tracking ${openCount} open applications due this term. Pin the ones that matter most; the rest stay in your tracker.`;
}

/** Keys added or removed since the last visit (both directions are "changed"). */
export function changedKeys(previous: readonly string[], current: readonly string[]): string[] {
  const before = new Set(previous);
  const now = new Set(current);
  const added = current.filter((k) => !before.has(k));
  const removed = previous.filter((k) => !now.has(k));
  return [...new Set([...added, ...removed])].sort();
}

export function buildRoadmap(input: RoadmapInput): RoadmapResult {
  const cap = input.applyItemsPerTerm ?? DEFAULT_APPLY_ITEMS_PER_TERM;
  const today = localDateIn(input.now, input.timeZone);
  const currentTerm = termKeyForDate(today);

  const byTerm = new Map<string, Placed[]>();
  for (const t of input.tracked) {
    const placed = applyItemFor(t, input, today, currentTerm);
    if (!placed) continue;
    const list = byTerm.get(placed.item.term);
    if (list) list.push(placed);
    else byTerm.set(placed.item.term, [placed]);
  }

  const prepByTerm = new Map<string, Placed[]>();
  for (const placed of prepareItemsFor(input, today, currentTerm)) {
    const list = prepByTerm.get(placed.item.term);
    if (list) list.push(placed);
    else prepByTerm.set(placed.item.term, [placed]);
  }

  const lastTerm = [...byTerm.keys(), ...prepByTerm.keys()].reduce((max, k) => (compareTermKeys(k, max) > 0 ? k : max), currentTerm);
  const terms: TermPlan[] = enumerateTerms(currentTerm, lastTerm).map((term) => {
    const { shown, more, openCount } = capTerm(byTerm.get(term) ?? [], cap);
    const prepare = [...(prepByTerm.get(term) ?? [])].sort(compareItems).map((p) => p.item);
    return { term, apply: shown, prepare, milestones: [], more, capacityWarning: capacityWarning(openCount, cap) };
  });
  // Terms the student has nothing in are dropped, except the current one (the plan's anchor).
  const visible = terms.filter((t) => t.term === currentTerm || t.apply.length > 0 || t.prepare.length > 0 || t.more > 0);

  const shownKeys = visible.flatMap((t) => [...t.apply, ...t.prepare, ...t.milestones].map((i) => i.itemKey));
  return {
    roadmap: {
      generatedAt: new Date(input.now).toISOString(),
      algoVersion: ROADMAP_ALGO_VERSION,
      templateKey: input.templateKey,
      terms: visible,
      changedSinceLastVisit: changedKeys(input.lastShownItemKeys, shownKeys),
    },
    shownKeys,
  };
}

const PROGRAM_SCOPED_KEY = /^(?:apply|prep):([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}):/;

/**
 * The program an item key belongs to (`apply:{programId}:{cycleKey}`, `prep:{programId}:...`),
 * stored with the action so the database's audience-consent guard can see it.
 */
export function programIdFromItemKey(itemKey: string): string | null {
  return PROGRAM_SCOPED_KEY.exec(itemKey)?.[1] ?? null;
}
