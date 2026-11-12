import { Hono, type Context, type MiddlewareHandler } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import {
  findSensitiveKeys,
  problem,
  type ApiErrorCode,
  type StudentProfile,
  type StudentProfileUpdate,
} from "@shared/contracts";
import { PRODUCT } from "@shared/config/product";
import { checkAiAccess } from "@server/ai/age";
import { localDateIn } from "@shared/time/zones";
import {
  buildReminders,
  buildRoadmapItems,
  deadlinePassed,
  isStepDone,
  defaultNameInMessages,
  selectCycle,
  trackingConsentKind,
} from "./first-door";
import { isCleanTerm, scanOutgoingText, type UnredactedKind } from "./guard";
import { toMatchSignals } from "@shared/onboarding/signals";
import { cleanTerms, projectFirstDoor, projectMatches, sanitizeAiProfile } from "./project";
import type { OnboardingDeps, OnboardingEnv, OnboardingRecord } from "./ports";
import { checkAiRateLimit } from "./rate-limit";
import {
  FirstDoorRequestSchema,
  MatchesRequestSchema,
  QuizSubmitSchema,
  ResumeExtractRequestSchema,
  toExperienceKinds,
  type OnboardingPreferences,
  type OnboardingSignals,
} from "./schemas";
import { onboardingDeps } from "./wiring";

/**
 * /api/v1/onboarding/*: the server half of the Duolingo-style onboarding.
 *
 * Privacy by construction:
 * - The resume file and its raw text never reach these routes. The extract route accepts only the
 *   student-approved redacted text with consent:true, re-checks it (guard.ts), passes it to the
 *   model and returns structured, guard-clean terms. It stores nothing and logs nothing.
 * - Bodies are strict zod objects, and any sensitive-looking key is refused before validation.
 * - No handler logs a request body, and errors carry codes and paths, never submitted values.
 * - Responses never carry a numeric fit score (project.ts builds them field by field).
 */

type Env = { Bindings: OnboardingEnv };
type Ctx = Context<Env>;
type DepsSource = OnboardingDeps | ((c: Context) => OnboardingDeps);

/** Bodies here are small JSON; the extract route's 12k characters fit with room for UTF-8. */
const MAX_BODY_BYTES = 64 * 1024;

const PROBLEM_HEADERS = { "content-type": "application/problem+json" } as const;

function fail(c: Ctx, code: ApiErrorCode, extra: Parameters<typeof problem>[1] = {}): Response {
  const body = problem(code, extra);
  return c.body(JSON.stringify(body), body.status as 400, PROBLEM_HEADERS);
}

/**
 * Field issues with the path and the zod issue code only. zod's own messages can quote the
 * received value (invalid enum), and these routes never echo student input.
 */
function fieldIssues(error: z.ZodError): { path: string; message: string }[] {
  return error.issues.slice(0, 50).map((i) => ({
    path: i.path.join(".") || "(root)",
    message: i.code === "unrecognized_keys" ? "Unrecognized key" : i.code,
  }));
}

/** 422 for text or terms that still carry contact details or sensitive statements. */
function unredacted(c: Ctx, kinds: readonly UnredactedKind[]): Response {
  const body = {
    type: "/problems/unredacted-content",
    title: "Remove the highlighted details before sending",
    status: 422,
    code: "unredacted_content",
    // Coarse kinds only; a sensitive category is never named, even to the sender.
    kinds,
  };
  return c.body(JSON.stringify(body), 422, PROBLEM_HEADERS);
}

type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

/** Reads JSON, refuses sensitive keys before validation, then validates strictly. */
async function readBody<S extends z.ZodTypeAny>(c: Ctx, schema: S): Promise<Parsed<z.infer<S>>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return { ok: false, response: fail(c, "bad_request", { detail: "Body must be JSON." }) };
  }
  if (findSensitiveKeys(raw).length > 0) return { ok: false, response: fail(c, "sensitive_field_rejected") };
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, response: fail(c, "validation_failed", { errors: fieldIssues(parsed.error) }) };
  }
  return { ok: true, data: parsed.data };
}

/** The words inside a skill reference: an unlisted skill is `x:{label}`, a listed one is an id. */
function skillText(ref: string): string {
  return ref.startsWith("x:") ? ref.slice(2) : ref.replace(/_/g, " ");
}

