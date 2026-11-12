/** @jsxImportSource hono/jsx */
import { Hono, type Context, type MiddlewareHandler } from "hono";
import type { Child } from "hono/jsx";
import { IdSchema, SlugSchema, type ProgramCard, type ReleaseArtifact, type ReleasePointer } from "@shared/contracts";
import { ROUTES } from "@shared/contracts/routes";
import { toIsoInstant } from "@shared/time";
import type { AppEnv, Env } from "../env";
import { sha256Hex } from "../lib/crypto";
import { getDb, getEventsDb } from "../db/client";
import * as registry from "../db/repos/registry";
import { incrementProgramDailyCount } from "../db/repos/events";
import type { CacheLike } from "../lib/cache";
import { CACHE_STATUS_HEADER, NEAR_DEADLINE_HEADER, edgeCache } from "../middleware/edge-cache";
import { assetForPath } from "./assets";
import { renderDocument, type SiteContext } from "./components/layout";
import { dbPageData, readData, DataUnavailableError, type ListRef, type PageData, type PublicListData } from "./data";
import { AUDIT_PATH, findReport, latestReport, REPORT_ID } from "./audit";
import { hubAvailable, hubPath, parseHubParam } from "./hubs";
import { BROWSER_CACHE, EDGE_STORABLE, browserCache, type BrowserCachePolicy } from "./headers";
import { artifactKeyFor, clientCoreKey, clientCorePath, publicPointer, readPointer, readText, releasePageData, type ReleaseBucket } from "./release";
import { llmsTxt, robotsTxt, securityTxt, sitemapXml } from "./text";
import { todayIso } from "./view-model";
import { AuditPage } from "./views/audit";
import { BotPage } from "./views/bot";
import { DeadlinesPage, parseRange, upcomingDeadlines } from "./views/deadlines";
import { NotFoundPage, UnavailablePage } from "./views/errors";
import { ExplorePage, parseExploreQuery } from "./views/explore";
import { LandingPage } from "./views/landing";
import { ListPage } from "./views/list";
import { MethodsPage } from "./views/methods";
import { OrgPage } from "./views/org";
import { PledgePage } from "./views/pledge";
import { deadlineSoon, ProgramPage } from "./views/program";
import { REMIND_PAGE_CSP } from "./islands";
import { TypeHubPage } from "./views/type-hub";

/**
 * Public pages (plan s02 2.3.2), mounted at "/":
 *   /                      landing (Dusk to Day)
 *   /explore               every published program, GET-form filters
 *   /programs/:slug        Program page; /programs 301s to /explore
 *   /deadlines             upcoming national deadlines
 *   /methods, /bot         how Novus verifies; the crawler's contact page
 *   /pledge                the no-sale pledge
 *   /orgs/:slug            an Organization and its published programs
 *   /types/:type           a type hub (family or type), only at 10+ verified programs
 *   /lists/:slug           a public advisor list; /lists/u/:token an unlisted one (never cached)
 *   /research/ai-deadline-audit[/:edition]   the AI deadline-accuracy audit; /audit 301s to it
 *   /robots.txt, /sitemap.xml, /llms.txt, /.well-known/security.txt
 *   /data/release.json, /data/client-core/{n}.json   the published release for browser islands
 *                          (the only router serving /data/*; release 0 is built live from D1
 *                          until the first release exists)
 *   /out/:programCycleId   the apply link, counted per program per day, then 302
 *   /p/{name}.{hash}.{ext} page CSS and scripts
 *
 * Pages never read cookies (the edge cache strips them before a handler runs) and never set any.
 * Each page renders from a PageData port: D1 normally; when D1 fails and the edge has no
 * last-good copy, the same view renders from the R2 release with a "saved copy" banner.
 */

export interface PageDeps {
  /** Live reads; the default goes through the registry repositories on DB. */
  readonly data: (env: Env, origin: string) => PageData;
  /** Reads from the published release (fallback), or null when there is no bucket. */
  readonly releaseData: (env: Env) => PageData | null;
  readonly now: () => number;
  /** Edge cache store: undefined uses caches.default where it exists, null turns caching off. */
  readonly cache?: CacheLike | null;
  /** Counts an apply click for a program and day; failures never block the redirect. */
  readonly countApplyClick: (env: Env, programId: string, day: string) => Promise<void>;
}

export const RELEASE_NOTICE =
  "Showing the last published copy of Novus while live data is briefly unavailable. Check the official site before you rely on a date.";

