import { Hono, type Context } from "hono";
import {
  DeadlineListQuerySchema,
  InstitutionSearchQuerySchema,
  ProgramListQuerySchema,
  SearchRequestSchema,
  type DeadlineListItem,
  type ProgramListResponse,
  type SearchResponse,
} from "@shared/contracts/api";
import { SlugSchema, type Paginated } from "@shared/contracts/common";
import { ROUTES, relativePath } from "@shared/contracts/routes";
import { EligibilityCheckRequestSchema, type EligibilityCheckResponse } from "@shared/contracts/eligibility";
import { PRODUCT } from "@shared/config/product";
import { buildEvalContext, evaluateEligibility } from "@shared/eligibility";
import { search, toSearchHit } from "@shared/matching";
import { localDateIn } from "@shared/time";
import { getOpportunityType, OpportunityTypeSlugSchema } from "@shared/taxonomy";
import type { AppEnv } from "@server/env";
import { decodeCursor, encodeCursor } from "@server/db/util";
import { problemFor } from "@server/lib/problem";
import { validateJson, validateQuery } from "@server/middleware/validate";
import { decodeOffsetCursor, filterListCards, filtersFromSearch, paginate, upcomingDeadlines } from "./listing";
import type { RegistryDeps } from "./ports";
import { TypeHubQuerySchema, type OrganizationResponse, type TypeHubResponse } from "./schemas";

/**
 * Public registry REST, mounted at /api/v1 (plan 02 2.3.3, plan 06 6.5):
 *
 *   GET  /programs                  cards in public order; filters; `q` searches with MiniSearch
 *   GET  /programs/:slug            lazy detail: current cycle, deadlines, requirements, evidence,
 *                                   verification and citation; 301 for a renamed slug
 *   GET  /deadlines                 upcoming national deadlines (nomination-gated at E1)
 *   GET  /opportunity-types         the taxonomy with published-program counts
 *   GET  /opportunity-types/:type   a type hub (cards of one type)              [not in ROUTES yet]
 *   GET  /organizations/:slug       an Organization and its programs           [not in ROUTES yet]
 *   GET  /institutions              institution lookup by name
 *   POST /search                    the same search the browser runs, for API clients
 *   POST /eligibility/check         non-sensitive eligibility for up to 10 programs (the shared
 *                                   evaluator; status and identity rules always come back unknown)
 *
 * Responses never carry a score about a student: search results have an integer rank and
 * why-shown codes only. Search queries are never logged or put in a shared cache. Unpublished
 * programs answer 404, the same as unknown ones.
 */

type Ctx = Context<AppEnv>;

/** Registry reads change within a minute of a publish (the release pointer's TTL). */
export const PUBLIC_LIST_CACHE = "public, max-age=60";
/** The taxonomy changes only with a deploy or a publish. */
export const TAXONOMY_CACHE = "public, max-age=300";
/** Responses to a typed query stay in the asker's browser only, never in a shared cache. */
export const PRIVATE_QUERY_CACHE = "private, max-age=60";

/** Citation terms for program detail (license pending s09's decision, as in server/mcp). */
export const REGISTRY_CITATION = { license: "CC-BY-4.0", termsPath: "/methods#terms" } as const;

/** Search results beyond this many are not paged (MATCHING_CONFIG.search.maxLimit). */
const SEARCH_WINDOW = 100;

function badCursor(c: Ctx): Response {
  return problemFor(c, "bad_request", { detail: "The cursor is not valid; start from the first page.", errors: [{ path: "cursor", message: "Invalid cursor" }] });
}

