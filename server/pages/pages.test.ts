import { beforeAll, describe, expect, it } from "vitest";
import { ReleaseArtifactSchema, ReleasePointerSchema, type ProgramDetail, type ReleaseArtifact, type ReleasePointer } from "@shared/contracts";
import { sha256Hex } from "../lib/crypto";
import { MemoryCache } from "../lib/cache";
import { freshEventsDb, seededDb } from "../db/testing/fixtures";
import { getDb } from "../db/client";
import { dbPageData, type PageData } from "./data";
import { createPageRoutes, RELEASE_NOTICE } from "./index";
import { assetPath } from "./assets";
import { RELEASE_POINTER_KEY, clientCoreKey, programDetailKey, releasePageData, type ReleaseBucket } from "./release";

const releaseDataFor = (bucket: ReleaseBucket): PageData => releasePageData(bucket);

/**
 * Renders every public page against the real sample seed (in-memory SQLite with the committed
 * migrations) and checks the contract: status, cache headers, no cookies, no inline scripts or
 * style attributes, escaped data blocks, sample labels, and the D1-failure fallbacks.
 */

const NOW = Date.parse("2026-11-11T15:00:00Z");
const ORIGIN = "https://novus.example.org";

type Seeded = Awaited<ReturnType<typeof seededDb>>;
let seeded: Seeded;
let events: Awaited<ReturnType<typeof freshEventsDb>>;
let env: Record<string, unknown>;

beforeAll(async () => {
  seeded = await seededDb("2026-11-11");
  events = await freshEventsDb();
  env = { DB: seeded.raw.d1, EVENTS_DB: events.raw.d1, APP_ORIGIN: ORIGIN, ENVIRONMENT: "production" };
});

function app(overrides: Parameters<typeof createPageRoutes>[0] = {}) {
  return createPageRoutes({ now: () => NOW, cache: null, releaseData: () => null, ...overrides });
}

async function get(path: string, init: RequestInit = {}, overrides: Parameters<typeof createPageRoutes>[0] = {}, envOverride?: Record<string, unknown>) {
  const res = await app(overrides).request(`${ORIGIN}${path}`, init, envOverride ?? env);
  return { res, body: await res.text() };
}

/** Every <script> must be external or a non-executed data block; no style attributes anywhere. */
function expectCspSafe(html: string): void {
  for (const tag of html.match(/<script\b[^>]*>/g) ?? []) {
    expect(tag.includes(" src=") || tag.includes('type="application/ld+json"') || tag.includes('type="application/json"')).toBe(true);
  }
  expect(html).not.toMatch(/\sstyle=/);
  expect(html).not.toMatch(/\son[a-z]+=/);
}

function jsonLdBlocks(html: string): unknown[] {
  return [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1] ?? "null") as unknown);
}

const publishedSlugs = (): string[] => seeded.seed.programs.filter((p) => p.isPublished !== false).map((p) => p.slug as string);

describe("landing", () => {
  it("renders the Dusk to Day page from registry data", async () => {
    const { res, body } = await get("/");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(body.startsWith("<!doctype html>")).toBe(true);
    expect(body).toContain('<canvas id="sky" aria-hidden="true"></canvas>');
    for (const id of ["slotA", "slotB", "slotC", "doors", "how", "join", "motionBtn", "clock", "doorCap"]) expect(body).toContain(`id="${id}"`);
    expect(body).toContain(assetPath("landing.css"));
    expect(body).toContain(assetPath("landing.js"));
    expect(body).toContain("Fall 2026");
    expect(body).toMatch(/Internships · \d+ programs?/);
    expect(body).toContain("includes sample data");
    expectCspSafe(body);
    const ld = jsonLdBlocks(body) as { "@type": string }[];
    expect(ld.map((n) => n["@type"])).toEqual(["Organization", "WebSite"]);
  });

  it("names no real program and features only records from the registry", async () => {
    const { body } = await get("/");
    const names = seeded.seed.programs.map((p) => p.name as string);
    const featured = body.match(/<h3 id="fp-h"><a href="\/programs\/([a-z0-9-]+)">/);
    expect(featured).not.toBeNull();
    expect(publishedSlugs()).toContain(featured?.[1]);
    expect(names.some((n) => body.includes(n))).toBe(true);
    expect(body).not.toMatch(/Google|Goldman|Goldwater|Hollings|Amgen|NOAA/);
  });
});

