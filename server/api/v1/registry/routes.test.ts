import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import {
  DeadlineListResponseSchema,
  InstitutionSearchResponseSchema,
  OpportunityTypeListResponseSchema,
  ProgramListResponseSchema,
  SearchResponseSchema,
} from "@shared/contracts/api";
import { ProblemDetailsSchema } from "@shared/contracts/common";
import { FORBIDDEN_STUDENT_SCORE_FIELDS } from "@shared/contracts/readiness";
import type { ProgramDetail } from "@shared/contracts/registry";
import type { AppEnv } from "@server/env";
import type { RegistryStore } from "./ports";
import { createRegistryRoutes } from "./routes";
import { OrganizationResponseSchema, TypeHubResponseSchema } from "./schemas";
import { CARDS, memoryStore, testDeps } from "./testing";

function appFor(store: RegistryStore): Hono<AppEnv> {
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "test");
    await next();
  });
  app.route("/api/v1", createRegistryRoutes(testDeps(store)));
  return app;
}

async function json(res: Response): Promise<unknown> {
  return res.json() as Promise<unknown>;
}

/** Walks a JSON value and returns every object key, for the no-score check. */
function allKeys(value: unknown, out = new Set<string>()): Set<string> {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      allKeys(v, out);
    }
  }
  return out;
}

describe("GET /api/v1/programs", () => {
  it("returns cards in public order with the release, in the contract shape", async () => {
    const res = await appFor(memoryStore()).request("/api/v1/programs");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    const body = ProgramListResponseSchema.parse(await json(res));
    expect(body.release).toBe(7);
    expect(body.items[0]?.slug).toBe("sample-nominated-scholarship");
    expect(body.items).toHaveLength(CARDS.length);
    expect(body.page.nextCursor).toBeNull();
  });

  it("pages with an opaque cursor and refuses a forged one", async () => {
    const app = appFor(memoryStore());
    const first = ProgramListResponseSchema.parse(await json(await app.request("/api/v1/programs?limit=2")));
    expect(first.items).toHaveLength(2);
    expect(first.page.nextCursor).not.toBeNull();
    const second = ProgramListResponseSchema.parse(await json(await app.request(`/api/v1/programs?limit=2&cursor=${first.page.nextCursor}`)));
    expect(second.items.map((c) => c.slug)).not.toContain(first.items[0]!.slug);
    const bad = await app.request("/api/v1/programs?cursor=forged");
    expect(bad.status).toBe(400);
    ProblemDetailsSchema.parse(await json(bad));
  });

  it("filters by type and searches by text without sharing the answer with other users' caches", async () => {
    const app = appFor(memoryStore());
    const typed = ProgramListResponseSchema.parse(await json(await app.request("/api/v1/programs?type=sprinternship")));
    expect(typed.items.map((c) => c.slug)).toEqual(["sample-soon-sprint"]);

    const res = await app.request("/api/v1/programs?q=nominated%20scholarship");
    expect(res.headers.get("cache-control")).toBe("private, max-age=60");
    const found = ProgramListResponseSchema.parse(await json(res));
    expect(found.items[0]?.slug).toBe("sample-nominated-scholarship");
  });

  it("refuses status or identity keys before parsing, without echoing values", async () => {
    const res = await appFor(memoryStore()).request("/api/v1/programs?citizenship=f1-visa-canary");
    expect(res.status).toBe(400);
    const text = await res.text();
    expect(text).toContain("sensitive_field_rejected");
    expect(text).not.toContain("f1-visa-canary");
  });

  it("rejects unknown filters and values with fixed messages", async () => {
    const app = appFor(memoryStore());
    expect((await app.request("/api/v1/programs?type=not_a_type")).status).toBe(400);
    expect((await app.request("/api/v1/programs?unknown=1")).status).toBe(400);
    expect((await app.request("/api/v1/programs?limit=1000")).status).toBe(400);
  });
});

describe("GET /api/v1/programs/:slug", () => {
  const detail = { program: { slug: "sample-late-internship" } } as unknown as ProgramDetail;

  it("returns detail with the citation built from the public origin", async () => {
    let seen: { origin: string; license: string; termsPath: string } | null = null;
    const store = memoryStore({
      async programDetail(slug, _now, citation) {
        seen = citation;
        return slug === "sample-late-internship" ? detail : null;
      },
    });
    const res = await appFor(store).request("/api/v1/programs/sample-late-internship");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("public, max-age=60");
    expect(await json(res)).toEqual(detail);
    expect(seen).toEqual({ origin: "https://novus.example.org", license: "CC-BY-4.0", termsPath: "/methods#terms" });
  });

  it("301s a renamed slug and 404s unknown, unpublished or malformed ones", async () => {
    const store = memoryStore({ renamedSlug: async (slug) => (slug === "sample-old-name" ? "sample-late-internship" : null) });
    const app = appFor(store);
    const moved = await app.request("/api/v1/programs/sample-old-name");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/api/v1/programs/sample-late-internship");
    const missing = await app.request("/api/v1/programs/sample-nothing");
    expect(missing.status).toBe(404);
    expect(ProblemDetailsSchema.parse(await json(missing)).code).toBe("not_found");
    expect((await app.request("/api/v1/programs/Not_A_Slug")).status).toBe(404);
  });
});

