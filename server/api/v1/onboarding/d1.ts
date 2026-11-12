import { z } from "zod";
import type { RoadmapItem } from "@shared/contracts";
import { effectiveDeadline } from "@shared/onboarding/feasibility";
import { PRODUCT } from "@shared/config/product";
import { addDays, localDateIn } from "@shared/time";
import type { Db } from "@server/db/client";
import * as onboarding from "@server/db/repos/onboarding";
import * as registry from "@server/db/repos/registry";
import * as students from "@server/db/repos/students";
import { OnboardingPreferencesSchema, OnboardingSignalsSchema, STEP_PATTERN } from "./schemas";
import type { CatalogEntry, FirstDoorRecord, OnboardingRecord, OnboardingRepos, ResolvedDeadline } from "./ports";

/**
 * D1 adapters for the onboarding ports. Thin: every query lives in server/db/repos. Stored JSON
 * is validated with the shared schemas on the way in (the route already did) and on the way out
 * (a hand-edited or outdated row reads as "not answered", never as a crash or a leak).
 */

// ---------------------------------------------------------------------------------------------
// Catalog: published programs from the registry repos, with cycles, requirements and deadlines
// ---------------------------------------------------------------------------------------------

/**
 * Effective deadline per cycle, resolved in the cycle's own zone with shared/onboarding's rule
 * (the one the browser's cards and plans use): next unexpired application deadline, campus
 * estimates E1/E2 for nomination-gated cycles. A cycle whose deadlines have all passed gets
 * yesterday, so `deadlinePassed` refuses it.
 */
export function resolveCycleDeadline(
  deadlines: Parameters<typeof effectiveDeadline>[0]["deadlines"],
  nominationRequired: boolean,
  nowMs: number,
  timeZone: string,
): ResolvedDeadline & { readonly passed: boolean } {
  const today = localDateIn(nowMs, timeZone);
  const ed = effectiveDeadline({ deadlines, flags: { nominationRequired } }, nowMs, timeZone, today);
  if (ed === "passed") return { on: addDays(today, -1), basis: "official", passed: true };
  return { on: ed.date, basis: ed.basis, passed: false };
}