const DEFAULT_DEPS: PageDeps = {
  data: (env, origin) => dbPageData(getDb(env.DB), { origin, license: "CC BY 4.0" }),
  releaseData: (env) => (env.STORE ? releasePageData(env.STORE as unknown as ReleaseBucket) : null),
  now: () => Date.now(),
  countApplyClick: (env, programId, day) => incrementProgramDailyCount(getEventsDb(env.EVENTS_DB), programId, day, "apply_click"),
};

/** Every read wrapped, so a D1 failure surfaces as DataUnavailableError and not as a render bug. */
function guarded(data: PageData): PageData {
  const { getOrganization, getPublicList, mergedSlugs } = data;
  return {
    listCards: (now) => readData(() => data.listCards(now)),
    getDetail: (slug, now) => readData(() => data.getDetail(slug, now)),
    cycleHistory: (programId, cycleKey) => readData(() => data.cycleHistory(programId, cycleKey)),
    resolveSlug: (slug) => readData(() => data.resolveSlug(slug)),
    ...(getOrganization ? { getOrganization: (slug: string, now: number) => readData(() => getOrganization.call(data, slug, now)) } : {}),
    ...(getPublicList ? { getPublicList: (ref: ListRef, now: number) => readData(() => getPublicList.call(data, ref, now)) } : {}),
    ...(mergedSlugs ? { mergedSlugs: (since: number) => readData(() => mergedSlugs.call(data, since)) } : {}),
  };
}

/** A read only D1 can answer; from the release it is "briefly unavailable", never a guess. */
function liveOnly<T>(read: T | undefined): T {
  if (read === undefined) throw new DataUnavailableError(new Error("this page needs live registry data"));
  return read;
}

/** Slug merges older than this drop out of a live release's `merged` map (plan 3.11: 13 months). */
const MERGED_WINDOW_MS = 395 * 86_400_000;
/** The live release 0 changes as D1 changes, so browsers keep it a minute, never for a year. */
const LIVE_RELEASE_CACHE = "public, max-age=60";
const UNLISTED_TOKEN = /^[0-9A-Za-z]{20,32}$/;

export function originOf(c: Context<AppEnv>): string {
  const configured = c.env?.APP_ORIGIN?.replace(/\/$/, "");
  return configured || new URL(c.req.url).origin;
}

function siteFor(c: Context<AppEnv>, now: number, containsSample: boolean, notice: string | null): SiteContext {
  return {
    origin: originOf(c),
    indexable: c.env?.ENVIRONMENT === "production",
    containsSample,
    year: Number(todayIso(now).slice(0, 4)),
    notice,
  };
}

function html(c: Context<AppEnv>, node: Child, status: 200 | 404 | 503, extra: Record<string, string> = {}): Response {
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=UTF-8",
    // Only a 200 may be stored at the edge; errors are never cached anywhere.
    "cache-control": status === 200 ? EDGE_STORABLE : BROWSER_CACHE.none,
    ...extra,
  };
  return c.body(renderDocument(node), status, headers);
}

function text(c: Context<AppEnv>, body: string, contentType: string, status: 200 | 503 = 200): Response {
  return c.body(body, status, {
    "content-type": `${contentType}; charset=UTF-8`,
    "cache-control": status === 200 ? EDGE_STORABLE : BROWSER_CACHE.none,
  });
}

/** Renders one page from whichever PageData it is given; `notice` marks a release-backed render. */
type PageRender = (c: Context<AppEnv>, data: PageData, notice: string | null) => Promise<Response>;

interface PageOptions {
  readonly policy: BrowserCachePolicy;
  /** Query parameters that change the page (everything else is dropped from the cache key). */
  readonly varyParams?: readonly string[];
  /** Body for a 503 when neither D1 nor the release can answer. */
  readonly unavailable?: (c: Context<AppEnv>) => Response;
}

/** Sets the browser policy after the edge cache, except on saved copies, which are never kept. */
function browserPolicy(policy: BrowserCachePolicy): MiddlewareHandler<AppEnv> {
  const apply = browserCache(policy);
  return async (c, next) => {
    let saved = false;
    await apply(c, async () => {
      await next();
      const state = c.res.headers.get(CACHE_STATUS_HEADER);
      saved = state === "STALE" || state === "FALLBACK";
    });
    if (saved) c.res.headers.set("cache-control", BROWSER_CACHE.none);
  };
}

