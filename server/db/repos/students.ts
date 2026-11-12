import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import {
  EMPTY_STUDENT_PROFILE,
  StudentProfileUpdateSchema,
  TrackerItemCreateSchema,
  TrackerItemUpdateSchema,
  RequirementProgressUpdateSchema,
  type ConsentChange,
  type ConsentRecord,
  type RequirementProgress,
  type StudentProfile,
  type StudentProfileUpdate,
  type TrackerItem,
  type TrackerItemCreate,
  type TrackerItemUpdate,
} from "../../../shared/contracts/student";
import { findSensitiveKeys } from "../../../shared/contracts/sensitive";
import { hasSensitive } from "../../../shared/resume/sensitive";
import type { RoadmapItemAction } from "../../../shared/contracts/roadmap";
import type { Role } from "../../../shared/taxonomy";
import type { Db } from "../client";
import * as s from "../schema";
import { uuidv7 } from "../columns";
import { iso, isoOrNull } from "../util";
import { classifyWriteError, fail, ok, runBatch, type RepoResult, type Stmt } from "./common";

/**
 * Student-owned records: profile, tracker, requirement progress, roadmap actions, consents and
 * account deletion. The profile holds non-sensitive fields only; every write path refuses a
 * body with a status or identity key before touching the database (defence in depth: the route
 * rejects it first). Rows that link a student to a status- or identity-defined program are
 * refused by the audience triggers unless a live consent covers them.
 */

type ProfileRow = typeof s.studentProfiles.$inferSelect;
type TrackerRow = typeof s.trackerItems.$inferSelect;

function rejectSensitive(value: unknown): RepoResult<never> | null {
  return findSensitiveKeys(value).length > 0 ? fail("invalid", "sensitive_field_rejected") : null;
}

/**
 * Free-text tags that state a status or identity ("DACA recipient", "first gen"). Key checks
 * cannot see these, so each value is run through two detectors: the browser's tag rule (the tag
 * read as a field name, client/src/pages/onboarding/model.ts checkTag) and the shared resume
 * lexicon (@shared/resume/sensitive), which knows phrases. Returns the indexes of refused tags,
 * never the values, so callers can refuse without echoing them.
 */
export function sensitiveTagValues(tags: readonly string[]): number[] {
  const refused: number[] = [];
  tags.forEach((raw, i) => {
    const tag = raw.trim().replace(/\s+/g, " ").toLowerCase();
    const asKey = tag.replace(/[^a-z0-9]+/g, "_");
    const keyHit = findSensitiveKeys({ [asKey]: true, [asKey.replace(/_/g, "")]: true }).length > 0;
    if (keyHit || hasSensitive(tag)) refused.push(i);
  });
  return refused;
}

// =============================================================================================
// Users and roles
// =============================================================================================

export async function getUserById(db: Db, userId: string) {
  return db.query.users.findFirst({ where: and(eq(s.users.id, userId), isNull(s.users.deletedAt)) });
}

export async function getUserByPublicId(db: Db, publicId: string) {
  return db.query.users.findFirst({ where: and(eq(s.users.publicId, publicId), isNull(s.users.deletedAt)) });
}

/** Live roles; every account is a student, plus any granted role. */
export async function getUserRoles(db: Db, userId: string): Promise<Role[]> {
  const rows = await db
    .select({ role: s.userRoles.role })
    .from(s.userRoles)
    .where(and(eq(s.userRoles.userId, userId), isNull(s.userRoles.revokedAt)));
  return [...new Set<Role>(["student", ...rows.map((r) => r.role as Role)])];
}

export async function grantRole(db: Db, userId: string, role: Role, now: number, scope: { workspaceId?: string; organizationId?: string } = {}, grantedBy?: string) {
  await db
    .insert(s.userRoles)
    .values({ id: uuidv7(now), userId, role, workspaceId: scope.workspaceId ?? null, organizationId: scope.organizationId ?? null, grantedBy: grantedBy ?? null, createdAt: now })
    .onConflictDoNothing();
}

/** Written at most once a day (the inactive-account retention rule needs only day precision). */
export async function touchLastActive(db: Db, userId: string, now: number): Promise<void> {
  await db
    .update(s.users)
    .set({ lastActiveAt: now })
    .where(and(eq(s.users.id, userId), sql`coalesce(${s.users.lastActiveAt}, 0) < ${now - 86_400_000}`));
}

