import { z } from "zod";
import {
  CipCodeSchema,
  ClassYearSchema,
  ConsentKindSchema,
  CycleKeySchema,
  EnrollmentIntensitySchema,
  ExperienceKindSchema,
  GpaBandSchema,
  InstitutionLevelSchema,
  MajorFamilySchema,
  OpportunityTypeSlugSchema,
  RoleSchema,
  TermKeySchema,
  TrackerStatusSchema,
  TransferIntentSchema,
  UsStateSchema,
} from "../taxonomy";
import {
  IdSchema,
  IsoDateSchema,
  IsoDateTimeSchema,
  PublicIdSchema,
  SlugSchema,
  TimeZoneSchema,
  YearMonthSchema,
} from "./common";

/**
 * Student-owned records. StudentProfile holds non-sensitive fields only: there is no field for
 * citizenship or immigration status, income or Pell, disability, race or ethnicity, gender,
 * sexual orientation, first-generation, veteran or foster-care status. `.strict()` makes the
 * server reject any such key with HTTP 400.
 */

export const StudentProfileSchema = z
  .object({
    classYear: ClassYearSchema.nullable(),
    expectedGraduationTerm: TermKeySchema.nullable(),
    institutionId: IdSchema.nullable(),
    institutionLevel: InstitutionLevelSchema.nullable(),
    enrollmentIntensity: EnrollmentIntensitySchema.nullable(),
    transferIntent: TransferIntentSchema.nullable(),
    majorCip: CipCodeSchema.nullable(),
    minorCip: CipCodeSchema.nullable(),
    majorFamily: MajorFamilySchema.nullable(),
    gpaBand: GpaBandSchema.nullable(),
    residenceState: UsStateSchema.nullable(),
    timeZone: TimeZoneSchema.nullable(),
    /** Month and year only, for age limits; never a full birth date. */
    birthYearMonth: YearMonthSchema.nullable(),
    interestTags: z.array(z.string().min(1).max(40)).max(30),
    preferredOpportunityTypes: z.array(OpportunityTypeSlugSchema).max(33),
    /** Generic prior experience (no program names). */
    priorExperience: z.array(ExperienceKindSchema).max(9),
    /** Hours a week the student can spend on applications; planning input, not a rating. */
    weeklyPrepHours: z.number().int().min(0).max(60).nullable(),
  })
  .strict();
export type StudentProfile = z.infer<typeof StudentProfileSchema>;

export const EMPTY_STUDENT_PROFILE: StudentProfile = {
  classYear: null,
  expectedGraduationTerm: null,
  institutionId: null,
  institutionLevel: null,
  enrollmentIntensity: null,
  transferIntent: null,
  majorCip: null,
  minorCip: null,
  majorFamily: null,
  gpaBand: null,
  residenceState: null,
  timeZone: null,
  birthYearMonth: null,
  interestTags: [],
  preferredOpportunityTypes: [],
  priorExperience: [],
  weeklyPrepHours: null,
};

/** PATCH body: any subset of profile fields, still strict. */
export const StudentProfileUpdateSchema = StudentProfileSchema.partial().strict();
export type StudentProfileUpdate = z.infer<typeof StudentProfileUpdateSchema>;

/** The signed-in user as the client sees it (public id only). */
export const SessionUserSchema = z
  .object({
    publicId: PublicIdSchema,
    email: z.string().email().max(320),
    displayName: z.string().max(80).nullable(),
    roles: z.array(RoleSchema).min(1),
    onboarded: z.boolean(),
  })
  .strict();
export type SessionUser = z.infer<typeof SessionUserSchema>;

export const MeSessionResponseSchema = z
  .object({ user: SessionUserSchema.nullable(), profile: StudentProfileSchema.nullable() })
  .strict();
export type MeSessionResponse = z.infer<typeof MeSessionResponseSchema>;

export const TRACKER_STATUS_SOURCES = ["student", "email_action", "system"] as const;

