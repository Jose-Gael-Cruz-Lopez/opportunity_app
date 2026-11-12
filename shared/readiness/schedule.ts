import { READINESS_CONFIG } from "./config";
import { epochDayOf, isoFromEpochDay, type IsoDate } from "./calendar";

/**
 * Capacity-aware backward scheduling across everything a student is preparing.
 *
 * The plan's per-item latest start (deadline − lead − ceil(effort / hoursPerDay)) assumes each
 * item has the day to itself. Three overlapping applications can each look "planned" while their
 * combined hours cannot fit, so readiness also runs:
 *   - backwardFill: reverse-time EDF (as-late-as-possible) over all tasks at the student's
 *     capacity; a task's latest start is the earliest day it receives hours;
 *   - demandBoundCheck: the exact processor-demand test (feasible iff, for every due date d,
 *     the hours due by d fit into the hours available before d);
 *   - levelledLoad: the YDS critical-interval density, the smallest steady weekly load that meets
 *     every deadline ("this plan needs about 7.5 h a week");
 *   - whatFits: Moore-Hodgson on whole applications, a hint for which ones fit the hours set.
 * All of them describe a plan, never the student.
 */

export interface ScheduleTask {
  readonly id: string;
  /** Student hours (already multiplied by quantity and any padding). */
  readonly effortHours: number;
  /** Work is allowed on days strictly before `due`. */
  readonly due: IsoDate;
}

export interface CapacityModel {
  /** Hours the student can spend on applications on an epoch day. */
  hoursOn(epochDay: number): number;
  /** Steady weekly hours, for copy. */
  readonly weeklyHours: number;
}

/** Weekly hours spread over every day, or over weekdays only. */
export function weeklyCapacity(weeklyHours: number, opts: { weekdaysOnly?: boolean } = {}): CapacityModel {
  const hours = Math.max(0, weeklyHours);
  if (opts.weekdaysOnly) {
    const perWeekday = hours / 5;
    return {
      weeklyHours: hours,
      hoursOn: (day) => {
        const weekday = ((((day + 3) % 7) + 7) % 7) + 1;
        return weekday <= 5 ? perWeekday : 0;
      },
    };
  }
  const perDay = hours / 7;
  return { weeklyHours: hours, hoursOn: () => perDay };
}

const EPS = 1e-9;

export interface BackwardFillResult {
  /** Earliest day each task receives hours in the as-late-as-possible plan; null if it never fits. */
  readonly latestStart: ReadonlyMap<string, IsoDate | null>;
  /** Hours of each task that fall before today (the task is late by that much). */
  readonly lateHours: ReadonlyMap<string, number>;
  readonly overflowHours: number;
  readonly feasible: boolean;
}