// =============================================================================================
// Profile
// =============================================================================================

export function toProfile(row: ProfileRow): StudentProfile {
  return {
    classYear: row.classYear as StudentProfile["classYear"],
    expectedGraduationTerm: row.expectedGraduationTerm,
    institutionId: row.institutionId,
    institutionLevel: row.institutionLevel as StudentProfile["institutionLevel"],
    enrollmentIntensity: row.enrollmentIntensity as StudentProfile["enrollmentIntensity"],
    transferIntent: row.transferIntent as StudentProfile["transferIntent"],
    majorCip: row.majorCip,
    minorCip: row.minorCip,
    majorFamily: row.majorFamily as StudentProfile["majorFamily"],
    gpaBand: row.gpaBand as StudentProfile["gpaBand"],
    residenceState: row.residenceState as StudentProfile["residenceState"],
    timeZone: row.timeZone,
    birthYearMonth: row.birthYearMonth,
    interestTags: row.interestTags,
    preferredOpportunityTypes: row.preferredOpportunityTypes,
    priorExperience: row.priorExperience,
    weeklyPrepHours: row.weeklyPrepHours,
  };
}

export async function getProfile(db: Db, userId: string): Promise<{ profile: StudentProfile; version: number } | null> {
  const row = await db.query.studentProfiles.findFirst({ where: and(eq(s.studentProfiles.userId, userId), isNull(s.studentProfiles.deletedAt)) });
  return row ? { profile: toProfile(row), version: row.version } : null;
}

/** Applies a partial update (creating the profile on first write); returns the full profile. */
export async function updateProfile(db: Db, userId: string, update: StudentProfileUpdate, now: number): Promise<RepoResult<StudentProfile>> {
  const refused = rejectSensitive(update);
  if (refused) return refused;
  // Values too: a status written as a tag must never reach student_profiles, whichever route sent it.
  if (Array.isArray(update.interestTags) && sensitiveTagValues(update.interestTags).length > 0) return fail("invalid", "sensitive_field_rejected");
  const parsed = StudentProfileUpdateSchema.safeParse(update);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; "));
  const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) as Partial<StudentProfile>;
  const insertValues = { ...EMPTY_STUDENT_PROFILE, ...patch };
  await db
    .insert(s.studentProfiles)
    .values({ userId, ...insertValues, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: s.studentProfiles.userId,
      set: { ...patch, deletedAt: null, updatedAt: now, version: sql`${s.studentProfiles.version} + 1` },
    });
  const current = await getProfile(db, userId);
  return current ? ok(current.profile) : fail("not_found");
}

export async function markOnboarded(db: Db, userId: string, now: number): Promise<void> {
  await db.update(s.users).set({ onboardedAt: now }).where(and(eq(s.users.id, userId), isNull(s.users.onboardedAt)));
}

// =============================================================================================
// Tracker
// =============================================================================================

export function toTrackerItem(row: TrackerRow, programSlug: string, cycleKey: string): TrackerItem {
  return {
    id: row.id,
    programCycleId: row.programCycleId,
    programSlug,
    cycleKey,
    status: row.status as TrackerItem["status"],
    statusSource: row.statusSource as TrackerItem["statusSource"],
    ownCampusDeadline: row.ownCampusDeadline,
    submittedOn: row.submittedOn,
    nameInMessages: row.nameInMessages,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
    version: row.version,
  };
}

function trackerSelect(db: Db) {
  return db
    .select({ item: s.trackerItems, slug: s.programs.slug, cycleKey: s.programCycles.cycleKey })
    .from(s.trackerItems)
    .innerJoin(s.programCycles, eq(s.programCycles.id, s.trackerItems.programCycleId))
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId));
}

export async function listTrackerItems(db: Db, userId: string): Promise<TrackerItem[]> {
  const rows = await trackerSelect(db)
    .where(and(eq(s.trackerItems.userId, userId), isNull(s.trackerItems.deletedAt)))
    .orderBy(asc(s.trackerItems.createdAt));
  return rows.map((r) => toTrackerItem(r.item, r.slug, r.cycleKey));
}

