import { and, eq, inArray, isNull, ne, or, sql } from "drizzle-orm";
import type { DeadlineBasis, DeadlineKind, DeadlinePrecision, DeadlineScope, TzMode, VerificationStored } from "@shared/taxonomy";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import { jsonIds } from "@server/db/repos/common";
import { curatorHandles, resolveProgramSlug } from "@server/db/repos/registry";
import { findCalendarFeed } from "@server/db/repos/notifications";
import { utcDate } from "@server/db/util";
import { isNeutral, keepWithdrawn, type DeadlineEventSource, type OwnCampusSource, type ProgramEventContext } from "./events";

/**
 * What the calendar routes read. The D1 implementation below is the production one; route tests
 * pass a plain object, so handlers are tested without a database.
 */

/** Deadlines of one cycle, with the program text their events use. */
export interface FeedGroup {
  readonly context: ProgramEventContext;
  readonly neutral: boolean;
  readonly deadlines: readonly DeadlineEventSource[];
  readonly ownCampus: OwnCampusSource | null;
}

export interface ProgramFeed {
  readonly kind: "feed";
  readonly slug: string;
  readonly programName: string;
  readonly isSample: boolean;
  readonly groups: readonly FeedGroup[];
}

export type ProgramFeedLookup = ProgramFeed | { readonly kind: "redirect"; readonly slug: string } | null;

export interface UserFeed {
  readonly groups: readonly FeedGroup[];
}

export interface CalStore {
  /** A published program's national deadlines; a redirect for a renamed or merged slug; else null. */
  programFeed(slug: string, now: number): Promise<ProgramFeedLookup>;
  /** The student's tracked deadlines for a live (unrevoked) feed token hash; else null. */
  userFeed(tokenHash: string, now: number): Promise<UserFeed | null>;
}

/** Past deadlines stay in feeds for a year so recent history does not vanish from calendars. */
export const PAST_DEADLINE_DAYS = 365;
const DAY_MS = 86_400_000;

type DeadlineRow = typeof s.deadlines.$inferSelect;
type CycleRow = typeof s.programCycles.$inferSelect;
type ProgramRow = typeof s.programs.$inferSelect;

export function toEventSource(row: DeadlineRow): DeadlineEventSource {
  return {
    id: row.id,
    kind: row.kind as DeadlineKind,
    scope: row.scope as DeadlineScope,
    roundLabel: row.roundLabel,
    basis: row.basis as DeadlineBasis,
    precision: row.precision as DeadlinePrecision,
    tzMode: row.tzMode as TzMode,
    localDate: row.localDate,
    localTime: row.localTime,
    windowStart: row.windowStart,
    windowEnd: row.windowEnd,
    timeZone: row.timeZone,
    dueAt: row.dueAt,
    revision: row.revision,
    verificationState: row.verificationState as VerificationStored,
    withdrawnAt: row.withdrawnAt,
    updatedAt: row.updatedAt,
  };
}

function context(program: ProgramRow, orgName: string, cycle: CycleRow, handles: ReadonlyMap<string, string>): ProgramEventContext {
  const verified = !["draft", "unverified"].includes(cycle.verificationState);
  return {
    slug: program.slug,
    name: program.name,
    organizationName: orgName,
    officialUrl: program.officialUrl,
    verifiedOn: verified ? utcDate(cycle.lastVerifiedAt) : null,
    verifiedBy: verified && cycle.verifiedBy ? (handles.get(cycle.verifiedBy) ?? null) : null,
    isSample: program.isSample,
  };
}

/** Keeps rows that are upcoming, recent, undated, or recently withdrawn. */
function inFeedWindow(row: DeadlineRow, now: number): boolean {
  if (!keepWithdrawn(row.withdrawnAt, now)) return false;
  return row.sortAt === null || row.sortAt >= now - PAST_DEADLINE_DAYS * DAY_MS;
}

/** Ids of a program's cycles, as a subquery. */
function cycleIdsOf(db: Db, programId: string) {
  return db.select({ id: s.programCycles.id }).from(s.programCycles).where(eq(s.programCycles.programId, programId));
}

function groupByCycle(rows: readonly DeadlineRow[]): Map<string, DeadlineRow[]> {
  const out = new Map<string, DeadlineRow[]>();
  for (const row of rows) {
    const list = out.get(row.programCycleId);
    if (list) list.push(row);
    else out.set(row.programCycleId, [row]);
  }
  return out;
}

async function loadProgramFeed(db: Db, slug: string, now: number): Promise<ProgramFeedLookup> {
  const resolved = await resolveProgramSlug(db, slug);
  if (!resolved || !resolved.program.isPublished) return null;
  if (resolved.redirectedFrom !== null) return { kind: "redirect", slug: resolved.program.slug };
  const program = resolved.program;

  const [orgs, cycles, deadlines] = await db.batch([
    db.select({ name: s.organizations.name }).from(s.organizations).where(eq(s.organizations.id, program.organizationId)).limit(1),
    db.select().from(s.programCycles).where(eq(s.programCycles.programId, program.id)),
    db
      .select()
      .from(s.deadlines)
      // The public feed carries national dates only; campus rows reach students through their own feed.
      .where(and(inArray(s.deadlines.programCycleId, cycleIdsOf(db, program.id)), eq(s.deadlines.scope, "national"))),
  ]);
  const handles = await curatorHandles(db);
  const orgName = orgs[0]?.name ?? "";
  const byCycle = groupByCycle(deadlines.filter((r) => inFeedWindow(r, now)));
  const groups: FeedGroup[] = cycles
    .filter((c) => byCycle.has(c.id))
    .map((cycle) => ({
      context: context(program, orgName, cycle, handles),
      // Public program data is already public; the feed names the program it was requested for.
      neutral: false,
      deadlines: (byCycle.get(cycle.id) ?? []).map(toEventSource),
      ownCampus: null,
    }));
  return { kind: "feed", slug: program.slug, programName: program.name, isSample: program.isSample, groups };
}