export function createRegistryRoutes(deps: RegistryDeps): Hono<AppEnv> {
  const app = new Hono<AppEnv>();

  app.get(relativePath(ROUTES.listPrograms), validateQuery(ProgramListQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const offset = decodeOffsetCursor(q.cursor);
    if (offset === null) return badCursor(c);
    const now = deps.now();
    const set = await deps.cards.get(deps.store(c), now);
    const text = q.q?.trim() ?? "";
    const ordered = text ? search(set.index(), text, { limit: SEARCH_WINDOW, now }).map((r) => r.card) : set.cards;
    const page = paginate(filterListCards(ordered, q, now), offset, q.limit, set.release);
    const body: ProgramListResponse = { ...page, release: set.release };
    return c.json(body, 200, { "cache-control": text ? PRIVATE_QUERY_CACHE : PUBLIC_LIST_CACHE });
  });

  app.get(relativePath(ROUTES.getProgram), async (c) => {
    const slug = c.req.param("slug") ?? "";
    if (!SlugSchema.safeParse(slug).success) return problemFor(c, "not_found");
    const store = deps.store(c);
    const detail = await store.programDetail(slug, deps.now(), { origin: deps.origin(c), ...REGISTRY_CITATION });
    if (detail) return c.json(detail, 200, { "cache-control": PUBLIC_LIST_CACHE });
    const renamed = await store.renamedSlug(slug);
    if (renamed && renamed !== slug) {
      return c.body(null, 301, { location: `/api/v1/programs/${renamed}`, "cache-control": PUBLIC_LIST_CACHE });
    }
    return problemFor(c, "not_found");
  });

  app.get(relativePath(ROUTES.listDeadlines), validateQuery(DeadlineListQuerySchema), async (c) => {
    const q = c.req.valid("query");
    const offset = decodeOffsetCursor(q.cursor);
    if (offset === null) return badCursor(c);
    const now = deps.now();
    const set = await deps.cards.get(deps.store(c), now);
    const body: Paginated<DeadlineListItem> = paginate(upcomingDeadlines(set.cards, q, now), offset, q.limit, set.release);
    return c.json(body, 200, { "cache-control": PUBLIC_LIST_CACHE });
  });

  app.get(relativePath(ROUTES.listOpportunityTypes), async (c) => {
    const items = await deps.store(c).opportunityTypeCounts();
    return c.json({ items }, 200, { "cache-control": TAXONOMY_CACHE });
  });

  app.get("/opportunity-types/:type", validateQuery(TypeHubQuerySchema), async (c) => {
    const parsed = OpportunityTypeSlugSchema.safeParse(c.req.param("type"));
    const def = parsed.success ? getOpportunityType(parsed.data) : undefined;
    if (!parsed.success || !def) return problemFor(c, "not_found");
    const q = c.req.valid("query");
    const offset = decodeOffsetCursor(q.cursor);
    if (offset === null) return badCursor(c);
    const set = await deps.cards.get(deps.store(c), deps.now());
    const cards = set.cards.filter((card) => card.opportunityTypes.includes(parsed.data));
    const body: TypeHubResponse = {
      type: { slug: parsed.data, label: def.label, group: def.group, inScope: def.inScope, programCount: cards.length },
      ...paginate(cards, offset, q.limit, set.release),
      release: set.release,
    };
    return c.json(body, 200, { "cache-control": PUBLIC_LIST_CACHE });
  });

  app.get("/organizations/:slug", async (c) => {
    const slug = c.req.param("slug");
    if (!SlugSchema.safeParse(slug).success) return problemFor(c, "not_found");
    const store = deps.store(c);
    const record = await store.organizationBySlug(slug);
    if (!record) return problemFor(c, "not_found");
    const set = await deps.cards.get(store, deps.now());
    const ids = new Set(record.programIds);
    const body: OrganizationResponse = {
      organization: record.organization,
      programs: set.cards.filter((card) => ids.has(card.programId)),
      release: set.release,
    };
    return c.json(body, 200, { "cache-control": PUBLIC_LIST_CACHE });
  });

  app.get(relativePath(ROUTES.searchInstitutions), validateQuery(InstitutionSearchQuerySchema), async (c) => {
    const q = c.req.valid("query");
    let after: { name: string; id: string } | null = null;
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      if (!cur || typeof cur.k !== "string") return badCursor(c);
      after = { name: cur.k, id: cur.id };
    }
    const rows = await deps.store(c).searchInstitutions(q.q.trim(), q.limit + 1, after);
    const items = rows.slice(0, q.limit);
    const last = items[items.length - 1];
    const nextCursor = rows.length > q.limit && last ? encodeCursor({ k: last.name, id: last.id }) : null;
    return c.json({ items, page: { nextCursor, limit: q.limit } }, 200, { "cache-control": "private, max-age=3600" });
  });

  app.post(relativePath(ROUTES.search), validateJson(SearchRequestSchema), async (c) => {
    const req = c.req.valid("json");
    const offset = decodeOffsetCursor(req.cursor);
    if (offset === null) return badCursor(c);
    const now = deps.now();
    const set = await deps.cards.get(deps.store(c), now);
    // One extra result tells whether another page exists, without counting every match.
    const results = search(set.index(), req.query, { filters: filtersFromSearch(req.filters), limit: req.limit + 1, offset, now });
    const hits = results.slice(0, req.limit).map(toSearchHit);
    const nextCursor = results.length > req.limit && offset + req.limit < SEARCH_WINDOW ? encodeCursor({ k: offset + req.limit, id: `r${set.release}` }) : null;
    const body: SearchResponse = { items: hits, page: { nextCursor, limit: req.limit }, release: set.release };
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  app.post(relativePath(ROUTES.checkEligibility), validateJson(EligibilityCheckRequestSchema), async (c) => {
    const req = c.req.valid("json");
    const now = deps.now();
    const set = await deps.cards.get(deps.store(c), now);
    const asOf = req.asOf ?? localDateIn(now, PRODUCT.fallbackTimeZone);
    const bySlug = new Map(set.cards.map((card) => [card.slug, card]));
    // Unknown or unpublished slugs are left out rather than reported as "unknown eligibility".
    const results = [...new Set(req.programs)].flatMap((slug) => {
      const card = bySlug.get(slug);
      if (!card) return [];
      const context = buildEvalContext({ deadlines: card.deadlines.map((d) => ({ ...d, institutionId: null })) });
      return [{ slug, cycleKey: card.cycleKey, result: evaluateEligibility(card.rules, req.profile, { asOf, context }) }];
    });
    const body: EligibilityCheckResponse = { results };
    // The body describes one student's (non-sensitive) answers: never cache it anywhere.
    return c.json(body, 200, { "cache-control": "no-store" });
  });

  return app;
}
