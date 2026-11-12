import { and, asc, eq, inArray, isNull } from "drizzle-orm";
import type { InstitutionCalendar, InstitutionLevel } from "@shared/taxonomy";
import type { Requirement } from "@shared/contracts";
import { search } from "@shared/matching";
import { isIsoDate } from "@shared/time/iso";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { fail } from "@server/db/repos/common";
import * as notifications from "@server/db/repos/notifications";
import * as onboarding from "@server/db/repos/onboarding";
import * as registry from "@server/db/repos/registry";
import * as students from "@server/db/repos/students";
import { CardCache, createD1RegistryStore } from "../registry";
import type { CycleFacts, ProgramFacts, ReadinessSource, RoadmapPlanStep, RoadmapState, StudentStore, TrackedCycle } from "./ports";

/**
 * The D1 StudentStore: thin adapters over server/db/repos plus two joined reads (tracked cycles
 * and one cycle's readiness inputs). Every query is keyed by the signed-in user's internal id or
 * by public registry ids; nothing here reads or writes a status or identity answer.
 */

type ProgramRow = typeof s.programs.$inferSelect;
type CycleRow = typeof s.programCycles.$inferSelect;

/** One card set and search index per isolate for Ask Novus retrieval (same policy as the registry routes). */
const askCards = new CardCache();

function programFacts(row: ProgramRow, organizationName: string, cycleCount: number): ProgramFacts {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    organizationName,
    officialUrl: row.officialUrl,
    summary: row.summary,
    sensitiveAudience: row.sensitiveAudience,
    isSample: row.isSample,
    newProgram: cycleCount <= 1,
  };
}

function cycleFacts(row: CycleRow): CycleFacts {
  return {
    id: row.id,
    cycleKey: row.cycleKey,
    opensOn: row.opensOn,
    predictedOpensOn: row.predictedOpensOn,
    applicationUrl: row.applicationUrl,
  };
}

/** Official stage odds for a cycle (verified official counts only; program-level facts). */
async function stageOddsFor(db: Db, cycle: CycleRow, handles: ReadonlyMap<string, string>) {
  const rows = await db.select().from(s.programCycleCounts).where(eq(s.programCycleCounts.programCycleId, cycle.id));
  if (rows.length === 0) return [];
  const evidence = await registry.liveEvidence(db, "program_cycle_count", rows.map((r) => r.id));
  const counts = rows.map((r) => {
    const ev = evidence.find((e) => e.entityId === r.id);
    return registry.toCount(r, ev ? registry.toEvidenceQuote(ev) : null);
  });
  const verifiedBy = cycle.verifiedBy ? (handles.get(cycle.verifiedBy) ?? null) : null;
  return registry.stageOddsFromCounts(counts, cycle.cycleKey, verifiedBy);
}

async function sourceFor(db: Db, program: ProgramRow, cycle: CycleRow): Promise<ReadinessSource | null> {
  if (!program.isPublished) return null;
  const [org, cycles, deadlines, requirements, ruleSet, handles] = await Promise.all([
    db.query.organizations.findFirst({ where: eq(s.organizations.id, program.organizationId) }),
    registry.listCycles(db, program.id),
    registry.listLiveDeadlines(db, [cycle.id]),
    registry.listRequirements(db, cycle.id),
    registry.getVerifiedRuleSet(db, cycle.id),
    registry.curatorHandles(db),
  ]);
  return {
    program: programFacts(program, org?.name ?? "", cycles.length),
    cycle: cycleFacts(cycle),
    deadlines,
    requirements,
    requirementsChecked: requirements.length > 0 && requirements.every((r) => r.verificationState === "verified"),
    ruleSet,
    stageOdds: await stageOddsFor(db, cycle, handles),
  };
}

async function trackedCycles(db: Db, userId: string): Promise<TrackedCycle[]> {
  const items = await students.listTrackerItems(db, userId);
  if (items.length === 0) return [];
  const cycleIds = [...new Set(items.map((i) => i.programCycleId))];
  const [rows, deadlines, requirementRows] = await Promise.all([
    db
      .select({ cycle: s.programCycles, program: s.programs, orgName: s.organizations.name })
      .from(s.programCycles)
      .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
      .innerJoin(s.organizations, eq(s.organizations.id, s.programs.organizationId))
      .where(inArray(s.programCycles.id, cycleIds)),
    registry.listLiveDeadlines(db, cycleIds),
    db
      .select()
      .from(s.requirements)
      .where(and(inArray(s.requirements.programCycleId, cycleIds), isNull(s.requirements.withdrawnAt)))
      .orderBy(asc(s.requirements.sortOrder)),
  ]);
  const byCycle = new Map(rows.map((r) => [r.cycle.id, r]));
  const requirements = requirementRows.map((r) => registry.toRequirement(r, null));
  const out: TrackedCycle[] = [];
  for (const item of items) {
    const row = byCycle.get(item.programCycleId);
    if (!row) continue;
    out.push({
      item,
      // Cycle count is not needed for roadmap rows; 2 keeps newProgram false without a query per item.
      program: programFacts(row.program, row.orgName, 2),
      cycle: cycleFacts(row.cycle),
      deadlines: deadlines.filter((d) => d.programCycleId === item.programCycleId),
      requirements: requirements.filter((r: Requirement) => r.programCycleId === item.programCycleId),
    });
  }
  return out;
}