describe("explore", () => {
  it("lists every published program with sample labels and no browser copy", async () => {
    const { res, body } = await get("/explore");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("are invented for this preview");
    const links = new Set([...body.matchAll(/href="\/programs\/([a-z0-9-]+)"/g)].map((m) => m[1]));
    expect(links.size).toBeGreaterThan(10);
    expectCspSafe(body);
  });

  it("filters with plain GET parameters and keeps filtered views out of the index", async () => {
    const all = await get("/explore");
    const research = await get("/explore?group=research");
    const count = (html: string) => Number(/<strong>(\d+) programs?<\/strong>/.exec(html)?.[1]);
    expect(count(research.body)).toBeGreaterThan(0);
    expect(count(research.body)).toBeLessThan(count(all.body));
    expect(research.body).toContain('content="noindex, nofollow"');
    expect(research.body).toContain('<option value="research" selected="">');
  });

  it("searches by text", async () => {
    const { body } = await get("/explore?q=research");
    expect(body).toMatch(/for “research”/);
  });
});

describe("program page", () => {
  it("renders every published sample program", async () => {
    for (const slug of publishedSlugs()) {
      const { res, body } = await get(`/programs/${slug}`);
      expect(res.status, slug).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain('<h1 id="prog-name">');
      expect(body).toContain("Sources");
      expect(body).toMatch(/href="\/out\/[0-9a-f-]{36}"/);
      // Sample records are never indexed and never described to search engines as real.
      expect(body).toContain('content="noindex, nofollow"');
      expect(jsonLdBlocks(body)).toEqual([]);
      expectCspSafe(body);
      // Rule 4: no score, percentage or match number about a student.
      expect(body).not.toMatch(/\d+\s?%|match score|percent ready/i);
    }
  });

  it("shows status, the deadline in its source zone, verification and private questions", async () => {
    const withPrivate = seeded.seed.ruleSetObjects.find((r) => r.rules.some((x) => x.sensitive));
    expect(withPrivate).toBeDefined();
    const cycle = seeded.seed.programCycles.find((c) => c.id === withPrivate?.programCycleId);
    const program = seeded.seed.programs.find((p) => p.id === cycle?.programId);
    const { body } = await get(`/programs/${program?.slug as string}`);
    expect(body).toContain("Answer privately");
    expect(body).toContain("Can I apply?");
    expect(body).toMatch(/class="chip (good|warn|late|neutral)"/);
    expect(body).toMatch(/Verified|Not yet verified|Needs re-check|Being re-checked/);
    // The island adds local time; the server shows the official zone or says the time is not stated.
    expect(body).toMatch(/\b(ET|CT|MT|PT|your time zone|time not stated|Rolling|Expected around|Sometime in)\b/);
    // No form ever asks a sensitive question on a public page.
    expect(body).not.toMatch(/name="(citizenship|pell|firstGeneration|identity)/);
  });

  it("renders the Remind me island under a policy that admits Turnstile, only while the cycle takes reminders", async () => {
    let shown = 0;
    for (const slug of publishedSlugs()) {
      const { res, body } = await get(`/programs/${slug}`);
      const csp = res.headers.get("content-security-policy") ?? "";
      expect(csp, slug).toContain("https://challenges.cloudflare.com");
      expect(csp, slug).not.toContain("'unsafe-inline'");
      const status = /<p class="eyebrow label">(Ended|Paused)<\/p>/.test(body) ? "closed" : "open";
      if (body.includes('data-island="remind-me"')) {
        shown++;
        expect(status, slug).toBe("open");
        expect(body).toMatch(/<script src="\/p\/i\/[^"]+\.js"/);
      }
    }
    expect(shown).toBeGreaterThan(0);
  });

  it("answers 404 for unknown and malformed slugs and 301 for case", async () => {
    expect((await get("/programs/no-such-program")).res.status).toBe(404);
    expect((await get("/programs/bad_slug!")).res.status).toBe(404);
    const slug = publishedSlugs()[0] as string;
    const upper = await get(`/programs/${slug.toUpperCase()}`);
    expect(upper.res.status).toBe(301);
    expect(upper.res.headers.get("location")).toBe(`/programs/${slug}`);
    const index = await get("/programs");
    expect(index.res.status).toBe(301);
    expect(index.res.headers.get("location")).toBe("/explore");
  });

  it("emits escaped JSON-LD for real records, even with hostile names", async () => {
    const data = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
    const slug = publishedSlugs()[0] as string;
    const detail = (await data.getDetail(slug, NOW)) as ProgramDetail;
    const hostile = "</script><img src=x onerror=alert(1)>";
    const forged: ProgramDetail = {
      ...detail,
      program: { ...detail.program, name: hostile, summary: `</script><form action=//evil.example><input name=x>`, isSample: false },
      organization: { ...detail.organization, isSample: false },
    };
    const fake: PageData = { ...data, getDetail: async () => forged, cycleHistory: async () => [] };
    const { res, body } = await get(`/programs/${slug}`, {}, { data: () => fake });
    expect(res.status).toBe(200);
    const blocks = [...body.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => m[1] ?? "");
    expect(blocks.length).toBe(2);
    for (const block of blocks) {
      expect(block).not.toContain("</script");
      expect(block).not.toContain("<");
    }
    const program = JSON.parse(blocks[0] as string) as { "@type": string; name: string };
    expect(program["@type"]).toBe("EducationalOccupationalProgram");
    expect(program.name).toBe(hostile);
    expect(body).not.toContain("<img src=x");
    expect(body).toContain('content="index, follow"');
  });
});

describe("deadlines", () => {
  it("lists upcoming deadlines soonest first, grouped by month", async () => {
    const { res, body } = await get("/deadlines");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const months = [...body.matchAll(/<h2 class="month" id="m-(\d{4}-\d{2})">/g)].map((m) => m[1] as string);
    expect(months.length).toBeGreaterThan(0);
    expect([...months].sort()).toEqual(months);
    expectCspSafe(body);
  });

  it("narrows to 30 days", async () => {
    const wide = await get("/deadlines?days=180");
    const narrow = await get("/deadlines?days=30");
    const n = (html: string) => Number(/<strong>(\d+) deadlines?<\/strong>/.exec(html)?.[1]);
    expect(n(narrow.body)).toBeLessThanOrEqual(n(wide.body));
    expect(narrow.body).toContain("in the next 30 days");
  });
});

describe("editorial and text files", () => {
  it("renders methods and the bot page", async () => {
    const methods = await get("/methods");
    expect(methods.res.status).toBe(200);
    expect(methods.body).toContain('id="freshness"');
    expect(methods.body).toContain("sample");
    expect(methods.res.headers.get("cache-control")).toBe("public, max-age=300");
    const bot = await get("/bot");
    expect(bot.body).toContain("NovusBot");
    expectCspSafe(methods.body + bot.body);
  });

  it("serves robots.txt by environment", async () => {
    const prod = await get("/robots.txt");
    expect(prod.body).toContain("User-agent: GPTBot\nDisallow: /");
    expect(prod.body).toContain("Disallow: /app");
    expect(prod.body).toContain(`Sitemap: ${ORIGIN}/sitemap.xml`);
    const staging = await get("/robots.txt", {}, {}, { ...env, ENVIRONMENT: "staging" });
    expect(staging.body).toBe("User-agent: *\nDisallow: /\n");
  });

  it("keeps sample records out of sitemap.xml and llms.txt", async () => {
    const sitemap = await get("/sitemap.xml");
    expect(sitemap.res.headers.get("content-type")).toContain("application/xml");
    expect(sitemap.body).toContain(`<loc>${ORIGIN}/explore</loc>`);
    expect(sitemap.body).not.toContain("/programs/");
    const llms = await get("/llms.txt");
    expect(llms.body).toContain("# Novus");
    expect(llms.body).toContain("No verified programs are published yet.");
    const security = await get("/.well-known/security.txt");
    expect(security.body).toContain("Contact: mailto:security@novus.example.org");
    expect(security.body).toContain("Expires: 2027-11-11");
  });
});

describe("assets", () => {
  it("serves hashed assets immutably and old hashes briefly", async () => {
    const current = await get(assetPath("site.css"));
    expect(current.res.status).toBe(200);
    expect(current.res.headers.get("content-type")).toContain("text/css");
    expect(current.res.headers.get("cache-control")).toContain("immutable");
    const stale = await get("/p/site.00000000.css");
    expect(stale.res.status).toBe(200);
    expect(stale.res.headers.get("cache-control")).toBe("public, max-age=300");
    expect((await get("/p/evil.00000000.css")).res.status).toBe(404);
  });
});

describe("apply link", () => {
  it("redirects to the official application and counts the click per program per day", async () => {
    const cycle = seeded.seed.programCycles[0];
    const program = seeded.seed.programs.find((p) => p.id === cycle?.programId);
    const { res } = await get(`/out/${cycle?.id as string}`);
    expect(res.status).toBe(302);
    const location = res.headers.get("location") ?? "";
    expect(location).toBe(new URL((cycle?.applicationUrl as string | null) ?? (program?.officialUrl as string)).toString());
    expect(new URL(location).hostname.endsWith("example.org")).toBe(true);
    const rows = events.raw.d1.prepare("SELECT program_id, day, event_name, n FROM program_daily_counts");
    const counted = (await rows.all<{ program_id: string; day: string; event_name: string; n: number }>()).results;
    expect(counted).toContainEqual({ program_id: program?.id, day: "2026-11-11", event_name: "apply_click", n: 1 });
  });

  it("answers 404 for unknown or malformed ids", async () => {
    expect((await get("/out/not-an-id")).res.status).toBe(404);
    expect((await get("/out/00000000-0000-4000-8000-000000000000")).res.status).toBe(404);
  });
});

/** An in-memory R2 bucket holding one release built from the seeded registry. */
async function releaseBucket(): Promise<{ bucket: ReleaseBucket; pointer: ReleasePointer; artifact: ReleaseArtifact }> {
  const data = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
  const cards = await data.listCards(NOW);
  const artifact: ReleaseArtifact = { v: 1, release: 7, generatedAt: "2026-11-11T12:00:00Z", cards, merged: { "old-name": cards[0]?.slug as string }, containsSample: true };
  const pointer: ReleasePointer = { release: 7, path: clientCoreKey(7), sha256: "a".repeat(64), publishedAt: "2026-11-11T12:00:00Z" };
  const objects = new Map<string, string>([
    [RELEASE_POINTER_KEY, JSON.stringify(pointer)],
    [clientCoreKey(7), JSON.stringify(artifact)],
  ]);
  for (const card of cards) {
    const detail = await data.getDetail(card.slug, NOW);
    if (detail) objects.set(programDetailKey(7, card.slug), JSON.stringify(detail));
  }
  const bucket: ReleaseBucket = { get: async (key) => (objects.has(key) ? { text: async () => objects.get(key) as string } : null) };
  return { bucket, pointer, artifact };
}

describe("D1 failure", () => {
  const broken: PageData = {
    listCards: async () => {
      throw new Error("D1_ERROR: network connection lost");
    },
    getDetail: async () => {
      throw new Error("D1_ERROR");
    },
    cycleHistory: async () => [],
    resolveSlug: async () => {
      throw new Error("D1_ERROR");
    },
  };

  it("answers 503 without a release", async () => {
    const { res, body } = await get("/explore", {}, { data: () => broken });
    expect(res.status).toBe(503);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(body).toContain("Briefly unavailable");
    expect(body).not.toContain("D1_ERROR");
  });

  it("renders a reduced page from the published release, never cached by browsers", async () => {
    const { bucket } = await releaseBucket();
    const slug = publishedSlugs()[0] as string;
    for (const path of ["/", "/explore", "/deadlines", `/programs/${slug}`]) {
      const { res, body } = await get(path, {}, { data: () => broken, releaseData: () => releaseDataFor(bucket) });
      expect(res.status, path).toBe(200);
      expect(res.headers.get("x-novus-cache")).toBe("FALLBACK");
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain(RELEASE_NOTICE);
    }
    const moved = await get("/programs/old-name", {}, { data: () => broken, releaseData: () => releaseDataFor(bucket) });
    expect(moved.res.status).toBe(301);
  });
});

describe("release files", () => {
  it("serves the pointer and immutable client-core files from R2", async () => {
    const { bucket, artifact } = await releaseBucket();
    const withStore = { ...env, STORE: bucket };
    const pointer = await get("/data/release.json", {}, {}, withStore);
    expect(pointer.res.status).toBe(200);
    expect(JSON.parse(pointer.body)).toMatchObject({ release: 7, path: "/data/client-core/7.json" });
    const core = await get("/data/client-core/7.json", {}, {}, withStore);
    expect(core.res.status).toBe(200);
    expect(core.res.headers.get("cache-control")).toContain("immutable");
    expect((JSON.parse(core.body) as ReleaseArtifact).cards.length).toBe(artifact.cards.length);
    expect((await get("/data/client-core/8.json", {}, {}, withStore)).res.status).toBe(404);
  });

  it("builds release 0 live from D1 before any release exists, never immutable", async () => {
    const pointerRes = await get("/data/release.json");
    expect(pointerRes.res.status).toBe(200);
    expect(pointerRes.res.headers.get("cache-control")).toBe("public, max-age=60");
    const pointer = ReleasePointerSchema.parse(JSON.parse(pointerRes.body));
    expect(pointer).toMatchObject({ release: 0, path: "/data/client-core/0.json" });
    const core = await get(pointer.path);
    expect(core.res.status).toBe(200);
    expect(core.res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await sha256Hex(core.body)).toBe(pointer.sha256);
    const artifact = ReleaseArtifactSchema.parse(JSON.parse(core.body));
    expect(artifact.release).toBe(0);
    expect(artifact.containsSample).toBe(true);
    expect(artifact.cards.length).toBe(publishedSlugs().length);
  });

  it("answers 503 for release 0 when D1 is down, and 404 for unknown releases without a store", async () => {
    const down: PageData = {
      listCards: async () => {
        throw new Error("D1_ERROR");
      },
      getDetail: async () => null,
      cycleHistory: async () => [],
      resolveSlug: async () => ({ kind: "missing" }),
    };
    const res = await get("/data/release.json", {}, { data: () => down });
    expect(res.res.status).toBe(503);
    expect(res.res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).not.toContain("D1_ERROR");
    expect((await get("/data/client-core/3.json")).res.status).toBe(404);
  });
});

describe("edge cache", () => {
  it("stores the anonymous render, ignores cookies, and keeps browsers on the page policy", async () => {
    const cache = new MemoryCache();
    let reads = 0;
    const counting = (): PageData => {
      const data = dbPageData(getDb(seeded.raw.d1), { origin: ORIGIN });
      return { ...data, listCards: (now) => ((reads += 1), data.listCards(now)) };
    };
    const routes = createPageRoutes({ now: () => NOW, cache, data: counting, releaseData: () => null });
    const first = await routes.request(`${ORIGIN}/explore?group=research&utm_source=x`, {}, env);
    const second = await routes.request(`${ORIGIN}/explore?group=research`, { headers: { cookie: "session=abc" } }, env);
    expect(first.headers.get("x-novus-cache")).toBe("MISS");
    expect(second.headers.get("x-novus-cache")).toBe("HIT");
    expect(second.headers.get("cache-control")).toBe("no-store");
    expect(await second.text()).toBe(await first.text());
    expect(reads).toBe(1);
    // A different filter is a different page.
    const other = await routes.request(`${ORIGIN}/explore?group=scholarships`, {}, env);
    expect(other.headers.get("x-novus-cache")).toBe("MISS");
  });
});

describe("no cookies on public pages", () => {
  it("never sets a cookie", async () => {
    for (const path of ["/", "/explore", "/deadlines", "/methods", "/bot", "/robots.txt", "/sitemap.xml", "/llms.txt"]) {
      const { res } = await get(path, { headers: { cookie: "better-auth.session_token=abc" } });
      expect(res.headers.get("set-cookie"), path).toBeNull();
    }
  });

});
