import { sql } from "drizzle-orm";
import {
  check,
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
  uniqueIndex,
  type AnySQLiteColumn,
} from "drizzle-orm/sqlite-core";
import {
  CLASS_YEARS,
  CONSENT_KINDS,
  COUNT_KINDS,
  COUNT_STAGES,
  DEADLINE_BASES,
  DEADLINE_PRECISIONS,
  DEADLINE_SCOPES,
  ENROLLMENT_INTENSITIES,
  EVIDENCE_BASES,
  EVIDENCE_ENTITIES,
  EVIDENCE_MATCHES,
  GPA_BANDS,
  HOST_POLICIES,
  INSTITUTION_CALENDARS,
  INSTITUTION_LEVELS,
  MAJOR_FAMILIES,
  ORGANIZATION_KINDS,
  OUTCOME_DECISIONS,
  OUTCOME_STAGES,
  OUTCOME_TIERS,
  PELL_DISPLACEMENT,
  PREDICTION_LABELS,
  RECURRENCES,
  REQUIREMENT_KINDS,
  REVIEW_TASK_STATES,
  ROLES,
  SOURCE_KINDS,
  SUBSCRIPTION_KINDS,
  TRACKER_STATUSES,
  TRANSFER_INTENTS,
  TZ_MODES,
  TZ_SOURCES,
  US_STATES,
  VERIFICATION_STORED,
  type ClassYear,
  type ExperienceKind,
  type IdentityCategory,
  type OpportunityTypeSlug,
} from "../../shared/taxonomy";
import type { Compensation } from "../../shared/contracts/registry";
import type { EligibilityRuleSetObjectSchema } from "../../shared/contracts/eligibility";
import { CHANGE_EVENT_TYPES, ALERT_TYPES, ALERT_PRIORITIES, NOTIFICATION_CHANNELS, NOTIFICATION_STATES, NOTIFICATION_STREAMS } from "../../shared/contracts/events";
import { SOURCE_APPROVALS, SOURCE_HEALTH, SOURCE_RENDER_MODES, CHANGE_CLASSES, type EvidenceLocator } from "../../shared/contracts/evidence";
import { JOB_STATUSES } from "../../shared/contracts/ops";
import { TRACKER_STATUS_SOURCES, REQUIREMENT_PROGRESS_STATES } from "../../shared/contracts/student";
import type { RoadmapTemplate } from "../../shared/contracts/roadmap";
import type { z } from "zod";
import {
  createdAt,
  day,
  emptyJsonArray,
  exactlyOne,
  flag,
  json,
  jsonArray,
  jsonObject,
  jsonValid,
  ms,
  newPublicId,
  oneOf,
  oneOfOrNull,
  pk,
  timestamps,
  updatedAt,
  version,
} from "./columns";

/**
 * D1 `novus-main` schema of record (data model section 3, Phases 0-2 plus the advisor pilot kit).
 *
 * Privacy by construction: no table or column here can hold SensitiveAnswers (citizenship or
 * immigration status, Pell or income, first-generation, disability, race or ethnicity, gender,
 * sexual orientation, veteran, foster-care or similar status). `schema.test.ts` checks every
 * column of the student-owned tables against the shared sensitive-key stems. Registry flags such
 * as `programs.sensitive_audience` describe programs, never a student.
 *
 * No column stores readiness, match or any composite score about a student (rule 4).
 *
 * No foreign key declares a cascading action: D1 rebuilds would cascade-delete children
 * (data model 3.2, rule 1), so repositories delete children explicitly.
 */

export type RuleSetBody = Omit<
  z.input<typeof EligibilityRuleSetObjectSchema>,
  "id" | "programCycleId" | "version" | "format" | "state" | "hash" | "createdVia" | "verifiedAt" | "verifiedBy" | "templateKey" | "fromCycleKey"
>;

// =============================================================================================
// Lookup tables (growing enums on referenced tables are rows, so a new value is an INSERT)
// =============================================================================================

export const opportunityTypes = sqliteTable("opportunity_types", {
  slug: text("slug").primaryKey(),
  ordinal: integer("ordinal").notNull().unique(),
  label: text("label").notNull(),
  group: text("group_key").notNull(),
  inScope: flag("in_scope", true),
});

const lookup = (name: string) =>
  sqliteTable(name, {
    code: text("code").primaryKey(),
    label: text("label").notNull(),
    sortOrder: integer("sort_order").notNull().default(0),
  });

export const lifecycles = lookup("lifecycles");
export const cycleStatuses = lookup("cycle_statuses");
export const cycleModels = lookup("cycle_models");
export const deadlineKinds = lookup("deadline_kinds");
export const reviewTaskKinds = lookup("review_task_kinds");

// =============================================================================================
// Better Auth core tables (adapter: drizzle, provider "sqlite", usePlural: true).
// JS property names match Better Auth's field names; SQL names are snake_case.
// Cascades from Better Auth's generated schema are stripped (deleteUser removes children first).
// =============================================================================================

const authDate = (name: string) => integer(name, { mode: "timestamp_ms" });