/** Orders by later due first, then id, so every renderer gets the same plan. */
function byLatestDue(a: ScheduleTask, b: ScheduleTask): number {
  if (a.due !== b.due) return a.due < b.due ? 1 : -1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

/**
 * Reverse-time EDF: walk days backward from the last due date; each day's hours go to the
 * unfinished task with the latest due date among those due after that day. Walking past today
 * continues on the same capacity, so a late task still gets a (past) latest start.
 */
export function backwardFill(
  tasks: readonly ScheduleTask[],
  opts: { today: IsoDate; capacity: CapacityModel; maxDays?: number },
): BackwardFillResult {
  const active = tasks.filter((t) => t.effortHours > EPS).slice().sort(byLatestDue);
  const latestStart = new Map<string, IsoDate | null>(tasks.map((t) => [t.id, null]));
  const lateHours = new Map<string, number>(tasks.map((t) => [t.id, 0]));
  if (active.length === 0) return { latestStart, lateHours, overflowHours: 0, feasible: true };

  const today = epochDayOf(opts.today);
  const maxDays = opts.maxDays ?? READINESS_CONFIG.capacity.maxPlanningDays;
  const dueDay = new Map(active.map((t) => [t.id, epochDayOf(t.due)]));
  const remaining = new Map(active.map((t) => [t.id, t.effortHours]));
  let unfinished = active.length;
  const lastDue = Math.max(...active.map((t) => dueDay.get(t.id)!));
  const stopDay = Math.min(today, lastDue) - maxDays;

  for (let day = lastDue - 1; day >= stopDay && unfinished > 0; day--) {
    let cap = opts.capacity.hoursOn(day);
    for (const task of active) {
      if (cap <= EPS) break;
      const left = remaining.get(task.id)!;
      if (left <= EPS || dueDay.get(task.id)! <= day) continue;
      const give = Math.min(cap, left);
      cap -= give;
      remaining.set(task.id, left - give);
      latestStart.set(task.id, isoFromEpochDay(day));
      if (day < today) lateHours.set(task.id, lateHours.get(task.id)! + give);
      if (left - give <= EPS) unfinished -= 1;
    }
  }
  for (const task of active) {
    if (remaining.get(task.id)! > EPS) latestStart.set(task.id, null);
  }
  const overflowHours = [...lateHours.values()].reduce((s, h) => s + h, 0) + [...remaining.values()].reduce((s, h) => s + (h > EPS ? h : 0), 0);
  return { latestStart, lateHours, overflowHours, feasible: overflowHours <= EPS };
}

export interface DemandBoundRow {
  readonly due: IsoDate;
  readonly demandHours: number;
  readonly supplyHours: number;
}

export interface DemandBoundResult {
  readonly feasible: boolean;
  readonly rows: readonly DemandBoundRow[];
  /** The first due date where the hours due exceed the hours available before it. */
  readonly firstViolation: (DemandBoundRow & { readonly gapHours: number }) | null;
}

/** Hours available on days [from, to) for a capacity model. */
export function supplyBetween(fromDay: number, toDay: number, capacity: CapacityModel): number {
  let total = 0;
  for (let d = fromDay; d < toDay; d++) total += capacity.hoursOn(d);
  return total;
}

/**
 * Exact feasibility for one student working on preemptible tasks that are all available now:
 * for every due date d, Σ effort due by d ≤ Σ capacity on [today, d).
 */
export function demandBoundCheck(
  tasks: readonly ScheduleTask[],
  opts: { today: IsoDate; capacity: CapacityModel },
): DemandBoundResult {
  const today = epochDayOf(opts.today);
  const active = tasks.filter((t) => t.effortHours > EPS);
  const dues = [...new Set(active.map((t) => t.due))].sort();
  const rows: DemandBoundRow[] = [];
  let firstViolation: DemandBoundResult["firstViolation"] = null;
  let supply = 0;
  let supplyThrough = today;
  for (const due of dues) {
    const dueDay = epochDayOf(due);
    if (dueDay > supplyThrough) {
      supply += supplyBetween(supplyThrough, dueDay, opts.capacity);
      supplyThrough = dueDay;
    }
    const demand = active.filter((t) => t.due <= due).reduce((s, t) => s + t.effortHours, 0);
    const row = { due, demandHours: demand, supplyHours: dueDay > today ? supply : 0 };
    rows.push(row);
    if (firstViolation === null && demand > row.supplyHours + EPS) {
      firstViolation = { ...row, gapHours: demand - row.supplyHours };
    }
  }
  return { feasible: firstViolation === null, rows, firstViolation };
}

export interface LevelledLoad {
  /** The smallest constant daily load that meets every future due date (YDS density). */
  readonly hoursPerDay: number;
  /** hoursPerDay × 7, rounded up to the nearest half hour for display. */
  readonly weeklyHoursRounded: number;
  /** The due date that sets the density (the critical interval's end). */
  readonly criticalDue: IsoDate | null;
  /** Tasks already due today or earlier, which no load can meet. */
  readonly pastDue: readonly string[];
}

/**
 * YDS critical-interval density when every task is available now:
 * max over due dates d of (hours due by d) / (days in [today, d)).
 */
export function levelledLoad(tasks: readonly ScheduleTask[], opts: { today: IsoDate }): LevelledLoad {
  const today = epochDayOf(opts.today);
  const active = tasks.filter((t) => t.effortHours > EPS);
  const pastDue = active.filter((t) => epochDayOf(t.due) <= today).map((t) => t.id).sort();
  const future = active.filter((t) => epochDayOf(t.due) > today);
  let best = 0;
  let criticalDue: IsoDate | null = null;
  for (const due of [...new Set(future.map((t) => t.due))].sort()) {
    const days = epochDayOf(due) - today;
    const demand = future.filter((t) => t.due <= due).reduce((s, t) => s + t.effortHours, 0);
    const density = demand / days;
    if (density > best + EPS) {
      best = density;
      criticalDue = due;
    }
  }
  return { hoursPerDay: best, weeklyHoursRounded: Math.ceil(best * 7 * 2 - EPS) / 2, criticalDue, pastDue };
}

export interface FitJob {
  readonly id: string;
  readonly effortHours: number;
  readonly due: IsoDate;
  /** Pinned applications are never suggested for deferral. */
  readonly pinned: boolean;
}

export interface WhatFitsResult {
  readonly onTime: readonly string[];
  readonly deferred: readonly string[];
  /** True when the pinned applications alone do not fit. */
  readonly pinnedOverflow: boolean;
}

/**
 * Moore-Hodgson: the largest set of applications that meets every deadline at this capacity.
 * Time-varying capacity is handled by measuring deadlines in cumulative capacity hours, which
 * keeps the algorithm optimal. It is a hint shown as an option, never applied automatically.
 */
export function whatFits(jobs: readonly FitJob[], opts: { today: IsoDate; capacity: CapacityModel }): WhatFitsResult {
  const today = epochDayOf(opts.today);
  const ordered = jobs
    .filter((j) => j.effortHours > EPS)
    .slice()
    .sort((a, b) => (a.due !== b.due ? (a.due < b.due ? -1 : 1) : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const chosen: FitJob[] = [];
  const deferred: string[] = [];
  let total = 0;
  let pinnedOverflow = false;
  for (const job of ordered) {
    chosen.push(job);
    total += job.effortHours;
    const supply = Math.max(0, supplyBetween(today, epochDayOf(job.due), opts.capacity));
    // Classic Moore-Hodgson drops one job (the longest); pinned jobs cannot be dropped, so keep
    // dropping the longest unpinned job until the prefix fits again or only pinned jobs remain.
    while (total > supply + EPS) {
      const removable = chosen
        .filter((j) => !j.pinned)
        .sort((a, b) => b.effortHours - a.effortHours || (a.due < b.due ? 1 : a.due > b.due ? -1 : a.id < b.id ? 1 : -1));
      const drop = removable[0];
      if (!drop) {
        pinnedOverflow = true;
        break;
      }
      chosen.splice(chosen.indexOf(drop), 1);
      total -= drop.effortHours;
      deferred.push(drop.id);
    }
  }
  return { onTime: chosen.map((j) => j.id), deferred: deferred.sort(), pinnedOverflow };
}
