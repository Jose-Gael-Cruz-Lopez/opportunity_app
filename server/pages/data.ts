import { and, eq, inArray } from "drizzle-orm";
import type { CycleStatus, Organization, ProgramCard, ProgramDetail, ProgramList } from "@shared/contracts";
import type { Db } from "../db/client";
import * as s from "../db/schema";
import * as advisorRepo from "../db/repos/advisor";
import * as registry from "../db/repos/registry";

/**
 * The read port public pages use. The default implementation reads D1 through the registry
 * repositories; tests pass fixtures. Pages never see a request, a cookie or a user.
 */

export interface CycleHistoryEntry {
  readonly cycleKey: string;
  readonly termLabel: string;
  readonly status: CycleStatus;
  readonly opensOn: string | null;
  /** The national application deadline that cycle published, as a calendar date. */
  readonly applicationDate: string | null;
}

export type SlugResolution =
  | { readonly kind: "found" }
  | { readonly kind: "moved"; readonly slug: string }
  | { readonly kind: "missing" };

/** An Organization with the cards of its published programs (at least one). */
export interface OrganizationPageData {
  readonly organization: Organization;
  readonly cards: readonly ProgramCard[];
}

/** A public (by slug) or unlisted (by capability token) advisor ProgramList. */
export type ListRef = { readonly slug: string } | { readonly token: string };

export interface PublicListEntry {
  readonly card: ProgramCard;
  /** The advisor's own note for this program, shown as written. */
  readonly note: string | null;
  /** The cycle the advisor pinned, when it is not the current one. */
  readonly cycleKey: string | null;
}

/**
 * What a list page may show. Never the owning workspace's id, its members or any student: the
 * list is the advisor's published words plus public registry cards.
 */
export interface PublicListData {
  readonly title: string;
  readonly description: string | null;
  readonly visibility: ProgramList["visibility"];
  /** The list holds a status- or identity-defined program (kept out of search engines). */
  readonly restricted: boolean;
  readonly updatedAt: string;
  /** Published programs only, in the advisor's order. */
  readonly entries: readonly PublicListEntry[];
}

export interface PageData {
  /** One card per published program's current cycle. */
  listCards(now: number): Promise<ProgramCard[]>;
  /** Detail for a published program, or null. */
  getDetail(slug: string, now: number): Promise<ProgramDetail | null>;
  /** Earlier and later cycles of a program, newest first, excluding `currentCycleKey`. */
  cycleHistory(programId: string, currentCycleKey: string): Promise<CycleHistoryEntry[]>;
  /** Whether an unknown slug was renamed or merged into another program. */
  resolveSlug(slug: string): Promise<SlugResolution>;
  /**
   * The reads below need D1. A source that cannot answer them (the R2 release) leaves them out,
   * and the page answers as briefly unavailable instead of guessing.
   */
  /** An Organization with at least one published program, else null. */
  getOrganization?(slug: string, now: number): Promise<OrganizationPageData | null>;
  /** A live public or unlisted list, else null. */
  getPublicList?(ref: ListRef, now: number): Promise<PublicListData | null>;
  /** Loser slug to survivor slug for merges and renames since `sinceMs`. */
  mergedSlugs?(sinceMs: number): Promise<Record<string, string>>;
}

export interface DbPageDataOptions {
  readonly origin: string;
  /** License named in citations; the registry license is a founders' decision (see notes). */
  readonly license?: string;
  readonly termsPath?: string;
}

export function dbPageData(db: Db, opts: DbPageDataOptions): PageData {
  const citation = { origin: opts.origin, license: opts.license ?? "All rights reserved", termsPath: opts.termsPath ?? "/methods#terms" };
  return {
    listCards: (now) => registry.listProgramCards(db, now),
    getDetail: (slug, now) => registry.getProgramDetail(db, slug, now, citation),
    async cycleHistory(programId, currentCycleKey) {
      const cycles = (await registry.listCycles(db, programId)).filter((c) => c.cycleKey !== currentCycleKey);
      if (cycles.length === 0) return [];
      const deadlines = await registry.listLiveDeadlines(
        db,
        cycles.map((c) => c.id),
      );
      return cycles.map((c) => {
        const app = deadlines.find((d) => d.programCycleId === c.id && d.kind === "application" && d.scope === "national");
        return {
          cycleKey: c.cycleKey,
          termLabel: c.termLabel,
          status: c.status as CycleStatus,
          opensOn: c.opensOn ?? null,
          applicationDate: app?.localDate ?? null,
        };
      });
    },
    async resolveSlug(slug) {
      const found = await registry.resolveProgramSlug(db, slug);
      if (!found || !found.program.isPublished) return { kind: "missing" };
      return found.redirectedFrom ? { kind: "moved", slug: found.program.slug } : { kind: "found" };
    },
    async getOrganization(slug, now) {
      const org = await db.query.organizations.findFirst({ where: eq(s.organizations.slug, slug) });
      if (!org) return null;
      const ids = await db
        .select({ id: s.programs.id })
        .from(s.programs)
        .where(and(eq(s.programs.organizationId, org.id), eq(s.programs.isPublished, true)));
      // An Organization with nothing published has no public page.
      if (ids.length === 0) return null;
      const cards = await registry.listProgramCards(db, now, { programIds: ids.map((r) => r.id) });
      return cards.length ? { organization: registry.toOrganization(org), cards } : null;
    },
    async getPublicList(ref, now) {
      const list = await advisorRepo.getPublicProgramList(db, ref);
      if (!list) return null;
      const slugs = [...new Set(list.items.map((i) => i.programSlug))];
      // listProgramCards with ids skips its own publish filter, so only published ids go in.
      const ids = slugs.length
        ? await db
            .select({ id: s.programs.id })
            .from(s.programs)
            .where(and(inArray(s.programs.slug, slugs), eq(s.programs.isPublished, true)))
        : [];
      const cards = ids.length ? await registry.listProgramCards(db, now, { programIds: ids.map((r) => r.id) }) : [];
      return toPublicList(list, cards);
    },
    mergedSlugs: (since) => registry.mergedSlugs(db, since),
  };
}

/** Joins a list's items to published cards, in the advisor's order; unpublished items drop out. */
export function toPublicList(list: Omit<ProgramList, "workspaceId">, cards: readonly ProgramCard[]): PublicListData {
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const entries: PublicListEntry[] = [];
  for (const item of [...list.items].sort((a, b) => a.position - b.position)) {
    const card = bySlug.get(item.programSlug);
    if (!card) continue;
    entries.push({ card, note: item.note, cycleKey: item.cycleKey !== null && item.cycleKey !== card.cycleKey ? item.cycleKey : null });
  }
  return {
    title: list.title,
    description: list.description,
    visibility: list.visibility,
    restricted: list.restricted,
    updatedAt: list.updatedAt,
    entries,
  };
}

/** Thrown (and mapped to a 503 the cache layer can answer from its last-good copy) when D1 fails. */
export class DataUnavailableError extends Error {
  constructor(cause: unknown) {
    super("registry data unavailable", { cause });
    this.name = "DataUnavailableError";
  }
}

/** Runs a read and wraps any failure, so handlers can tell a data outage from a bug in rendering. */
export async function readData<T>(read: () => Promise<T>): Promise<T> {
  try {
    return await read();
  } catch (err) {
    throw new DataUnavailableError(err);
  }
}