describe("GET /api/v1/deadlines", () => {
  it("lists upcoming national deadlines within the window", async () => {
    const res = await appFor(memoryStore()).request("/api/v1/deadlines?withinDays=30");
    expect(res.status).toBe(200);
    const body = DeadlineListResponseSchema.parse(await json(res));
    expect(body.items.map((i) => i.programSlug)).toEqual(["sample-nominated-scholarship", "sample-soon-sprint", "sample-applicant-local-award"]);
    expect(body.items[0]?.nominationRequired).toBe(true);
  });

  it("validates the window", async () => {
    expect((await appFor(memoryStore()).request("/api/v1/deadlines?withinDays=0")).status).toBe(400);
  });
});

describe("taxonomy, type hubs and organizations", () => {
  it("lists opportunity types with counts", async () => {
    const store = memoryStore({
      opportunityTypeCounts: async () => [{ slug: "sprinternship", ordinal: 6, label: "Sprinternships", group: "early_career", inScope: true, programCount: 1 }],
    });
    const res = await appFor(store).request("/api/v1/opportunity-types");
    expect(res.headers.get("cache-control")).toBe("public, max-age=300");
    expect(OpportunityTypeListResponseSchema.parse(await json(res)).items).toHaveLength(1);
  });

  it("serves a type hub and 404s an unknown type", async () => {
    const app = appFor(memoryStore());
    const res = await app.request("/api/v1/opportunity-types/summer_internship");
    expect(res.status).toBe(200);
    const body = TypeHubResponseSchema.parse(await json(res));
    expect(body.type).toMatchObject({ slug: "summer_internship", label: "Summer internships", programCount: 2 });
    expect(body.items.map((c) => c.slug)).toEqual(["sample-late-internship", "sample-closed-program"]);
    expect((await app.request("/api/v1/opportunity-types/not_a_type")).status).toBe(404);
  });

  it("serves an Organization with its programs", async () => {
    const org = CARDS[0]!;
    const store = memoryStore({
      organizationBySlug: async (slug) =>
        slug === "example-org-a"
          ? {
              organization: { id: "7a000000-0000-4000-8000-000000000001", slug, name: "Example Org A", kind: "company", country: "US", defaultTimeZone: null, websiteUrl: null, isSample: true },
              programIds: [org.programId, CARDS[3]!.programId],
            }
          : null,
    });
    const app = appFor(store);
    const res = await app.request("/api/v1/organizations/example-org-a");
    expect(res.status).toBe(200);
    const body = OrganizationResponseSchema.parse(await json(res));
    expect(body.programs.map((c) => c.slug)).toEqual(["sample-late-internship", "sample-expected-fellowship"]);
    expect((await app.request("/api/v1/organizations/unknown-org")).status).toBe(404);
  });
});

describe("GET /api/v1/institutions", () => {
  it("pages by name with a keyset cursor", async () => {
    const all = ["Alpha", "Beta", "Gamma"].map((name, i) => ({ id: `7b000000-0000-4000-8000-00000000000${i}`, name: `Sample ${name} College`, level: "two_year" as const, state: null, calendar: null }));
    const seen: ({ name: string; id: string } | null)[] = [];
    const store = memoryStore({
      async searchInstitutions(_q, limit, after) {
        seen.push(after);
        const start = after ? all.findIndex((r) => r.id === after.id) + 1 : 0;
        return all.slice(start, start + limit);
      },
    });
    const app = appFor(store);
    const first = InstitutionSearchResponseSchema.parse(await json(await app.request("/api/v1/institutions?q=sample&limit=2")));
    expect(first.items).toHaveLength(2);
    const second = InstitutionSearchResponseSchema.parse(await json(await app.request(`/api/v1/institutions?q=sample&limit=2&cursor=${first.page.nextCursor}`)));
    expect(second.items.map((r) => r.name)).toEqual(["Sample Gamma College"]);
    expect(second.page.nextCursor).toBeNull();
    expect(seen[1]).toEqual({ name: "Sample Beta College", id: all[1]!.id });
    expect((await app.request("/api/v1/institutions?q=a")).status).toBe(400);
  });
});

describe("POST /api/v1/search", () => {
  const post = (app: Hono<AppEnv>, body: unknown) =>
    app.request("/api/v1/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

  it("returns ranked hits with integer ranks and why-shown codes, never a score", async () => {
    const res = await post(appFor(memoryStore()), { query: "sprint", limit: 5 });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const raw = await json(res);
    const body = SearchResponseSchema.parse(raw);
    expect(body.items[0]?.card.slug).toBe("sample-soon-sprint");
    expect(body.items[0]?.rank).toBe(0);
    const keys = allKeys(raw);
    for (const forbidden of [...FORBIDDEN_STUDENT_SCORE_FIELDS, "score", "relevance"]) expect(keys.has(forbidden), forbidden).toBe(false);
  });

  it("applies filters and refuses sensitive keys in the body", async () => {
    const app = appFor(memoryStore());
    const filtered = SearchResponseSchema.parse(await json(await post(app, { query: "sample", filters: { types: ["national_scholarship"] } })));
    expect(filtered.items.map((h) => h.card.slug)).toEqual(["sample-nominated-scholarship"]);
    const refused = await post(app, { query: "sample", filters: {}, pell: true });
    expect(refused.status).toBe(400);
    expect(await refused.text()).toContain("sensitive_field_rejected");
  });

  it("pages through results", async () => {
    const app = appFor(memoryStore());
    const first = SearchResponseSchema.parse(await json(await post(app, { query: "sample", limit: 2 })));
    expect(first.items).toHaveLength(2);
    expect(first.page.nextCursor).not.toBeNull();
    const second = SearchResponseSchema.parse(await json(await post(app, { query: "sample", limit: 2, cursor: first.page.nextCursor })));
    expect(second.items[0]?.rank).toBe(2);
  });
});
