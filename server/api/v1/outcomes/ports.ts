import type { Context, MiddlewareHandler } from "hono";
import type { AppEnv } from "@server/env";
import type { OutcomeReport, OutcomeReportCreate, OutcomeReportUpdate } from "@shared/contracts/advisor";
import type { StudentProfile } from "@shared/contracts/student";
import type { ConsentKind, OutcomeTier } from "@shared/taxonomy";
import type { BandGateFlags, OutcomePrivateConfig, SummaryReport } from "@shared/readiness/outcomes";

/**
 * Ports for the Outcome routes. The routes depend on these interfaces only, so they are tested
 * with an in-memory store and bound to D1 in wiring.ts. Internal ids (user, outcome) never leave
 * the store except as opaque keys; responses carry public ids only.
 */

/** Curated facts about one cycle that the validators and audience rules read. */
export interface OutcomeCycleFacts {
  readonly programCycleId: string;
  readonly cycleKey: string;
  readonly programId: string;
  readonly programSlug: string;
  readonly organizationId: string;
  /** Status-defined programs collect no Outcomes (s09 N3): the route answers 404. */
  readonly sensitiveAudience: boolean;
  /** Identity-defined programs need a live identity_tracking consent (s09 N4). */
  readonly identityAudience: boolean;
  readonly decisionWindowStart: string | null;
  readonly decisionWindowEnd: string | null;
  readonly classYears: readonly string[];
  readonly rollingDecisions: boolean;
  readonly nominationRequired: boolean;
  /** Earliest national application or priority-round date (the round fallback). */
  readonly earliestRoundDeadline: string | null;
}

export interface OwnTracking {
  readonly status: string;
  readonly submittedOn: string | null;
}

export interface OutcomeWrite {
  readonly input: OutcomeReportCreate;
  readonly tier: OutcomeTier;
  readonly flags: readonly string[];
}

export type WriteResult = { ok: true; value: OutcomeReport } | { ok: false; error: "conflict" | "not_found" | "consent_required" | "invalid" };

export interface OwnOutcome {
  readonly report: OutcomeReport;
  /** Flag codes stay server-side; a re-validated edit keeps a Curator's earlier codes. */
  readonly flagCodes: readonly string[];
}

export interface SummaryProgram {
  readonly programId: string;
  readonly slug: string;
  readonly sensitiveAudience: boolean;
  readonly isSample: boolean;
  /** Most recent cycles first. */
  readonly cycles: readonly { readonly id: string; readonly cycleKey: string }[];
}

export interface OutcomesStore {
  cycleFacts(programCycleId: string): Promise<OutcomeCycleFacts | null>;
  tracking(userId: string, programCycleId: string): Promise<OwnTracking | null>;
  profile(userId: string): Promise<StudentProfile | null>;
  hasConsent(userId: string, kind: ConsentKind, scopeId?: string | null): Promise<boolean>;
  /** True when the user holds a live sponsor role for the program's Organization (s09 9.8). */
  sponsorAffiliated(userId: string, organizationId: string): Promise<boolean>;
  /** Highest verified tier for this account; `self_reported` until edu verification exists. */
  verifiedTier(userId: string): Promise<OutcomeTier>;
  /** The account's other live reports created on or after `since` (season start). */
  otherReportsSince(userId: string, excludingCycleId: string, sinceMs: number): Promise<number>;
  privateConfig(): Promise<OutcomePrivateConfig>;

  listOwn(userId: string): Promise<OutcomeReport[]>;
  getOwn(userId: string, publicId: string): Promise<OwnOutcome | null>;
  create(userId: string, write: OutcomeWrite, profile: StudentProfile | null, now: number): Promise<WriteResult>;
  update(userId: string, publicId: string, patch: OutcomeReportUpdate, flags: readonly string[], now: number): Promise<WriteResult>;
  /** access_audit: changed field NAMES only, under a pseudonymous subject key. */
  auditEdit(userId: string, fields: readonly string[], now: number, requestId: string | null): Promise<void>;

  summaryProgram(slug: string): Promise<SummaryProgram | null>;
  /** Live reports of a cycle created before `createdBeforeMs` (fixed daily windows). */
  summaryReports(programCycleId: string, createdBeforeMs: number): Promise<SummaryReport[]>;
  /** True while a live over-count hold freezes the cycle's aggregates. */
  cycleHeld(programCycleId: string): Promise<boolean>;
  /** Gates of the stored band model for this program, or null (none yet). */
  bandGates(programId: string): Promise<BandGateFlags | null>;
}

export interface OutcomesDeps {
  readonly store: (c: Context<AppEnv>) => OutcomesStore;
  readonly requireStudent: MiddlewareHandler<AppEnv>;
  readonly userId: (c: Context<AppEnv>) => string | null;
  readonly now: () => number;
}
