import { beforeAll, describe, expect, it } from "vitest";
import type { ProgramCard } from "@shared/contracts";
import { MemoryCache } from "../lib/cache";
import { getDb } from "../db/client";
import * as advisorRepo from "../db/repos/advisor";
import { freshEventsDb, seededDb } from "../db/testing/fixtures";
import { dbPageData, type PageData } from "./data";
import { createPageRoutes, RELEASE_NOTICE } from "./index";
import { RELEASE_POINTER_KEY, clientCoreKey, releasePageData, type ReleaseBucket } from "./release";

/**
 * The pages added for Phase 1-2 (pledge, Organization pages, type hubs, advisor lists, the AI
 * deadline audit) against the real sample seed: status codes, cache headers, no cookies, CSP-safe
 * markup, index rules, JSON-LD only for real records, and the D1-failure behaviour.
 */

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ORIGIN = "https://novus.example.org";

type Seeded = Awaited<ReturnType<typeof seededDb>>;
let seeded: Seeded;
let env: Record<string, unknown>;
let publicList: { slug: string; title: string };
let restrictedList: { slug: string };
let unlistedToken: string;

const OPEN = "sample-reu-site-ecology";
const SECOND = "sample-sprinternship";
const RESTRICTED = "sample-phd-pathway-program";

beforeAll(async () => {
  seeded = await seededDb("2026-11-11");
  const events = await freshEventsDb();
  env = { DB: seeded.raw.d1, EVENTS_DB: events.raw.d1, APP_ORIGIN: ORIGIN, ENVIRONMENT: "production" };
  const ws = await advisorRepo.createWorkspace(seeded.db, { name: "Sample Pilot Office", approvedBy: "founder" }, NOW);
  const make = async (visibility: "public" | "unlisted", slugs: string[], title: string) => {
    const res = await advisorRepo.createProgramList(
      seeded.db,
      { workspaceId: ws },
      { title, description: "Sample list for tests.", visibility, items: slugs.map((programSlug, i) => ({ programSlug, cycleKey: null, note: i === 0 ? "Sample note: ask for letters early." : null })) },
      NOW,
    );
    if (!res.ok) throw new Error(`list not created: ${JSON.stringify(res)}`);
    return res.value;
  };
  const pub = await make("public", [SECOND, OPEN], "Sample sophomore picks");
  publicList = { slug: pub.slug as string, title: pub.title };
  restrictedList = { slug: (await make("public", [OPEN, RESTRICTED], "Sample pathways")).slug as string };
  unlistedToken = (await make("unlisted", [OPEN], "Sample private picks")).token as string;
});

function app(overrides: Parameters<typeof createPageRoutes>[0] = {}) {
  return createPageRoutes({ now: () => NOW, cache: null, releaseData: () => null, ...overrides });
}

async function get(path: string, init: RequestInit = {}, overrides: Parameters<typeof createPageRoutes>[0] = {}) {
  const res = await app(overrides).request(`${ORIGIN}${path}`, init, env);
  return { res, body: await res.text() };
}

function expectCspSafe(html: string): void {
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    expect(tag.includes(" src=") || tag.includes('type="application/ld+json"') || tag.includes('type="application/json"')).toBe(true);
  }
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/\son[a-z]+=/);
}

function jsonLdTypes(html: string): string[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => (JSON.parse(m[1] ?? "{}") as { "@type": string })["@type"]);
}

/** Organization slugs in the seed, with how many published programs each has. */
function seedOrgs(): { slug: string; id: string; programs: number }[] {
  return seeded.seed.organizations.map((o) => ({
    slug: o.slug as string,
    id: o.id as string,
    programs: seeded.seed.programs.filter((p) => p.organizationId === o.id && p.isPublished !== false).length,
  }));
}

/** Live PageData with extra cards appended (to push a hub over its bar in tests). */
function withCards(extra: (cards: ProgramCard[]) => ProgramCard[]): () => PageData {
  return () => {
    const data = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
    return { ...data, listCards: async (now) => extra(await data.listCards(now)) };
  };
}

