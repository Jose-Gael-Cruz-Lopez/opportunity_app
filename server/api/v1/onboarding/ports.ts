import type { Context, MiddlewareHandler } from "hono";
import type {
  Program,
  ProgramCard,
  ProgramCycle,
  Requirement,
  RoadmapItem,
  StudentProfile,
  StudentProfileUpdate,
  TrackerItem,
  TrackerItemCreate,
} from "@shared/contracts";
import type { OnboardingPreferences, OnboardingSignals, AiResumeProfile } from "./schemas";

/**
 * Ports: the narrow interfaces these routes need from modules built in parallel (server/auth,
 * server/db, server/ai, shared/onboarding). The routes depend on these shapes only, so they
 * typecheck and test today; wiring.ts binds the real modules at integration. Each port is the
 * smallest surface the route uses, which also keeps the privacy review short.
 */

/** Worker bindings this feature reads. Everything else on Env is ignored. */
export interface OnboardingEnv {
  /** Gemini key; absent means AI steps report "off" and everything else still works. */
  readonly GEMINI_API_KEY?: string;
  /** Optional Workers rate-limit binding for the AI route (see rate-limit.ts). */
  readonly ONBOARDING_AI_RATE_LIMITER?: RateLimitBinding;
}

/** The Cloudflare Workers rate-limit binding shape (`limit({ key })`). */
export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}

export interface AuthPort {
  /** server/auth requireUser: answers 401 itself when there is no session. */
  readonly requireUser: MiddlewareHandler;
  /** Reads the internal user id that requireUser put on the context; null if absent. */
  userId(c: Context): string | null;
}

/** What the server keeps about onboarding: answers and approved signals, never resume text. */
export interface OnboardingRecord {
  readonly preferences: OnboardingPreferences | null;
  /** Signals the student confirmed (chips), already checked by guard.ts. */
  readonly signals: OnboardingSignals | null;
  readonly step: string | null;
  readonly completedAt: string | null;
  readonly firstDoor: FirstDoorRecord | null;
  readonly updatedAt: string;
}

/** The first door the student saved, with the plan's steps (program facts only, no student text). */
export interface FirstDoorRecord {
  readonly programId: string;
  readonly programCycleId: string;
  readonly trackerItemId: string;
  readonly steps?: readonly { readonly id: string; readonly title: string; readonly kind: string; readonly minutes: number; readonly due: string | null }[];
}

export interface StudentProfileRepo {
  get(userId: string): Promise<StudentProfile | null>;
  update(userId: string, patch: StudentProfileUpdate): Promise<StudentProfile>;
  getOnboarding(userId: string): Promise<OnboardingRecord | null>;
  saveOnboarding(userId: string, record: OnboardingRecord): Promise<void>;
  /** Marks the account onboarded (sign-in then lands on the app, not /app/start). Idempotent. */
  markOnboarded?(userId: string): Promise<void>;
}

/** An effective deadline someone already resolved for a cycle (campus estimates included). */
export interface ResolvedDeadline {
  /** YYYY-MM-DD, or null when rolling or not announced. */
  readonly on: string | null;
  readonly basis: "official" | "estimated" | "campus_estimate" | "rolling" | "not_announced";
}

/** A published program with the cycles and requirements matching and planning need. */
export interface CatalogEntry {
  readonly program: Program;
  readonly cycles: readonly ProgramCycle[];
  readonly requirements: readonly Requirement[];
  /** Effective (latest national or campus) deadline per cycle id, as YYYY-MM-DD, when known. */
  readonly deadlines?: Readonly<Record<string, string | null>>;
  /** The effective deadline per cycle id with its basis (what planning counts back from). */
  readonly resolved?: Readonly<Record<string, ResolvedDeadline>>;
  /** The program's current card (registry read model): what matching reads. */
  readonly card?: ProgramCard;
}

export interface ProgramRepo {
  /** Published programs with an open or expected cycle, for matching. */
  listMatchable(now: Date): Promise<readonly CatalogEntry[]>;
  /** One published program with its cycles and requirements, or null. */
  getEntry(programId: string): Promise<CatalogEntry | null>;
}

export interface TrackerRepo {
  findByCycle(userId: string, programCycleId: string): Promise<TrackerItem | null>;
  create(userId: string, input: TrackerItemCreate): Promise<TrackerItem>;
}

