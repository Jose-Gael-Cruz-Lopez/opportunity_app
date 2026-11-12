import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { z } from "zod";
import { OutcomeReportCreateSchema, OutcomeReportUpdateSchema, type OutcomeReport, type OutcomeReportCreate } from "@shared/contracts/advisor";
import { PublicIdSchema, SlugSchema, type ApiErrorCode } from "@shared/contracts/common";
import type { StudentProfile } from "@shared/contracts/student";
import {
  outcomeEditable,
  validateOutcomeReport,
  type OutcomeFacts,
  type OutcomeIssue,
  type ValidationContext,
} from "@shared/readiness/outcomes";
import type { AppEnv } from "@server/env";
import { problemFor, type ProblemExtra } from "@server/lib/problem";
import { parseInput } from "@server/lib/validation";
import type { OutcomeCycleFacts, OutcomesDeps, OutcomesStore } from "./ports";
import { buildOutcomeSummary } from "./summary";

/**
 * Outcome reporting (plans 7.8 and 9.5), mounted at /api/v1:
 *
 *   GET   /me/outcomes                         listOutcomes    (student)
 *   POST  /me/outcomes                         createOutcome   (student)
 *   PATCH /me/outcomes/:publicId               updateOutcome   (student)
 *   GET   /programs/:slug/outcomes/summary     outcomeSummary  (public, aggregate only)
 *
 * Privacy by construction:
 * - Bodies are refused with 400 sensitive_field_rejected when they carry a status or identity
 *   key, before validation (server/lib/validation). The snapshot is built server-side from the
 *   non-sensitive profile only (class year, GPA band, major family, institution level).
 * - Status-defined programs collect nothing: the write answers 404, exactly as for an unknown
 *   cycle, and the id is never logged. Identity-defined programs need the identity consent.
 * - Reads of other people's Outcomes exist only as the public summary, whose every number passes
 *   shared/disclosure's release() (k >= 5, cells of 10, bands, complements).
 * - Nothing here logs a body, a date, a decision or a user id.
 */

const MAX_BODY_BYTES = 8 * 1024;

type Ctx = Context<AppEnv>;
type Parsed<T> = { ok: true; data: T } | { ok: false; response: Response };

function fail(c: Context, code: ApiErrorCode, extra: ProblemExtra = {}): Response {
  return problemFor(c, code, extra);
}

async function readJson<S extends z.ZodTypeAny>(c: Context, schema: S): Promise<Parsed<z.output<S>>> {
  let raw: unknown;
  try {
    raw = JSON.parse(await c.req.text());
  } catch {
    return { ok: false, response: fail(c, "bad_request", { detail: "Send a JSON body." }) };
  }
  const outcome = parseInput(schema, raw);
  if (!outcome.ok) return { ok: false, response: fail(c, outcome.code, { errors: outcome.errors }) };
  return { ok: true, data: outcome.data };
}

function issuesResponse(c: Context, errors: readonly OutcomeIssue[]): Response {
  return fail(c, "validation_failed", { errors: errors.map((e) => ({ path: e.path, message: e.message })) });
}

/** UTC calendar date of an instant (validators compare against the student's "today"). */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Age in whole years from `YYYY-MM`. Only the month is known, so the birthday is taken as the
 * LAST day of that month (server/ai/age.ts does the same): an uncertain age reads younger.
 */
export function ageFromBirthMonth(birthYearMonth: string | null | undefined, today: string): number | null {
  if (!birthYearMonth || !/^\d{4}-\d{2}$/.test(birthYearMonth)) return null;
  const [by, bm] = birthYearMonth.split("-").map(Number) as [number, number];
  const [ty, tm, td] = today.split("-").map(Number) as [number, number, number];
  const lastDay = new Date(Date.UTC(by, bm, 0)).getUTCDate();
  const hadBirthday = tm > bm || (tm === bm && td >= lastDay);
  return ty - by - (hadBirthday ? 0 : 1);
}