export const users = sqliteTable(
  "users",
  {
    id: pk(),
    name: text("name").notNull().default(""),
    email: text("email").notNull().unique(),
    emailVerified: integer("email_verified", { mode: "boolean" }).notNull().default(false),
    image: text("image"),
    createdAt: authDate("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: authDate("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
    /** The only user identifier that may appear in a URL or response. */
    publicId: text("public_id")
      .notNull()
      .unique()
      .$defaultFn(() => newPublicId()),
    trustLevel: integer("trust_level").notNull().default(0),
    /** An adult's analytics opt-out (time recorded, so it is auditable). */
    analyticsOffAt: ms("analytics_off_at"),
    /** Written at most daily, for the inactive-account retention rule. */
    lastActiveAt: ms("last_active_at"),
    onboardedAt: ms("onboarded_at"),
    /** Soft delete: content hidden at once, hard delete by deletion.process within 72 hours. */
    deletedAt: ms("deleted_at"),
  },
  (t) => [index("users_deleted_idx").on(t.deletedAt).where(sql`${t.deletedAt} IS NOT NULL`)],
);

export const sessions = sqliteTable(
  "sessions",
  {
    id: pk(),
    expiresAt: authDate("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: authDate("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: authDate("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
    /** Truncated to /24 or /48 by the auth hook before insert. */
    ipAddress: text("ip_address"),
    /** Reduced to a device class by the auth hook. */
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
  },
  (t) => [index("sessions_user_idx").on(t.userId), index("sessions_expires_idx").on(t.expiresAt)],
);

export const accounts = sqliteTable(
  "accounts",
  {
    id: pk(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: authDate("access_token_expires_at"),
    refreshTokenExpiresAt: authDate("refresh_token_expires_at"),
    scope: text("scope"),
    /** Stays null in the email-code flow. */
    password: text("password"),
    createdAt: authDate("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: authDate("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index("accounts_user_idx").on(t.userId), uniqueIndex("accounts_provider_uq").on(t.providerId, t.accountId)],
);

export const verifications = sqliteTable(
  "verifications",
  {
    id: pk(),
    /** Hashed by Better Auth (`verification.storeIdentifier: "hashed"`). */
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: authDate("expires_at").notNull(),
    createdAt: authDate("created_at")
      .notNull()
      .$defaultFn(() => new Date()),
    updatedAt: authDate("updated_at")
      .notNull()
      .$defaultFn(() => new Date())
      .$onUpdateFn(() => new Date()),
  },
  (t) => [index("verifications_identifier_idx").on(t.identifier), index("verifications_expires_idx").on(t.expiresAt)],
);

export const rateLimits = sqliteTable("rate_limits", {
  id: pk(),
  key: text("key").notNull().unique(),
  count: integer("count").notNull(),
  lastRequest: integer("last_request").notNull(),
});

/** Roles beyond the default `student`, scoped globally, to a workspace or to an Organization. */
export const userRoles = sqliteTable(
  "user_roles",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").notNull(),
    workspaceId: text("workspace_id").references((): AnySQLiteColumn => advisorWorkspaces.id),
    organizationId: text("organization_id").references((): AnySQLiteColumn => organizations.id),
    grantedBy: text("granted_by"),
    createdAt: createdAt(),
    revokedAt: ms("revoked_at"),
  },
  (t) => [
    oneOf("user_roles_role_ck", t.role, ROLES),
    // user_roles_live_uq (expression index) lives in the guards migration.
    index("user_roles_user_idx").on(t.userId),
  ],
);

// =============================================================================================
// Curators (public handles only; personal fields are never seeded from the repository)
// =============================================================================================

export const curators = sqliteTable(
  "curators",
  {
    id: pk(),
    /** Shown as "Verified by {handle}"; never a person's name. */
    publicHandle: text("public_handle").notNull().unique(),
    role: text("role").notNull().default("curator"),
    /** Linked to an account out of band. */
    userId: text("user_id").references(() => users.id),
    active: flag("active", true),
    isSample: flag("is_sample"),
    createdAt: createdAt(),
  },
  (t) => [oneOf("curators_role_ck", t.role, ["curator", "moderator", "admin"])],
);

// =============================================================================================
// Registry core
// =============================================================================================

export const organizations = sqliteTable(
  "organizations",
  {
    id: pk(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    country: text("country").notNull().default("US"),
    defaultTimeZone: text("default_time_zone"),
    websiteUrl: text("website_url"),
    isSample: flag("is_sample"),
    version: version(),
    ...timestamps(),
  },
  (t) => [oneOf("organizations_kind_ck", t.kind, ORGANIZATION_KINDS), check("organizations_country_ck", sql`length(${t.country}) = 2`)],
);

export const programs = sqliteTable(
  "programs",
  {
    id: pk(),
    slug: text("slug").notNull().unique(),
    name: text("name").notNull(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    /** Original prose written by Novus, never copied from the official page. */
    summary: text("summary"),
    officialUrl: text("official_url").notNull(),
    recurrence: text("recurrence").notNull(),
    lifecycle: text("lifecycle")
      .notNull()
      .default("active")
      .references(() => lifecycles.code),
    /** Open only to a non-citizen status, Pell recipients or a health condition (describes the program). */
    sensitiveAudience: flag("sensitive_audience"),
    /** Communities the program serves (describes the program, never a student). */
    identityAudience: json<IdentityCategory[]>("identity_audience").notNull().default(emptyJsonArray),
    campusLeadDays: integer("campus_lead_days"),
    campusLeadMedianDays: integer("campus_lead_median_days"),
    campusLeadN: integer("campus_lead_n"),
    isWedge: flag("is_wedge"),
    isPublished: flag("is_published"),
    /** Sample/demo record: never presented as a verified fact about a real program. */
    isSample: flag("is_sample"),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    oneOf("programs_recurrence_ck", t.recurrence, RECURRENCES),
    jsonArray("programs_identity_audience_ck", t.identityAudience),
    index("programs_org_idx").on(t.organizationId),
    index("programs_published_idx").on(t.isPublished, t.lifecycle),
  ],
);

export const programTypes = sqliteTable(
  "program_types",
  {
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    typeSlug: text("type_slug")
      .notNull()
      .references(() => opportunityTypes.slug)
      .$type<OpportunityTypeSlug>(),
    isPrimary: flag("is_primary"),
  },
  (t) => [primaryKey({ columns: [t.programId, t.typeSlug] }), index("program_types_type_idx").on(t.typeSlug)],
);

/** Search aliases such as REU, SULI or "sprintship". */
export const programAliases = sqliteTable(
  "program_aliases",
  {
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    alias: text("alias").notNull(),
  },
  (t) => [primaryKey({ columns: [t.programId, t.alias] }), index("program_aliases_alias_idx").on(t.alias)],
);

export const programInterestTags = sqliteTable(
  "program_interest_tags",
  {
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    tag: text("tag").notNull(),
  },
  (t) => [primaryKey({ columns: [t.programId, t.tag] }), index("program_interest_tags_tag_idx").on(t.tag)],
);

/** Fields of study a program targets, by CIP prefix (`core`, `related`, or `borderline` = unknown). */
export const programFields = sqliteTable(
  "program_fields",
  {
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    cipPrefix: text("cip_prefix").notNull(),
    relation: text("relation").notNull().default("core"),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.cipPrefix] }),
    oneOf("program_fields_relation_ck", t.relation, ["core", "related", "borderline"]),
    check("program_fields_cip_ck", sql`${t.cipPrefix} GLOB '[0-9][0-9]*'`),
  ],
);

export const programMajorFamilies = sqliteTable(
  "program_major_families",
  {
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    majorFamily: text("major_family").notNull(),
  },
  (t) => [primaryKey({ columns: [t.programId, t.majorFamily] }), oneOf("program_major_families_ck", t.majorFamily, MAJOR_FAMILIES)],
);

/** Old slug -> surviving program, kept for merges and renames (client-core `merged`). */
export const slugRedirects = sqliteTable("slug_redirects", {
  fromSlug: text("from_slug").primaryKey(),
  toProgramId: text("to_program_id")
    .notNull()
    .references(() => programs.id),
  reason: text("reason").notNull().default("rename"),
  createdAt: createdAt(),
});

export const institutions = sqliteTable(
  "institutions",
  {
    id: pk(),
    /** IPEDS UNITID. */
    unitId: text("unit_id").unique(),
    name: text("name").notNull(),
    level: text("level").notNull(),
    control: text("control"),
    state: text("state"),
    calendar: text("calendar"),
    academicYearStartMonth: integer("academic_year_start_month").notNull().default(8),
    timeZone: text("time_zone"),
    isHbcu: flag("is_hbcu"),
    isTribal: flag("is_tribal"),
    isHsi: flag("is_hsi"),
    isSample: flag("is_sample"),
    ...timestamps(),
  },
  (t) => [
    oneOf("institutions_level_ck", t.level, INSTITUTION_LEVELS),
    oneOfOrNull("institutions_control_ck", t.control, ["public", "private_nonprofit", "private_for_profit"]),
    oneOfOrNull("institutions_state_ck", t.state, US_STATES),
    oneOfOrNull("institutions_calendar_ck", t.calendar, INSTITUTION_CALENDARS),
    check("institutions_ay_month_ck", sql`${t.academicYearStartMonth} BETWEEN 1 AND 12`),
    index("institutions_name_idx").on(t.name),
  ],
);

export const institutionEmailDomains = sqliteTable(
  "institution_email_domains",
  {
    domain: text("domain").primaryKey(),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id),
    active: flag("active", true),
    createdAt: createdAt(),
  },
  (t) => [index("institution_email_domains_inst_idx").on(t.institutionId)],
);

/** Positive listings: a campus that can nominate for a program in a list year. */
export const institutionParticipation = sqliteTable(
  "institution_participation",
  {
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    institutionId: text("institution_id")
      .notNull()
      .references(() => institutions.id),
    listYear: integer("list_year").notNull(),
    basis: text("basis").notNull(),
    createdAt: createdAt(),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.institutionId, t.listYear] }),
    oneOf("institution_participation_basis_ck", t.basis, ["official_list", "attested"]),
    index("institution_participation_inst_idx").on(t.institutionId),
  ],
);

