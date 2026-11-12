import { and, asc, count, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { TrackerStatus } from "@shared/taxonomy";
import type { Db, EventsDb } from "@server/db/client";
import * as s from "@server/db/schema";
import { analyticsEvents } from "@server/db/events-schema";
import type { ListedProgram, StatusCount } from "./aggregate";

/**
 * Read queries the advisor routes need beyond server/db/repos/advisor.ts. Every query is scoped
 * by workspace id (or by programs already scoped to it) and returns counts, never student rows.
 */

/** Distinct programs on the workspace's live lists, with the restricted flag derived per program. */
export async function listedPrograms(db: Db, workspaceId: string): Promise<(ListedProgram & { id: string })[]> {
  const rows = await db
    .selectDistinct({
      id: s.programs.id,
      slug: s.programs.slug,
      name: s.programs.name,
      sensitive: s.programs.sensitiveAudience,
      identity: s.programs.identityAudience,
    })
    .from(s.programListItems)
    .innerJoin(s.programLists, eq(s.programLists.id, s.programListItems.listId))
    .innerJoin(s.programs, eq(s.programs.id, s.programListItems.programId))
    .where(and(eq(s.programLists.workspaceId, workspaceId), isNull(s.programLists.deletedAt)))
    .orderBy(asc(s.programs.slug));
  return rows.map((r) => ({ id: r.id, slug: r.slug, name: r.name, restricted: r.sensitive || r.identity.length > 0 }));
}

/**
 * Tracker counts per program and status, over live trackers of live accounts. The caller passes
 * only unrestricted program ids, so restricted programs are never even counted.
 */
export async function trackerStatusCounts(db: Db, programIds: readonly string[]): Promise<StatusCount[]> {
  if (programIds.length === 0) return [];
  const rows = await db
    .select({ slug: s.programs.slug, status: s.trackerItems.status, n: count() })
    .from(s.trackerItems)
    .innerJoin(s.programCycles, eq(s.programCycles.id, s.trackerItems.programCycleId))
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .innerJoin(s.users, eq(s.users.id, s.trackerItems.userId))
    .where(and(inArray(s.programs.id, [...programIds]), isNull(s.trackerItems.deletedAt), isNull(s.users.deletedAt)))
    .groupBy(s.programs.slug, s.trackerItems.status);
  return rows.map((r) => ({ programSlug: r.slug, status: r.status as TrackerStatus, n: Number(r.n) }));
}

/** Public page paths of the workspace's lists, as page_view events record them. */
export async function listPagePaths(db: Db, workspaceId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: s.programLists.slug, token: s.programLists.token, visibility: s.programLists.visibility })
    .from(s.programLists)
    .where(and(eq(s.programLists.workspaceId, workspaceId), isNull(s.programLists.deletedAt)));
  return rows.flatMap((r) => (r.visibility === "public" && r.slug ? [`/lists/${r.slug}`] : r.token ? [`/lists/u/${r.token}`] : []));
}

/** page_view events on those paths inside the period. Null when no events database is bound. */
export async function listViewCount(edb: EventsDb | null, paths: readonly string[], startMs: number, endMs: number): Promise<number | null> {
  if (!edb) return null;
  if (paths.length === 0) return 0;
  const [row] = await edb
    .select({ n: count() })
    .from(analyticsEvents)
    .where(and(eq(analyticsEvents.name, "page_view"), inArray(analyticsEvents.path, [...paths]), gte(analyticsEvents.at, startMs), lt(analyticsEvents.at, endMs)));
  return Number(row?.n ?? 0);
}

export interface CampusDeadlineRow {
  readonly programSlug: string;
  readonly programName: string;
  readonly cycleKey: string;
  readonly kind: string;
  readonly localDate: string | null;
  readonly localTime: string | null;
  readonly timeZone: string | null;
  /** When the Curator confirmed it (the "Confirmed by your campus on [date]" label). */
  readonly confirmedAt: number;
}

/** Curator-approved campus deadlines of the workspace's institution, for programs on its lists. */
export async function approvedCampusDeadlines(db: Db, institutionId: string, programIds: readonly string[]): Promise<CampusDeadlineRow[]> {
  if (programIds.length === 0) return [];
  const rows = await db
    .select({
      programSlug: s.programs.slug,
      programName: s.programs.name,
      cycleKey: s.programCycles.cycleKey,
      kind: s.deadlines.kind,
      localDate: s.deadlines.localDate,
      localTime: s.deadlines.localTime,
      timeZone: s.deadlines.timeZone,
      confirmedAt: s.deadlines.updatedAt,
    })
    .from(s.deadlines)
    .innerJoin(s.programCycles, eq(s.programCycles.id, s.deadlines.programCycleId))
    .innerJoin(s.programs, eq(s.programs.id, s.programCycles.programId))
    .where(
      and(
        eq(s.deadlines.scope, "campus"),
        eq(s.deadlines.institutionId, institutionId),
        eq(s.deadlines.verificationState, "verified"),
        isNull(s.deadlines.withdrawnAt),
        inArray(s.programs.id, [...programIds]),
      ),
    )
    .orderBy(asc(s.deadlines.sortAt));
  return rows.map((r) => ({ ...r, localDate: r.localDate ?? null, confirmedAt: Number(r.confirmedAt) }));
}

/** Payload key under which one workspace's submission sits on a shared campus_deadline task. */
export function campusPayloadKey(workspaceId: string): string {
  return `campus:${workspaceId}`;
}

/** Campus deadline submissions from this workspace still waiting for a Curator. */
export async function pendingCampusSubmissions(db: Db, workspaceId: string): Promise<number> {
  const key = `$."${campusPayloadKey(workspaceId)}"`;
  const [row] = await db
    .select({ n: count() })
    .from(s.reviewTasks)
    .where(
      and(
        eq(s.reviewTasks.kind, "campus_deadline"),
        inArray(s.reviewTasks.state, ["open", "claimed", "second_review", "snoozed"]),
        sql`json_extract(${s.reviewTasks.payload}, ${key}) IS NOT NULL`,
      ),
    );
  return Number(row?.n ?? 0);
}
