import { z } from "zod";

/**
 * Registry enums. Values are lowercase snake_case so they pass the schema's CHECK builder.
 * Growing enums on referenced tables are lookup rows seeded from these lists; closed sets are CHECKs.
 */

const e = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values);

export const RECURRENCES = ["annual", "biannual", "rolling", "one_time", "irregular"] as const;
export const RecurrenceSchema = e(RECURRENCES);
export type Recurrence = z.infer<typeof RecurrenceSchema>;

export const LIFECYCLES = ["active", "paused", "ended", "merged"] as const;
export const LifecycleSchema = e(LIFECYCLES);
export type Lifecycle = z.infer<typeof LifecycleSchema>;

export const CYCLE_STATUSES = ["expected", "open", "closed", "paused", "ended", "relaunched"] as const;
export const CycleStatusSchema = e(CYCLE_STATUSES);
export type CycleStatus = z.infer<typeof CycleStatusSchema>;

/** Allowed cycle transitions (the state machine in the data model). Only open -> closed is automatic. */
export const CYCLE_TRANSITIONS: Readonly<Record<CycleStatus, readonly CycleStatus[]>> = {
  expected: ["open", "paused", "ended"],
  open: ["paused", "closed"],
  closed: ["open"],
  paused: ["open", "relaunched"],
  relaunched: ["open"],
  ended: [],
};

export function canTransitionCycle(from: CycleStatus, to: CycleStatus): boolean {
  return CYCLE_TRANSITIONS[from].includes(to);
}

export const CYCLE_MODELS = ["term", "rolling", "event", "round_based"] as const;
export const CycleModelSchema = e(CYCLE_MODELS);
export type CycleModel = z.infer<typeof CycleModelSchema>;

export const DEADLINE_KINDS = [
  "application",
  "campus_internal",
  "nomination",
  "priority_round",
  "recommendation",
  "supplemental",
  "interest_form",
  "decision_expected",
  "program_start",
] as const;
export const DeadlineKindSchema = e(DEADLINE_KINDS);
export type DeadlineKind = z.infer<typeof DeadlineKindSchema>;

/**
 * Deadline kinds that close national submission. Nomination-gated programs publish their
 * national date as a `nomination` row, so it counts alongside `application`. Eligibility's
 * national_deadline anchor and readiness's final national deadline both use this set, so the
 * date a rule is judged at and the date a plan counts back from cannot disagree.
 */
export const NATIONAL_SUBMISSION_KINDS: ReadonlySet<DeadlineKind> = new Set<DeadlineKind>(["application", "nomination"]);

export const DEADLINE_SCOPES = ["national", "campus"] as const;
export const DeadlineScopeSchema = e(DEADLINE_SCOPES);
export type DeadlineScope = z.infer<typeof DeadlineScopeSchema>;

export const DEADLINE_BASES = ["official", "attested", "predicted"] as const;
export const DeadlineBasisSchema = e(DEADLINE_BASES);
export type DeadlineBasis = z.infer<typeof DeadlineBasisSchema>;

export const DEADLINE_PRECISIONS = ["exact", "date_only", "month_only", "window", "rolling", "tbd"] as const;
export const DeadlinePrecisionSchema = e(DEADLINE_PRECISIONS);
export type DeadlinePrecision = z.infer<typeof DeadlinePrecisionSchema>;

export const TZ_MODES = ["fixed", "applicant_local"] as const;
export const TzModeSchema = e(TZ_MODES);
export type TzMode = z.infer<typeof TzModeSchema>;

export const TZ_SOURCES = ["stated", "org_default"] as const;
export const TzSourceSchema = e(TZ_SOURCES);
export type TzSource = z.infer<typeof TzSourceSchema>;

/** Stored verification states; `stale` is derived at read time (shared/time). */
export const VERIFICATION_STORED = ["draft", "verified", "reverifying", "unverified"] as const;
export const VerificationStoredSchema = e(VERIFICATION_STORED);
export type VerificationStored = z.infer<typeof VerificationStoredSchema>;

export const VERIFICATION_DISPLAY = ["draft", "verified", "reverifying", "stale", "unverified"] as const;
export const VerificationDisplaySchema = e(VERIFICATION_DISPLAY);
export type VerificationDisplay = z.infer<typeof VerificationDisplaySchema>;

export const FRESHNESS = ["fresh", "aging", "stale"] as const;
export const FreshnessSchema = e(FRESHNESS);
export type Freshness = z.infer<typeof FreshnessSchema>;

export const PELL_DISPLACEMENT = ["none", "possible", "yes", "unknown"] as const;
export const PellDisplacementSchema = e(PELL_DISPLACEMENT);
export type PellDisplacement = z.infer<typeof PellDisplacementSchema>;

export const PREDICTION_LABELS = ["low", "medium", "high"] as const;
export const PredictionLabelSchema = e(PREDICTION_LABELS);
export type PredictionLabel = z.infer<typeof PredictionLabelSchema>;

/** Requirement kinds (the readiness section owns the list; the taxonomy hosts it). */
export const REQUIREMENT_KINDS = [
  "recommendation",
  "essay",
  "campus_nomination",
  "test_score",
  "portfolio",
  "resume",
  "transcript",
  "interview",
  "fee",
  "coursework",
  "gpa_floor",
  "other",
] as const;
export const RequirementKindSchema = e(REQUIREMENT_KINDS);
export type RequirementKind = z.infer<typeof RequirementKindSchema>;

export const NOMINATORS = ["campus_rep", "faculty_rep", "department"] as const;
export const NominatorSchema = e(NOMINATORS);
export type Nominator = z.infer<typeof NominatorSchema>;