/** Exact hosts a program's site, portal or mail comes from; the publish batch checks URLs against them. */
export const officialDomains = sqliteTable(
  "official_domains",
  {
    id: pk(),
    organizationId: text("organization_id")
      .notNull()
      .references(() => organizations.id),
    host: text("host").notNull(),
    role: text("role").notNull(),
    sharedPlatform: flag("shared_platform"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("official_domains_role_ck", t.role, ["site", "application_portal", "email_sender"]),
    uniqueIndex("official_domains_uq").on(t.organizationId, t.host, t.role),
    index("official_domains_host_idx").on(t.host),
  ],
);

export const programCycles = sqliteTable(
  "program_cycles",
  {
    id: pk(),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    cycleKey: text("cycle_key").notNull(),
    termLabel: text("term_label").notNull(),
    cycleModel: text("cycle_model")
      .notNull()
      .default("term")
      .references(() => cycleModels.code),
    status: text("status")
      .notNull()
      .default("expected")
      .references(() => cycleStatuses.code),
    statusChangedAt: ms("status_changed_at").notNull(),
    /** "system:pipeline.hourly" or a Curator id. */
    statusChangedBy: text("status_changed_by").notNull(),
    /** Zone stated for the cycle's fixed deadlines, else the Organization's default. */
    timeZone: text("time_zone"),
    opensOn: day("opens_on"),
    predictedOpensOn: day("predicted_opens_on"),
    predictionLabel: text("prediction_label"),
    decisionWindowStart: day("decision_window_start"),
    decisionWindowEnd: day("decision_window_end"),
    decisionsReleasedOn: day("decisions_released_on"),
    eventStart: day("event_start"),
    eventEnd: day("event_end"),
    applicationUrl: text("application_url"),
    pellDisplacement: text("pell_displacement").notNull().default("unknown"),
    applicationFeeCents: integer("application_fee_cents"),
    participantCostCents: integer("participant_cost_cents"),
    compensation: json<Compensation>("compensation"),
    /** Class years the official rules admit, for list filters (derived from the verified rules). */
    classYears: json<ClassYear[]>("class_years").notNull().default(emptyJsonArray),
    verificationState: text("verification_state").notNull().default("draft"),
    lastVerifiedAt: ms("last_verified_at"),
    verifiedBy: text("verified_by").references(() => curators.id),
    /** Machine attestation only. */
    sourceCheckedAt: ms("source_checked_at"),
    campusEstimateRelease: integer("campus_estimate_release"),
    rolledOverFromId: text("rolled_over_from_id").references((): AnySQLiteColumn => programCycles.id),
    version: version(),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("cycles_key_uq").on(t.programId, t.cycleKey),
    index("cycles_status_idx").on(t.status, t.predictedOpensOn),
    index("cycles_fresh_idx").on(t.verificationState, t.lastVerifiedAt),
    check("cycles_key_ck", sql`${t.cycleKey} GLOB '[a-z]*-[0-9][0-9][0-9][0-9]*'`),
    oneOf("cycles_verification_ck", t.verificationState, VERIFICATION_STORED),
    oneOf("cycles_pell_ck", t.pellDisplacement, PELL_DISPLACEMENT),
    oneOfOrNull("cycles_prediction_label_ck", t.predictionLabel, PREDICTION_LABELS),
    check(
      "cycles_verified_ck",
      sql`${t.verificationState} IN ('draft', 'unverified') OR (${t.lastVerifiedAt} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL)`,
    ),
    check("cycles_money_ck", sql`coalesce(${t.applicationFeeCents}, 0) >= 0 AND coalesce(${t.participantCostCents}, 0) >= 0`),
    jsonObject("cycles_compensation_ck", t.compensation),
    jsonArray("cycles_class_years_ck", t.classYears),
  ],
);

export const deadlines = sqliteTable(
  "deadlines",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    kind: text("kind")
      .notNull()
      .references(() => deadlineKinds.code),
    scope: text("scope").notNull(),
    institutionId: text("institution_id").references(() => institutions.id),
    /** "" when the program has no rounds, so the unique slot index sees no NULLs. */
    roundLabel: text("round_label").notNull().default(""),
    basis: text("basis").notNull(),
    precision: text("precision").notNull(),
    tzMode: text("tz_mode").notNull().default("fixed"),
    localDate: day("local_date"),
    localTime: text("local_time"),
    windowStart: day("window_start"),
    windowEnd: day("window_end"),
    timeZone: text("time_zone"),
    tzSource: text("tz_source"),
    dueAt: ms("due_at"),
    sortAt: ms("sort_at"),
    /** ICS SEQUENCE only, never a lock (the cycle's version guards concurrency). */
    revision: integer("revision").notNull().default(1),
    verificationState: text("verification_state").notNull().default("draft"),
    withdrawnAt: ms("withdrawn_at"),
    ...timestamps(),
  },
  (t) => [
    // deadlines_slot_uq (partial expression index over coalesce(institution_id, '')) lives in the
    // guards migration: drizzle-kit 0.31 cannot emit expression index columns correctly.
    index("deadlines_sort_idx").on(t.sortAt),
    index("deadlines_cycle_idx").on(t.programCycleId),
    index("deadlines_campus_idx").on(t.institutionId, t.programCycleId),
    oneOf("dl_scope_ck", t.scope, DEADLINE_SCOPES),
    oneOf("dl_basis_ck", t.basis, DEADLINE_BASES),
    oneOf("dl_precision_ck", t.precision, DEADLINE_PRECISIONS),
    oneOf("dl_tz_mode_ck", t.tzMode, TZ_MODES),
    oneOfOrNull("dl_tz_source_ck", t.tzSource, TZ_SOURCES),
    oneOf("dl_verification_ck", t.verificationState, VERIFICATION_STORED),
    check("dl_campus_ck", sql`${t.scope} = 'national' OR ${t.institutionId} IS NOT NULL`),
    check("dl_attested_ck", sql`${t.basis} <> 'attested' OR ${t.scope} = 'campus'`),
    check(
      "dl_window_ck",
      sql`((${t.precision} = 'window') = (${t.windowStart} IS NOT NULL AND ${t.windowEnd} IS NOT NULL)) AND (${t.precision} <> 'window' OR ${t.basis} = 'predicted') AND (${t.basis} <> 'predicted' OR ${t.precision} IN ('window', 'tbd'))`,
    ),
    check("dl_date_ck", sql`(${t.localDate} IS NOT NULL) = (${t.precision} IN ('exact', 'date_only', 'month_only', 'window'))`),
    check("dl_time_ck", sql`(${t.localTime} IS NOT NULL) = (${t.precision} = 'exact')`),
    check(
      "dl_zone_ck",
      sql`CASE ${t.tzMode} WHEN 'applicant_local' THEN ${t.timeZone} IS NULL AND ${t.precision} IN ('exact', 'date_only') ELSE ${t.timeZone} IS NOT NULL OR ${t.precision} IN ('month_only', 'rolling', 'tbd') END`,
    ),
    check("dl_instant_ck", sql`(${t.dueAt} IS NOT NULL) = (${t.tzMode} = 'fixed' AND ${t.precision} IN ('exact', 'date_only'))`),
  ],
);

export const requirements = sqliteTable(
  "requirements",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    kind: text("kind").notNull(),
    label: text("label").notNull(),
    detail: text("detail"),
    quantity: integer("quantity").notNull().default(1),
    wordLimit: integer("word_limit"),
    deadlineId: text("deadline_id").references(() => deadlines.id),
    /** Curator overrides of the readiness guidance table. */
    effortHours: real("effort_hours"),
    leadTimeDays: integer("lead_time_days"),
    sortOrder: integer("sort_order").notNull().default(0),
    verificationState: text("verification_state").notNull().default("draft"),
    withdrawnAt: ms("withdrawn_at"),
    ...timestamps(),
  },
  (t) => [
    index("requirements_cycle_idx").on(t.programCycleId),
    oneOf("requirements_kind_ck", t.kind, REQUIREMENT_KINDS),
    oneOf("requirements_verification_ck", t.verificationState, VERIFICATION_STORED),
    check("requirements_quantity_ck", sql`${t.quantity} BETWEEN 1 AND 20`),
  ],
);

/** Shared rule templates (for example a funder's baseline); a rule set names one by key. */
export const eligibilityTemplates = sqliteTable(
  "eligibility_templates",
  {
    key: text("key").primaryKey(),
    body: json<RuleSetBody>("body").notNull(),
    hash: text("hash"),
    state: text("state").notNull().default("draft"),
    ...timestamps(),
  },
  (t) => [oneOf("eligibility_templates_state_ck", t.state, ["draft", "verified", "superseded"]), jsonObject("eligibility_templates_body_ck", t.body)],
);

/**
 * Versioned JsonLogic rule sets (`jsonlogic-v1`). `body` holds coverage, rules, anyOf, attestations,
 * nomination and the evidence map; verified versions are immutable by trigger (migration guards).
 */
export const eligibilityRuleSets = sqliteTable(
  "eligibility_rule_sets",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    version: integer("version").notNull(),
    format: text("format").notNull().default("jsonlogic-v1"),
    state: text("state").notNull(),
    templateKey: text("template_key").references(() => eligibilityTemplates.key),
    body: json<RuleSetBody>("body").notNull(),
    /** sha256 of the canonical JSON of the rules; set when verified. */
    hash: text("hash"),
    coverageComplete: flag("coverage_complete"),
    launchCoverageComplete: flag("launch_coverage_complete"),
    diffFromPrevious: json<unknown[]>("diff_from_previous"),
    createdVia: text("created_via").notNull(),
    /** Rules copied from an earlier cycle ("may change"). */
    fromCycleKey: text("from_cycle_key"),
    verifiedAt: ms("verified_at"),
    verifiedBy: text("verified_by").references(() => curators.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("ers_version_uq").on(t.programCycleId, t.version),
    uniqueIndex("ers_verified_uq")
      .on(t.programCycleId)
      .where(sql`${t.state} = 'verified'`),
    oneOf("ers_state_ck", t.state, ["draft", "verified", "superseded"]),
    oneOf("ers_format_ck", t.format, ["jsonlogic-v1"]),
    oneOf("ers_created_via_ck", t.createdVia, ["sheet", "console", "rollover", "llm_draft", "sample"]),
    jsonObject("ers_body_ck", t.body),
    jsonArray("ers_diff_ck", t.diffFromPrevious),
    check(
      "ers_verified_ck",
      sql`${t.state} = 'draft' OR (${t.hash} IS NOT NULL AND ${t.verifiedBy} IS NOT NULL AND ${t.verifiedAt} IS NOT NULL)`,
    ),
  ],
);

/** Official counts per stage; only `official_publication` rows feed odds. */
export const programCycleCounts = sqliteTable(
  "program_cycle_counts",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    stage: text("stage").notNull(),
    count: integer("count").notNull(),
    kind: text("kind").notNull(),
    provenance: text("provenance").notNull(),
    asOf: day("as_of").notNull(),
    verifiedBy: text("verified_by").references(() => curators.id),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("counts_stage_uq").on(t.programCycleId, t.stage),
    oneOf("counts_stage_ck", t.stage, COUNT_STAGES),
    oneOf("counts_kind_ck", t.kind, COUNT_KINDS),
    oneOf("counts_provenance_ck", t.provenance, ["official_publication", "owner_reported"]),
    check("counts_nonneg_ck", sql`${t.count} >= 0`),
  ],
);

/** Opening/deadline predictions per cycle and run (the predictor writes p10/p50/p90 and a label). */
export const cyclePredictions = sqliteTable(
  "cycle_predictions",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    event: text("event").notNull(),
    method: text("method").notNull(),
    p10: day("p10").notNull(),
    p50: day("p50").notNull(),
    p90: day("p90").notNull(),
    label: text("label").notNull(),
    isCurrent: flag("is_current", true),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("predictions_event_ck", t.event, ["opens", "application_deadline", "decisions"]),
    oneOf("predictions_method_ck", t.method, ["official_rule", "history", "curator_month", "curator_estimate"]),
    oneOf("predictions_label_ck", t.label, PREDICTION_LABELS),
    check("predictions_order_ck", sql`${t.p10} <= ${t.p50} AND ${t.p50} <= ${t.p90}`),
    uniqueIndex("predictions_current_uq")
      .on(t.programCycleId, t.event)
      .where(sql`${t.isCurrent} = 1`),
  ],
);