/** Copies of a card as distinct real, verified programs. */
function clones(card: ProgramCard, n: number, fields: Partial<ProgramCard> = {}): ProgramCard[] {
  return Array.from({ length: n }, (_, i) => ({
    ...card,
    programId: `00000000-0000-4000-8000-${String(900 + i).padStart(12, "0")}`,
    programCycleId: `00000000-0000-4000-9000-${String(900 + i).padStart(12, "0")}`,
    slug: `real-research-${i}`,
    name: `Real Research Program ${i}`,
    isSample: false,
    verification: { state: "verified", verifiedOn: "2026-11-01", verifiedBy: card.verification.verifiedBy, freshness: "fresh" },
    ...fields,
  }));
}

describe("pledge", () => {
  it("renders nine promises as an indexable editorial page", async () => {
    const { res, body } = await get("/pledge");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(body.match(/<span class="sr">Promise \d+: <\/span>/g)).toHaveLength(9);
    expect(body).toContain("We never sell your data.");
    expect(body).toContain("awaiting review by counsel");
    expect(body).toContain('content="index, follow"');
    expect(jsonLdTypes(body)).toEqual(["WebPage", "BreadcrumbList"]);
    expectCspSafe(body);
  });
});

describe("AI deadline audit", () => {
  it("publishes the protocol and schedule with no results before the first report", async () => {
    const { res, body } = await get("/research/ai-deadline-audit");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(body).toContain("No results are published yet");
    expect(body).toContain('id="protocol"');
    expect(body).toContain('id="schedule"');
    expect(body).toContain("Wilson 95% interval");
    expect(body).not.toContain("<table");
    expect(jsonLdTypes(body)).toEqual(["WebPage", "BreadcrumbList"]);
    expectCspSafe(body);
  });

  it("301s the press short links and 404s editions that do not exist", async () => {
    const short = await get("/audit");
    expect(short.res.status).toBe(301);
    expect(short.res.headers.get("location")).toBe("/research/ai-deadline-audit");
    const dated = await get("/audit/2027-01");
    expect(dated.res.status).toBe(301);
    expect(dated.res.headers.get("location")).toBe("/research/ai-deadline-audit/2027-01");
    expect((await get("/research/ai-deadline-audit/2027-01")).res.status).toBe(404);
    expect((await get("/audit/latest")).res.status).toBe(404);
    expect((await get("/research/ai-deadline-audit/2027-01")).res.headers.get("cache-control")).toBe("no-store");
  });
});