/** Season start for the private seasonal cap: 1 July before `today` (an academic year). */
export function seasonStartMs(today: string): number {
  const [y, m] = today.split("-").map(Number) as [number, number];
  const year = m >= 7 ? y : y - 1;
  return Date.UTC(year, 6, 1);
}

function factsOf(input: Pick<OutcomeReportCreate, "stages" | "decision" | "decidedOn">): OutcomeFacts {
  return { stages: input.stages, decision: input.decision, decidedOn: input.decidedOn };
}

/**
 * The audience and affiliation gates every write passes before validation. Returns a response
 * to send, or null to continue.
 */
async function gate(c: Context, store: OutcomesStore, userId: string, cycle: OutcomeCycleFacts | null, profile: StudentProfile | null, today: string): Promise<Response | null> {
  // Status-defined programs collect no Outcomes; answer as if the cycle did not exist.
  if (!cycle || cycle.sensitiveAudience) return fail(c, "not_found");
  if (cycle.identityAudience && !(await store.hasConsent(userId, "identity_tracking"))) {
    return fail(c, "consent_required", { detail: "Allow Novus to save this program to your account first." });
  }
  // A user linked to a Sponsor cannot report on its Programs (s09 9.8): refused, not flagged.
  if (await store.sponsorAffiliated(userId, cycle.organizationId)) {
    return fail(c, "forbidden", { detail: "Accounts linked to this program's organization cannot report outcomes for it." });
  }
  const age = ageFromBirthMonth(profile?.birthYearMonth ?? null, today);
  if (age !== null && age < 18 && !(await store.hasConsent(userId, "minor_outcomes"))) {
    return fail(c, "consent_required", { detail: "Students under 18 need to turn on outcome sharing in Settings first." });
  }
  return null;
}

async function validationContext(store: OutcomesStore, userId: string, cycle: OutcomeCycleFacts, profile: StudentProfile | null, today: string): Promise<ValidationContext> {
  const [privateConfig, others] = await Promise.all([store.privateConfig(), store.otherReportsSince(userId, cycle.programCycleId, seasonStartMs(today))]);
  return {
    today,
    cycle: {
      decisionWindowStart: cycle.decisionWindowStart,
      decisionWindowEnd: cycle.decisionWindowEnd,
      rollingDecisions: cycle.rollingDecisions,
      classYears: cycle.classYears,
    },
    roundDeadline: cycle.earliestRoundDeadline,
    nominationRequired: cycle.nominationRequired,
    snapshotClassYear: profile?.classYear ?? null,
    otherReportsThisSeason: others,
    privateConfig,
  };
}