// =============================================================================================
// Sources, Snapshots and evidence
// =============================================================================================

export const sourceHosts = sqliteTable(
  "source_hosts",
  {
    host: text("host").primaryKey(),
    policy: text("policy").notNull(),
    policySource: text("policy_source").notNull().default("default"),
    minIntervalMs: integer("min_interval_ms").notNull().default(2000),
    updatedAt: updatedAt(),
  },
  (t) => [
    oneOf("source_hosts_policy_ck", t.policy, HOST_POLICIES),
    oneOf("source_hosts_policy_source_ck", t.policySource, ["seed", "default", "curator"]),
    check("source_hosts_interval_ck", sql`${t.minIntervalMs} >= 1000`),
  ],
);

export const sources = sqliteTable(
  "sources",
  {
    id: pk(),
    kind: text("kind").notNull(),
    url: text("url").notNull().unique(),
    host: text("host")
      .notNull()
      .references(() => sourceHosts.host),
    renderMode: text("render_mode").notNull().default("static"),
    programId: text("program_id").references(() => programs.id),
    organizationId: text("organization_id").references(() => organizations.id),
    approval: text("approval").notNull().default("pending_approval"),
    health: text("health").notNull().default("ok"),
    baselineSnapshotId: text("baseline_snapshot_id"),
    nextCheckAt: ms("next_check_at"),
    lastFetchedAt: ms("last_fetched_at"),
    optedOutOn: day("opted_out_on"),
    ...timestamps(),
  },
  (t) => [
    oneOf("sources_kind_ck", t.kind, SOURCE_KINDS),
    oneOf("sources_render_ck", t.renderMode, SOURCE_RENDER_MODES),
    oneOf("sources_approval_ck", t.approval, SOURCE_APPROVALS),
    oneOf("sources_health_ck", t.health, SOURCE_HEALTH),
    index("sources_due_idx").on(t.nextCheckAt).where(sql`${t.nextCheckAt} IS NOT NULL`),
    index("sources_program_idx").on(t.programId),
  ],
);

export const snapshots = sqliteTable(
  "snapshots",
  {
    id: pk(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id),
    fetchedAt: ms("fetched_at").notNull(),
    requestedUrl: text("requested_url").notNull(),
    finalUrl: text("final_url").notNull(),
    redirectChain: json<string[]>("redirect_chain").notNull().default(emptyJsonArray),
    httpStatus: integer("http_status").notNull(),
    contentType: text("content_type").notNull(),
    rawSha256: text("raw_sha256").notNull(),
    mainTextSha256: text("main_text_sha256"),
    normalizerVersion: text("normalizer_version").notNull(),
    /** R2 keys under `snapshots/`; page bytes never live in D1. */
    rawKey: text("raw_key").notNull(),
    textKey: text("text_key"),
    changeClass: text("change_class"),
    hostPolicy: text("host_policy").notNull(),
    /** False when the host signals no AI input; such a Snapshot never reaches a model. */
    aiInputAllowed: flag("ai_input_allowed", true),
    deleteAfter: ms("delete_after"),
    legalHold: flag("legal_hold"),
    createdAt: createdAt(),
  },
  (t) => [
    index("snapshots_source_idx").on(t.sourceId, t.fetchedAt),
    index("snapshots_raw_idx").on(t.rawSha256),
    index("snapshots_text_idx").on(t.mainTextSha256),
    oneOfOrNull("snapshots_change_ck", t.changeClass, CHANGE_CLASSES),
    oneOf("snapshots_policy_ck", t.hostPolicy, HOST_POLICIES),
    jsonArray("snapshots_redirects_ck", t.redirectChain),
    check("snapshots_status_ck", sql`${t.httpStatus} BETWEEN 100 AND 599`),
  ],
);

