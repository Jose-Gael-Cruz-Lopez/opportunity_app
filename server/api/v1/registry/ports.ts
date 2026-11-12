import type { Context } from "hono";
import type { Organization, ProgramCard, ProgramDetail } from "@shared/contracts/registry";
import type { InstitutionCalendar, InstitutionLevel, OpportunityTypeSlug, UsState } from "@shared/taxonomy";
import type { AppEnv } from "@server/env";
import type { CardCache } from "./cards";

/**
 * What the public registry routes read. The D1 implementation (./store.ts) is the production
 * one; route tests pass plain objects, so handlers are tested without a database.
 */

export interface CitationOptions {
  readonly origin: string;
  readonly license: string;
  readonly termsPath: string;
}

export interface OpportunityTypeCount {
  readonly slug: OpportunityTypeSlug;
  readonly ordinal: number;
  readonly label: string;
  readonly group: string;
  readonly inScope: boolean;
  readonly programCount: number;
}

export interface InstitutionHit {
  readonly id: string;
  readonly name: string;
  readonly level: InstitutionLevel;
  readonly state: UsState | null;
  readonly calendar: InstitutionCalendar | null;
}

export interface OrganizationRecord {
  readonly organization: Organization;
  /** Published programs of this Organization. */
  readonly programIds: readonly string[];
}

export interface RegistryStore {
  /** The latest published RegistryRelease number, 0 before the first release. */
  currentRelease(): Promise<number>;
  /** One card per published program (its current cycle). */
  listCards(now: number): Promise<ProgramCard[]>;
  /** Loser slug -> survivor slug for merges and renames since `sinceMs`. */
  mergedSlugs(sinceMs: number): Promise<Record<string, string>>;
  programDetail(slug: string, now: number, citation: CitationOptions): Promise<ProgramDetail | null>;
  /** The current slug of a published program that was renamed or merged away from `slug`, else null. */
  renamedSlug(slug: string): Promise<string | null>;
  organizationBySlug(slug: string): Promise<OrganizationRecord | null>;
  opportunityTypeCounts(): Promise<OpportunityTypeCount[]>;
  /** Institutions whose name contains `q`, ordered by name then id, after the keyset `after`. */
  searchInstitutions(q: string, limit: number, after: { name: string; id: string } | null): Promise<InstitutionHit[]>;
}

export interface RegistryDeps {
  readonly store: (c: Context<AppEnv>) => RegistryStore;
  readonly now: () => number;
  /** Public origin for citations (APP_ORIGIN). */
  readonly origin: (c: Context<AppEnv>) => string;
  /** Per-isolate card and search-index cache; tests pass a fresh one. */
  readonly cards: CardCache;
}

