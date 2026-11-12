import { z } from "zod";
import { CycleKeySchema, MajorFamilySchema, TermKeySchema } from "../taxonomy";
import { IdSchema, IsoDateSchema, IsoDateTimeSchema, SlugSchema } from "./common";

/**
 * Roadmap: a term-by-term plan computed on read. Only the student's own actions (pin, dismiss,
 * complete) are stored, keyed by `itemKey`: `apply:{programId}:{cycleKey}` or a template row key.
 */

export const ROADMAP_ITEM_KINDS = ["apply", "prepare", "milestone"] as const;
export const RoadmapItemKindSchema = z.enum(ROADMAP_ITEM_KINDS);

export const ROADMAP_ITEM_STATES = ["open", "done", "dismissed", "missed"] as const;
export const RoadmapItemStateSchema = z.enum(ROADMAP_ITEM_STATES);

export const ItemKeySchema = z.string().regex(/^(apply|prep|ms|tpl):[A-Za-z0-9_.:-]{1,110}$/, "roadmap item key");

export const RoadmapItemSchema = z
  .object({
    itemKey: ItemKeySchema,
    kind: RoadmapItemKindSchema,
    term: TermKeySchema,
    title: z.string().max(200),
    detail: z.string().max(400).nullable(),
    programId: IdSchema.nullable(),
    programSlug: SlugSchema.nullable(),
    programCycleId: IdSchema.nullable(),
    cycleKey: CycleKeySchema.nullable(),
    /** Due date (effective deadline for apply items). */
    dueOn: IsoDateSchema.nullable(),
    startBy: IsoDateSchema.nullable(),
    /** "expected" for predicted cycles, "may change" for rules copied from a previous cycle. */
    dateConfidence: z.enum(["official", "estimated", "expected", "unknown"]),
    state: RoadmapItemStateSchema,
    pinned: z.boolean(),
    /** Why-shown and guidance codes (copy lives in the wording module). */
    reasonCodes: z.array(z.string().max(60)).max(8),
    source: z.enum(["template", "rule", "student"]),
  })
  .strict();
export type RoadmapItem = z.infer<typeof RoadmapItemSchema>;

export const TermPlanSchema = z
  .object({
    term: TermKeySchema,
    apply: z.array(RoadmapItemSchema),
    prepare: z.array(RoadmapItemSchema),
    milestones: z.array(RoadmapItemSchema),
    /** How many eligible candidates were left out by the per-term cap. */
    more: z.number().int().nonnegative(),
    capacityWarning: z.string().max(300).nullable(),
  })
  .strict();
export type TermPlan = z.infer<typeof TermPlanSchema>;

export const RoadmapSchema = z
  .object({
    generatedAt: IsoDateTimeSchema,
    algoVersion: z.string().max(40),
    templateKey: z.string().max(80).nullable(),
    terms: z.array(TermPlanSchema),
    /** Item keys added or removed since the student's last visit. */
    changedSinceLastVisit: z.array(ItemKeySchema),
  })
  .strict();
export type Roadmap = z.infer<typeof RoadmapSchema>;

export const ROADMAP_ACTIONS = ["pin", "unpin", "dismiss", "restore", "complete", "reopen"] as const;
export const RoadmapItemActionSchema = z.object({ action: z.enum(ROADMAP_ACTIONS) }).strict();
export type RoadmapItemAction = z.infer<typeof RoadmapItemActionSchema>;

/** A Milestone row in a curated RoadmapTemplate (content written by people). */
export const MilestoneSchema = z
  .object({
    key: z.string().max(80),
    title: z.string().max(200),
    detail: z.string().max(400).nullable(),
    /** Offset from the start of study, e.g. term 2 = second term. */
    termIndex: z.number().int().min(0).max(12),
    programCycleId: IdSchema.nullable(),
  })
  .strict();
export type Milestone = z.infer<typeof MilestoneSchema>;

export const RoadmapTemplateSchema = z
  .object({
    key: z.string().max(80),
    path: z.enum(["four_year", "two_year_transfer", "two_year_career"]),
    majorFamilies: z.array(MajorFamilySchema).max(16),
    milestones: z.array(MilestoneSchema),
    prepare: z.array(MilestoneSchema),
    featuredProgramSlugs: z.array(SlugSchema).max(30),
    applyItemsPerTerm: z.number().int().min(1).max(10).default(4),
    isSample: z.boolean().default(false),
  })
  .strict();
export type RoadmapTemplate = z.infer<typeof RoadmapTemplateSchema>;
