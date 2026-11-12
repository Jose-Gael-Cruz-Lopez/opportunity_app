import { and, asc, desc, eq, gte, inArray, isNull, ne, sql } from "drizzle-orm";
import type { OutcomeReport, OutcomeReportUpdate } from "@shared/contracts/advisor";
import type { StudentProfile } from "@shared/contracts/student";
import type { ConsentKind, OutcomeTier } from "@shared/taxonomy";
import { NO_PRIVATE_CONFIG, PRIVATE_CONFIG_KEYS, type BandGateFlags, type OutcomePrivateConfig, type SummaryReport } from "@shared/readiness/outcomes";
import type { Db } from "@server/db/client";
import { uuidv7 } from "@server/db/columns";
import { accessAuditInsert } from "@server/db/repos/audit";
import { isConsentRequired, isUniqueViolation, runBatch, type Stmt } from "@server/db/repos/common";
import { outcomeSnapshot, toOutcomeReport } from "@server/db/repos/outcomes";
import { getProfile } from "@server/db/repos/students";
import * as s from "@server/db/schema";
import type { OutcomeCycleFacts, OutcomesStore, OutcomeWrite, OwnOutcome, SummaryProgram, WriteResult } from "./ports";
import * as bandsRepo from "@server/db/repos/bands";

/**
 * D1 binding of the Outcome ports. Reads and writes the `outcomes` and `outcome_stages` tables
 * through drizzle; the audience triggers in the guards migration refuse status-defined programs
 * and identity-defined ones without consent even if a route check were missed.
 *
 * Holds: plan 7.9.1 proposes an `outcome_cycle_holds` table, which does not exist yet. Until it
 * does, a cycle is held while a live `outcome_anomaly` ReviewTask on it carries the
 * `outcome_over_count` reason (written by the outcomes.quality job).
 */

export const OVER_COUNT_REASON = "outcome_over_count";

export interface D1OutcomesOptions {
  /** Pseudonymous access_audit subject key (HMAC of the user id); null skips the audit row. */
  readonly subjectKey?: (userId: string) => Promise<string>;
  /** Gates of the stored band model covering this program, if any. */
  readonly bandGates?: (programId: string) => Promise<BandGateFlags | null>;
}

async function stagesFor(db: Db, outcomeId: string) {
  return db
    .select({ stage: s.outcomeStages.stage, onDate: s.outcomeStages.onDate })
    .from(s.outcomeStages)
    .where(eq(s.outcomeStages.outcomeId, outcomeId))
    .orderBy(asc(s.outcomeStages.stage));
}

function stageOrder(stages: { stage: string; onDate: string | null }[]) {
  const order = ["submitted", "campus_nominated", "not_nominated", "interview_invited", "interviewed", "waitlisted"];
  return [...stages].sort((a, b) => order.indexOf(a.stage) - order.indexOf(b.stage));
}

export async function readPrivateConfig(db: Db): Promise<OutcomePrivateConfig> {
  const rows = await db
    .select({ key: s.config.key, value: s.config.value })
    .from(s.config)
    .where(inArray(s.config.key, [PRIVATE_CONFIG_KEYS.overCountFraction, PRIVATE_CONFIG_KEYS.seasonalCap]));
  const num = (key: string): number | null => {
    const v = rows.find((r) => r.key === key)?.value;
    return typeof v === "number" && Number.isFinite(v) && v > 0 ? v : null;
  };
  return rows.length === 0 ? NO_PRIVATE_CONFIG : { overCountFraction: num(PRIVATE_CONFIG_KEYS.overCountFraction), seasonalCap: num(PRIVATE_CONFIG_KEYS.seasonalCap) };
}

/** Curated cycle facts (no Outcome-derived field is read here). */
export async function readCycleFacts(db: Db, programCycleId: string): Promise<OutcomeCycleFacts | null> {
  const [row] = await db
    .select({
      programCycleId: s.programCycles.id,
      cycleKey: s.programCycles.cycleKey,
      programId: s.programs.id,
      programSlug: s.programs.slug,
      organizationId: s.programs.organizationId,
      sensitiveAudience: s.programs.sensitiveAudience,
      identityAudience: s.programs.identityAudience,
      decisionWindowStart: s.programCycles.decisionWindowStart,
      decisionWindowEnd: s.programCycles.decisionWindowEnd,
      classYears: s.programCycles.classYears,
    })
    .from(s.programCycles)
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .where(eq(s.programCycles.id, programCycleId))
    .limit(1);
  if (!row) return null;
  const [dls, noms] = await db.batch([
    db
      .select({ kind: s.deadlines.kind, precision: s.deadlines.precision, localDate: s.deadlines.localDate, scope: s.deadlines.scope })
      .from(s.deadlines)
      .where(and(eq(s.deadlines.programCycleId, programCycleId), isNull(s.deadlines.withdrawnAt))),
    db
      .select({ n: sql<number>`count(*)` })
      .from(s.requirements)
      .where(and(eq(s.requirements.programCycleId, programCycleId), eq(s.requirements.kind, "campus_nomination"))),
  ]);
  const rounds = dls
    .filter((d) => d.scope === "national" && (d.kind === "application" || d.kind === "priority_round") && d.localDate && /^\d{4}-\d{2}-\d{2}$/.test(d.localDate))
    .map((d) => d.localDate!)
    .sort();
  return {
    programCycleId: row.programCycleId,
    cycleKey: row.cycleKey,
    programId: row.programId,
    programSlug: row.programSlug,
    organizationId: row.organizationId,
    sensitiveAudience: Boolean(row.sensitiveAudience),
    identityAudience: (row.identityAudience ?? []).length > 0,
    decisionWindowStart: row.decisionWindowStart,
    decisionWindowEnd: row.decisionWindowEnd,
    classYears: row.classYears ?? [],
    // No rolling_decisions column yet: a rolling application deadline is the nearest signal.
    rollingDecisions: dls.some((d) => d.precision === "rolling"),
    nominationRequired: Number(noms[0]?.n ?? 0) > 0 || dls.some((d) => d.kind === "nomination" || d.kind === "campus_internal"),
    earliestRoundDeadline: rounds[0] ?? null,
  };
}

