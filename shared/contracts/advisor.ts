import { z } from "zod";
import {
  ClassYearSchema,
  CycleKeySchema,
  GpaBandSchema,
  MajorFamilySchema,
  OutcomeDecisionSchema,
  OutcomeStageSchema,
  OutcomeTierSchema,
} from "../taxonomy";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  LocalTimeSchema,
  PublicIdSchema,
  SlugSchema,
  TimeZoneSchema,
  UrlSchema,
} from "./common";

/** Advisor workspaces and program lists (the concierge pilot kit), and student outcome reports. */

export const AdvisorWorkspaceSchema = z
  .object({
    id: IdSchema,
    name: z.string().min(1).max(120),
    institutionId: IdSchema.nullable(),
    kind: z.enum(["concierge_pilot", "self_service"]),
    createdAt: IsoDateTimeSchema,
    isSample: z.boolean().default(false),
  })
  .strict();
export type AdvisorWorkspace = z.infer<typeof AdvisorWorkspaceSchema>;

export const ProgramListItemSchema = z
  .object({
    programSlug: SlugSchema,
    cycleKey: CycleKeySchema.nullable(),
    /** Advisor's own note (original text, shown to students who open the list). */
    note: z.string().max(500).nullable(),
    position: z.number().int().nonnegative(),
  })
  .strict();
export type ProgramListItem = z.infer<typeof ProgramListItemSchema>;

export const ProgramListSchema = z
  .object({
    id: IdSchema,
    workspaceId: IdSchema,
    title: z.string().min(1).max(120),
    description: z.string().max(1000).nullable(),
    /** Public lists have a slug; unlisted lists only a 128-bit token. */
    visibility: z.enum(["public", "unlisted"]),
    slug: SlugSchema.nullable(),
    token: z.string().regex(/^[0-9A-Za-z]{20,32}$/).nullable(),
    /** True when the list includes a status- or identity-defined program (derived). */
    restricted: z.boolean(),
    items: z.array(ProgramListItemSchema).max(200),
    updatedAt: IsoDateTimeSchema,
  })
  .strict()
  .superRefine((l, ctx) => {
    if (l.visibility === "public" && l.slug === null) ctx.addIssue({ code: "custom", path: ["slug"], message: "public lists need a slug" });
    if (l.visibility === "unlisted" && l.token === null) ctx.addIssue({ code: "custom", path: ["token"], message: "unlisted lists need a token" });
  });
export type ProgramList = z.infer<typeof ProgramListSchema>;

export const ProgramListCreateSchema = z
  .object({
    title: z.string().min(1).max(120),
    description: z.string().max(1000).nullable().default(null),
    visibility: z.enum(["public", "unlisted"]).default("unlisted"),
    items: z.array(ProgramListItemSchema.omit({ position: true })).max(200).default([]),
  })
  .strict();
export type ProgramListCreate = z.infer<typeof ProgramListCreateSchema>;

export const ProgramListUpdateSchema = ProgramListCreateSchema.partial().strict();
export type ProgramListUpdate = z.infer<typeof ProgramListUpdateSchema>;

/** A campus deadline an advisor submits for Curator confirmation before display. */
export const CampusDeadlineSubmissionSchema = z
  .object({
    programSlug: SlugSchema,
    cycleKey: CycleKeySchema,
    kind: z.enum(["campus_internal", "nomination", "interest_form"]),
    localDate: IsoDateSchema,
    localTime: LocalTimeSchema.nullable(),
    timeZone: TimeZoneSchema,
    sourceUrl: UrlSchema.nullable(),
    note: z.string().max(500).nullable(),
  })
  .strict();
export type CampusDeadlineSubmission = z.infer<typeof CampusDeadlineSubmissionSchema>;

/** Aggregate workspace report: counts only, passed through disclosure thresholds; no names. */
export const WorkspaceReportSchema = z
  .object({
    workspaceId: IdSchema,
    period: z.string().regex(/^\d{4}-(\d{2}|Q[1-4])$/),
    listViews: z.string().max(40),
    trackedPrograms: z.string().max(40),
    /** Banded counts such as "fewer than 10" when small. */
    rows: z.array(z.object({ programSlug: SlugSchema, trackers: z.string().max(40) }).strict()),
  })
  .strict();
export type WorkspaceReport = z.infer<typeof WorkspaceReportSchema>;

/**
 * OutcomeReport: a student's own report of how an application went. The snapshot holds only
 * non-sensitive context (no first-generation or other status answers).
 */
export const OutcomeReportSchema = z
  .object({
    publicId: PublicIdSchema,
    programCycleId: IdSchema,
    tier: OutcomeTierSchema,
    stages: z.array(z.object({ stage: OutcomeStageSchema, on: IsoDateSchema.nullable() }).strict()).max(6),
    decision: OutcomeDecisionSchema.nullable(),
    decidedOn: IsoDateSchema.nullable(),
    snapshot: z
      .object({
        classYear: ClassYearSchema.nullable(),
        gpaBand: GpaBandSchema.nullable(),
        majorFamily: MajorFamilySchema.nullable(),
        institutionType: z.enum(["two_year", "four_year", "other"]).nullable(),
        priorFeeder: z.enum(["yes", "no"]).nullable(),
      })
      .strict(),
    qualityState: z.enum(["ok", "flagged"]),
    createdAt: IsoDateTimeSchema,
  })
  .strict();
export type OutcomeReport = z.infer<typeof OutcomeReportSchema>;

export const OutcomeReportCreateSchema = OutcomeReportSchema.pick({
  programCycleId: true,
  stages: true,
  decision: true,
  decidedOn: true,
})
  .extend({ priorFeeder: z.enum(["yes", "no"]).nullable().default(null) })
  .strict();
export type OutcomeReportCreate = z.infer<typeof OutcomeReportCreateSchema>;

export const OutcomeReportUpdateSchema = OutcomeReportCreateSchema.omit({ programCycleId: true }).partial().strict();
export type OutcomeReportUpdate = z.infer<typeof OutcomeReportUpdateSchema>;