export interface ConsentRepo {
  /** True when an unrevoked consent of this kind covers the program. */
  has(userId: string, kind: "sensitive_tracking" | "identity_tracking" | "health_tracking", programId: string): Promise<boolean>;
}

export interface RoadmapRepo {
  /** Upserts student-sourced roadmap items by itemKey (idempotent on retries). */
  upsertStudentItems(userId: string, items: readonly RoadmapItem[]): Promise<void>;
}

/** A reminder row for the sender. Copy is chosen by the sender from `kind` and `neutral`. */
export interface ReminderDraft {
  readonly key: string;
  readonly trackerItemId: string;
  readonly kind: "step_due" | "intention" | "submit_buffer";
  readonly stepId: string;
  readonly sendOn: string;
  readonly at: string;
  readonly timeZone: string;
  /** True when the reminder must not name the program (identity- or sensitive-audience). */
  readonly neutral: boolean;
}

export interface ReminderRepo {
  /** Upserts by key so retrying first-door never duplicates reminders. */
  schedule(userId: string, reminders: readonly ReminderDraft[]): Promise<void>;
}

export interface OnboardingRepos {
  readonly profiles: StudentProfileRepo;
  readonly programs: ProgramRepo;
  readonly tracker: TrackerRepo;
  readonly consents: ConsentRepo;
  readonly roadmap: RoadmapRepo;
  readonly reminders: ReminderRepo;
}

// --- Matching engine (shared/onboarding). Shapes follow the agreed interface. ------------------

export type MatchTier = "strong" | "good" | "stretch";

export interface MatchItem {
  readonly programId: string;
  readonly tier: MatchTier;
  readonly reasons: readonly string[];
  readonly feasibility: { readonly startBy: string; readonly daysLeft: number; readonly enoughTime: boolean };
  readonly requirementsMet: { readonly met: number; readonly total: number };
}

export interface MatchSet {
  readonly items: readonly MatchItem[];
}

export interface FirstDoorOption {
  readonly programId: string;
  readonly rationale: string;
}

export interface FirstDoorChoice {
  readonly options: readonly FirstDoorOption[];
}

export interface PlanStep {
  readonly id: string;
  readonly title: string;
  readonly kind: string;
  readonly minutes: number;
  readonly due?: string;
  readonly doneDuringOnboarding?: boolean;
}

export interface FirstApplicationPlan {
  readonly steps: readonly PlanStep[];
}

export interface MatchEngine {
  findMatches(input: {
    preferences: OnboardingPreferences;
    signals: OnboardingSignals | null;
    programs: readonly CatalogEntry[];
    now: Date;
    k: number;
  }): MatchSet;
  pickFirstDoor(matches: MatchSet, preferences: OnboardingPreferences, now: Date): FirstDoorChoice;
  /** Throws an error named FirstDoorClosedError when every deadline of the cycle has passed. */
  planFirstApplication(input: {
    program: Program;
    cycle: ProgramCycle;
    requirements: readonly Requirement[];
    signals: OnboardingSignals | null;
    now: Date;
    /** The cycle's effective deadline, already resolved (never shifted again for nomination). */
    deadline?: ResolvedDeadline | null;
    /** Nomination-gated cycle (the card's flag or a campus_nomination requirement). */
    nominationRequired?: boolean;
    preferences?: OnboardingPreferences | null;
    timeZone?: string | null;
  }): FirstApplicationPlan;
}

// --- AI (server/ai createAi(env).extractResumeProfile) -----------------------------------------

export type ResumeExtractResult =
  | { readonly status: "ok"; readonly profile: unknown }
  | { readonly status: "unavailable" };

/** Who is asking: the internal id (hashed for the daily cap) and the age the gate reads. */
export interface ResumeAiViewer {
  readonly userId: string;
  readonly birthYearMonth: string | null;
}

export interface ResumeAi {
  /** Receives redacted, allowlisted, guard-checked text only. */
  extractResumeProfile(redactedText: string, viewer?: ResumeAiViewer): Promise<ResumeExtractResult>;
}

export interface OnboardingDeps {
  readonly auth: AuthPort;
  repos(c: Context): OnboardingRepos;
  readonly engine: MatchEngine;
  createAi(env: OnboardingEnv): ResumeAi;
  /** Clock seam for tests. */
  now(): Date;
}

export type { AiResumeProfile };
