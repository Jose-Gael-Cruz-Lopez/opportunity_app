import { NATIONAL_SUBMISSION_KINDS, type DeadlineKind, type InstitutionCalendar, type InstitutionLevel } from "../taxonomy";
import { isIsoDate, isIsoMonth } from "../time/iso";

/**
 * EvalContext: everything a rule may need besides the student's own profile. It is plain data
 * with no I/O, and every caller (browser, Worker, MCP, Readiness) builds it with
 * buildEvalContext from the same registry rows, so their results match.
 */

/** The dates a rule can be judged at (EligibilityRule.asOf other than "today"). */
export const ANCHOR_KINDS = ["campus_deadline", "national_deadline", "program_start"] as const;
export type AnchorKind = (typeof ANCHOR_KINDS)[number];

export interface EvalInstitution {
  readonly id: string | null;
  readonly level: InstitutionLevel | null;
  readonly calendar: InstitutionCalendar | null;
  /** First month of the academic year (default August). */
  readonly academicYearStartMonth: number;
  /**
   * true when the institution has a verified listing that lets it nominate; null when Novus has
   * no record. Never false: a school can still register a representative (plan 6.4.4).
   */
  readonly participates: true | null;
}

export interface EvalContext {
  /** ISO dates (YYYY-MM-DD) per anchor; a missing anchor leaves date-relative rules unknown. */
  readonly anchors: Readonly<Partial<Record<AnchorKind, string | null>>>;
  readonly institution: EvalInstitution | null;
}

export const EMPTY_CONTEXT: EvalContext = Object.freeze({ anchors: Object.freeze({}), institution: null });

/** The Deadline fields buildEvalContext reads (a structural subset of the registry Deadline). */
export interface DeadlineLike {
  readonly kind: DeadlineKind;
  readonly scope: "national" | "campus";
  readonly institutionId: string | null;
  readonly basis: "official" | "attested" | "predicted";
  /** YYYY-MM-DD, or YYYY-MM for month-only rows (read as the first of the month). */
  readonly localDate: string | null;
  readonly withdrawnAt?: string | null;
}

export interface InstitutionLike {
  readonly id: string;
  readonly level: InstitutionLevel;
  readonly calendar: InstitutionCalendar | null;
  readonly academicYearStartMonth?: number;
}

export interface BuildEvalContextInput {
  readonly deadlines?: readonly DeadlineLike[];
  readonly institution?: InstitutionLike | null;
  /** Institutions with a verified nominating listing for this cycle. */
  readonly participatingInstitutionIds?: readonly string[] | null;
  /** The student's own private campus deadline from their tracker, if they recorded one. */
  readonly ownCampusDeadline?: string | null;
}

/** First calendar day of a published date (`2027-09` -> `2027-09-01`), or null. */
function dayOf(localDate: string | null): string | null {
  if (localDate === null) return null;
  if (isIsoDate(localDate)) return localDate;
  if (isIsoMonth(localDate)) return `${localDate}-01`;
  return null;
}

function usable(d: DeadlineLike): boolean {
  return d.basis !== "predicted" && !d.withdrawnAt;
}

function earliest(dates: readonly (string | null)[]): string | null {
  const real = dates.filter((d): d is string => d !== null).sort();
  return real[0] ?? null;
}

function latest(dates: readonly (string | null)[]): string | null {
  const real = dates.filter((d): d is string => d !== null).sort();
  return real[real.length - 1] ?? null;
}

/**
 * Builds the context from registry rows:
 * - national_deadline: the last national application or nomination date (the final round, not a
 *   priority one);
 * - program_start: the first national program_start date (month-only rows count from day 1);
 * - campus_deadline: the student's own campus date, else the earliest official or attested
 *   campus row for their institution (campus_internal or nomination kinds);
 * - institution: level, calendar and participation (true only when listed, else null).
 * Predicted and withdrawn rows are ignored: eligibility is judged on published dates only.
 */
export function buildEvalContext(input: BuildEvalContextInput = {}): EvalContext {
  const rows = (input.deadlines ?? []).filter(usable);
  const national = rows.filter((d) => d.scope === "national");
  const institution = input.institution ?? null;
  const campusRows = rows.filter(
    (d) => d.scope === "campus" && institution !== null && d.institutionId === institution.id && (d.kind === "campus_internal" || d.kind === "nomination"),
  );
  const own = input.ownCampusDeadline && isIsoDate(input.ownCampusDeadline) ? input.ownCampusDeadline : null;
  const anchors: Partial<Record<AnchorKind, string | null>> = {
    national_deadline: latest(national.filter((d) => NATIONAL_SUBMISSION_KINDS.has(d.kind)).map((d) => dayOf(d.localDate))),
    program_start: earliest(national.filter((d) => d.kind === "program_start").map((d) => dayOf(d.localDate))),
    campus_deadline: own ?? earliest(campusRows.map((d) => dayOf(d.localDate))),
  };
  const participating = new Set(input.participatingInstitutionIds ?? []);
  return {
    anchors,
    institution: institution
      ? {
          id: institution.id,
          level: institution.level,
          calendar: institution.calendar,
          academicYearStartMonth: institution.academicYearStartMonth ?? 8,
          participates: participating.has(institution.id) ? true : null,
        }
      : null,
  };
}