/** One quote backing one field of one record; quotes and URLs are never rewritten in place. */
export const fieldEvidence = sqliteTable(
  "field_evidence",
  {
    id: pk(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    fieldPath: text("field_path").notNull(),
    basis: text("basis").notNull(),
    snapshotId: text("snapshot_id").references(() => snapshots.id),
    attestationTaskId: text("attestation_task_id"),
    url: text("url").notNull(),
    quote: text("quote").notNull(),
    locator: json<EvidenceLocator>("locator"),
    match: text("match").notNull(),
    verifiedBy: text("verified_by").references(() => curators.id),
    supersededAt: ms("superseded_at"),
    createdAt: createdAt(),
  },
  (t) => [
    index("ev_live_idx")
      .on(t.entityType, t.entityId)
      .where(sql`${t.supersededAt} IS NULL`),
    index("ev_snapshot_idx").on(t.snapshotId),
    oneOf("ev_entity_ck", t.entityType, EVIDENCE_ENTITIES),
    oneOf("ev_basis_values_ck", t.basis, EVIDENCE_BASES),
    oneOf("ev_match_ck", t.match, EVIDENCE_MATCHES),
    jsonObject("ev_locator_ck", t.locator),
    check(
      "ev_basis_ck",
      sql`CASE ${t.basis} WHEN 'snapshot' THEN ${t.snapshotId} IS NOT NULL WHEN 'attestation' THEN ${t.attestationTaskId} IS NOT NULL ELSE ${t.snapshotId} IS NULL END`,
    ),
  ],
);

/** Rows from outside lists (the co-founder's list and similar) mapped to Sources and Programs. */
export const externalRefs = sqliteTable(
  "external_refs",
  {
    id: pk(),
    system: text("system").notNull(),
    externalId: text("external_id").notNull(),
    rowKind: text("row_kind").notNull(),
    sourceId: text("source_id").references(() => sources.id),
    programId: text("program_id").references(() => programs.id),
    ...timestamps(),
  },
  (t) => [uniqueIndex("external_refs_uq").on(t.system, t.externalId), oneOf("external_refs_kind_ck", t.rowKind, ["json", "hand"])],
);

// =============================================================================================
// Review, publishing, audit
// =============================================================================================

export const LIVE_REVIEW_STATES = ["open", "claimed", "second_review", "snoozed"] as const;

export const reviewTasks = sqliteTable(
  "review_tasks",
  {
    id: pk(),
    kind: text("kind")
      .notNull()
      .references(() => reviewTaskKinds.code),
    subjectType: text("subject_type").notNull(),
    subjectId: text("subject_id").notNull(),
    /** `{kind}:{subjectType}:{subjectId}`, unique among live tasks. */
    dedupeKey: text("dedupe_key").notNull(),
    reasonCodes: json<string[]>("reason_codes").notNull().default(emptyJsonArray),
    evidenceIds: json<string[]>("evidence_ids").notNull().default(emptyJsonArray),
    priority: integer("priority").notNull().default(5),
    state: text("state").notNull().default("open"),
    dueAt: ms("due_at"),
    claimedBy: text("claimed_by").references(() => curators.id),
    claimExpiresAt: ms("claim_expires_at"),
    payload: json<Record<string, unknown>>("payload").notNull().default(sql`'{}'`),
    resolution: text("resolution"),
    activeSeconds: integer("active_seconds").notNull().default(0),
    resolvedAt: ms("resolved_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("review_tasks_live_uq")
      .on(t.dedupeKey)
      .where(sql`${t.state} IN ('open', 'claimed', 'second_review', 'snoozed')`),
    index("review_tasks_queue_idx").on(t.state, t.priority, t.dueAt),
    index("review_tasks_subject_idx").on(t.subjectType, t.subjectId),
    oneOf("review_tasks_state_ck", t.state, REVIEW_TASK_STATES),
    oneOf("review_tasks_subject_ck", t.subjectType, EVIDENCE_ENTITIES),
    check("review_tasks_priority_ck", sql`${t.priority} BETWEEN 0 AND 9`),
    jsonArray("review_tasks_reasons_ck", t.reasonCodes),
    jsonArray("review_tasks_evidence_ck", t.evidenceIds),
    jsonObject("review_tasks_payload_ck", t.payload),
  ],
);

/**
 * Stale-version guard for publish batches: `ok` is a sub-select of the versioned row, so a stale
 * version makes it NULL, the NOT NULL constraint throws and the whole batch rolls back.
 */
export const publishGuards = sqliteTable("publish_guards", {
  taskId: text("task_id").primaryKey(),
  ok: integer("ok").notNull(),
  appliedAt: ms("applied_at").notNull(),
});

/** Append-only (trigger): before and after values of public registry fields. */
export const registryAudit = sqliteTable(
  "registry_audit",
  {
    id: pk(),
    at: ms("at").notNull(),
    actorKind: text("actor_kind").notNull(),
    actorRef: text("actor_ref").notNull(),
    entityType: text("entity_type").notNull(),
    entityId: text("entity_id").notNull(),
    field: text("field").notNull(),
    before: json<unknown>("before_value"),
    after: json<unknown>("after_value"),
    taskId: text("task_id"),
    snapshotIds: json<string[]>("snapshot_ids").notNull().default(emptyJsonArray),
  },
  (t) => [
    index("registry_audit_entity_idx").on(t.entityType, t.entityId, t.at),
    oneOf("registry_audit_actor_ck", t.actorKind, ["user", "curator", "system", "pipeline", "admin"]),
    oneOf("registry_audit_entity_ck", t.entityType, EVIDENCE_ENTITIES),
    jsonValid("registry_audit_before_ck", t.before),
    jsonValid("registry_audit_after_ck", t.after),
    jsonArray("registry_audit_snapshots_ck", t.snapshotIds),
  ],
);

/** Who read or changed personal data: field names and a pseudonymous subject key, never values. */
export const accessAudit = sqliteTable(
  "access_audit",
  {
    id: pk(),
    createdAt: createdAt(),
    actorKind: text("actor_kind").notNull(),
    actorRef: text("actor_ref").notNull(),
    action: text("action").notNull(),
    purpose: text("purpose").notNull(),
    fields: json<string[]>("fields").notNull().default(emptyJsonArray),
    subjectKey: text("subject_key").notNull(),
    requestId: text("request_id"),
  },
  (t) => [
    index("access_audit_subject_idx").on(t.subjectKey, t.createdAt),
    oneOf("access_audit_actor_ck", t.actorKind, ["user", "curator", "system", "pipeline", "admin"]),
    oneOf("access_audit_action_ck", t.action, ["read", "export", "update", "delete", "share"]),
    jsonArray("access_audit_fields_ck", t.fields),
  ],
);

/** Release numbers are allocated by the publish batch (max + 1), so none is skipped. */
export const registryReleases = sqliteTable(
  "registry_releases",
  {
    number: integer("number").primaryKey(),
    state: text("state").notNull().default("pending"),
    clientCoreKey: text("client_core_key"),
    sizeBytes: integer("size_bytes"),
    sha256: text("sha256"),
    containsSample: flag("contains_sample"),
    createdAt: createdAt(),
    builtAt: ms("built_at"),
    publishedAt: ms("published_at"),
  },
  (t) => [oneOf("registry_releases_state_ck", t.state, ["pending", "built", "published", "failed"])],
);

/** The publish outbox: registry facts only, never student data. */
export const changeEvents = sqliteTable(
  "change_events",
  {
    id: pk(),
    type: text("type").notNull(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    payload: json<Record<string, unknown>>("payload").notNull().default(sql`'{}'`),
    taskId: text("task_id"),
    /** `{task or job}:{type}:{programCycleId}`: a retried publish writes nothing new. */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    release: integer("release"),
    /** Set by alerts.match once fan-out finished. */
    fannedOutAt: ms("fanned_out_at"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("change_events_type_ck", t.type, CHANGE_EVENT_TYPES),
    jsonObject("change_events_payload_ck", t.payload),
    index("change_events_pending_idx").on(t.createdAt).where(sql`${t.fannedOutAt} IS NULL`),
    index("change_events_cycle_idx").on(t.programCycleId, t.createdAt),
  ],
);

export const reports = sqliteTable(
  "reports",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    field: text("field").notNull(),
    note: text("note").notNull().default(""),
    reporterUserId: text("reporter_user_id").references(() => users.id),
    taskId: text("task_id").references(() => reviewTasks.id),
    createdAt: createdAt(),
    resolvedAt: ms("resolved_at"),
  },
  (t) => [
    oneOf("reports_field_ck", t.field, ["deadline", "eligibility", "status", "link", "requirements", "other"]),
    check("reports_note_ck", sql`length(${t.note}) <= 280`),
    index("reports_cycle_idx").on(t.programCycleId),
  ],
);

// =============================================================================================
// Students: profile, tracker, requirement progress, roadmap (no status or identity column)
// =============================================================================================

export const studentProfiles = sqliteTable(
  "student_profiles",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    classYear: text("class_year"),
    expectedGraduationTerm: text("expected_graduation_term"),
    institutionId: text("institution_id").references(() => institutions.id),
    institutionLevel: text("institution_level"),
    enrollmentIntensity: text("enrollment_intensity"),
    transferIntent: text("transfer_intent"),
    majorCip: text("major_cip"),
    minorCip: text("minor_cip"),
    majorFamily: text("major_family"),
    gpaBand: text("gpa_band"),
    residenceState: text("residence_state"),
    timeZone: text("time_zone"),
    /** Month and year only, for age limits. */
    birthYearMonth: text("birth_year_month"),
    interestTags: json<string[]>("interest_tags").notNull().default(emptyJsonArray),
    preferredOpportunityTypes: json<OpportunityTypeSlug[]>("preferred_opportunity_types").notNull().default(emptyJsonArray),
    priorExperience: json<ExperienceKind[]>("prior_experience").notNull().default(emptyJsonArray),
    weeklyPrepHours: integer("weekly_prep_hours"),
    version: version(),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    oneOfOrNull("profiles_class_year_ck", t.classYear, CLASS_YEARS),
    oneOfOrNull("profiles_level_ck", t.institutionLevel, INSTITUTION_LEVELS),
    oneOfOrNull("profiles_intensity_ck", t.enrollmentIntensity, ENROLLMENT_INTENSITIES),
    oneOfOrNull("profiles_transfer_ck", t.transferIntent, TRANSFER_INTENTS),
    oneOfOrNull("profiles_major_family_ck", t.majorFamily, MAJOR_FAMILIES),
    oneOfOrNull("profiles_gpa_band_ck", t.gpaBand, GPA_BANDS),
    oneOfOrNull("profiles_state_ck", t.residenceState, US_STATES),
    check("profiles_birth_ck", sql`${t.birthYearMonth} IS NULL OR ${t.birthYearMonth} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'`),
    check("profiles_hours_ck", sql`${t.weeklyPrepHours} IS NULL OR ${t.weeklyPrepHours} BETWEEN 0 AND 60`),
    jsonArray("profiles_tags_ck", t.interestTags),
    jsonArray("profiles_types_ck", t.preferredOpportunityTypes),
    jsonArray("profiles_experience_ck", t.priorExperience),
  ],
);

export const trackerItems = sqliteTable(
  "tracker_items",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    status: text("status").notNull().default("interested"),
    statusSource: text("status_source").notNull().default("student"),
    /** The student's own campus date; private to them (its ICS SEQUENCE is `version`). */
    ownCampusDeadline: day("own_campus_deadline"),
    submittedOn: day("submitted_on"),
    nameInMessages: flag("name_in_messages", true),
    version: version(),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    uniqueIndex("tracker_items_user_cycle_uq").on(t.userId, t.programCycleId),
    index("tracker_items_cycle_idx").on(t.programCycleId).where(sql`${t.deletedAt} IS NULL`),
    oneOf("tracker_items_status_ck", t.status, TRACKER_STATUSES),
    oneOf("tracker_items_source_ck", t.statusSource, TRACKER_STATUS_SOURCES),
  ],
);

export const requirementProgress = sqliteTable(
  "requirement_progress",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    /** `req:{requirementId}` or `kind:{requirementKind}` for reusable items such as a resume. */
    subjectKey: text("subject_key").notNull(),
    /** Set for `req:` subjects so the audience guard can see the program. */
    programCycleId: text("program_cycle_id").references(() => programCycles.id),
    state: text("state").notNull(),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    primaryKey({ columns: [t.userId, t.subjectKey] }),
    oneOf("requirement_progress_state_ck", t.state, REQUIREMENT_PROGRESS_STATES),
    check("requirement_progress_key_ck", sql`${t.subjectKey} GLOB 'req:*' OR ${t.subjectKey} GLOB 'kind:*'`),
  ],
);

/** Curated term-by-term templates (content written by people; body follows RoadmapTemplateSchema). */
export const roadmapTemplates = sqliteTable(
  "roadmap_templates",
  {
    key: text("key").primaryKey(),
    path: text("path").notNull(),
    body: json<RoadmapTemplate>("body").notNull(),
    isSample: flag("is_sample"),
    ...timestamps(),
  },
  (t) => [oneOf("roadmap_templates_path_ck", t.path, ["four_year", "two_year_transfer", "two_year_career"]), jsonObject("roadmap_templates_body_ck", t.body)],
);

/** Plans are computed on read; this keeps only what the student last saw. */
export const roadmaps = sqliteTable(
  "roadmaps",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    templateKey: text("template_key").references(() => roadmapTemplates.key),
    lastShownItemKeys: json<string[]>("last_shown_item_keys").notNull().default(emptyJsonArray),
    lastVisitAt: ms("last_visit_at"),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [jsonArray("roadmaps_keys_ck", t.lastShownItemKeys)],
);