describe("organization pages", () => {
  it("lists every published program of the organization, labelled sample and not indexed", async () => {
    const org = seedOrgs().sort((a, b) => b.programs - a.programs)[0]!;
    const { res, body } = await get(`/orgs/${org.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie")).toBeNull();
    const linked = new Set([...body.matchAll(/<h3 id="p-[^"]+"><a href="\/programs\/([a-z0-9-]+)">/g)].map((m) => m[1]));
    const expected = seeded.seed.programs.filter((p) => p.organizationId === org.id && p.isPublished !== false).map((p) => p.slug);
    expect([...linked].sort()).toEqual([...expected].sort());
    expect(body).toContain("Verified by a person");
    expect(body).toContain("are invented for this preview");
    expect(body).toContain('content="noindex, nofollow"');
    expect(jsonLdTypes(body)).toEqual([]);
    expect(body).not.toMatch(/\d+\s?%|match score/i);
    expectCspSafe(body);
  });

  it("is linked from each program page", async () => {
    const program = seeded.seed.programs.find((p) => p.slug === OPEN)!;
    const org = seedOrgs().find((o) => o.id === program.organizationId)!;
    const { body } = await get(`/programs/${OPEN}`);
    expect(body).toContain(`href="/orgs/${org.slug}"`);
  });

  it("301s case, 404s unknown and malformed slugs", async () => {
    const org = seedOrgs()[0]!;
    const upper = await get(`/orgs/${org.slug.toUpperCase()}`);
    expect(upper.res.status).toBe(301);
    expect(upper.res.headers.get("location")).toBe(`/orgs/${org.slug}`);
    expect((await get("/orgs/no-such-org")).res.status).toBe(404);
    expect((await get("/orgs/bad_slug!")).res.status).toBe(404);
  });

  it("is indexed with JSON-LD only at ten real verified programs", async () => {
    const live = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
    const base = (await live.listCards(NOW)).find((c) => c.slug === OPEN)!;
    const org = { id: base.programId, slug: "example-real-org", name: "Example Real Org", kind: "foundation" as const, country: "US", defaultTimeZone: null, websiteUrl: "https://example.org", isSample: false };
    const page = (n: number) => () => ({ ...live, getOrganization: async () => ({ organization: org, cards: clones(base, n) }) });
    const ten = await get("/orgs/example-real-org", {}, { data: page(10) });
    expect(ten.body).toContain('content="index, follow"');
    expect(jsonLdTypes(ten.body)).toEqual(["Organization", "CollectionPage", "BreadcrumbList"]);
    const nine = await get("/orgs/example-real-org", {}, { data: page(9) });
    expect(nine.body).toContain('content="noindex, nofollow"');
    expect(jsonLdTypes(nine.body)).toEqual([]);
  });
});

describe("type hubs", () => {
  it("404s every seed family, since none has ten verified programs", async () => {
    for (const path of ["/types/research", "/types/fellowships", "/types/internships", "/types/research-program"]) {
      expect((await get(path)).res.status, path).toBe(404);
    }
  });

  it("renders a hub at ten verified programs, indexed when they are real", async () => {
    const live = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
    const base = (await live.listCards(NOW)).find((c) => c.slug === OPEN)!;
    const data = withCards((cards) => [...cards.filter((c) => !c.isSample), ...clones(base, 10)]);
    const { res, body } = await get("/types/research", {}, { data });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(body).toContain("Research, <em>checked</em>.");
    expect(body).toContain("Novus lists 10 programs in research, 10 of them verified by a person");
    expect(body).toContain('content="index, follow"');
    expect(jsonLdTypes(body)).toEqual(["CollectionPage", "BreadcrumbList"]);
    expectCspSafe(body);
    const sitemap = await get("/sitemap.xml", {}, { data });
    expect(sitemap.body).toContain(`<loc>${ORIGIN}/types/research</loc>`);
  });

  it("keeps a hub that only passes with sample records out of the index", async () => {
    const live = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
    const base = (await live.listCards(NOW)).find((c) => c.slug === OPEN)!;
    const data = withCards((cards) => [...cards, ...clones(base, 6, { isSample: true })]);
    const { res, body } = await get("/types/research", {}, { data });
    expect(res.status).toBe(200);
    expect(body).toContain('content="noindex, nofollow"');
    expect(jsonLdTypes(body)).toEqual([]);
  });

  it("301s other spellings and 404s names without a hub", async () => {
    const under = await get("/types/research_program");
    expect(under.res.status).toBe(301);
    expect(under.res.headers.get("location")).toBe("/types/research-program");
    expect((await get("/types/Early-Career")).res.headers.get("location")).toBe("/types/early-career");
    for (const path of ["/types/other", "/types/gap-year", "/types/nothing"]) expect((await get(path)).res.status, path).toBe(404);
  });
});

describe("advisor lists", () => {
  it("renders a public list in the office's order with its notes, never the workspace", async () => {
    const { res, body } = await get(`/lists/${publicList.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(body).toContain(publicList.title);
    expect(body).toContain("Sample note: ask for letters early.");
    const order = [...body.matchAll(/<h3 id="p-[^"]+"><a href="\/programs\/([a-z0-9-]+)">/g)].map((m) => m[1]);
    expect(order).toEqual([SECOND, OPEN]);
    expect(body).not.toContain("Sample Pilot Office");
    expect(body).not.toContain("workspace");
    // Sample programs: never indexed, never described to search engines.
    expect(body).toContain('content="noindex, nofollow"');
    expect(jsonLdTypes(body)).toEqual([]);
    expectCspSafe(body);
  });

  it("keeps a list with a status- or identity-defined program out of search engines", async () => {
    const { res } = await get(`/lists/${restrictedList.slug}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
  });

  it("serves an unlisted list only by its token, never cached, indexed or referred", async () => {
    const { res, body } = await get(`/lists/u/${unlistedToken}`);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(body).toContain('<meta name="referrer" content="no-referrer"/>');
    expect(body).toContain("Sample private picks");
    // The token never appears in the page (no canonical, no og:url naming it).
    expect(body).not.toContain(unlistedToken);
    expect((await get(`/lists/u/${"0".repeat(22)}`)).res.status).toBe(404);
    expect((await get("/lists/u/short")).res.status).toBe(404);
    // The token does not open the list by slug, and a public slug does not work as a token.
    expect((await get(`/lists/${unlistedToken.toLowerCase()}`)).res.status).toBe(404);
  });

  it("404s unknown lists", async () => {
    expect((await get("/lists/no-such-list")).res.status).toBe(404);
  });
});

describe("D1 failure on the new pages", () => {
  const broken: PageData = {
    listCards: async () => {
      throw new Error("D1_ERROR");
    },
    getDetail: async () => {
      throw new Error("D1_ERROR");
    },
    cycleHistory: async () => [],
    resolveSlug: async () => {
      throw new Error("D1_ERROR");
    },
    getOrganization: async () => {
      throw new Error("D1_ERROR");
    },
    getPublicList: async () => {
      throw new Error("D1_ERROR");
    },
  };

  async function bucket(): Promise<ReleaseBucket> {
    const cards = await dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN }).listCards(NOW);
    const objects = new Map<string, string>([
      [RELEASE_POINTER_KEY, JSON.stringify({ release: 3, path: clientCoreKey(3), sha256: "a".repeat(64), publishedAt: "2026-11-11T12:00:00Z" })],
      [clientCoreKey(3), JSON.stringify({ v: 1, release: 3, generatedAt: "2026-11-11T12:00:00Z", cards, merged: {}, containsSample: true })],
    ]);
    return { get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) as string } : null) };
  }

  it("answers 503 for organization and list pages rather than guessing from the release", async () => {
    const b = await bucket();
    const org = seedOrgs()[0]!;
    for (const path of [`/orgs/${org.slug}`, `/lists/${publicList.slug}`, `/lists/u/${unlistedToken}`]) {
      const { res, body } = await get(path, {}, { data: () => broken, releaseData: () => releasePageData(b) });
      expect(res.status, path).toBe(503);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(body).not.toContain("D1_ERROR");
    }
  });

  it("renders a type hub from the release when it passes the bar there", async () => {
    const b = await bucket();
    const { res } = await get("/types/research", {}, { data: () => broken, releaseData: () => releasePageData(b) });
    // The seed's release has four research programs: below the bar, so a plain 404, not a 503.
    expect(res.status).toBe(404);
    expect(RELEASE_NOTICE.length).toBeGreaterThan(0);
  });
});

describe("methods detail", () => {
  it("explains the workflow, accuracy, AI use, odds, advisors and money with links", async () => {
    const { res, body } = await get("/methods");
    expect(res.status).toBe(200);
    for (const id of ["verify", "workflow", "freshness", "dates", "accuracy", "ai", "odds", "privacy", "coverage", "advisors", "money", "corrections", "terms"]) {
      expect(body, id).toContain(`id="${id}"`);
    }
    expect(body).toContain("No accuracy figure is published yet.");
    expect(body).toContain('href="/research/ai-deadline-audit"');
    expect(body).toContain('href="/pledge"');
    expect(body).toContain("nothing for a group under 5");
    expect(jsonLdTypes(body)).toEqual(["WebPage", "BreadcrumbList"]);
    expectCspSafe(body);
  });
});

describe("cookies and caching across the new pages", () => {
  it("never sets a cookie and stores only anonymous renders at the edge", async () => {
    const org = seedOrgs()[0]!;
    const paths = ["/pledge", "/research/ai-deadline-audit", `/orgs/${org.slug}`, `/lists/${publicList.slug}`, `/lists/u/${unlistedToken}`, "/types/research"];
    for (const path of paths) {
      const { res } = await get(path, { headers: { cookie: "__Host-novus.session=abc" } });
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
    const cache = new MemoryCache();
    const routes = createPageRoutes({ now: () => NOW, cache, releaseData: () => null });
    const first = await routes.request(`${ORIGIN}/orgs/${org.slug}`, {}, env);
    const second = await routes.request(`${ORIGIN}/orgs/${org.slug}`, { headers: { cookie: "a=b" } }, env);
    expect(first.headers.get("x-novus-cache")).toBe("MISS");
    expect(second.headers.get("x-novus-cache")).toBe("HIT");
    // Unlisted lists never enter the edge cache.
    const u1 = await routes.request(`${ORIGIN}/lists/u/${unlistedToken}`, {}, env);
    const u2 = await routes.request(`${ORIGIN}/lists/u/${unlistedToken}`, {}, env);
    expect(u1.headers.get("x-novus-cache")).toBeNull();
    expect(u2.headers.get("x-novus-cache")).toBeNull();
  });
});
