import type { Context, MiddlewareHandler } from "hono";
import type {
  ConsentChange,
  ConsentRecord,
  Deadline,
  EligibilityRuleSet,
  InboxItem,
  NotificationPrefs,
  ProgramCard,
  Requirement,
  RequirementProgress,
  RequirementProgressUpdate,
  RoadmapItemAction,
  StageOdds,
  StudentProfile,
  StudentProfileUpdate,
  TrackerItem,
  TrackerItemCreate,
  TrackerItemUpdate,
} from "@shared/contracts";
import type { InstitutionLike } from "@shared/eligibility";
import type { Ai } from "@server/ai";
import type { RepoResult } from "@server/db/repos/common";
import type { RateLimitBindingLike, WindowRule } from "@server/lib/rate-limit";
import type { AppEnv, Env } from "@server/env";
import type { ReadinessBandsSource } from "./readiness-bands";

/**
 * What the signed-in student routes need from the rest of the Worker. The D1 implementation
 * (./store.ts) adapts server/db/repos; route tests pass the in-memory store from ./testing.ts, so
 * handlers are tested without a database. Nothing on this surface accepts SensitiveAnswers: the
 * profile type is the non-sensitive StudentProfile and the routes refuse status or identity keys
 * before any of these methods run.
 */

/** The program facts readiness, the roadmap and the assistant read (public registry data). */
export interface ProgramFacts {
  readonly id: string;
  readonly slug: string;
  readonly name: string;
  readonly organizationName: string;
  readonly officialUrl: string;
  readonly summary: string | null;
  /** Status-defined program (non-citizen status, Pell, health): readiness and AI answer 404. */
  readonly sensitiveAudience: boolean;
  readonly isSample: boolean;
  /** No earlier cycles exist (competitiveness says "new program"). */
  readonly newProgram: boolean;
}

export interface CycleFacts {
  readonly id: string;
  readonly cycleKey: string;
  readonly opensOn: string | null;
  readonly predictedOpensOn: string | null;
  readonly applicationUrl: string | null;
}

/** One published program cycle with everything the deterministic readiness parts need. */
export interface ReadinessSource {
  readonly program: ProgramFacts;
  readonly cycle: CycleFacts;
  readonly deadlines: readonly Deadline[];
  readonly requirements: readonly Requirement[];
  /** True only when every curated requirement is verified. */
  readonly requirementsChecked: boolean;
  /** The verified rule set, or null ("Novus has no reviewed rules yet"). */
  readonly ruleSet: EligibilityRuleSet | null;
  /** Official program-level stage odds; never a number about a student. */
  readonly stageOdds: readonly StageOdds[];
}

/** A tracker item joined with its cycle's facts (roadmap rows and readiness workload). */
export interface TrackedCycle {
  readonly item: TrackerItem;
  readonly program: ProgramFacts;
  readonly cycle: CycleFacts;
  readonly deadlines: readonly Deadline[];
  readonly requirements: readonly Requirement[];
}

export interface RoadmapActionRecord {
  readonly pinned: boolean;
  readonly state: "open" | "done" | "dismissed";
}

/** One step of the student's first-door plan, as onboarding stored it (title and due date). */
export interface RoadmapPlanStep {
  readonly programId: string;
  readonly programCycleId: string;
  readonly stepId: string;
  readonly title: string;
  /** shared/onboarding step kind; `submit` is the cycle's Apply item, not a Prepare item. */
  readonly kind: string;
  readonly due: string | null;
}

export interface RoadmapState {
  readonly templateKey: string | null;
  readonly lastShownItemKeys: readonly string[];
  readonly actions: ReadonlyMap<string, RoadmapActionRecord>;
  /** The first-door plan's steps (empty when the student has none). */
  readonly planSteps?: readonly RoadmapPlanStep[];
}

export interface InboxPage {
  readonly items: readonly InboxItem[];
}

export interface StudentStore {
  getProfile(userId: string): Promise<StudentProfile | null>;
  updateProfile(userId: string, update: StudentProfileUpdate, now: number): Promise<RepoResult<StudentProfile>>;