/** The student's own actions on plan items (pin, dismiss, complete), by item key. */
export const roadmapItems = sqliteTable(
  "roadmap_items",
  {
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    itemKey: text("item_key").notNull(),
    programId: text("program_id").references(() => programs.id),
    pinned: flag("pinned"),
    state: text("state").notNull().default("open"),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [primaryKey({ columns: [t.userId, t.itemKey] }), oneOf("roadmap_items_state_ck", t.state, ["open", "done", "dismissed"])],
);

/**
 * What onboarding (/app/start) keeps per student: the quiz answers in the shared
 * ServerPreferences vocabulary, the resume signals the student confirmed (closed-vocabulary
 * MatchSignals) and the first door they chose. Never resume text, never a SensitiveAnswer, never
 * a match tier or score. Both JSON documents are re-validated with the shared zod schemas on read.
 */
export const onboardingRecords = sqliteTable(
  "onboarding_records",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    preferences: json<Record<string, unknown>>("preferences"),
    signals: json<Record<string, unknown>>("signals"),
    step: text("step"),
    completedAt: ms("completed_at"),
    /** { programId, programCycleId, trackerItemId, steps: [{ id, title, kind, minutes, due }] } */
    firstDoor: json<Record<string, unknown>>("first_door"),
    version: version(),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    check("onboarding_records_step_ck", sql`${t.step} IS NULL OR (length(${t.step}) BETWEEN 1 AND 40)`),
    check("onboarding_records_preferences_ck", sql`${t.preferences} IS NULL OR json_type(${t.preferences}) = 'object'`),
    check("onboarding_records_signals_ck", sql`${t.signals} IS NULL OR json_type(${t.signals}) = 'object'`),
    check("onboarding_records_first_door_ck", sql`${t.firstDoor} IS NULL OR json_type(${t.firstDoor}) = 'object'`),
  ],
);

export const REMINDER_KINDS = ["step_due", "intention", "submit_buffer"] as const;
export const REMINDER_STATES = ["scheduled", "sent", "cancelled"] as const;

/**
 * Dated reminders for a tracked application (first door's plan steps and the student's if-then
 * intention). Keyed per user so retries upsert. `neutral` reminders must not name the program
 * (identity- or status-defined audiences). The `reminders.schedule` job sends them.
 */
export const reminders = sqliteTable(
  "reminders",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    reminderKey: text("reminder_key").notNull(),
    trackerItemId: text("tracker_item_id")
      .notNull()
      .references(() => trackerItems.id),
    kind: text("kind").notNull(),
    stepId: text("step_id").notNull(),
    sendOn: day("send_on").notNull(),
    /** Local wall-clock time HH:MM in `time_zone`. */
    sendAt: text("send_at").notNull(),
    timeZone: text("time_zone").notNull(),
    neutral: flag("neutral"),
    state: text("state").notNull().default("scheduled"),
    sentAt: ms("sent_at"),
    ...timestamps(),
  },
  (t) => [
    uniqueIndex("reminders_user_key_uq").on(t.userId, t.reminderKey),
    index("reminders_due_idx").on(t.state, t.sendOn),
    index("reminders_tracker_idx").on(t.trackerItemId),
    oneOf("reminders_kind_ck", t.kind, REMINDER_KINDS),
    oneOf("reminders_state_ck", t.state, REMINDER_STATES),
    check("reminders_send_on_ck", sql`${t.sendOn} GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'`),
    check("reminders_send_at_ck", sql`${t.sendAt} GLOB '[0-2][0-9]:[0-5][0-9]'`),
  ],
);

// =============================================================================================
// Consents, contacts, subscriptions and notifications
// =============================================================================================

export const consentTexts = sqliteTable(
  "consent_texts",
  {
    version: text("version").primaryKey(),
    kind: text("kind").notNull(),
    locale: text("locale").notNull().default("en"),
    textSha256: text("text_sha256").notNull(),
    publishedAt: ms("published_at").notNull(),
  },
  (t) => [oneOf("consent_texts_kind_ck", t.kind, CONSENT_KINDS)],
);

/** Email-only Remind-me recipients (before an account exists). */
export const contacts = sqliteTable(
  "contacts",
  {
    id: pk(),
    email: text("email").notNull(),
    /** Keyed HMAC of the normalized address, with its key id, for lookups and suppression. */
    emailHmac: text("email_hmac").notNull(),
    hmacKeyId: text("hmac_key_id").notNull(),
    confirmedAt: ms("confirmed_at"),
    userId: text("user_id").references(() => users.id),
    /**
     * Minor mode (s01 F-04/F-08, s09 9.10.2): set from the Remind-me age screen for ages 16-17 to
     * the first instant the visitor can be 18. While it is in the future the address gets no
     * Promotions, no weekly-email extras and no analytics. The birth month itself is not stored.
     */
    minorUntil: ms("minor_until"),
    deleteAfter: ms("delete_after"),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex("contacts_hmac_uq").on(t.emailHmac, t.hmacKeyId), index("contacts_delete_idx").on(t.deleteAfter)],
);

export const consents = sqliteTable(
  "consents",
  {
    id: pk(),
    userId: text("user_id").references(() => users.id),
    contactId: text("contact_id").references(() => contacts.id),
    kind: text("kind").notNull(),
    /** A program for per-item tracking consents, a Cohort for advisor scope; null when account-wide. */
    scopeType: text("scope_type"),
    scopeId: text("scope_id"),
    textVersion: text("text_version")
      .notNull()
      .references(() => consentTexts.version),
    method: text("method").notNull(),
    grantedAt: ms("granted_at").notNull(),
    revokedAt: ms("revoked_at"),
  },
  (t) => [
    exactlyOne("consents_subject_ck", t.userId, t.contactId),
    oneOf("consents_kind_ck", t.kind, CONSENT_KINDS),
    oneOf("consents_method_ck", t.method, ["dialog", "email_link"]),
    oneOfOrNull("consents_scope_type_ck", t.scopeType, ["program", "cohort"]),
    // consents_live_uq (one live decision per subject, kind and scope) lives in the guards migration.
    index("consents_user_idx").on(t.userId, t.kind),
  ],
);

export const subscriptions = sqliteTable(
  "subscriptions",
  {
    id: pk(),
    userId: text("user_id").references(() => users.id),
    contactId: text("contact_id").references(() => contacts.id),
    kind: text("kind").notNull(),
    programCycleId: text("program_cycle_id").references(() => programCycles.id),
    nameInMessages: flag("name_in_messages", true),
    // Saved-filter facets arrive with the saved_filter kind (later phase) as typed columns, never free JSON.
    deleteAfter: ms("delete_after"),
    createdAt: createdAt(),
  },
  (t) => [
    exactlyOne("subscriptions_subject_ck", t.userId, t.contactId),
    oneOf("subscriptions_kind_ck", t.kind, SUBSCRIPTION_KINDS),
    // subscriptions_uq (expression index) lives in the guards migration.
    index("subscriptions_user_idx").on(t.userId),
    index("subscriptions_cycle_idx").on(t.programCycleId),
  ],
);

export const emailSuppressions = sqliteTable(
  "email_suppressions",
  {
    emailHmac: text("email_hmac").notNull(),
    keyId: text("key_id").notNull(),
    reason: text("reason").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.emailHmac, t.keyId] }), oneOf("email_suppressions_reason_ck", t.reason, ["unsubscribe", "bounce", "complaint", "manual"])],
);

export const alerts = sqliteTable(
  "alerts",
  {
    id: pk(),
    type: text("type").notNull(),
    userId: text("user_id").references(() => users.id),
    contactId: text("contact_id").references(() => contacts.id),
    /** `u:{userId}` or `c:{contactId}`; non-null so NULLs cannot defeat the dedupe index. */
    recipientKey: text("recipient_key").notNull(),
    programCycleId: text("program_cycle_id").references(() => programCycles.id),
    changeEventId: text("change_event_id").references(() => changeEvents.id),
    dedupeKey: text("dedupe_key").notNull(),
    priority: text("priority").notNull().default("p1"),
    title: text("title").notNull(),
    body: text("body").notNull(),
    href: text("href"),
    scheduledFor: ms("scheduled_for").notNull(),
    readAt: ms("read_at"),
    createdAt: createdAt(),
  },
  (t) => [
    exactlyOne("alerts_recipient_ck", t.userId, t.contactId),
    check(
      "alerts_recipient_key_ck",
      sql`${t.recipientKey} = CASE WHEN ${t.userId} IS NOT NULL THEN 'u:' || ${t.userId} ELSE 'c:' || ${t.contactId} END`,
    ),
    oneOf("alerts_type_ck", t.type, ALERT_TYPES),
    oneOf("alerts_priority_ck", t.priority, ALERT_PRIORITIES),
    uniqueIndex("alerts_dedupe_uq").on(t.recipientKey, t.dedupeKey),
    index("alerts_inbox_idx").on(t.userId, t.createdAt),
    index("alerts_cycle_idx").on(t.programCycleId),
  ],
);