export function createD1OutcomesStore(db: Db, opts: D1OutcomesOptions = {}): OutcomesStore {
  async function ownRow(userId: string, publicId: string) {
    return db.query.outcomes.findFirst({ where: and(eq(s.outcomes.publicId, publicId), eq(s.outcomes.userId, userId), isNull(s.outcomes.deletedAt)) });
  }
  async function reportFor(row: typeof s.outcomes.$inferSelect): Promise<OutcomeReport> {
    return toOutcomeReport(row, stageOrder(await stagesFor(db, row.id)));
  }

  return {
    cycleFacts: (id) => readCycleFacts(db, id),

    async tracking(userId, programCycleId) {
      const row = await db.query.trackerItems.findFirst({
        where: and(eq(s.trackerItems.userId, userId), eq(s.trackerItems.programCycleId, programCycleId), isNull(s.trackerItems.deletedAt)),
      });
      return row ? { status: row.status, submittedOn: row.submittedOn } : null;
    },

    async profile(userId): Promise<StudentProfile | null> {
      return (await getProfile(db, userId))?.profile ?? null;
    },

    async hasConsent(userId, kind: ConsentKind, scopeId = null) {
      const conds = [eq(s.consents.userId, userId), eq(s.consents.kind, kind), isNull(s.consents.revokedAt)];
      if (scopeId) conds.push(eq(s.consents.scopeId, scopeId));
      const row = await db.select({ id: s.consents.id }).from(s.consents).where(and(...conds)).limit(1);
      return row.length > 0;
    },

    async sponsorAffiliated(userId, organizationId) {
      const row = await db
        .select({ id: s.userRoles.id })
        .from(s.userRoles)
        .where(and(eq(s.userRoles.userId, userId), eq(s.userRoles.role, "sponsor_admin"), eq(s.userRoles.organizationId, organizationId), isNull(s.userRoles.revokedAt)))
        .limit(1);
      return row.length > 0;
    },

    // Edu-email verification (POST /api/v1/me/edu-verification) is not built, so every report is
    // self_reported: stored and counted toward the report goal, never in a displayed aggregate.
    async verifiedTier(): Promise<OutcomeTier> {
      return "self_reported";
    },

    async otherReportsSince(userId, excludingCycleId, sinceMs) {
      const rows = await db
        .select({ n: sql<number>`count(*)` })
        .from(s.outcomes)
        .where(and(eq(s.outcomes.userId, userId), ne(s.outcomes.programCycleId, excludingCycleId), isNull(s.outcomes.deletedAt), gte(s.outcomes.createdAt, sinceMs)));
      return Number(rows[0]?.n ?? 0);
    },

    privateConfig: () => readPrivateConfig(db),

    async listOwn(userId) {
      const rows = await db
        .select()
        .from(s.outcomes)
        .where(and(eq(s.outcomes.userId, userId), isNull(s.outcomes.deletedAt)))
        .orderBy(desc(s.outcomes.createdAt));
      return Promise.all(rows.map(reportFor));
    },

    async getOwn(userId, publicId): Promise<OwnOutcome | null> {
      const row = await ownRow(userId, publicId);
      return row ? { report: await reportFor(row), flagCodes: row.flagCodes ?? [] } : null;
    },

    async create(userId, write: OutcomeWrite, profile, now): Promise<WriteResult> {
      const id = uuidv7(now);
      const data = write.input;
      const stmts: Stmt[] = [
        db.insert(s.outcomes).values({
          id,
          userId,
          programCycleId: data.programCycleId,
          tier: write.tier,
          decision: data.decision,
          decidedOn: data.decidedOn,
          ...outcomeSnapshot(profile),
          priorFeeder: data.priorFeeder,
          qualityState: write.flags.length > 0 ? "flagged" : "ok",
          flagCodes: [...write.flags],
          createdAt: now,
          updatedAt: now,
        }),
      ];
      if (data.stages.length) stmts.push(db.insert(s.outcomeStages).values(data.stages.map((st) => ({ outcomeId: id, stage: st.stage, onDate: st.on, createdAt: now }))));
      try {
        await runBatch(db, stmts);
      } catch (err) {
        if (isUniqueViolation(err)) return { ok: false, error: "conflict" };
        if (isConsentRequired(err)) return { ok: false, error: "consent_required" };
        throw err;
      }
      const row = await db.query.outcomes.findFirst({ where: eq(s.outcomes.id, id) });
      return row ? { ok: true, value: await reportFor(row) } : { ok: false, error: "not_found" };
    },

    async update(userId, publicId, patch: OutcomeReportUpdate, flags, now): Promise<WriteResult> {
      const row = await ownRow(userId, publicId);
      if (!row) return { ok: false, error: "not_found" };
      const set: Partial<typeof s.outcomes.$inferInsert> = { updatedAt: now, flagCodes: [...flags], qualityState: flags.length > 0 ? "flagged" : "ok" };
      if (patch.decision !== undefined) set.decision = patch.decision;
      if (patch.decidedOn !== undefined) set.decidedOn = patch.decidedOn;
      if (patch.priorFeeder !== undefined) set.priorFeeder = patch.priorFeeder;
      const stmts: Stmt[] = [db.update(s.outcomes).set({ ...set, version: sql`${s.outcomes.version} + 1` }).where(eq(s.outcomes.id, row.id))];
      if (patch.stages !== undefined) {
        stmts.push(db.delete(s.outcomeStages).where(eq(s.outcomeStages.outcomeId, row.id)));
        if (patch.stages.length) stmts.push(db.insert(s.outcomeStages).values(patch.stages.map((st) => ({ outcomeId: row.id, stage: st.stage, onDate: st.on, createdAt: now }))));
      }
      await runBatch(db, stmts);
      const fresh = await db.query.outcomes.findFirst({ where: eq(s.outcomes.id, row.id) });
      return fresh ? { ok: true, value: await reportFor(fresh) } : { ok: false, error: "not_found" };
    },

    async auditEdit(userId, fields, now, requestId) {
      if (!opts.subjectKey) return;
      await accessAuditInsert(db, {
        at: now,
        actor: { kind: "user", ref: "self" },
        action: "update",
        purpose: "outcome_edit",
        fields: fields.map((f) => `outcome.${f}`),
        subjectKey: await opts.subjectKey(userId),
        requestId,
      });
    },

    async summaryProgram(slug): Promise<SummaryProgram | null> {
      const program = await db.query.programs.findFirst({ where: and(eq(s.programs.slug, slug), eq(s.programs.isPublished, true)) });
      if (!program) return null;
      const cycles = await db
        .select({ id: s.programCycles.id, cycleKey: s.programCycles.cycleKey })
        .from(s.programCycles)
        .where(eq(s.programCycles.programId, program.id))
        .orderBy(desc(s.programCycles.cycleKey));
      return { programId: program.id, slug: program.slug, sensitiveAudience: Boolean(program.sensitiveAudience), isSample: Boolean(program.isSample), cycles };
    },

    async summaryReports(programCycleId, createdBeforeMs): Promise<SummaryReport[]> {
      const rows = await db
        .select({ id: s.outcomes.id, tier: s.outcomes.tier, qualityState: s.outcomes.qualityState, decision: s.outcomes.decision, decidedOn: s.outcomes.decidedOn })
        .from(s.outcomes)
        .where(and(eq(s.outcomes.programCycleId, programCycleId), isNull(s.outcomes.deletedAt), sql`${s.outcomes.createdAt} < ${createdBeforeMs}`));
      if (rows.length === 0) return [];
      const stages = await db
        .select({ outcomeId: s.outcomeStages.outcomeId, stage: s.outcomeStages.stage, onDate: s.outcomeStages.onDate })
        .from(s.outcomeStages)
        .where(inArray(s.outcomeStages.outcomeId, rows.map((r) => r.id)));
      // Rows stay inside this function: only their aggregate-relevant fields go back, and the
      // caller hands them straight to shared/disclosure.
      return rows.map((r) => ({
        tier: r.tier,
        qualityState: r.qualityState === "flagged" ? "flagged" : "ok",
        decision: r.decision as SummaryReport["decision"],
        decidedOn: r.decidedOn,
        stages: stages.filter((st) => st.outcomeId === r.id).map((st) => ({ stage: st.stage as SummaryReport["stages"][number]["stage"], on: st.onDate })),
      }));
    },

    // A live outcome_cycle_holds row, or (during the transition) a live over-count task.
    async cycleHeld(programCycleId) {
      return bandsRepo.cycleHeld(db, programCycleId);
    },

    async bandGates(programId) {
      return opts.bandGates ? opts.bandGates(programId) : null;
    },
  };
}