export async function getTrackerItem(db: Db, userId: string, itemId: string): Promise<TrackerItem | null> {
  const rows = await trackerSelect(db)
    .where(and(eq(s.trackerItems.id, itemId), eq(s.trackerItems.userId, userId), isNull(s.trackerItems.deletedAt)))
    .limit(1);
  const r = rows[0];
  return r ? toTrackerItem(r.item, r.slug, r.cycleKey) : null;
}

/**
 * Saves a cycle to the tracker. Re-adding a removed item restores it. The audience trigger
 * answers `consent_required` for a sensitive- or identity-audience program without consent.
 */
export async function addTrackerItem(db: Db, userId: string, input: TrackerItemCreate, now: number): Promise<RepoResult<TrackerItem>> {
  const parsed = TrackerItemCreateSchema.safeParse(input);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const data = parsed.data;
  try {
    await db
      .insert(s.trackerItems)
      .values({ id: uuidv7(now), userId, programCycleId: data.programCycleId, status: data.status, nameInMessages: data.nameInMessages, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [s.trackerItems.userId, s.trackerItems.programCycleId],
        set: { deletedAt: null, status: data.status, nameInMessages: data.nameInMessages, updatedAt: now, version: sql`${s.trackerItems.version} + 1` },
        setWhere: sql`${s.trackerItems.deletedAt} IS NOT NULL`,
      });
  } catch (err) {
    return classifyWriteError(err);
  }
  const rows = await trackerSelect(db)
    .where(and(eq(s.trackerItems.userId, userId), eq(s.trackerItems.programCycleId, data.programCycleId)))
    .limit(1);
  const r = rows[0];
  return r ? ok(toTrackerItem(r.item, r.slug, r.cycleKey)) : fail("not_found");
}

/** Optimistic update: a stale `version` answers version_conflict and changes nothing. */
export async function updateTrackerItem(db: Db, userId: string, itemId: string, update: TrackerItemUpdate, now: number): Promise<RepoResult<TrackerItem>> {
  const parsed = TrackerItemUpdateSchema.safeParse(update);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  const { version, ...fields } = parsed.data;
  const set: Partial<typeof s.trackerItems.$inferInsert> = {};
  if (fields.status !== undefined) {
    set.status = fields.status;
    set.statusSource = "student";
  }
  if (fields.ownCampusDeadline !== undefined) set.ownCampusDeadline = fields.ownCampusDeadline;
  if (fields.submittedOn !== undefined) set.submittedOn = fields.submittedOn;
  if (fields.nameInMessages !== undefined) set.nameInMessages = fields.nameInMessages;
  const rows = await db
    .update(s.trackerItems)
    .set({ ...set, updatedAt: now, version: sql`${s.trackerItems.version} + 1` })
    .where(and(eq(s.trackerItems.id, itemId), eq(s.trackerItems.userId, userId), eq(s.trackerItems.version, version), isNull(s.trackerItems.deletedAt)))
    .returning({ id: s.trackerItems.id });
  if (rows.length === 0) {
    const exists = await getTrackerItem(db, userId, itemId);
    return fail(exists ? "version_conflict" : "not_found");
  }
  const item = await getTrackerItem(db, userId, itemId);
  return item ? ok(item) : fail("not_found");
}

/** Soft delete; the row's private campus date disappears from feeds at once. */
export async function removeTrackerItem(db: Db, userId: string, itemId: string, now: number): Promise<boolean> {
  const rows = await db
    .update(s.trackerItems)
    .set({ deletedAt: now, updatedAt: now, version: sql`${s.trackerItems.version} + 1` })
    .where(and(eq(s.trackerItems.id, itemId), eq(s.trackerItems.userId, userId), isNull(s.trackerItems.deletedAt)))
    .returning({ id: s.trackerItems.id });
  if (rows.length === 0) return false;
  // A removed application must not keep sending reminders.
  await db
    .update(s.reminders)
    .set({ state: "cancelled", updatedAt: now })
    .where(and(eq(s.reminders.trackerItemId, itemId), eq(s.reminders.userId, userId), eq(s.reminders.state, "scheduled")));
  return true;
}

// =============================================================================================
// Requirement progress
// =============================================================================================

export async function listRequirementProgress(db: Db, userId: string): Promise<RequirementProgress[]> {
  const rows = await db
    .select()
    .from(s.requirementProgress)
    .where(and(eq(s.requirementProgress.userId, userId), isNull(s.requirementProgress.deletedAt)));
  return rows.map((r) => ({ subjectKey: r.subjectKey, state: r.state as RequirementProgress["state"], updatedAt: iso(r.updatedAt) }));
}

