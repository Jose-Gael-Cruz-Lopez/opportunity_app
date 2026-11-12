import { z } from "zod";
import {
  CompensationSchema,
  DeadlineViewSchema,
  PredictionSchema,
  ProgramFlagsSchema,
  RecordCitationSchema,
  type DeadlineView,
  type ProgramCard,
} from "@shared/contracts";
import {
  ClassYearSchema,
  CycleKeySchema,
  CycleStatusSchema,
  FreshnessSchema,
  MajorFamilySchema,
  OpportunityTypeSlugSchema,
  VerificationDisplaySchema,
} from "@shared/taxonomy";
import { computeDueAt, computeSortAt, toIsoInstant } from "@shared/time";
import { citeDeadline, citeProgram, type CitationContext } from "./citation";

/**
 * Output shapes shared by the tools. Field names follow the REST contracts (camelCase) so an
 * assistant and the API describe a record the same way. No shape carries a score, percentage or
 * "match" number (a test checks every output schema against FORBIDDEN_STUDENT_SCORE_FIELDS).
 */

export const McpCitationSchema = RecordCitationSchema.extend({ citeAs: z.string().max(800) }).strict();

export const McpDeadlineSchema = DeadlineViewSchema.extend({
  /** "predicted, not announced" for predicted rows; null otherwise. */
  label: z.string().max(60).nullable(),
  citation: McpCitationSchema,
}).strict();
export type McpDeadline = z.infer<typeof McpDeadlineSchema>;

export const VerificationViewSchema = z
  .object({
    state: VerificationDisplaySchema,
    verifiedOn: z.string().nullable(),
    verifiedBy: z.string().nullable(),
    freshness: FreshnessSchema,
  })
  .strict();

export const ProgramSummarySchema = z
  .object({
    slug: z.string(),
    programId: z.string(),
    name: z.string(),
    organizationName: z.string(),
    /** Novus-written prose, never copied from the official page. */
    summary: z.string().nullable(),
    opportunityTypes: z.array(OpportunityTypeSlugSchema),
    cycleKey: CycleKeySchema,
    status: CycleStatusSchema,
    opensOn: z.string().nullable(),
    verification: VerificationViewSchema,
    nextDeadline: McpDeadlineSchema.nullable(),
    flags: ProgramFlagsSchema,
    officialUrl: z.string(),
    applicationUrl: z.string().nullable(),
    /** True for sample data that describes no real program. */
    isSample: z.boolean(),
    citation: McpCitationSchema,
  })
  .strict();
export type ProgramSummary = z.infer<typeof ProgramSummarySchema>;

export const ProgramFactsSchema = ProgramSummarySchema.extend({
  classYears: z.array(ClassYearSchema),
  majorFamilies: z.array(MajorFamilySchema),
  compensation: CompensationSchema.nullable(),
  /** Days of preparation the curated Requirements imply; null means unknown, never zero. */
  prepDays: z.number().int().nonnegative().nullable(),
  prediction: PredictionSchema.extend({ note: z.string() }).strict().nullable(),
  deadlines: z.array(McpDeadlineSchema),
}).strict();

/** Instant of a deadline for ordering: dueAt, else the shared sort rule (applicant-local at the latest US zone). */
export function deadlineSortMs(d: DeadlineView): number | null {
  if (d.sortAt) {
    const ms = Date.parse(d.sortAt);
    if (Number.isFinite(ms)) return ms;
  }
  return computeSortAt(d);
}

function dueAtIso(d: DeadlineView): string | null {
  if (d.tzMode === "applicant_local") return null; // no single instant exists for every applicant
  if (d.dueAt) return d.dueAt;
  const ms = computeDueAt(d);
  return ms === null ? null : toIsoInstant(ms);
}

/** Campus and attested rows are omitted: s03 shows them only to that Institution's students. */
export function publicDeadlines(card: ProgramCard): DeadlineView[] {
  return card.deadlines.filter((d) => d.scope === "national" && d.basis !== "attested");
}

export function toMcpDeadline(card: ProgramCard, d: DeadlineView, ctx: CitationContext): McpDeadline {
  const sortMs = deadlineSortMs(d);
  return {
    ...d,
    dueAt: dueAtIso(d),
    sortAt: d.sortAt ?? (sortMs === null ? null : toIsoInstant(sortMs)),
    label: d.basis === "predicted" ? "predicted, not announced" : null,
    citation: citeDeadline(card, d, ctx),
  };
}

/** The first upcoming national application deadline (or the latest past one when none is upcoming). */
export function nextNationalDeadline(card: ProgramCard, now: number): DeadlineView | null {
  const rows = publicDeadlines(card).filter((d) => d.kind === "application");
  let best: { d: DeadlineView; ms: number } | null = null;
  for (const d of rows) {
    const ms = deadlineSortMs(d);
    if (ms === null || ms < now) continue;
    if (!best || ms < best.ms) best = { d, ms };
  }
  return best?.d ?? rows[0] ?? null;
}

export function toProgramSummary(card: ProgramCard, ctx: CitationContext, now: number): ProgramSummary {
  const next = nextNationalDeadline(card, now);
  return {
    slug: card.slug,
    programId: card.programId,
    name: card.name,
    organizationName: card.organizationName,
    summary: card.summary,
    opportunityTypes: card.opportunityTypes,
    cycleKey: card.cycleKey,
    status: card.status,
    opensOn: card.opensOn,
    verification: card.verification,
    nextDeadline: next ? toMcpDeadline(card, next, ctx) : null,
    flags: card.flags,
    officialUrl: card.officialUrl,
    applicationUrl: card.applicationUrl,
    isSample: card.isSample,
    citation: citeProgram(card, ctx),
  };
}

// ---------------------------------------------------------------------------------------------
// Cursors: opaque, offset-based, bounded by maxPaginationDepth.
// ---------------------------------------------------------------------------------------------

export const CursorSchema = z.string().max(200);

export function encodeCursor(offset: number): string {
  return btoa(JSON.stringify({ o: offset }));
}

/** Returns the offset a cursor stands for, or null when it is not one of ours. */
export function decodeCursor(cursor: string | undefined): number | null {
  if (!cursor) return 0;
  try {
    const parsed = JSON.parse(atob(cursor)) as unknown;
    if (parsed && typeof parsed === "object" && "o" in parsed) {
      const o = (parsed as { o: unknown }).o;
      if (typeof o === "number" && Number.isInteger(o) && o >= 0) return o;
    }
  } catch {
    // fall through
  }
  return null;
}

/** Slices one page and says where the next starts; no page reaches past `depth`. */
export function paginate<T>(items: readonly T[], offset: number, limit: number, depth: number): { page: T[]; nextCursor: string | null } {
  const end = Math.min(offset + limit, depth, items.length);
  const page = offset >= end ? [] : items.slice(offset, end);
  const more = end < items.length && end < depth;
  return { page, nextCursor: more ? encodeCursor(end) : null };
}