interface ConsentState {
  readonly sensitivePrograms: ReadonlySet<string>;
  readonly identity: boolean;
}

/**
 * Mirrors the database's audience guard (server/db/guards.ts): health-defined programs never
 * reach a server feed; status-defined ones need a live per-program `sensitive_tracking` consent;
 * identity-defined ones need a live `identity_tracking` consent. Rows should not exist otherwise,
 * but a feed must not depend on that.
 */
export function feedAllows(program: Pick<ProgramRow, "id" | "sensitiveAudience" | "identityAudience">, consent: ConsentState): boolean {
  const identity = program.identityAudience as readonly string[];
  if (identity.includes("health")) return false;
  if (program.sensitiveAudience && !consent.sensitivePrograms.has(program.id)) return false;
  if (identity.length > 0 && !consent.identity) return false;
  return true;
}

async function loadUserFeed(db: Db, tokenHash: string, now: number): Promise<UserFeed | null> {
  const feed = await findCalendarFeed(db, tokenHash);
  if (!feed) return null;

  // Plain per-table selects: a batched join of whole tables would collide on shared column
  // names (id, version, ...) when D1 returns batch rows as objects.
  const live = and(eq(s.trackerItems.userId, feed.userId), isNull(s.trackerItems.deletedAt), ne(s.trackerItems.status, "not_applying"));
  const cycleIds = db.select({ id: s.trackerItems.programCycleId }).from(s.trackerItems).where(live);
  const programIds = db.select({ id: s.programCycles.programId }).from(s.programCycles).where(inArray(s.programCycles.id, cycleIds));
  const [profiles, itemRows, cycleRows, programRows, orgRows, consents] = await db.batch([
    db
      .select({ institutionId: s.studentProfiles.institutionId })
      .from(s.studentProfiles)
      .where(and(eq(s.studentProfiles.userId, feed.userId), isNull(s.studentProfiles.deletedAt)))
      .limit(1),
    db.select().from(s.trackerItems).where(live),
    db.select().from(s.programCycles).where(inArray(s.programCycles.id, cycleIds)),
    db.select().from(s.programs).where(inArray(s.programs.id, programIds)),
    db
      .select({ id: s.organizations.id, name: s.organizations.name })
      .from(s.organizations)
      .where(inArray(s.organizations.id, db.select({ id: s.programs.organizationId }).from(s.programs).where(inArray(s.programs.id, programIds)))),
    db
      .select({ kind: s.consents.kind, scopeId: s.consents.scopeId })
      .from(s.consents)
      .where(and(eq(s.consents.userId, feed.userId), isNull(s.consents.revokedAt))),
  ]);
  const cyclesById = new Map(cycleRows.map((c) => [c.id, c]));
  const programsById = new Map(programRows.map((p) => [p.id, p]));
  const orgNames = new Map(orgRows.map((o) => [o.id, o.name]));
  const items = itemRows.flatMap((item) => {
    const cycle = cyclesById.get(item.programCycleId);
    const program = cycle ? programsById.get(cycle.programId) : undefined;
    return cycle && program ? [{ item, cycle, program, orgName: orgNames.get(program.organizationId) ?? "" }] : [];
  });

  const consent: ConsentState = {
    sensitivePrograms: new Set(consents.filter((k) => k.kind === "sensitive_tracking" && k.scopeId).map((k) => k.scopeId as string)),
    identity: consents.some((k) => k.kind === "identity_tracking"),
  };
  const allowed = items.filter((r) => feedAllows(r.program, consent));
  if (allowed.length === 0) return { groups: [] };

  const institutionId = profiles[0]?.institutionId ?? null;
  const allowedCycleIds = allowed.map((r) => r.cycle.id);
  const scope = institutionId
    ? or(eq(s.deadlines.scope, "national"), and(eq(s.deadlines.scope, "campus"), eq(s.deadlines.institutionId, institutionId)))
    : eq(s.deadlines.scope, "national");
  const rows = await db
    .select()
    .from(s.deadlines)
    .where(and(sql`${s.deadlines.programCycleId} IN ${jsonIds(allowedCycleIds)}`, scope));
  const handles = await curatorHandles(db);
  const byCycle = groupByCycle(rows.filter((r) => inFeedWindow(r, now)));

  const groups = allowed.map((r): FeedGroup => {
    const own = r.item.ownCampusDeadline;
    return {
      context: context(r.program, r.orgName, r.cycle, handles),
      neutral: isNeutral({
        sensitiveAudience: r.program.sensitiveAudience,
        identityAudience: r.program.identityAudience as readonly string[],
        nameInMessages: r.item.nameInMessages,
        feedNeutral: feed.neutralTitles,
      }),
      deadlines: (byCycle.get(r.cycle.id) ?? []).map(toEventSource),
      ownCampus: own ? { trackerItemId: r.item.id, date: own, version: r.item.version, updatedAt: r.item.updatedAt } : null,
    };
  });
  return { groups };
}

export function createD1CalStore(db: Db): CalStore {
  return {
    programFeed: (slug, now) => loadProgramFeed(db, slug, now),
    userFeed: (tokenHash, now) => loadUserFeed(db, tokenHash, now),
  };
}