  listTracker(userId: string): Promise<TrackerItem[]>;
  /** not_found for an unknown or unpublished cycle; consent_required for status- or identity-defined programs. */
  addTracker(userId: string, input: TrackerItemCreate, now: number): Promise<RepoResult<TrackerItem>>;
  updateTracker(userId: string, itemId: string, update: TrackerItemUpdate, now: number): Promise<RepoResult<TrackerItem>>;
  removeTracker(userId: string, itemId: string, now: number): Promise<boolean>;
  /** Tracked cycles with their deadlines and requirements (live items only). */
  trackedCycles(userId: string): Promise<TrackedCycle[]>;

  getNotificationPrefs(userId: string): Promise<NotificationPrefs>;
  saveNotificationPrefs(userId: string, prefs: NotificationPrefs, now: number): Promise<void>;

  listConsents(userId: string): Promise<ConsentRecord[]>;
  changeConsent(userId: string, change: ConsentChange, now: number): Promise<RepoResult<true>>;

  listRequirementProgress(userId: string): Promise<RequirementProgress[]>;
  setRequirementProgress(userId: string, update: RequirementProgressUpdate, now: number): Promise<RepoResult<RequirementProgress>>;

  getRoadmapState(userId: string): Promise<RoadmapState>;
  recordRoadmapAction(
    userId: string,
    itemKey: string,
    action: RoadmapItemAction["action"],
    programId: string | null,
    now: number,
  ): Promise<RepoResult<RoadmapActionRecord>>;
  saveRoadmapVisit(userId: string, itemKeys: readonly string[], templateKey: string | null, now: number): Promise<void>;

  /** A published cycle by id; null when unknown or unpublished. */
  readinessSource(programCycleId: string): Promise<ReadinessSource | null>;
  /** The current cycle of a published program by slug (follows renames); null when unknown. */
  readinessSourceBySlug(slug: string): Promise<ReadinessSource | null>;
  institution(institutionId: string): Promise<InstitutionLike | null>;
  /** True only for a positive participation listing; never "no". */
  participates(programId: string, institutionId: string): Promise<boolean>;

  /** Revokes live feeds and stores the new token hash. */
  rotateCalendarFeed(userId: string, tokenHash: string, now: number): Promise<void>;

  listInbox(userId: string, now: number, opts: { limit: number; before: { createdAt: number; id: string } | null }): Promise<InboxItem[]>;
  markInboxRead(userId: string, alertId: string, now: number): Promise<boolean>;

  /**
   * Soft-deletes the account: hidden at once, sessions and calendar feeds revoked. The daily
   * `deletion.process` job purges the rows once the undo window has passed.
   */
  deleteAccount(userId: string, now: number): Promise<void>;

  /** Published cards matching a free-text query, best first (Ask Novus retrieval). */
  searchCards(query: string, now: number, limit: number): Promise<ProgramCard[]>;
}

export type StudentCtx = Context<AppEnv>;

export interface StudentDeps {
  readonly store: (c: StudentCtx) => StudentStore;
  /** server/ai; tests pass createAi({}, { provider: createMockProvider(...) }). */
  readonly ai: (c: StudentCtx) => Ai;
  readonly now: () => number;
  /** Public origin (APP_ORIGIN) for calendar URLs, record links and the methodology page. */
  readonly origin: (c: StudentCtx) => string;
  /**
   * Must answer 401 without a session, like server/auth's requireUser. Defaults to a local
   * equivalent, so this module does not depend on server/auth's load order.
   */
  readonly requireStudent?: MiddlewareHandler<AppEnv>;
  /** Burst limits per assistant route and user (the AI ledger enforces daily caps and spend). */
  readonly aiRateRules?: readonly WindowRule[];
  readonly aiRateBinding?: (env: Env) => RateLimitBindingLike | undefined;
  /** New calendar token; injectable so tests can predict the URL. */
  readonly newCalendarToken?: () => string;
  /**
   * Stored band models and held cycles for readiness (./readiness-bands). Without it readiness
   * shows the official base rate only, exactly as before band models were stored.
   */
  readonly bands?: (c: StudentCtx) => ReadinessBandsSource;
}