export const notifications = sqliteTable(
  "notifications",
  {
    id: pk(),
    alertId: text("alert_id")
      .notNull()
      .references(() => alerts.id),
    channel: text("channel").notNull(),
    stream: text("stream").notNull().default("transactional"),
    /** `notif:{alertId}:{channel}` */
    idempotencyKey: text("idempotency_key").notNull().unique(),
    state: text("state").notNull().default("queued"),
    expiresAt: ms("expires_at").notNull(),
    sentAt: ms("sent_at"),
    attempts: integer("attempts").notNull().default(0),
    /** Error class only, never a provider payload. */
    lastError: text("last_error"),
    ...timestamps(),
  },
  (t) => [
    oneOf("notifications_channel_ck", t.channel, NOTIFICATION_CHANNELS),
    oneOf("notifications_stream_ck", t.stream, NOTIFICATION_STREAMS),
    oneOf("notifications_state_ck", t.state, NOTIFICATION_STATES),
    index("notifications_queue_idx").on(t.state, t.createdAt).where(sql`${t.state} = 'queued'`),
    index("notifications_alert_idx").on(t.alertId),
  ],
);

export const notificationPrefs = sqliteTable(
  "notification_prefs",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    weeklyEmail: flag("weekly_email", true),
    weeklyDay: integer("weekly_day"),
    quietHoursStart: text("quiet_hours_start").notNull().default("22:00"),
    quietHoursEnd: text("quiet_hours_end").notNull().default("08:00"),
    examPauseUntil: day("exam_pause_until"),
    channelEmail: flag("channel_email", true),
    channelInApp: flag("channel_in_app", true),
    channelPush: flag("channel_push"),
    updatedAt: updatedAt(),
  },
  (t) => [check("notification_prefs_day_ck", sql`${t.weeklyDay} IS NULL OR ${t.weeklyDay} BETWEEN 1 AND 7`)],
);

/** Hashed, rotatable, revocable ICS feed tokens. */
export const calendarFeeds = sqliteTable(
  "calendar_feeds",
  {
    id: pk(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    tokenHash: text("token_hash").notNull().unique(),
    neutralTitles: flag("neutral_titles"),
    createdAt: createdAt(),
    revokedAt: ms("revoked_at"),
  },
  (t) => [index("calendar_feeds_user_idx").on(t.userId)],
);

/** Single-use links from emails for one TrackerItem and action, expiring at the deadline. */
export const emailActionTokens = sqliteTable(
  "email_action_tokens",
  {
    tokenHash: text("token_hash").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    trackerItemId: text("tracker_item_id")
      .notNull()
      .references(() => trackerItems.id),
    action: text("action").notNull(),
    expiresAt: ms("expires_at").notNull(),
    usedAt: ms("used_at"),
    createdAt: createdAt(),
  },
  (t) => [oneOf("email_action_tokens_action_ck", t.action, ["mark_submitted", "not_applying", "snooze"]), index("email_action_tokens_expires_idx").on(t.expiresAt)],
);

// =============================================================================================
// Advisor pilot kit (tenant: workspace)
// =============================================================================================

export const advisorWorkspaces = sqliteTable(
  "advisor_workspaces",
  {
    id: pk(),
    name: text("name").notNull(),
    institutionId: text("institution_id").references(() => institutions.id),
    kind: text("kind").notNull().default("concierge_pilot"),
    approvedBy: text("approved_by"),
    approvedAt: ms("approved_at"),
    isSample: flag("is_sample"),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    oneOf("advisor_workspaces_kind_ck", t.kind, ["concierge_pilot", "self_service"]),
    check("advisor_workspaces_approval_ck", sql`(${t.approvedBy} IS NULL) = (${t.approvedAt} IS NULL)`),
  ],
);

export const programLists = sqliteTable(
  "program_lists",
  {
    id: pk(),
    ownerKind: text("owner_kind").notNull().default("workspace"),
    workspaceId: text("workspace_id").references(() => advisorWorkspaces.id),
    title: text("title").notNull(),
    description: text("description"),
    visibility: text("visibility").notNull().default("unlisted"),
    slug: text("slug").unique(),
    /** Unlisted lists: a 128-bit random token. */
    token: text("token").unique(),
    /** Derived: the list holds a sensitive- or identity-audience program. */
    restricted: flag("restricted"),
    version: version(),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    oneOf("program_lists_owner_ck", t.ownerKind, ["workspace", "partner", "novus"]),
    oneOf("program_lists_visibility_ck", t.visibility, ["public", "unlisted"]),
    check("program_lists_owner_ws_ck", sql`(${t.ownerKind} = 'workspace') = (${t.workspaceId} IS NOT NULL)`),
    check("program_lists_public_ck", sql`${t.visibility} <> 'public' OR ${t.slug} IS NOT NULL`),
    check("program_lists_unlisted_ck", sql`${t.visibility} <> 'unlisted' OR ${t.token} IS NOT NULL`),
    index("program_lists_ws_idx").on(t.workspaceId),
  ],
);

export const programListItems = sqliteTable(
  "program_list_items",
  {
    listId: text("list_id")
      .notNull()
      .references(() => programLists.id),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    cycleKey: text("cycle_key"),
    note: text("note"),
    position: integer("position").notNull(),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.listId, t.programId] }), check("program_list_items_note_ck", sql`${t.note} IS NULL OR length(${t.note}) <= 500`)],
);

