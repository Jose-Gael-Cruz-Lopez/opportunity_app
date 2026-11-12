import { and, asc, eq, sql } from "drizzle-orm";
import type { InstitutionCalendar, InstitutionLevel, OpportunityTypeSlug, UsState } from "@shared/taxonomy";
import type { Db } from "@server/db/client";
import * as s from "@server/db/schema";
import * as registry from "@server/db/repos/registry";
import type { InstitutionHit, OpportunityTypeCount, RegistryStore } from "./ports";

/** The D1 RegistryStore: thin adapters over server/db/repos/registry plus two small reads. */

function escapeLike(q: string): string {
  return q.replace(/[%_\\]/g, (c) => `\\${c}`);
}

async function searchInstitutions(db: Db, q: string, limit: number, after: { name: string; id: string } | null): Promise<InstitutionHit[]> {
  const pattern = `%${escapeLike(q)}%`;
  const keyset = after
    ? sql`(${s.institutions.name} > ${after.name} OR (${s.institutions.name} = ${after.name} AND ${s.institutions.id} > ${after.id}))`
    : sql`1 = 1`;
  const rows = await db
    .select({ id: s.institutions.id, name: s.institutions.name, level: s.institutions.level, state: s.institutions.state, calendar: s.institutions.calendar })
    .from(s.institutions)
    .where(and(sql`${s.institutions.name} LIKE ${pattern} ESCAPE '\\'`, keyset))
    .orderBy(asc(s.institutions.name), asc(s.institutions.id))
    .limit(limit);
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    level: r.level as InstitutionLevel,
    state: r.state as UsState | null,
    calendar: r.calendar as InstitutionCalendar | null,
  }));
}

async function organizationBySlug(db: Db, slug: string) {
  const org = await db.query.organizations.findFirst({ where: eq(s.organizations.slug, slug) });
  if (!org) return null;
  const programs = await db
    .select({ id: s.programs.id })
    .from(s.programs)
    .where(and(eq(s.programs.organizationId, org.id), eq(s.programs.isPublished, true)));
  // An Organization with nothing published has no public page.
  if (programs.length === 0) return null;
  return { organization: registry.toOrganization(org), programIds: programs.map((p) => p.id) };
}

export function createD1RegistryStore(db: Db): RegistryStore {
  return {
    currentRelease: async () => (await registry.latestPublishedRelease(db))?.number ?? 0,
    listCards: (now) => registry.listProgramCards(db, now),
    mergedSlugs: (since) => registry.mergedSlugs(db, since),
    programDetail: (slug, now, citation) => registry.getProgramDetail(db, slug, now, citation),
    renamedSlug: async (slug) => {
      const resolved = await registry.resolveProgramSlug(db, slug);
      return resolved && resolved.redirectedFrom !== null && resolved.program.isPublished ? resolved.program.slug : null;
    },
    organizationBySlug: (slug) => organizationBySlug(db, slug),
    opportunityTypeCounts: async (): Promise<OpportunityTypeCount[]> =>
      (await registry.opportunityTypeCounts(db)).map((r) => ({ ...r, slug: r.slug as OpportunityTypeSlug, programCount: Number(r.programCount) })),
    searchInstitutions: (q, limit, after) => searchInstitutions(db, q, limit, after),
  };
}
