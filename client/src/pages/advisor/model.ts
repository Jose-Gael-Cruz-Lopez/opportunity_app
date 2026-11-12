import { z } from "zod";
import type { ProgramList } from "@shared/contracts/advisor";
import { CycleKeySchema } from "@shared/taxonomy";

/**
 * Pure helpers for the advisor workspace screen: response shapes of the advisor routes that are
 * not in the shared route map yet, share links, report periods, how a disclosure-controlled table
 * reads, and the campus deadline form. Nothing here handles an individual student.
 */

// ---- Response shapes (mirrors server/api/v1/advisor) ------------------------------------------

const ReleasedTableSchema = z.union([
  z.object({ period: z.string(), suppressed: z.literal(true), reason: z.string() }),
  z.object({
    period: z.string(),
    suppressed: z.literal(false),
    total: z.string(),
    cells: z.array(z.object({ key: z.string(), label: z.string() })),
  }),
]);
export type ReleasedTableView = z.infer<typeof ReleasedTableSchema>;

const NamedProgramSchema = z.object({ slug: z.string(), name: z.string() });

export const ProgressViewSchema = z.object({
  period: z.string(),
  population: z.literal("all_novus_students"),
  minGroupSize: z.number().int().positive(),
  programs: z.array(NamedProgramSchema),
  excluded: z.array(NamedProgramSchema),
  byProgram: ReleasedTableSchema,
  byStage: ReleasedTableSchema,
});
export type ProgressView = z.infer<typeof ProgressViewSchema>;

export const CampusViewSchema = z.object({
  institutionLinked: z.boolean(),
  pending: z.number().int().nonnegative(),
  approved: z.array(
    z.object({
      programSlug: z.string(),
      programName: z.string(),
      cycleKey: z.string(),
      kind: z.string(),
      localDate: z.string().nullable(),
      localTime: z.string().nullable(),
      timeZone: z.string().nullable(),
      confirmedOn: z.string(),
    }),
  ),
});
export type CampusView = z.infer<typeof CampusViewSchema>;

// ---- Labels -----------------------------------------------------------------------------------

export const STAGE_LABELS: Record<string, string> = {
  saved: "Saved",
  started: "Started an application",
  submitted: "Submitted",
};

const SUPPRESSION_COPY: Record<string, string> = {
  below_min_total: "Fewer than 5 students so far, so nothing is shown yet.",
  single_category: "All activity is in one group, so showing it could identify students.",
  unsafe_small_cells: "The groups are too small to show safely this time.",
};

export function suppressionText(reason: string, minGroup = 5): string {
  return SUPPRESSION_COPY[reason] ?? `Hidden to protect groups smaller than ${minGroup}.`;
}

export interface TableRowView {
  readonly key: string;
  readonly label: string;
  readonly value: string;
  /** True when the value is a band or hidden, so the UI can explain why. */
  readonly protectedValue: boolean;
}

/** Rows for a released table, with names for the keys and a flag on protected cells. */
export function tableRows(table: ReleasedTableView, names: Readonly<Record<string, string>>): TableRowView[] {
  if (table.suppressed) return [];
  return table.cells.map((c) => ({
    key: c.key,
    label: names[c.key] ?? c.key,
    value: c.label,
    protectedValue: c.label.startsWith("fewer than") || c.label === "not shown",
  }));
}

// ---- Lists ------------------------------------------------------------------------------------

/** Where students open the list; null for a list with neither slug nor token. */
export function shareUrl(list: Pick<ProgramList, "visibility" | "slug" | "token">, origin: string): string | null {
  const base = origin.replace(/\/$/, "");
  if (list.visibility === "public" && list.slug) return `${base}/lists/${list.slug}`;
  if (list.visibility === "unlisted" && list.token) return `${base}/lists/u/${list.token}`;
  return null;
}

/** Program slugs typed one per line or comma-separated, deduplicated, in order. */
export function parseSlugs(text: string): string[] {
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,]+/)) {
    const slug = raw.trim().toLowerCase();
    if (/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) seen.add(slug);
  }
  return [...seen];
}

// ---- Report periods ---------------------------------------------------------------------------

export interface PeriodOption {
  readonly value: string;
  readonly label: string;
}

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** This month, the previous two months and this quarter, newest first. */
export function periodOptions(nowMs: number): PeriodOption[] {
  const d = new Date(nowMs);
  const year = d.getUTCFullYear();
  const month = d.getUTCMonth();
  const out: PeriodOption[] = [];
  for (let back = 0; back < 3; back++) {
    const m = (month - back + 12) % 12;
    const y = month - back < 0 ? year - 1 : year;
    out.push({ value: `${y}-${String(m + 1).padStart(2, "0")}`, label: `${MONTHS[m]} ${y}${back === 0 ? " (so far)" : ""}` });
  }
  const q = Math.floor(month / 3) + 1;
  out.push({ value: `${year}-Q${q}`, label: `Q${q} ${year} (so far)` });
  return out;
}

// ---- Campus deadline form ---------------------------------------------------------------------

export interface CampusForm {
  programSlug: string;
  cycleKey: string;
  kind: "campus_internal" | "nomination" | "interest_form";
  localDate: string;
  localTime: string;
  timeZone: string;
  sourceUrl: string;
  note: string;
}

export const CAMPUS_KINDS: readonly { value: CampusForm["kind"]; label: string }[] = [
  { value: "nomination", label: "Campus nomination deadline" },
  { value: "campus_internal", label: "Internal campus deadline" },
  { value: "interest_form", label: "Interest form" },
];

export function emptyCampusForm(timeZone: string): CampusForm {
  return { programSlug: "", cycleKey: "", kind: "nomination", localDate: "", localTime: "", timeZone, sourceUrl: "", note: "" };
}

/** Field problems in plain words; an empty object means the form can be sent. */
export function campusFormErrors(form: CampusForm, today: string): Partial<Record<keyof CampusForm, string>> {
  const errors: Partial<Record<keyof CampusForm, string>> = {};
  if (!form.programSlug) errors.programSlug = "Pick a program from your lists.";
  if (!CycleKeySchema.safeParse(form.cycleKey).success) errors.cycleKey = "Use a cycle such as summer-2027.";
  if (!/^\d{4}-\d{2}-\d{2}$/.test(form.localDate)) errors.localDate = "Choose a date.";
  else if (form.localDate < today) errors.localDate = "Campus deadlines must be today or later.";
  if (form.localTime && !/^\d{2}:\d{2}$/.test(form.localTime)) errors.localTime = "Use a time such as 17:00.";
  if (form.sourceUrl && !/^https:\/\/\S+$/.test(form.sourceUrl)) errors.sourceUrl = "Use an https link to the office's page.";
  if (form.note.length > 500) errors.note = "Keep the note under 500 characters.";
  return errors;
}

/** The request body for a valid form (CampusDeadlineSubmissionSchema). */
export function campusBody(form: CampusForm) {
  return {
    programSlug: form.programSlug,
    cycleKey: form.cycleKey,
    kind: form.kind,
    localDate: form.localDate,
    localTime: form.localTime || null,
    timeZone: form.timeZone,
    sourceUrl: form.sourceUrl || null,
    note: form.note.trim() || null,
  };
}