/** Records progress; `req:` subjects carry their cycle so the audience guard applies. */
export async function setRequirementProgress(
  db: Db,
  userId: string,
  update: { subjectKey: string; state: RequirementProgress["state"] },
  now: number,
): Promise<RepoResult<RequirementProgress>> {
  const parsed = RequirementProgressUpdateSchema.safeParse(update);
  if (!parsed.success) return fail("invalid", parsed.error.issues.map((i) => i.message).join("; "));
  let programCycleId: string | null = null;
  if (parsed.data.subjectKey.startsWith("req:")) {
    const req = await db.query.requirements.findFirst({ where: eq(s.requirements.id, parsed.data.subjectKey.slice(4)) });
    if (!req) return fail("not_found");
    programCycleId = req.programCycleId;
  }
  try {
    await db
      .insert(s.requirementProgress)
      .values({ userId, subjectKey: parsed.data.subjectKey, programCycleId, state: parsed.data.state, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [s.requirementProgress.userId, s.requirementProgress.subjectKey],
        set: { state: parsed.data.state, deletedAt: null, updatedAt: now },
      });
  } catch (err) {
    return classifyWriteError(err);
  }
  return ok({ subjectKey: parsed.data.subjectKey, state: parsed.data.state, updatedAt: iso(now) });
}

// =============================================================================================
// Roadmap (plans are computed on read; only the student's own actions are stored)
// =============================================================================================

export interface RoadmapItemActionState {
  pinned: boolean;
  state: "open" | "done" | "dismissed";
}

/** Pure reducer for one action on an item's stored state. */
export function applyRoadmapAction(current: RoadmapItemActionState, action: RoadmapItemAction["action"]): RoadmapItemActionState {
  switch (action) {
    case "pin":
      return { ...current, pinned: true };
    case "unpin":
      return { ...current, pinned: false };
    case "dismiss":
      return { pinned: false, state: "dismissed" };
    case "restore":
      return { ...current, state: "open" };
    case "complete":
      return { ...current, state: "done" };
    case "reopen":
      return { ...current, state: "open" };
  }
}

export async function getRoadmapState(db: Db, userId: string) {
  const [roadmap, items] = await db.batch([
    db.select().from(s.roadmaps).where(and(eq(s.roadmaps.userId, userId), isNull(s.roadmaps.deletedAt))).limit(1),
    db.select().from(s.roadmapItems).where(and(eq(s.roadmapItems.userId, userId), isNull(s.roadmapItems.deletedAt))),
  ]);
  const r = roadmap[0];
  return {
    templateKey: r?.templateKey ?? null,
    lastShownItemKeys: r?.lastShownItemKeys ?? [],
    lastVisitAt: isoOrNull(r?.lastVisitAt),
    actions: new Map(items.map((i) => [i.itemKey, { pinned: i.pinned, state: i.state as RoadmapItemActionState["state"], programId: i.programId }])),
  };
}