/**
 * The first-door plan steps from the onboarding record (written by POST /onboarding/first-door
 * with each step's title and due date). Anything malformed is skipped, never thrown.
 */
export function planStepsFrom(firstDoor: Record<string, unknown> | null): RoadmapPlanStep[] {
  if (!firstDoor) return [];
  const { programId, programCycleId, steps } = firstDoor as { programId?: unknown; programCycleId?: unknown; steps?: unknown };
  if (typeof programId !== "string" || typeof programCycleId !== "string" || !Array.isArray(steps)) return [];
  const out: RoadmapPlanStep[] = [];
  for (const step of steps.slice(0, 20)) {
    if (!step || typeof step !== "object") continue;
    const { id, title, kind, due } = step as { id?: unknown; title?: unknown; kind?: unknown; due?: unknown };
    if (typeof id !== "string" || !/^[A-Za-z0-9_.-]{1,40}$/.test(id) || typeof title !== "string" || typeof kind !== "string") continue;
    out.push({ programId, programCycleId, stepId: id, title: title.slice(0, 200), kind, due: typeof due === "string" && isIsoDate(due) ? due : null });
  }
  return out;
}

async function roadmapState(db: Db, userId: string): Promise<RoadmapState> {
  const [state, record] = await Promise.all([students.getRoadmapState(db, userId), onboarding.getOnboardingRecord(db, userId)]);
  return {
    templateKey: state.templateKey,
    lastShownItemKeys: state.lastShownItemKeys,
    actions: new Map([...state.actions].map(([key, a]) => [key, { pinned: a.pinned, state: a.state }])),
    planSteps: planStepsFrom((record?.firstDoor as Record<string, unknown> | null | undefined) ?? null),
  };
}

export function createD1StudentStore(db: Db): StudentStore {
  return {
    getProfile: async (userId) => (await students.getProfile(db, userId))?.profile ?? null,
    updateProfile: (userId, update, now) => students.updateProfile(db, userId, update, now),

    listTracker: (userId) => students.listTrackerItems(db, userId),
    addTracker: async (userId, input, now) => {
      // An unknown or unpublished cycle is a 404, not a foreign-key error.
      const ctx = await registry.getCycleContext(db, input.programCycleId);
      if (!ctx || !ctx.program.isPublished) return fail("not_found");
      return students.addTrackerItem(db, userId, input, now);
    },
    updateTracker: (userId, itemId, update, now) => students.updateTrackerItem(db, userId, itemId, update, now),
    removeTracker: (userId, itemId, now) => students.removeTrackerItem(db, userId, itemId, now),
    trackedCycles: (userId) => trackedCycles(db, userId),

    getNotificationPrefs: (userId) => notifications.getNotificationPrefs(db, userId),
    saveNotificationPrefs: (userId, prefs, now) => notifications.saveNotificationPrefs(db, userId, prefs, now),

    listConsents: (userId) => students.listConsents(db, userId),
    changeConsent: (userId, change, now) => students.changeConsent(db, userId, change, now),

    listRequirementProgress: (userId) => students.listRequirementProgress(db, userId),
    setRequirementProgress: (userId, update, now) => students.setRequirementProgress(db, userId, update, now),

    getRoadmapState: (userId) => roadmapState(db, userId),
    recordRoadmapAction: (userId, itemKey, action, programId, now) => students.recordRoadmapAction(db, userId, itemKey, action, programId, now),
    saveRoadmapVisit: (userId, keys, templateKey, now) => students.saveRoadmapVisit(db, userId, keys, templateKey, now),

    readinessSource: async (programCycleId) => {
      const ctx = await registry.getCycleContext(db, programCycleId);
      return ctx ? sourceFor(db, ctx.program, ctx.cycle) : null;
    },
    readinessSourceBySlug: async (slug) => {
      const resolved = await registry.resolveProgramSlug(db, slug);
      if (!resolved) return null;
      const cycle = registry.pickCurrentCycle(await registry.listCycles(db, resolved.program.id));
      return cycle ? sourceFor(db, resolved.program, cycle) : null;
    },
    institution: async (institutionId) => {
      const row = await registry.getInstitution(db, institutionId);
      if (!row) return null;
      return {
        id: row.id,
        level: row.level as InstitutionLevel,
        calendar: row.calendar as InstitutionCalendar | null,
        academicYearStartMonth: row.academicYearStartMonth,
      };
    },
    participates: async (programId, institutionId) => (await registry.institutionParticipates(db, programId, institutionId)) === true,

    rotateCalendarFeed: async (userId, tokenHash, now) => {
      // Account-wide titles stay named; each tracker item's nameInMessages still applies per event.
      await notifications.rotateCalendarFeed(db, userId, tokenHash, false, now);
    },

    listInbox: (userId, now, opts) => notifications.listInbox(db, userId, now, opts),
    markInboxRead: (userId, alertId, now) => notifications.markAlertRead(db, userId, alertId, now),

    deleteAccount: (userId, now) => students.softDeleteUser(db, userId, now),

    searchCards: async (query, now, limit) => {
      const set = await askCards.get(createD1RegistryStore(db), now);
      return search(set.index(), query, { limit, now }).map((hit) => hit.card);
    },
  };
}