export const attributionCodes = sqliteTable(
  "attribution_codes",
  {
    id: pk(),
    /** 10+ random characters, never a UUIDv7. */
    code: text("code").notNull().unique(),
    kind: text("kind").notNull(),
    workspaceId: text("workspace_id").references(() => advisorWorkspaces.id),
    /** The owner implies a protected trait: counts only, never stored per person. */
    identityOwned: flag("identity_owned"),
    expiresAt: ms("expires_at"),
    revokedAt: ms("revoked_at"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("attribution_codes_kind_ck", t.kind, ["advisor_pilot", "ambassador", "partner", "creator"]),
    check("attribution_codes_len_ck", sql`length(${t.code}) >= 10`),
  ],
);

export const shortLinks = sqliteTable("short_links", {
  slug: text("slug").primaryKey(),
  targetPath: text("target_path").notNull(),
  campaignId: text("campaign_id"),
  createdAt: createdAt(),
});

// =============================================================================================
// Outcomes (self-reported; read only as aggregates with n >= 5)
// =============================================================================================

export const outcomes = sqliteTable(
  "outcomes",
  {
    id: pk(),
    publicId: text("public_id")
      .notNull()
      .unique()
      .$defaultFn(() => newPublicId()),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    tier: text("tier").notNull().default("self_reported"),
    /** No `pending`: null means undecided. */
    decision: text("decision"),
    decidedOn: day("decided_on"),
    // Snapshot at report time: non-sensitive context only.
    classYear: text("class_year"),
    gpaBand: text("gpa_band"),
    majorFamily: text("major_family"),
    institutionType: text("institution_type"),
    priorFeeder: text("prior_feeder"),
    /** Set only from a live institution-email verification. */
    institutionId: text("institution_id").references(() => institutions.id),
    qualityState: text("quality_state").notNull().default("ok"),
    flagCodes: json<string[]>("flag_codes").notNull().default(emptyJsonArray),
    version: version(),
    ...timestamps(),
    deletedAt: ms("deleted_at"),
  },
  (t) => [
    uniqueIndex("outcomes_user_cycle_uq").on(t.userId, t.programCycleId),
    index("outcomes_cycle_idx").on(t.programCycleId).where(sql`${t.deletedAt} IS NULL`),
    oneOf("outcomes_tier_ck", t.tier, OUTCOME_TIERS),
    oneOfOrNull("outcomes_decision_ck", t.decision, OUTCOME_DECISIONS),
    oneOfOrNull("outcomes_class_year_ck", t.classYear, CLASS_YEARS),
    oneOfOrNull("outcomes_gpa_band_ck", t.gpaBand, GPA_BANDS),
    oneOfOrNull("outcomes_major_family_ck", t.majorFamily, MAJOR_FAMILIES),
    oneOfOrNull("outcomes_institution_type_ck", t.institutionType, INSTITUTION_LEVELS),
    oneOfOrNull("outcomes_prior_feeder_ck", t.priorFeeder, ["yes", "no"]),
    oneOf("outcomes_quality_ck", t.qualityState, ["ok", "flagged"]),
    jsonArray("outcomes_flags_ck", t.flagCodes),
  ],
);

export const outcomeStages = sqliteTable(
  "outcome_stages",
  {
    outcomeId: text("outcome_id")
      .notNull()
      .references(() => outcomes.id),
    stage: text("stage").notNull(),
    onDate: day("on_date"),
    createdAt: createdAt(),
  },
  (t) => [primaryKey({ columns: [t.outcomeId, t.stage] }), oneOf("outcome_stages_stage_ck", t.stage, OUTCOME_STAGES)],
);

/**
 * A hold freezes one cycle's Outcome-derived output (plan 7.9.1): the public summary releases
 * nothing for it and readiness shows no personal band for its program. `outcomes.quality` opens
 * an `over_count` hold; resolving the outcome_anomaly task releases it. At most one live hold
 * per cycle and reason; released rows are kept as history.
 */
export const OUTCOME_HOLD_REASONS = ["over_count", "curator"] as const;

export const outcomeCycleHolds = sqliteTable(
  "outcome_cycle_holds",
  {
    id: pk(),
    programCycleId: text("program_cycle_id")
      .notNull()
      .references(() => programCycles.id),
    reason: text("reason").notNull(),
    /** The outcome_anomaly task that opened or tracks the hold, when there is one. */
    reviewTaskId: text("review_task_id").references(() => reviewTasks.id),
    frozenAt: ms("frozen_at").notNull(),
    releasedAt: ms("released_at"),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex("outcome_cycle_holds_live_uq")
      .on(t.programCycleId, t.reason)
      .where(sql`${t.releasedAt} IS NULL`),
    index("outcome_cycle_holds_cycle_idx").on(t.programCycleId),
    oneOf("outcome_cycle_holds_reason_ck", t.reason, OUTCOME_HOLD_REASONS),
    check("outcome_cycle_holds_order_ck", sql`${t.releasedAt} IS NULL OR ${t.releasedAt} >= ${t.frozenAt}`),
  ],
);

// =============================================================================================
// Personal competitiveness band models (plan 7.5.5, Phase 4; shared/readiness/bands-store)
// =============================================================================================

/**
 * `bands.fit` output, one row per program the model covers: indexed gate columns plus the
 * model sliced to that program (coefficients, covariances, pooled cell counts and this
 * program's centre and counts). No Outcome row, account, report date or feature value of a
 * person is stored. Readiness re-checks every gate, approval, freshness and holds at read time.
 * A refit supersedes the live rows of its model key; superseded rows are kept as history.
 */
export const bandModels = sqliteTable(
  "band_models",
  {
    id: pk(),
    /** `{type}.{from}-{to}`, the key approval tasks name. */
    modelKey: text("model_key").notNull(),
    programId: text("program_id")
      .notNull()
      .references(() => programs.id),
    opportunityType: text("opportunity_type").notNull(),
    fromStage: text("from_stage").notNull(),
    toStage: text("to_stage").notNull(),
    modelVersion: text("model_version").notNull(),
    algo: text("algo").notNull(),
    fittedOn: day("fitted_on").notNull(),
    gatePooled: flag("gate_pooled"),
    gateHeldOut: text("gate_held_out").notNull(),
    gateRepresentativeness: flag("gate_representativeness"),
    gateFairness: flag("gate_fairness"),
    gateUsefulness: flag("gate_usefulness"),
    /** Approval as recorded at fit time; readiness checks the live approval task instead. */
    gateApproved: flag("gate_approved"),
    programEligible: flag("program_eligible"),
    nEff: real("n_eff").notNull(),
    passReports: integer("pass_reports").notNull(),
    failReports: integer("fail_reports").notNull(),
    model: json<Record<string, unknown>>("model").notNull(),
    createdAt: createdAt(),
    supersededAt: ms("superseded_at"),
  },
  (t) => [
    uniqueIndex("band_models_live_uq")
      .on(t.modelKey, t.programId)
      .where(sql`${t.supersededAt} IS NULL`),
    index("band_models_program_idx")
      .on(t.programId)
      .where(sql`${t.supersededAt} IS NULL`),
    oneOf("band_models_from_ck", t.fromStage, COUNT_STAGES),
    oneOf("band_models_to_ck", t.toStage, COUNT_STAGES),
    oneOf("band_models_held_out_ck", t.gateHeldOut, ["pass", "fail_skill", "fail_calibration", "not_evaluated"]),
    check("band_models_counts_ck", sql`${t.nEff} >= 0 AND ${t.passReports} >= 0 AND ${t.failReports} >= 0`),
    check("band_models_fitted_ck", sql`${t.fittedOn} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    jsonObject("band_models_model_ck", t.model),
  ],
);

// =============================================================================================
// Operations: jobs, nonces, flags, config
// =============================================================================================

/** The database is the queue (architecture 2.3.7). Payloads hold opaque ids only. */
export const jobs = sqliteTable(
  "jobs",
  {
    id: pk(),
    kind: text("kind").notNull(),
    payload: json<Record<string, unknown>>("payload").notNull().default(sql`'{}'`),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    concurrencyKey: text("concurrency_key"),
    status: text("status").notNull().default("pending"),
    priority: integer("priority").notNull().default(5),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(8),
    runAfter: ms("run_after").notNull(),
    leaseOwner: text("lease_owner"),
    leaseExpiresAt: ms("lease_expires_at"),
    /** Error class only, never a stack trace or user data. */
    lastError: text("last_error"),
    finishedAt: ms("finished_at"),
    ...timestamps(),
  },
  (t) => [
    oneOf("jobs_status_ck", t.status, JOB_STATUSES),
    jsonObject("jobs_payload_ck", t.payload),
    check("jobs_priority_ck", sql`${t.priority} BETWEEN 0 AND 9`),
    index("jobs_due_idx").on(t.status, t.kind, t.priority, t.runAfter),
    index("jobs_concurrency_idx").on(t.concurrencyKey, t.status).where(sql`${t.concurrencyKey} IS NOT NULL`),
  ],
);

export const jobRuns = sqliteTable(
  "job_runs",
  {
    id: pk(),
    jobId: text("job_id").references(() => jobs.id),
    kind: text("kind").notNull(),
    trigger: text("trigger").notNull(),
    startedAt: ms("started_at").notNull(),
    finishedAt: ms("finished_at"),
    outcome: text("outcome"),
    processed: integer("processed").notNull().default(0),
    errorClass: text("error_class"),
  },
  (t) => [
    oneOf("job_runs_trigger_ck", t.trigger, ["tick", "hourly", "daily", "lease", "request", "catch_up", "manual"]),
    oneOfOrNull("job_runs_outcome_ck", t.outcome, ["ok", "partial", "failed", "deferred"]),
    index("job_runs_kind_idx").on(t.kind, t.startedAt),
  ],
);

/** Liveness of each clock and worker (`tick`, `modal`); the tick alerts on stale rows. */
export const heartbeats = sqliteTable("heartbeats", {
  name: text("name").primaryKey(),
  lastSeenAt: ms("last_seen_at").notNull(),
  detail: json<Record<string, unknown>>("detail"),
});

/** Replay protection for HMAC-signed internal requests; inserted in the batch it protects. */
export const internalNonces = sqliteTable(
  "internal_nonces",
  {
    nonce: text("nonce").primaryKey(),
    keyId: text("key_id").notNull(),
    expiresAt: ms("expires_at").notNull(),
  },
  (t) => [index("internal_nonces_expires_idx").on(t.expiresAt)],
);

export const flags = sqliteTable("flags", {
  key: text("key").primaryKey(),
  enabled: flag("enabled"),
  note: text("note"),
  updatedAt: updatedAt(),
});

/** Private anti-abuse thresholds; never seeded from the public repository. */
export const config = sqliteTable("config", {
  key: text("key").primaryKey(),
  value: json<unknown>("value").notNull(),
  updatedAt: updatedAt(),
});

// ---- Staff second factors (server/auth/second-factor.ts) --------------------------------------
// No cascades (the schema rule): students.purgeUser deletes these rows before the user. The
// session proof has no foreign key to sessions, because Better Auth deletes sessions on sign-out
// without knowing this table exists; an orphaned proof names a session id that can never come
// back and is swept at its expiry (sweepSecondFactorProofs).

/** One TOTP authenticator per staff user. */
export const staffSecondFactors = sqliteTable(
  "staff_second_factors",
  {
    userId: text("user_id")
      .primaryKey()
      .references(() => users.id),
    /** The base32 TOTP secret, AES-GCM encrypted with a key derived from BETTER_AUTH_SECRET. */
    secretEnc: text("secret_enc").notNull(),
    /** Null while enrollment waits for the first correct code. */
    confirmedAt: integer("confirmed_at"),
    /** The last accepted TOTP step; a code at or before it is a replay. */
    lastUsedStep: integer("last_used_step"),
    failedCount: integer("failed_count").notNull().default(0),
    lockedUntil: integer("locked_until"),
    /** HMAC-SHA-256 hex of each unused recovery code; a used code is removed. */
    recoveryCodeHashes: text("recovery_code_hashes", { mode: "json" }).$type<string[]>().notNull(),
    createdAt: integer("created_at").notNull(),
    updatedAt: integer("updated_at").notNull(),
  },
  (t) => [
    check(
      "staff_second_factors_codes_ck",
      sql`json_valid(${t.recoveryCodeHashes}) AND json_type(${t.recoveryCodeHashes}) = 'array'`,
    ),
  ],
);

/** A session that passed the second factor; staff routes require a live row for their session. */
export const sessionSecondFactors = sqliteTable(
  "session_second_factors",
  {
    /** A Better Auth session id; deliberately not a foreign key (see above). */
    sessionId: text("session_id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    method: text("method").notNull(),
    verifiedAt: integer("verified_at").notNull(),
    expiresAt: integer("expires_at").notNull(),
  },
  (t) => [
    check("session_second_factors_method_ck", sql`${t.method} IN ('totp', 'recovery_code')`),
    index("session_second_factors_user_idx").on(t.userId),
    index("session_second_factors_expires_idx").on(t.expiresAt),
  ],
);

/** Every table, for getDb's typed client and Better Auth's adapter. */
export const authSchema = { users, sessions, accounts, verifications, rateLimits } as const;