/** Remembers which item keys the student saw (drives "changed since your last visit"). */
export async function saveRoadmapVisit(db: Db, userId: string, itemKeys: readonly string[], templateKey: string | null, now: number): Promise<void> {
  await db
    .insert(s.roadmaps)
    .values({ userId, templateKey, lastShownItemKeys: [...itemKeys], lastVisitAt: now, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({ target: s.roadmaps.userId, set: { templateKey, lastShownItemKeys: [...itemKeys], lastVisitAt: now, deletedAt: null, updatedAt: now } });
}

export async function recordRoadmapAction(
  db: Db,
  userId: string,
  itemKey: string,
  action: RoadmapItemAction["action"],
  programId: string | null,
  now: number,
): Promise<RepoResult<RoadmapItemActionState>> {
  const existing = await db.query.roadmapItems.findFirst({ where: and(eq(s.roadmapItems.userId, userId), eq(s.roadmapItems.itemKey, itemKey)) });
  const current: RoadmapItemActionState = existing && existing.deletedAt === null ? { pinned: existing.pinned, state: existing.state as RoadmapItemActionState["state"] } : { pinned: false, state: "open" };
  const next = applyRoadmapAction(current, action);
  try {
    await db
      .insert(s.roadmapItems)
      .values({ userId, itemKey, programId, pinned: next.pinned, state: next.state, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({ target: [s.roadmapItems.userId, s.roadmapItems.itemKey], set: { pinned: next.pinned, state: next.state, programId, deletedAt: null, updatedAt: now } });
  } catch (err) {
    return classifyWriteError(err);
  }
  return ok(next);
}

export async function listRoadmapTemplates(db: Db) {
  return db.select().from(s.roadmapTemplates).orderBy(asc(s.roadmapTemplates.key));
}

// =============================================================================================
// Consents
// =============================================================================================

export async function listConsents(db: Db, userId: string): Promise<ConsentRecord[]> {
  const rows = await db.select().from(s.consents).where(eq(s.consents.userId, userId)).orderBy(asc(s.consents.grantedAt));
  return rows.map((r) => ({
    kind: r.kind as ConsentRecord["kind"],
    textVersion: r.textVersion,
    grantedAt: iso(r.grantedAt),
    revokedAt: isoOrNull(r.revokedAt),
    programId: r.scopeType === "program" ? r.scopeId : null,
  }));
}

/**
 * Grants or revokes one consent. Revoking `sensitive_tracking` (per program) or
 * `identity_tracking` (account-wide) deletes the covered server rows in the same batch, so
 * nothing stays linked without consent; the caller writes the deletion-ledger entry.
 */
export async function changeConsent(db: Db, userId: string, change: ConsentChange, now: number): Promise<RepoResult<true>> {
  // identity_tracking is account-wide (the audience triggers accept any live row of the kind):
  // it is always stored unscoped, and revoking it revokes every live row of the kind, so no
  // program-scoped copy can outlive "Stop saving these on Novus".
  const accountWide = change.kind === "identity_tracking";
  const scopeId = accountWide ? null : (change.programId ?? null);
  const live = and(
    eq(s.consents.userId, userId),
    eq(s.consents.kind, change.kind),
    accountWide ? undefined : scopeId ? eq(s.consents.scopeId, scopeId) : isNull(s.consents.scopeId),
    isNull(s.consents.revokedAt),
  );
  if (change.granted) {
    try {
      await db
        .insert(s.consents)
        .values({
          id: uuidv7(now),
          userId,
          kind: change.kind,
          scopeType: scopeId ? "program" : null,
          scopeId,
          textVersion: change.textVersion,
          method: "dialog",
          grantedAt: now,
        })
        .onConflictDoNothing();
      return ok(true);
    } catch (err) {
      return classifyWriteError(err);
    }
  }
  const stmts: Stmt[] = [db.update(s.consents).set({ revokedAt: now }).where(live)];
  const programFilter =
    change.kind === "sensitive_tracking" && scopeId
      ? sql`${s.programs.id} = ${scopeId}`
      : change.kind === "identity_tracking"
        ? sql`json_array_length(${s.programs.identityAudience}) > 0`
        : null;
  if (programFilter) {
    const cycles = db
      .select({ id: s.programCycles.id })
      .from(s.programCycles)
      .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
      .where(programFilter);
    const programs = db.select({ id: s.programs.id }).from(s.programs).where(programFilter);
    const alerts = db.select({ id: s.alerts.id }).from(s.alerts).where(and(eq(s.alerts.userId, userId), inArray(s.alerts.programCycleId, cycles)));
    const trackers = db.select({ id: s.trackerItems.id }).from(s.trackerItems).where(and(eq(s.trackerItems.userId, userId), inArray(s.trackerItems.programCycleId, cycles)));
    stmts.push(
      db.delete(s.notifications).where(inArray(s.notifications.alertId, alerts)),
      db.delete(s.alerts).where(and(eq(s.alerts.userId, userId), inArray(s.alerts.programCycleId, cycles))),
      db.delete(s.emailActionTokens).where(inArray(s.emailActionTokens.trackerItemId, trackers)),
      db.delete(s.trackerItems).where(and(eq(s.trackerItems.userId, userId), inArray(s.trackerItems.programCycleId, cycles))),
      db.delete(s.requirementProgress).where(and(eq(s.requirementProgress.userId, userId), inArray(s.requirementProgress.programCycleId, cycles))),
      db.delete(s.subscriptions).where(and(eq(s.subscriptions.userId, userId), inArray(s.subscriptions.programCycleId, cycles))),
      db.delete(s.roadmapItems).where(and(eq(s.roadmapItems.userId, userId), inArray(s.roadmapItems.programId, programs))),
    );
  }
  await runBatch(db, stmts);
  return ok(true);
}

// =============================================================================================
// Account deletion (no cascades: children are deleted explicitly, in dependency order)
// =============================================================================================

/** Soft delete: sessions revoked and content hidden at once; `purgeUser` runs within 72 hours. */
export async function softDeleteUser(db: Db, userId: string, now: number): Promise<void> {
  await runBatch(db, [
    db.update(s.users).set({ deletedAt: now }).where(eq(s.users.id, userId)),
    db.delete(s.sessions).where(eq(s.sessions.userId, userId)),
    db.update(s.calendarFeeds).set({ revokedAt: now }).where(and(eq(s.calendarFeeds.userId, userId), isNull(s.calendarFeeds.revokedAt))),
  ]);
}

/** Undo within the 48-hour window. */
export async function restoreUser(db: Db, userId: string): Promise<void> {
  await db.update(s.users).set({ deletedAt: null }).where(eq(s.users.id, userId));
}

/** Hard delete of every row the account owns (released aggregates may remain). */
export async function purgeUser(db: Db, userId: string): Promise<void> {
  const alerts = db.select({ id: s.alerts.id }).from(s.alerts).where(eq(s.alerts.userId, userId));
  const outcomes = db.select({ id: s.outcomes.id }).from(s.outcomes).where(eq(s.outcomes.userId, userId));
  await runBatch(db, [
    db.delete(s.notifications).where(inArray(s.notifications.alertId, alerts)),
    db.delete(s.alerts).where(eq(s.alerts.userId, userId)),
    db.delete(s.emailActionTokens).where(eq(s.emailActionTokens.userId, userId)),
    // Reminders reference tracker items, so they go first.
    db.delete(s.reminders).where(eq(s.reminders.userId, userId)),
    db.delete(s.onboardingRecords).where(eq(s.onboardingRecords.userId, userId)),
    db.delete(s.trackerItems).where(eq(s.trackerItems.userId, userId)),
    db.delete(s.requirementProgress).where(eq(s.requirementProgress.userId, userId)),
    db.delete(s.roadmapItems).where(eq(s.roadmapItems.userId, userId)),
    db.delete(s.roadmaps).where(eq(s.roadmaps.userId, userId)),
    db.delete(s.outcomeStages).where(inArray(s.outcomeStages.outcomeId, outcomes)),
    db.delete(s.outcomes).where(eq(s.outcomes.userId, userId)),
    db.delete(s.subscriptions).where(eq(s.subscriptions.userId, userId)),
    db.update(s.contacts).set({ userId: null }).where(eq(s.contacts.userId, userId)),
    db.delete(s.consents).where(eq(s.consents.userId, userId)),
    db.delete(s.calendarFeeds).where(eq(s.calendarFeeds.userId, userId)),
    db.delete(s.notificationPrefs).where(eq(s.notificationPrefs.userId, userId)),
    db.update(s.reports).set({ reporterUserId: null }).where(eq(s.reports.reporterUserId, userId)),
    db.delete(s.studentProfiles).where(eq(s.studentProfiles.userId, userId)),
    db.delete(s.userRoles).where(eq(s.userRoles.userId, userId)),
    db.update(s.curators).set({ userId: null }).where(eq(s.curators.userId, userId)),
    db.delete(s.sessionSecondFactors).where(eq(s.sessionSecondFactors.userId, userId)),
    db.delete(s.staffSecondFactors).where(eq(s.staffSecondFactors.userId, userId)),
    db.delete(s.sessions).where(eq(s.sessions.userId, userId)),
    db.delete(s.accounts).where(eq(s.accounts.userId, userId)),
    db.delete(s.users).where(eq(s.users.id, userId)),
  ]);
}

/** Accounts soft-deleted before `cutoff` (the deletion job purges them). */
export async function usersPendingPurge(db: Db, cutoff: number, limit = 50) {
  return db
    .select({ id: s.users.id })
    .from(s.users)
    .where(sql`${s.users.deletedAt} IS NOT NULL AND ${s.users.deletedAt} <= ${cutoff}`)
    .limit(limit);
}