/** Every free-text term in preferences and signals must pass the same guard as resume text. */
function dirtyTermKinds(preferences: OnboardingPreferences, signals: OnboardingSignals | null): UnredactedKind[] {
  const terms = [
    ...preferences.skills.map(skillText),
    ...(signals ? [...signals.skills.map(skillText), ...signals.coursework] : []),
  ];
  const kinds = new Set<UnredactedKind>();
  for (const t of terms) for (const k of scanOutgoingText(t).kinds) kinds.add(k);
  return [...kinds];
}

/**
 * Profile fields the quiz answered; unanswered (null or empty) fields leave stored values alone.
 * Interests are stored as the quiz's topic ids, opportunity types as the categories' type slugs.
 */
export function toProfilePatch(preferences: OnboardingPreferences, signals: OnboardingSignals | null): StudentProfileUpdate {
  const patch: StudentProfileUpdate = {};
  if (preferences.classYear) patch.classYear = preferences.classYear;
  if (preferences.majorFamily) patch.majorFamily = preferences.majorFamily;
  if (preferences.timeZone) patch.timeZone = preferences.timeZone;
  patch.weeklyPrepHours = preferences.weeklyHours;
  if (preferences.interests.length > 0) patch.interestTags = cleanTerms(preferences.interests, 30);
  if (preferences.opportunityTypes.length > 0) patch.preferredOpportunityTypes = [...new Set(preferences.opportunityTypes)];
  const experience = toExperienceKinds([...preferences.experience, ...(signals?.experience ?? [])]);
  if (experience.length > 0) patch.priorExperience = experience;
  return patch;
}

/** Signals as stored: the shared closed shape, with every free-text term re-checked. */
export function toStoredSignals(signals: OnboardingSignals): OnboardingSignals {
  const clean = toMatchSignals(signals);
  return {
    ...clean,
    skills: clean.skills.filter((ref) => isCleanTerm(skillText(ref))),
    coursework: cleanTerms(clean.coursework, 20),
  };
}

export type AiAvailability = { readonly enabled: true } | { readonly enabled: false; readonly reason: "no_key" | "age" };

/**
 * Whether the AI reading step may run for this student. Gemini's terms require users to be 18 or
 * older (server/ai/age.ts), so an unknown or under-18 age turns the step off; the on-device parse,
 * matching and the first-door plan still work.
 */
export function aiAvailability(hasKey: boolean, profile: StudentProfile | null, now: Date): AiAvailability {
  if (!hasKey) return { enabled: false, reason: "no_key" };
  const today = localDateIn(now.getTime(), profile?.timeZone ?? PRODUCT.fallbackTimeZone);
  const access = checkAiAccess({ userId: null, birthYearMonth: profile?.birthYearMonth ?? null }, today);
  return access.allowed ? { enabled: true } : { enabled: false, reason: "age" };
}

const EMPTY_RECORD = (now: Date): OnboardingRecord => ({
  preferences: null,
  signals: null,
  step: null,
  completedAt: null,
  firstDoor: null,
  updatedAt: now.toISOString(),
});

