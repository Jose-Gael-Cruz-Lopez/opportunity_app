import { getTableColumns, inArray, type SQL } from "drizzle-orm";
import type { SQLiteTable } from "drizzle-orm/sqlite-core";
import { getDb, type Db } from "../client";
import * as s from "../schema";
import { rowsPerInsert } from "../util";
import type { SampleSeed } from "./build";
import { renderStatements, type BuiltQuery } from "./sql";

/**
 * SQL text for the sample seed, built with Drizzle's query builder (so column names and JSON
 * encoding match the schema) and inlined for `wrangler d1 execute --file`. Inserts use
 * ON CONFLICT DO NOTHING, so applying the file twice is harmless; `--reset` first deletes the
 * sample rows (and local rows that point at them), children first.
 */

/** A Drizzle client used only to render SQL; it never executes anything. */
function renderer(): Db {
  return getDb({} as D1Database);
}

/** Insert order respects foreign keys. */
export function seedTables(seed: SampleSeed): [SQLiteTable, readonly Record<string, unknown>[]][] {
  return [
    [s.curators, seed.curators],
    [s.organizations, seed.organizations],
    [s.institutions, seed.institutions],
    [s.institutionEmailDomains, seed.institutionEmailDomains],
    [s.programs, seed.programs],
    [s.programTypes, seed.programTypes],
    [s.programAliases, seed.programAliases],
    [s.programInterestTags, seed.programInterestTags],
    [s.programFields, seed.programFields],
    [s.programMajorFamilies, seed.programMajorFamilies],
    [s.programCycles, seed.programCycles],
    [s.deadlines, seed.deadlines],
    [s.requirements, seed.requirements],
    [s.eligibilityRuleSets, seed.eligibilityRuleSets],
    [s.institutionParticipation, seed.institutionParticipation],
  ];
}

function columnCount(table: SQLiteTable): number {
  return Object.keys(getTableColumns(table)).length;
}

export function insertQueries(seed: SampleSeed): BuiltQuery[] {
  const db = renderer();
  const out: BuiltQuery[] = [];
  for (const [table, rows] of seedTables(seed)) {
    if (rows.length === 0) continue;
    // Inlined SQL has no bound parameters, but chunking keeps each statement well under 100 KB.
    const size = rowsPerInsert(columnCount(table));
    for (let i = 0; i < rows.length; i += size) {
      const q = db
        .insert(table)
        .values(rows.slice(i, i + size) as never)
        .onConflictDoNothing()
        .toSQL();
      out.push({ sql: q.sql, params: q.params });
    }
  }
  return out;
}

/** Deletes the sample rows and anything local that references them (children first). */
export function resetQueries(seed: SampleSeed): BuiltQuery[] {
  const db = renderer();
  const programIds = seed.programs.map((p) => p.id as string);
  const cycleIds = seed.programCycles.map((c) => c.id as string);
  const orgIds = seed.organizations.map((o) => o.id as string);
  const institutionIds = seed.institutions.map((i) => i.id as string);
  const curatorIds = seed.curators.map((c) => c.id as string);
  const q = (built: { toSQL(): { sql: string; params: unknown[] } }): BuiltQuery => {
    const r = built.toSQL();
    return { sql: r.sql, params: r.params };
  };
  const alertIds = db.select({ id: s.alerts.id }).from(s.alerts).where(inArray(s.alerts.programCycleId, cycleIds));
  const outcomeIds = db.select({ id: s.outcomes.id }).from(s.outcomes).where(inArray(s.outcomes.programCycleId, cycleIds));
  const trackerIds = db.select({ id: s.trackerItems.id }).from(s.trackerItems).where(inArray(s.trackerItems.programCycleId, cycleIds));
  const del = (table: SQLiteTable, where: SQL) => q(db.delete(table).where(where));
  return [
    del(s.notifications, inArray(s.notifications.alertId, alertIds)),
    del(s.alerts, inArray(s.alerts.programCycleId, cycleIds)),
    del(s.changeEvents, inArray(s.changeEvents.programCycleId, cycleIds)),
    del(s.emailActionTokens, inArray(s.emailActionTokens.trackerItemId, trackerIds)),
    del(s.trackerItems, inArray(s.trackerItems.programCycleId, cycleIds)),
    del(s.requirementProgress, inArray(s.requirementProgress.programCycleId, cycleIds)),
    del(s.subscriptions, inArray(s.subscriptions.programCycleId, cycleIds)),
    del(s.outcomeStages, inArray(s.outcomeStages.outcomeId, outcomeIds)),
    del(s.outcomes, inArray(s.outcomes.programCycleId, cycleIds)),
    del(s.reports, inArray(s.reports.programCycleId, cycleIds)),
    // Wave 4 tables that reference cycles and programs (foreign keys).
    del(s.outcomeCycleHolds, inArray(s.outcomeCycleHolds.programCycleId, cycleIds)),
    del(s.bandModels, inArray(s.bandModels.programId, programIds)),
    del(s.roadmapItems, inArray(s.roadmapItems.programId, programIds)),
    del(s.programListItems, inArray(s.programListItems.programId, programIds)),
    del(s.institutionParticipation, inArray(s.institutionParticipation.programId, programIds)),
    del(s.eligibilityRuleSets, inArray(s.eligibilityRuleSets.programCycleId, cycleIds)),
    del(s.requirements, inArray(s.requirements.programCycleId, cycleIds)),
    del(s.programCycleCounts, inArray(s.programCycleCounts.programCycleId, cycleIds)),
    del(s.cyclePredictions, inArray(s.cyclePredictions.programCycleId, cycleIds)),
    del(s.deadlines, inArray(s.deadlines.programCycleId, cycleIds)),
    del(s.programCycles, inArray(s.programCycles.id, cycleIds)),
    del(s.programMajorFamilies, inArray(s.programMajorFamilies.programId, programIds)),
    del(s.programFields, inArray(s.programFields.programId, programIds)),
    del(s.programInterestTags, inArray(s.programInterestTags.programId, programIds)),
    del(s.programAliases, inArray(s.programAliases.programId, programIds)),
    del(s.programTypes, inArray(s.programTypes.programId, programIds)),
    del(s.slugRedirects, inArray(s.slugRedirects.toProgramId, programIds)),
    del(s.programs, inArray(s.programs.id, programIds)),
    del(s.institutionEmailDomains, inArray(s.institutionEmailDomains.institutionId, institutionIds)),
    del(s.institutions, inArray(s.institutions.id, institutionIds)),
    del(s.organizations, inArray(s.organizations.id, orgIds)),
    del(s.curators, inArray(s.curators.id, curatorIds)),
  ];
}

export function renderSeedSql(seed: SampleSeed, opts: { reset?: boolean } = {}): string {
  const header = [
    "-- SAMPLE DATA for local development (generated by server/db/seed). Every program, organization,",
    "-- date and rule here is invented and marked is_sample = 1; none describes a real program.",
    `-- Dates are relative to ${seed.today}.`,
  ].join("\n");
  const body = renderStatements([...(opts.reset ? resetQueries(seed) : []), ...insertQueries(seed)]);
  return `${header}\n${body}`;
}
