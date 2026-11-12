import { PRODUCT } from "../config/product";
import { LEAD_TIME_TABLE } from "../readiness/config";
import { effortHoursFor, leadDaysFor, type RequirementLike as ReadinessRequirement } from "../readiness/requirements";
import type { RequirementKind } from "../taxonomy";
import { addDays } from "../time/iso";

/**
 * Backward scheduling for onboarding, on plan 07's guidance table (7.4.2) as shared/readiness
 * owns it, so the onboarding "Start by" date equals the Tracker's latestStart:
 *
 *   latestStart(r) = deadline - leadDays(r) - ceil(effortHours(r) / hoursPerDay)
 *   prepDays       = max over Requirements of leadDays(r) + ceil(effortHours(r) / hoursPerDay)
 *
 * The default PrepModel calls shared/readiness's leadDaysFor and effortHoursFor (Curator
 * overrides first, then the table), with the effective deadline already campus-scoped, so a
 * campus nomination adds no lead of its own. All table values are plan judgment, to be checked
 * in student interviews.
 */

export interface RequirementLike {
  readonly id?: string;
  readonly kind: RequirementKind;
  readonly label?: string;
  readonly quantity?: number;
  /** Curator overrides of the guidance table (null or absent: use the table). */
  readonly effortHours?: number | null;
  readonly leadTimeDays?: number | null;
}

/** Plan 07's guidance table (shared/readiness's LEAD_TIME_TABLE): one table for every surface. */
export const GUIDANCE_TABLE = LEAD_TIME_TABLE;

/** Plan 07 schedules at one hour a day so every surface computes the same dates. */
export const HOURS_PER_DAY: number = PRODUCT.readiness.hoursPerDay;

/** Submit two days early (the T-2 reminder of plans 06 and 07). */
export const SUBMIT_BUFFER_DAYS = 2;

export interface PrepModel {
  leadDays(r: RequirementLike): number | null;
  effortHours(r: RequirementLike): number | null;
}

/** Compact onboarding requirements may lack an id or label; readiness reads neither for these numbers. */
function asReadiness(r: RequirementLike): ReadinessRequirement {
  return { ...r, id: r.id ?? r.kind, label: r.label ?? r.kind };
}

export const DEFAULT_PREP_MODEL: PrepModel = {
  leadDays: (r) => leadDaysFor(asReadiness(r)),
  // "effortHours includes the count" (plan 07): every letter and essay is its own work.
  effortHours: (r) => effortHoursFor(asReadiness(r)),
};

/** Days of preparation one requirement needs: lead plus effort days at one hour a day. */
export function requirementPrepDays(r: RequirementLike, model: PrepModel = DEFAULT_PREP_MODEL): number | null {
  const lead = model.leadDays(r);
  const effort = model.effortHours(r);
  if (lead === null && effort === null) return null;
  return (lead ?? 0) + Math.ceil((effort ?? 0) / HOURS_PER_DAY);
}

export interface PrepSummary {
  /** Max over requirements of lead + effort days; null when nothing schedulable is listed. */
  readonly prepDays: number | null;
  /** Total hours of the student's own work, counting every letter and essay. */
  readonly hours: number | null;
  readonly letters: number;
  readonly essays: number;
  readonly kinds: readonly RequirementKind[];
}

export function summarizeRequirements(reqs: readonly RequirementLike[], model: PrepModel = DEFAULT_PREP_MODEL): PrepSummary {
  let prepDays: number | null = null;
  let hours: number | null = null;
  let letters = 0;
  let essays = 0;
  const kinds = new Set<RequirementKind>();
  for (const r of reqs) {
    kinds.add(r.kind);
    const days = requirementPrepDays(r, model);
    if (days !== null) prepDays = Math.max(prepDays ?? 0, days);
    const h = model.effortHours(r);
    if (h !== null) hours = (hours ?? 0) + h;
    const qty = Math.max(1, Math.floor(r.quantity ?? 1));
    if (r.kind === "recommendation") letters += qty;
    if (r.kind === "essay") essays += qty;
  }
  return { prepDays, hours: hours === null ? null : Math.round(hours * 4) / 4, letters, essays, kinds: [...kinds] };
}

/** Latest start date for a requirement, counted back from the effective deadline (YYYY-MM-DD). */
export function latestStart(deadline: string, r: RequirementLike, model: PrepModel = DEFAULT_PREP_MODEL): string | null {
  const days = requirementPrepDays(r, model);
  return days === null ? null : addDays(deadline, -days);
}