export function createPageRoutes(overrides: Partial<PageDeps> = {}): Hono<AppEnv> {
  const deps: PageDeps = { ...DEFAULT_DEPS, ...overrides };
  const pages = new Hono<AppEnv>();

  const unavailablePage = (c: Context<AppEnv>): Response =>
    html(c, <UnavailablePage site={siteFor(c, deps.now(), false, null)} path={new URL(c.req.url).pathname} />, 503);

  /** Route chain: browser policy, edge cache (with the release fallback), then the live render. */
  const page = (render: PageRender, options: PageOptions): [MiddlewareHandler<AppEnv>, MiddlewareHandler<AppEnv>, MiddlewareHandler<AppEnv>] => {
    const unavailable = options.unavailable ?? unavailablePage;
    const live: MiddlewareHandler<AppEnv> = async (c) => {
      try {
        return await render(c, guarded(deps.data(c.env, originOf(c))), null);
      } catch (err) {
        if (err instanceof DataUnavailableError) return unavailable(c);
        throw err;
      }
    };
    const fallback = async (c: Context<AppEnv>): Promise<Response | null> => {
      const release = deps.releaseData(c.env);
      if (!release) return null;
      const res = await render(c, release, RELEASE_NOTICE);
      return res.status === 200 || res.status === 301 || res.status === 404 ? res : null;
    };
    const cache = edgeCache({
      ...(deps.cache !== undefined ? { cache: deps.cache } : {}),
      varyParams: options.varyParams ?? [],
      fallback,
      now: deps.now,
    });
    return [browserPolicy(options.policy), cache, live];
  };

  // ---- Landing -------------------------------------------------------------------------------
  pages.get(
    "/",
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const cards = await data.listCards(now);
        const site = siteFor(c, now, cards.some((x) => x.isSample), notice);
        return html(c, <LandingPage model={{ cards, now }} site={site} />, 200, nearHeader(cards, now));
      },
      { policy: "listing" },
    ),
  );

  // ---- Explore -------------------------------------------------------------------------------
  pages.get(
    "/explore",
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const cards = await data.listCards(now);
        const query = parseExploreQuery(new URL(c.req.url).searchParams);
        const site = siteFor(c, now, cards.some((x) => x.isSample), notice);
        return html(c, <ExplorePage model={{ cards, query, now }} site={site} />, 200, nearHeader(cards, now));
      },
      { policy: "private", varyParams: ["q", "group", "status", "paid", "free"] },
    ),
  );

  pages.get("/programs", (c) => c.redirect("/explore", 301));

  // ---- Program page --------------------------------------------------------------------------
  pages.get(
    "/programs/:slug",
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const raw = c.req.param("slug") ?? "";
        const lower = raw.toLowerCase();
        if (lower !== raw && SlugSchema.safeParse(lower).success) return c.redirect(`/programs/${lower}`, 301);
        const site404 = (): Response => html(c, <NotFoundPage site={siteFor(c, now, false, notice)} path={`/programs/${raw}`} />, 404);
        if (!SlugSchema.safeParse(raw).success) return site404();

        const detail = await data.getDetail(raw, now);
        if (!detail) {
          const resolved = await data.resolveSlug(raw);
          return resolved.kind === "moved" ? c.redirect(`/programs/${resolved.slug}`, 301) : site404();
        }
        const history = await data.cycleHistory(detail.program.id, detail.cycle.cycleKey);
        const model = { detail, history, now };
        const site = siteFor(c, now, detail.program.isSample, notice);
        // The Remind me island loads Turnstile, so this page's policy admits challenges.cloudflare.com.
        const headers: Record<string, string> = { "content-security-policy": REMIND_PAGE_CSP };
        if (deadlineSoon(model)) headers[NEAR_DEADLINE_HEADER] = "1";
        return html(c, <ProgramPage model={model} site={site} />, 200, headers);
      },
      { policy: "private" },
    ),
  );

  // ---- Deadlines -----------------------------------------------------------------------------
  pages.get(
    "/deadlines",
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const cards = await data.listCards(now);
        const range = parseRange(c.req.query("days"));
        const site = siteFor(c, now, cards.some((x) => x.isSample), notice);
        return html(c, <DeadlinesPage model={{ cards, range, now }} site={site} />, 200, nearHeader(cards, now));
      },
      { policy: "listing", varyParams: ["days"] },
    ),
  );

  // ---- Editorial -----------------------------------------------------------------------------
  pages.get(
    "/methods",
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const cards = await data.listCards(now);
        const site = siteFor(c, now, cards.some((x) => x.isSample), notice);
        return html(c, <MethodsPage model={{ cards, now }} site={site} />, 200);
      },
      { policy: "editorial" },
    ),
  );

  pages.get("/bot", browserPolicy("editorial"), (c) => html(c, <BotPage site={siteFor(c, deps.now(), false, null)} />, 200));

  pages.get(ROUTES.pledgePage.path, browserPolicy("editorial"), (c) => html(c, <PledgePage site={siteFor(c, deps.now(), false, null)} />, 200));

  // ---- AI deadline-accuracy audit ------------------------------------------------------------
  pages.get(AUDIT_PATH, browserPolicy("editorial"), (c) => {
    const now = deps.now();
    const report = latestReport();
    return html(c, <AuditPage model={{ report, path: AUDIT_PATH, now }} site={siteFor(c, now, false, null)} />, 200);
  });
  pages.get(`${AUDIT_PATH}/:edition`, browserPolicy("editorial"), (c) => {
    const now = deps.now();
    const edition = c.req.param("edition");
    const report = REPORT_ID.test(edition) ? findReport(edition) : null;
    if (!report) return html(c, <NotFoundPage site={siteFor(c, now, false, null)} path={AUDIT_PATH} />, 404);
    const path = `${AUDIT_PATH}/${report.id}`;
    return html(c, <AuditPage model={{ report, path, now }} site={siteFor(c, now, report.isSample, null)} />, 200);
  });
  // Short links for press (plan s02 2.9): one canonical page, dated editions under it.
  pages.get(ROUTES.auditRedirect.path, (c) => c.redirect(AUDIT_PATH, 301));
  pages.get("/audit/:edition", (c) => {
    const edition = c.req.param("edition");
    if (!REPORT_ID.test(edition)) return html(c, <NotFoundPage site={siteFor(c, deps.now(), false, null)} path={AUDIT_PATH} />, 404);
    return c.redirect(`${AUDIT_PATH}/${edition}`, 301);
  });

  // ---- Type hubs -----------------------------------------------------------------------------
  pages.get(
    ROUTES.typePage.path,
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const raw = c.req.param("type") ?? "";
        const parsed = parseHubParam(raw);
        const notFound = (): Response => html(c, <NotFoundPage site={siteFor(c, now, false, notice)} path="/explore" />, 404);
        if (!parsed) return notFound();
        if (!parsed.canonical) return c.redirect(hubPath(parsed.key), 301);
        const cards = await data.listCards(now);
        // Below the verified-program bar there is no hub: Explore's filter covers it.
        if (!hubAvailable(cards, parsed.key, now)) return notFound();
        const site = siteFor(c, now, cards.some((x) => x.isSample), notice);
        return html(c, <TypeHubPage model={{ key: parsed.key, cards, now }} site={site} />, 200, nearHeader(cards, now));
      },
      { policy: "listing" },
    ),
  );

  // ---- Organization pages --------------------------------------------------------------------
  pages.get(
    ROUTES.orgPage.path,
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const raw = c.req.param("slug") ?? "";
        const lower = raw.toLowerCase();
        if (lower !== raw && SlugSchema.safeParse(lower).success) return c.redirect(`/orgs/${lower}`, 301);
        const notFound = (): Response => html(c, <NotFoundPage site={siteFor(c, now, false, notice)} path="/explore" />, 404);
        if (!SlugSchema.safeParse(raw).success) return notFound();
        const found = await liveOnly(data.getOrganization)(raw, now);
        if (!found) return notFound();
        const site = siteFor(c, now, found.organization.isSample || found.cards.some((x) => x.isSample), notice);
        return html(c, <OrgPage model={{ organization: found.organization, cards: found.cards, now }} site={site} />, 200, nearHeader(found.cards, now));
      },
      { policy: "listing" },
    ),
  );

  // ---- Advisor lists -------------------------------------------------------------------------
  const listResponse = (c: Context<AppEnv>, list: PublicListData, path: string, now: number, notice: string | null): Response => {
    const cards = list.entries.map((e) => e.card);
    const site = siteFor(c, now, cards.some((x) => x.isSample), notice);
    return html(c, <ListPage model={{ list, path, now }} site={site} />, 200, nearHeader(cards, now));
  };

  pages.get(
    ROUTES.listPage.path,
    ...page(
      async (c, data, notice) => {
        const now = deps.now();
        const raw = c.req.param("slug") ?? "";
        const lower = raw.toLowerCase();
        if (lower !== raw && SlugSchema.safeParse(lower).success) return c.redirect(`/lists/${lower}`, 301);
        const notFound = (): Response => html(c, <NotFoundPage site={siteFor(c, now, false, notice)} path="/explore" />, 404);
        if (!SlugSchema.safeParse(raw).success) return notFound();
        const list = await liveOnly(data.getPublicList)({ slug: raw }, now);
        if (!list) return notFound();
        const res = listResponse(c, list, `/lists/${raw}`, now, notice);
        // A list holding a status- or identity-defined program stays out of search engines.
        if (list.restricted) res.headers.set("x-robots-tag", "noindex, nofollow");
        return res;
      },
      { policy: "listing" },
    ),
  );

  /**
   * Unlisted lists: the token in the path is the capability. No edge or browser copy, no index,
   * no referrer (a meta tag, since the global header middleware sets its own Referrer-Policy),
   * and no saved-copy fallback: the release does not hold lists.
   */
  pages.get("/lists/u/:token", async (c) => {
    const now = deps.now();
    const privateHeaders = { "cache-control": BROWSER_CACHE.none, "x-robots-tag": "noindex, nofollow" };
    const notFound = (): Response => html(c, <NotFoundPage site={siteFor(c, now, false, null)} path="/explore" />, 404, privateHeaders);
    const token = c.req.param("token");
    if (!UNLISTED_TOKEN.test(token)) return notFound();
    let list: PublicListData | null;
    try {
      list = await liveOnly(guarded(deps.data(c.env, originOf(c))).getPublicList)({ token }, now);
    } catch (err) {
      if (err instanceof DataUnavailableError) return unavailablePage(c);
      throw err;
    }
    if (!list || list.visibility !== "unlisted") return notFound();
    const res = listResponse(c, list, "/lists/u", now, null);
    for (const [k, v] of Object.entries(privateHeaders)) res.headers.set(k, v);
    return res;
  });

  // ---- Text files ----------------------------------------------------------------------------
  pages.get("/robots.txt", browserPolicy("editorial"), (c) =>
    text(c, robotsTxt(originOf(c), c.env?.ENVIRONMENT === "production"), "text/plain"),
  );
  pages.get("/.well-known/security.txt", browserPolicy("editorial"), (c) => text(c, securityTxt(originOf(c), deps.now()), "text/plain"));

  const textUnavailable = (c: Context<AppEnv>): Response => text(c, "Temporarily unavailable.\n", "text/plain", 503);
  pages.get(
    "/sitemap.xml",
    ...page(
      async (c, data) => {
        const now = deps.now();
        return text(c, sitemapXml(originOf(c), await data.listCards(now), now), "application/xml");
      },
      { policy: "editorial", unavailable: textUnavailable },
    ),
  );
  pages.get(
    "/llms.txt",
    ...page(
      async (c, data) => {
        const now = deps.now();
        return text(c, llmsTxt(originOf(c), await data.listCards(now), now), "text/markdown");
      },
      { policy: "editorial", unavailable: textUnavailable },
    ),
  );

  // ---- Page assets ---------------------------------------------------------------------------
  pages.get("/p/:file", (c) => {
    const found = assetForPath(new URL(c.req.url).pathname);
    if (!found) return c.notFound();
    // An old hash still gets the newest file (HTML cached before a deploy), but not forever.
    return c.body(found.body, 200, {
      "content-type": found.contentType,
      "cache-control": found.current ? BROWSER_CACHE.immutable : BROWSER_CACHE.editorial,
    });
  });

  // ---- Release files -------------------------------------------------------------------------
  // The only router serving /data/* (server/api/v1/registry's duplicate was removed).

  /** Release 0: the artifact assembled live from D1, for environments before their first release. */
  const liveReleaseBody = async (c: Context<AppEnv>): Promise<{ body: string; at: number }> => {
    const now = deps.now();
    const at = Math.floor(now / 60_000) * 60_000;
    const data = guarded(deps.data(c.env, originOf(c)));
    const cards = await data.listCards(now);
    const merged = data.mergedSlugs ? await data.mergedSlugs(now - MERGED_WINDOW_MS) : {};
    const artifact: ReleaseArtifact = { v: 1, release: 0, generatedAt: toIsoInstant(at), cards, merged, containsSample: cards.some((x) => x.isSample) };
    return { body: JSON.stringify(artifact), at };
  };
  const releaseUnavailable = (c: Context<AppEnv>): Response => c.json({ error: "unavailable" }, 503, { "cache-control": BROWSER_CACHE.none });

  pages.get(ROUTES.releasePointer.path, async (c) => {
    const bucket = c.env?.STORE as unknown as ReleaseBucket | undefined;
    const pointer = bucket ? await readPointer(bucket).catch(() => null) : null;
    if (pointer) return c.json(publicPointer(pointer), 200, { "cache-control": ROUTES.releasePointer.cache });
    try {
      const live = await liveReleaseBody(c);
      const body: ReleasePointer = { release: 0, path: clientCorePath(0), sha256: await sha256Hex(live.body), publishedAt: toIsoInstant(live.at) };
      return c.json(body, 200, { "cache-control": LIVE_RELEASE_CACHE });
    } catch (err) {
      if (err instanceof DataUnavailableError) return releaseUnavailable(c);
      throw err;
    }
  });

  pages.get(ROUTES.clientCore.path, async (c) => {
    const release = Number.parseInt(c.req.param("file"), 10);
    if (!Number.isSafeInteger(release)) return c.json({ error: "not_found" }, 404, { "cache-control": BROWSER_CACHE.none });
    if (release === 0) {
      try {
        const live = await liveReleaseBody(c);
        return c.body(live.body, 200, { "content-type": "application/json; charset=UTF-8", "cache-control": LIVE_RELEASE_CACHE });
      } catch (err) {
        if (err instanceof DataUnavailableError) return releaseUnavailable(c);
        throw err;
      }
    }
    const bucket = c.env?.STORE as unknown as ReleaseBucket | undefined;
    if (!bucket) return c.json({ error: "not_found" }, 404, { "cache-control": BROWSER_CACHE.none });
    const pointer = await readPointer(bucket).catch(() => null);
    // Releases are immutable, so a release newer than the pointer is not served yet.
    if (pointer && release > pointer.release) return c.json({ error: "not_found" }, 404, { "cache-control": BROWSER_CACHE.none });
    const body = await readText(bucket, artifactKeyFor(release, pointer)).catch(() => null);
    const found = body ?? (pointer?.release === release ? null : await readText(bucket, clientCoreKey(release)).catch(() => null));
    if (found === null) return c.json({ error: "not_found" }, 404, { "cache-control": BROWSER_CACHE.none });
    return c.body(found, 200, { "content-type": "application/json; charset=UTF-8", "cache-control": BROWSER_CACHE.immutable });
  });

  // ---- Apply link ----------------------------------------------------------------------------
  pages.get("/out/:programCycleId", async (c) => {
    const id = c.req.param("programCycleId");
    const now = deps.now();
    const notFound = (): Response => html(c, <NotFoundPage site={siteFor(c, now, false, null)} path={`/out/${id}`} />, 404);
    if (!IdSchema.safeParse(id).success) return notFound();

    const target = await applyTarget(c, id, now);
    if (!target) return notFound();
    const count = deps.countApplyClick(c.env, target.programId, todayIso(now)).catch(() => undefined);
    try {
      c.executionCtx.waitUntil(count);
    } catch {
      await count; // no execution context outside workerd
    }
    return new Response(null, {
      status: 302,
      headers: { location: target.url, "cache-control": BROWSER_CACHE.none, "referrer-policy": "strict-origin-when-cross-origin" },
    });
  });

  /** The official application URL for a published cycle: D1 first, then the release. */
  async function applyTarget(c: Context<AppEnv>, cycleId: string, now: number): Promise<{ url: string; programId: string } | null> {
    try {
      const ctx = await registry.getCycleContext(getDb(c.env.DB), cycleId);
      if (!ctx || !ctx.program.isPublished) return null;
      return safeTarget(ctx.cycle.applicationUrl ?? ctx.program.officialUrl, ctx.program.id);
    } catch {
      const release = deps.releaseData(c.env);
      const card = release ? (await release.listCards(now).catch(() => [] as ProgramCard[])).find((x) => x.programCycleId === cycleId) : undefined;
      return card ? safeTarget(card.applicationUrl ?? card.officialUrl, card.programId) : null;
    }
  }

  return pages;
}

/** Only http(s) URLs are ever redirected to, whatever a record holds. */
export function safeTarget(url: string, programId: string): { url: string; programId: string } | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" || parsed.protocol === "http:" ? { url: parsed.toString(), programId } : null;
  } catch {
    return null;
  }
}

/** Marks a listing whose soonest deadline is within 14 days, so its last-good copy lives a day. */
function nearHeader(cards: readonly ProgramCard[], now: number): Record<string, string> {
  return upcomingDeadlines(cards, now, 14).length > 0 ? { [NEAR_DEADLINE_HEADER]: "1" } : {};
}

export const pageRoutes = createPageRoutes();