export const SOURCE_KINDS = [
  "official_page",
  "official_pdf",
  "federal_api",
  "ats_board",
  "list_row",
  "campus_page",
  "hint",
  "licensed",
] as const;
export const SourceKindSchema = e(SOURCE_KINDS);
export type SourceKind = z.infer<typeof SourceKindSchema>;

export const EVIDENCE_ENTITIES = [
  "program",
  "program_cycle",
  "deadline",
  "requirement",
  "eligibility_rule_set",
  "program_cycle_count",
  "institution_participation",
  "organization",
  "official_domain",
] as const;
export const EvidenceEntitySchema = e(EVIDENCE_ENTITIES);
export type EvidenceEntity = z.infer<typeof EvidenceEntitySchema>;

export const EVIDENCE_BASES = ["snapshot", "attestation", "api_record", "manual_note"] as const;
export const EvidenceBasisSchema = e(EVIDENCE_BASES);
export type EvidenceBasis = z.infer<typeof EvidenceBasisSchema>;

export const EVIDENCE_MATCHES = ["exact", "aligned", "manual"] as const;
export const EvidenceMatchSchema = e(EVIDENCE_MATCHES);
export type EvidenceMatch = z.infer<typeof EvidenceMatchSchema>;

export const HOST_POLICIES = ["allowed", "api_only", "manual_only", "link_only", "never"] as const;
export const HostPolicySchema = e(HOST_POLICIES);
export type HostPolicy = z.infer<typeof HostPolicySchema>;

export const ORGANIZATION_KINDS = [
  "federal_agency",
  "state_agency",
  "foundation",
  "nonprofit",
  "company",
  "university",
  "national_lab",
  "professional_society",
  "other",
] as const;
export const OrganizationKindSchema = e(ORGANIZATION_KINDS);
export type OrganizationKind = z.infer<typeof OrganizationKindSchema>;

export const ROLES = ["student", "advisor", "sponsor_admin", "curator", "moderator", "admin"] as const;
export const RoleSchema = e(ROLES);
export type Role = z.infer<typeof RoleSchema>;

export const SUBSCRIPTION_KINDS = ["remind_me", "tracked_cycle", "saved_filter", "weekly_digest"] as const;
export const SubscriptionKindSchema = e(SUBSCRIPTION_KINDS);
export type SubscriptionKind = z.infer<typeof SubscriptionKindSchema>;

export const CONSENT_KINDS = [
  "sensitive_tracking",
  "identity_tracking",
  "health_tracking",
  "analytics",
  "minor_outcomes",
  "advisor_scope",
  "derived_results",
  "school_email_alerts",
] as const;
export const ConsentKindSchema = e(CONSENT_KINDS);
export type ConsentKind = z.infer<typeof ConsentKindSchema>;

export const OUTCOME_TIERS = [
  "self_reported",
  "institution_email",
  "letter_checked",
  "email_authenticated",
  "official_list",
] as const;
export const OutcomeTierSchema = e(OUTCOME_TIERS);
export type OutcomeTier = z.infer<typeof OutcomeTierSchema>;

export const OUTCOME_STAGES = [
  "submitted",
  "campus_nominated",
  "not_nominated",
  "interview_invited",
  "interviewed",
  "waitlisted",
] as const;
export const OutcomeStageSchema = e(OUTCOME_STAGES);
export type OutcomeStage = z.infer<typeof OutcomeStageSchema>;

/** No `pending`: a missing decision means undecided. */
export const OUTCOME_DECISIONS = ["accepted", "rejected", "withdrew", "declined_offer", "no_response"] as const;
export const OutcomeDecisionSchema = e(OUTCOME_DECISIONS);
export type OutcomeDecision = z.infer<typeof OutcomeDecisionSchema>;

export const COUNT_STAGES = ["campus_applicants", "applicants", "nominees", "finalists", "awards", "alternates"] as const;
export const CountStageSchema = e(COUNT_STAGES);
export type CountStage = z.infer<typeof CountStageSchema>;

export const COUNT_KINDS = ["exact", "lower_bound", "approx"] as const;
export const CountKindSchema = e(COUNT_KINDS);
export type CountKind = z.infer<typeof CountKindSchema>;

export const TRACKER_STATUSES = ["interested", "applying", "submitted", "decided", "not_applying"] as const;
export const TrackerStatusSchema = e(TRACKER_STATUSES);
export type TrackerStatus = z.infer<typeof TrackerStatusSchema>;

export const REVIEW_TASK_KINDS = [
  "new_program",
  "cycle_update",
  "reconfirm",
  "rollover",
  "posting_match",
  "possible_duplicate",
  "error_report",
  "community_hint",
  "source_broken",
  "extraction_failed",
  "scam_flag",
  "overdue_opening",
  "counts_table",
  "outcome_anomaly",
  "relation_proposal",
  "band_model_approval",
  "campus_deadline",
  "sponsor_claim",
  "owner_update",
  "promotion_copy",
  "resource_link",
] as const;
export const ReviewTaskKindSchema = e(REVIEW_TASK_KINDS);
export type ReviewTaskKind = z.infer<typeof ReviewTaskKindSchema>;

export const REVIEW_TASK_STATES = [
  "open",
  "claimed",
  "second_review",
  "approved",
  "applied",
  "apply_failed",
  "rejected",
  "snoozed",
  "escalated",
] as const;
export const ReviewTaskStateSchema = e(REVIEW_TASK_STATES);
export type ReviewTaskState = z.infer<typeof ReviewTaskStateSchema>;