export function createOutcomesRoutes(deps: OutcomesDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  const limit = bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => fail(c, "payload_too_large") });
  const requireUserId = (c: Ctx): string => {
    const id = deps.userId(c);
    // requireStudent runs first on every route that calls this.
    if (!id) throw new Error("outcome route reached without a session");
    return id;
  };

  // Handler errors become a bare 500: no message, no stack, no body in any log line.
  app.onError((_err, c) => fail(c, "internal"));

  app.get("/me/outcomes", deps.requireStudent, async (c) => {
    const items = await deps.store(c).listOwn(requireUserId(c));
    c.header("cache-control", "no-store");
    return c.json({ items } satisfies { items: OutcomeReport[] });
  });

  app.post("/me/outcomes", deps.requireStudent, limit, async (c) => {
    const body = await readJson(c, OutcomeReportCreateSchema);
    if (!body.ok) return body.response;
    const userId = requireUserId(c);
    const store = deps.store(c);
    const now = deps.now();
    const today = utcDay(now);
    const [cycle, profile] = await Promise.all([store.cycleFacts(body.data.programCycleId), store.profile(userId)]);
    const blocked = await gate(c, store, userId, cycle, profile, today);
    if (blocked) return blocked;
    // Reports are for programs the student tracks (the Tracker's decision step).
    if (!(await store.tracking(userId, cycle!.programCycleId))) {
      return fail(c, "conflict", { detail: "Track this program before reporting how it went." });
    }
    const result = validateOutcomeReport(factsOf(body.data), await validationContext(store, userId, cycle!, profile, today));
    if (!result.ok) return issuesResponse(c, result.errors);
    const tier = await store.verifiedTier(userId);
    const written = await store.create(userId, { input: body.data, tier, flags: result.flags }, profile, now);
    if (!written.ok) {
      if (written.error === "conflict") return fail(c, "conflict", { detail: "You already reported this cycle; edit that report instead." });
      if (written.error === "consent_required") return fail(c, "consent_required");
      return fail(c, written.error === "not_found" ? "not_found" : "validation_failed");
    }
    c.header("cache-control", "no-store");
    return c.json(written.value, 201);
  });

  app.patch("/me/outcomes/:publicId", deps.requireStudent, limit, async (c) => {
    const publicId = PublicIdSchema.safeParse(c.req.param("publicId"));
    if (!publicId.success) return fail(c, "not_found");
    const body = await readJson(c, OutcomeReportUpdateSchema);
    if (!body.ok) return body.response;
    const userId = requireUserId(c);
    const store = deps.store(c);
    const now = deps.now();
    const today = utcDay(now);
    const own = await store.getOwn(userId, publicId.data);
    if (!own) return fail(c, "not_found");
    if (!outcomeEditable(own.report.decidedOn, today)) {
      return fail(c, "conflict", { detail: "Reports can be edited until 60 days after the decision." });
    }
    const [cycle, profile] = await Promise.all([store.cycleFacts(own.report.programCycleId), store.profile(userId)]);
    const blocked = await gate(c, store, userId, cycle, profile, today);
    if (blocked) return blocked;
    const merged: OutcomeFacts = {
      stages: body.data.stages ?? own.report.stages,
      decision: body.data.decision !== undefined ? body.data.decision : own.report.decision,
      decidedOn: body.data.decidedOn !== undefined ? body.data.decidedOn : own.report.decidedOn,
    };
    const result = validateOutcomeReport(merged, await validationContext(store, userId, cycle!, profile, today));
    if (!result.ok) return issuesResponse(c, result.errors);
    // A Curator's earlier flags stay until a Curator clears them; new flags are added.
    const flags = [...new Set([...own.flagCodes, ...result.flags])].sort();
    const written = await store.update(userId, publicId.data, body.data, flags, now);
    if (!written.ok) return fail(c, written.error === "not_found" ? "not_found" : "conflict");
    const changed = Object.keys(body.data).sort();
    if (changed.length > 0) await store.auditEdit(userId, changed, now, c.get("requestId") ?? null);
    c.header("cache-control", "no-store");
    return c.json(written.value);
  });

  app.get("/programs/:slug/outcomes/summary", async (c) => {
    const slug = SlugSchema.safeParse(c.req.param("slug"));
    if (!slug.success) return fail(c, "not_found");
    const store = deps.store(c);
    const program = await store.summaryProgram(slug.data);
    // Status-defined programs have no outcome data at all; they read like unknown programs.
    if (!program || program.sensitiveAudience) return fail(c, "not_found");
    const now = deps.now();
    const asOf = utcDay(now);
    // Fixed daily windows: reports filed today wait for tomorrow, so repeated reads within a day
    // cannot be differenced to isolate one report.
    const cutoff = Date.parse(`${asOf}T00:00:00Z`);
    const cycles = await Promise.all(
      program.cycles.slice(0, 3).map(async (cy) => {
        const held = await store.cycleHeld(cy.id);
        return { cycleKey: cy.cycleKey, held, reports: held ? [] : await store.summaryReports(cy.id, cutoff) };
      }),
    );
    const summary = buildOutcomeSummary({ programSlug: program.slug, asOf, isSample: program.isSample, cycles, bandGates: await store.bandGates(program.programId) });
    c.header("cache-control", "public, max-age=3600");
    return c.json(summary);
  });

  return app;
}