/** Builds catalog entries from one registry snapshot (published programs, or the given ids). */
export async function loadCatalog(db: Db, now: Date, programIds?: readonly string[]): Promise<CatalogEntry[]> {
  const nowMs = now.getTime();
  const snap = await registry.loadRegistrySnapshot(db, programIds ? { programIds } : {});
  const out: CatalogEntry[] = [];
  for (const row of snap.programs) {
    if (!row.isPublished) continue;
    const card = registry.buildProgramCard(snap, row, nowMs);
    if (!card) continue;
    const program = registry.toProgram(row, {
      types: snap.types.get(row.id) ?? [],
      aliases: snap.aliases.get(row.id) ?? [],
      tags: snap.tags.get(row.id) ?? [],
      majorFamilies: snap.majorFamilies.get(row.id) ?? [],
    });
    const cycleRows = snap.cyclesByProgram.get(row.id) ?? [];
    const cycles = cycleRows.map((c) => registry.toCycle(c, snap.handles));
    const requirements = cycleRows.flatMap((c) => (snap.requirementsByCycle.get(c.id) ?? []).map((r) => registry.toRequirement(r, null)));
    const deadlines: Record<string, string | null> = {};
    const resolved: Record<string, ResolvedDeadline> = {};
    for (const c of cycleRows) {
      const views = (snap.deadlinesByCycle.get(c.id) ?? []).filter((d) => d.scope === "national").map(registry.toDeadlineView);
      const nomination =
        card.programCycleId === c.id
          ? card.flags.nominationRequired
          : views.some((d) => d.kind === "nomination" || d.kind === "campus_internal");
      const r = resolveCycleDeadline(views, nomination, nowMs, c.timeZone ?? PRODUCT.fallbackTimeZone);
      deadlines[c.id] = r.on;
      resolved[c.id] = { on: r.on, basis: r.basis };
    }
    out.push({ program, cycles, requirements, deadlines, resolved, card });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The onboarding record
// ---------------------------------------------------------------------------------------------

const FirstDoorRecordSchema = z
  .object({
    programId: z.string().max(64),
    programCycleId: z.string().max(64),
    trackerItemId: z.string().max(64),
    steps: z
      .array(
        z
          .object({
            id: z.string().max(40),
            title: z.string().max(200),
            kind: z.string().max(40),
            minutes: z.number().int().min(0).max(600),
            due: z.string().max(10).nullable(),
          })
          .strict(),
      )
      .max(20)
      .optional(),
  })
  .strict();

function readRecord(row: onboarding.OnboardingRow): OnboardingRecord {
  const preferences = OnboardingPreferencesSchema.safeParse(row.preferences);
  const signals = OnboardingSignalsSchema.safeParse(row.signals);
  const firstDoor = FirstDoorRecordSchema.safeParse(row.firstDoor);
  return {
    preferences: preferences.success ? preferences.data : null,
    signals: signals.success ? signals.data : null,
    step: row.step !== null && STEP_PATTERN.test(row.step) ? row.step : null,
    completedAt: row.completedAt === null ? null : new Date(row.completedAt).toISOString(),
    firstDoor: firstDoor.success ? (firstDoor.data as FirstDoorRecord) : null,
    updatedAt: new Date(row.updatedAt).toISOString(),
  };
}

function writeRecord(record: OnboardingRecord): onboarding.OnboardingWrite {
  // Re-validate so nothing outside the shared shapes is ever stored, whatever the caller built.
  const preferences = record.preferences ? OnboardingPreferencesSchema.parse(record.preferences) : null;
  const signals = record.signals ? OnboardingSignalsSchema.parse(record.signals) : null;
  const firstDoor = record.firstDoor ? FirstDoorRecordSchema.parse(record.firstDoor) : null;
  return {
    preferences: preferences as Record<string, unknown> | null,
    signals: signals as Record<string, unknown> | null,
    step: record.step,
    completedAt: record.completedAt === null ? null : Date.parse(record.completedAt),
    firstDoor: firstDoor as Record<string, unknown> | null,
  };
}

// ---------------------------------------------------------------------------------------------
// Repos
// ---------------------------------------------------------------------------------------------

function roadmapRow(item: RoadmapItem): onboarding.RoadmapRowWrite {
  return { itemKey: item.itemKey, programId: item.programId, pinned: item.pinned, state: item.state === "done" ? "done" : "open" };
}

export function createD1OnboardingRepos(db: Db, clock: () => number = Date.now): OnboardingRepos {
  return {
    profiles: {
      get: async (userId) => (await students.getProfile(db, userId))?.profile ?? null,
      update: async (userId, patch) => {
        const result = await students.updateProfile(db, userId, patch, clock());
        if (!result.ok) throw new Error(`profile update failed: ${result.error}`);
        return result.value;
      },
      getOnboarding: async (userId) => {
        const row = await onboarding.getOnboardingRecord(db, userId);
        return row ? readRecord(row) : null;
      },
      saveOnboarding: (userId, record) => onboarding.saveOnboardingRecord(db, userId, writeRecord(record), clock()),
      markOnboarded: (userId) => students.markOnboarded(db, userId, clock()),
    },
    programs: {
      listMatchable: (now) => loadCatalog(db, now),
      getEntry: async (programId) => (await loadCatalog(db, new Date(clock()), [programId]))[0] ?? null,
    },
    tracker: {
      findByCycle: async (userId, programCycleId) =>
        (await students.listTrackerItems(db, userId)).find((t) => t.programCycleId === programCycleId) ?? null,
      create: async (userId, input) => {
        const result = await students.addTrackerItem(db, userId, input, clock());
        if (!result.ok) throw new Error(`tracker create failed: ${result.error}`);
        return result.value;
      },
    },
    consents: {
      // Matches the audience triggers (0002_guards) and outcomes/d1.ts: identity_tracking is one
      // account-wide consent, so any live one counts; the status opt-in (sensitive_tracking) is
      // per program.
      has: async (userId, kind, programId) =>
        (await students.listConsents(db, userId)).some(
          (c) => c.kind === kind && c.revokedAt === null && (kind === "identity_tracking" || c.programId === programId),
        ),
    },
    roadmap: {
      upsertStudentItems: async (userId, items) => {
        const result = await onboarding.upsertRoadmapRows(db, userId, items.map(roadmapRow), clock());
        // Status-defined programs take no roadmap actions at all (audience trigger, by design):
        // the tracker item and its reminders still carry the plan.
        if (!result.ok && result.error !== "consent_required") throw new Error(`roadmap upsert failed: ${result.error}`);
      },
    },
    reminders: {
      schedule: (userId, drafts) => onboarding.scheduleReminders(db, userId, drafts, clock()),
    },
  };
}