export const TrackerItemSchema = z
  .object({
    id: IdSchema,
    programCycleId: IdSchema,
    programSlug: SlugSchema,
    cycleKey: CycleKeySchema,
    status: TrackerStatusSchema,
    statusSource: z.enum(TRACKER_STATUS_SOURCES),
    /** The student's own campus deadline; private to them. */
    ownCampusDeadline: IsoDateSchema.nullable(),
    submittedOn: IsoDateSchema.nullable(),
    /** Whether alerts may name the program (identity-audience programs default to neutral copy). */
    nameInMessages: z.boolean(),
    createdAt: IsoDateTimeSchema,
    updatedAt: IsoDateTimeSchema,
    /** Optimistic concurrency and the ICS SEQUENCE for the private campus date. */
    version: z.number().int().min(1),
  })
  .strict();
export type TrackerItem = z.infer<typeof TrackerItemSchema>;

export const TrackerItemCreateSchema = z
  .object({
    programCycleId: IdSchema,
    status: TrackerStatusSchema.default("interested"),
    nameInMessages: z.boolean().default(true),
  })
  .strict();
export type TrackerItemCreate = z.infer<typeof TrackerItemCreateSchema>;

export const TrackerItemUpdateSchema = z
  .object({
    status: TrackerStatusSchema.optional(),
    ownCampusDeadline: IsoDateSchema.nullable().optional(),
    submittedOn: IsoDateSchema.nullable().optional(),
    nameInMessages: z.boolean().optional(),
    /** The version the client last saw; a mismatch answers 409 version_conflict. */
    version: z.number().int().min(1),
  })
  .strict();
export type TrackerItemUpdate = z.infer<typeof TrackerItemUpdateSchema>;

/** Per-student progress on a Requirement (or a reusable item such as `kind:resume`). */
export const REQUIREMENT_PROGRESS_STATES = ["in_progress", "met", "not_applicable"] as const;
export const RequirementProgressSchema = z
  .object({
    subjectKey: z.string().regex(/^(req:[0-9a-f-]{36}|kind:[a-z_]+)$/, "req:{requirementId} or kind:{requirementKind}"),
    state: z.enum(REQUIREMENT_PROGRESS_STATES),
    updatedAt: IsoDateTimeSchema,
  })
  .strict();
export type RequirementProgress = z.infer<typeof RequirementProgressSchema>;

export const RequirementProgressUpdateSchema = RequirementProgressSchema.omit({ updatedAt: true });
export type RequirementProgressUpdate = z.infer<typeof RequirementProgressUpdateSchema>;

export const ConsentRecordSchema = z
  .object({
    kind: ConsentKindSchema,
    textVersion: z.string().max(40),
    grantedAt: IsoDateTimeSchema,
    revokedAt: IsoDateTimeSchema.nullable(),
    /** Program the consent covers, for per-item tracking consents. */
    programId: IdSchema.nullable(),
  })
  .strict();
export type ConsentRecord = z.infer<typeof ConsentRecordSchema>;

export const ConsentChangeSchema = z
  .object({ kind: ConsentKindSchema, textVersion: z.string().max(40), programId: IdSchema.nullable().default(null), granted: z.boolean() })
  .strict();
export type ConsentChange = z.infer<typeof ConsentChangeSchema>;

/** Anonymous Remind-me sign-up (email only; Turnstile token verified by the server). */
export const RemindMeRequestSchema = z
  .object({
    email: z.string().email().max(320),
    programCycleId: IdSchema,
    turnstileToken: z.string().min(1).max(4096),
    /** Explicit opt-in for status- or identity-defined programs; otherwise the server answers 409. */
    sensitiveOptIn: z.boolean().default(false),
    /**
     * Age screen answer (YYYY-MM), required (s01 F-04/F-08): under 16 stores nothing; 16-17 sets
     * minor mode on the Contact. The value itself is never stored or logged.
     */
    birthYearMonth: YearMonthSchema,
  })
  .strict();
export type RemindMeRequest = z.infer<typeof RemindMeRequestSchema>;