export function createOnboardingRoutes(source: DepsSource): Hono<Env> {
  const depsFor = (c: Context): OnboardingDeps => (typeof source === "function" ? source(c) : source);
  const app = new Hono<Env>();

  // Personal data: never cache, at any layer.
  const noStore: MiddlewareHandler<Env> = async (c, next) => {
    await next();
    c.header("Cache-Control", "no-store");
  };
  app.use("/onboarding/*", noStore);
  app.use("/onboarding/*", (c, next) => depsFor(c).auth.requireUser(c, next));
  app.use(
    "/onboarding/*",
    bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c as Ctx, "payload_too_large") }),
  );

  // Handler errors become a bare 500: no message, no stack, no body in any log line.
  app.onError((_err, c) => fail(c as Ctx, "internal"));

  const requireUserId = (c: Ctx): string | null => depsFor(c).auth.userId(c);

  app.get("/onboarding/state", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return fail(c, "unauthenticated");
    const deps = depsFor(c);
    const repos = deps.repos(c);
    const [profile, onboarding] = await Promise.all([repos.profiles.get(userId), repos.profiles.getOnboarding(userId)]);
    return c.json({ profile, onboarding, ai: aiAvailability(Boolean(c.env?.GEMINI_API_KEY), profile, deps.now()) });
  });

  app.post("/onboarding/quiz", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return fail(c, "unauthenticated");
    const body = await readBody(c, QuizSubmitSchema);
    if (!body.ok) return body.response;
    const { preferences, signals, step, completed } = body.data;
    const dirty = dirtyTermKinds(preferences, signals);
    if (dirty.length > 0) return unredacted(c, dirty);

    const deps = depsFor(c);
    const repos = deps.repos(c);
    const now = deps.now();
    const previous = (await repos.profiles.getOnboarding(userId)) ?? EMPTY_RECORD(now);
    const record: OnboardingRecord = {
      ...previous,
      preferences,
      signals: signals ? toStoredSignals(signals) : previous.signals,
      step: step ?? previous.step,
      completedAt: completed ? previous.completedAt ?? now.toISOString() : previous.completedAt,
      updatedAt: now.toISOString(),
    };
    const profile = await repos.profiles.update(userId, toProfilePatch(preferences, signals));
    await repos.profiles.saveOnboarding(userId, record);
    if (completed) await repos.profiles.markOnboarded?.(userId);
    return c.json({ profile, onboarding: record });
  });

  app.post("/onboarding/resume/extract", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return fail(c, "unauthenticated");
    let raw: unknown;
    try {
      raw = await c.req.json();
    } catch {
      return fail(c, "bad_request", { detail: "Body must be JSON." });
    }
    if (findSensitiveKeys(raw).length > 0) return fail(c, "sensitive_field_rejected");
    // Consent is checked on its own so a missing or false flag reads as "ask first", not a typo.
    if (typeof raw !== "object" || raw === null || (raw as { consent?: unknown }).consent !== true) {
      return fail(c, "consent_required", { detail: "Review the text and confirm before it is sent." });
    }
    const parsed = ResumeExtractRequestSchema.safeParse(raw);
    if (!parsed.success) return fail(c, "validation_failed", { errors: fieldIssues(parsed.error) });

    const scan = scanOutgoingText(parsed.data.redactedText);
    if (!scan.ok) return unredacted(c, scan.kinds);

    // Without a key, or for a student not known to be 18+, the step is off and the client keeps
    // its on-device parse. No model client is built in either case.
    if (!c.env?.GEMINI_API_KEY) return c.json({ ai: "off" as const, reason: "no_key" as const });
    const deps = depsFor(c);
    const viewerProfile = await deps.repos(c).profiles.get(userId);
    const availability = aiAvailability(true, viewerProfile, deps.now());
    if (!availability.enabled) return c.json({ ai: "off" as const, reason: availability.reason });
    const decision = await checkAiRateLimit(userId, deps.now().getTime(), c.env.ONBOARDING_AI_RATE_LIMITER);
    if (!decision.allowed) {
      c.header("Retry-After", String(decision.retryAfterSeconds));
      return fail(c, "rate_limited");
    }

    let result: Awaited<ReturnType<ReturnType<OnboardingDeps["createAi"]>["extractResumeProfile"]>>;
    try {
      result = await deps
        .createAi(c.env)
        .extractResumeProfile(parsed.data.redactedText, { userId, birthYearMonth: viewerProfile?.birthYearMonth ?? null });
    } catch {
      // Provider errors can carry the prompt in their message; swallow them whole.
      return c.json({ ai: "unavailable" as const });
    }
    if (result.status !== "ok") return c.json({ ai: "unavailable" as const });
    const profile = sanitizeAiProfile(result.profile);
    if (!profile) return c.json({ ai: "unavailable" as const });
    // Nothing is stored here. The student confirms these chips; POST /onboarding/quiz saves them.
    return c.json({ ai: "on" as const, profile });
  });

  app.post("/onboarding/matches", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return fail(c, "unauthenticated");
    const body = await readBody(c, MatchesRequestSchema);
    if (!body.ok) return body.response;
    const { preferences, signals, k } = body.data;
    const dirty = dirtyTermKinds(preferences, signals);
    if (dirty.length > 0) return unredacted(c, dirty);

    const deps = depsFor(c);
    const now = deps.now();
    const catalog = (await deps.repos(c).programs.listMatchable(now)).filter(
      (e) => e.program.isPublished && e.program.lifecycle === "active",
    );
    const cleanSignals = signals ? toStoredSignals(signals) : null;
    const matches = deps.engine.findMatches({ preferences, signals: cleanSignals, programs: catalog, now, k });
    const items = projectMatches(matches, catalog, k);
    const firstDoor = projectFirstDoor(deps.engine.pickFirstDoor(matches, preferences, now), items);
    const counts = {
      strong: items.filter((i) => i.tier === "strong").length,
      good: items.filter((i) => i.tier === "good").length,
      stretch: items.filter((i) => i.tier === "stretch").length,
    };
    return c.json({ items, firstDoor, counts });
  });

  app.post("/onboarding/first-door", async (c) => {
    const userId = requireUserId(c);
    if (!userId) return fail(c, "unauthenticated");
    const body = await readBody(c, FirstDoorRequestSchema);
    if (!body.ok) return body.response;
    const req = body.data;

    const deps = depsFor(c);
    const repos = deps.repos(c);
    const now = deps.now();
    const entry = await repos.programs.getEntry(req.programId);
    if (!entry) return fail(c, "not_found");
    const cycle = selectCycle(entry, req.programCycleId);
    if (!cycle) return fail(c, "conflict", { detail: "This cycle is not open for applications." });

    const [profile, previous] = await Promise.all([repos.profiles.get(userId), repos.profiles.getOnboarding(userId)]);
    const timeZone = req.timeZone ?? profile?.timeZone ?? cycle.timeZone ?? PRODUCT.fallbackTimeZone;
    const today = localDateIn(now.getTime(), timeZone);
    if (deadlinePassed(entry, cycle.id, today)) {
      return fail(c, "conflict", { detail: "The deadline for this cycle has passed." });
    }

    // Tracking a status- or identity-defined program would reveal the student's answer, so the
    // server links them only under an explicit consent; the client otherwise keeps the plan local.
    const consentKind = trackingConsentKind(entry.program);
    if (consentKind && !(await repos.consents.has(userId, consentKind, entry.program.id))) {
      return fail(c, "consent_required", { detail: "Keep this plan on your device, or allow Novus to save it." });
    }

    const requirements = entry.requirements.filter((r) => r.programCycleId === cycle.id);
    const known = entry.deadlines?.[cycle.id] ?? null;
    let plan: ReturnType<OnboardingDeps["engine"]["planFirstApplication"]>;
    try {
      plan = deps.engine.planFirstApplication({
        program: entry.program,
        cycle,
        requirements,
        signals: previous?.signals ?? null,
        now,
        deadline: entry.resolved?.[cycle.id] ?? (known ? { on: known, basis: "official" } : null),
        nominationRequired: entry.card?.flags.nominationRequired === true || requirements.some((r) => r.kind === "campus_nomination"),
        preferences: previous?.preferences ?? null,
        timeZone,
      });
    } catch (err) {
      if ((err as { name?: unknown } | null)?.name === "FirstDoorClosedError") {
        return fail(c, "conflict", { detail: "The deadline for this cycle has passed." });
      }
      throw err;
    }

    // Idempotent: a retry after a partial failure finds the same TrackerItem and upserts the same
    // roadmap and reminder keys.
    const existing = await repos.tracker.findByCycle(userId, cycle.id);
    const trackerItem =
      existing ??
      (await repos.tracker.create(userId, {
        programCycleId: cycle.id,
        status: "applying",
        nameInMessages: req.nameInMessages ?? defaultNameInMessages(entry.program),
      }));

    const roadmapItems = buildRoadmapItems({
      program: entry.program,
      cycle,
      plan,
      completedStepIds: req.completedStepIds,
      today,
    });
    await repos.roadmap.upsertStudentItems(userId, roadmapItems);

    const reminders = buildReminders({
      trackerItemId: trackerItem.id,
      plan,
      completedStepIds: req.completedStepIds,
      intention: req.intention,
      today,
      timeZone,
      neutral: !trackerItem.nameInMessages,
    });
    await repos.reminders.schedule(userId, reminders);

    const record: OnboardingRecord = {
      ...(previous ?? EMPTY_RECORD(now)),
      firstDoor: {
        programId: entry.program.id,
        programCycleId: cycle.id,
        trackerItemId: trackerItem.id,
        steps: plan.steps.map((s) => ({ id: s.id, title: s.title.slice(0, 200), kind: s.kind, minutes: s.minutes, due: s.due ?? null })),
      },
      completedAt: previous?.completedAt ?? now.toISOString(),
      updatedAt: now.toISOString(),
    };
    await repos.profiles.saveOnboarding(userId, record);
    await repos.profiles.markOnboarded?.(userId);

    return c.json(
      {
        trackerItem,
        roadmapItems,
        reminders: reminders.map(({ kind, stepId, sendOn, at, timeZone: tz }) => ({ kind, stepId, sendOn, at, timeZone: tz })),
        plan: {
          steps: plan.steps.map((s) => ({
            id: s.id,
            title: s.title,
            kind: s.kind,
            minutes: s.minutes,
            due: s.due ?? null,
            done: isStepDone(s, req.completedStepIds),
          })),
        },
      },
      existing ? 200 : 201,
    );
  });

  return app;
}

/** Mounted by integration under /api/v1. Until wiring.ts binds real modules it answers 503. */
export const onboardingRoutes = createOnboardingRoutes(onboardingDeps);
