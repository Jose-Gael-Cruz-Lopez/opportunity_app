import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { eq } from "drizzle-orm";
import {
  DeadlineListResponseSchema,
  InstitutionSearchResponseSchema,
  OpportunityTypeListResponseSchema,
  ProgramListResponseSchema,
  SearchResponseSchema,
} from "@shared/contracts/api";
import { EligibilityCheckResponseSchema } from "@shared/contracts/eligibility";
import { ProgramDetailSchema, type ProgramCard } from "@shared/contracts/registry";
import type { AppEnv } from "@server/env";
import * as s from "@server/db/schema";
import { sampleIds } from "@server/db/seed/build";
import { seededDb } from "@server/db/testing/fixtures";
import { CardCache } from "./cards";
import { openToTwoYear } from "./listing";
import { createRegistryRoutes } from "./routes";
import { OrganizationResponseSchema, TypeHubResponseSchema } from "./schemas";
import { createD1RegistryStore } from "./store";

/** Integration: the routes over the D1 store, the committed migrations and the sample seed. */

const NOW = Date.parse("2026-11-11T15:00:00Z");

async function setup() {
  const t = await seededDb();
  const store = createD1RegistryStore(t.db);
  const app = new Hono<AppEnv>();
  app.use("*", async (c, next) => {
    c.set("requestId", "test");
    await next();
  });
  app.route("/api/v1", createRegistryRoutes({ store: () => store, now: () => NOW, origin: () => "https://novus.example.org", cards: new CardCache() }));
  return { t, store, app };
}

const get = async (app: Hono<AppEnv>, path: string): Promise<unknown> => {
  const res = await app.request(path);
  expect(res.status, path).toBe(200);
  return res.json() as Promise<unknown>;
};

describe("registry routes over D1 (sample data)", () => {
  it("lists every published sample program as a valid card, all labelled sample", async () => {
    const { app } = await setup();
    const body = ProgramListResponseSchema.parse(await get(app, "/api/v1/programs?limit=100"));
    expect(body.items.length).toBeGreaterThanOrEqual(20);
    expect(body.items.every((c) => c.isSample)).toBe(true);
    expect(body.release).toBe(0);
    expect(body.items[0]!.status).toBe("open");
  });

  it("serves program detail with requirements, evidence and a citation", async () => {
    const { app } = await setup();
    const detail = ProgramDetailSchema.parse(await get(app, "/api/v1/programs/sample-reu-site-ecology"));
    expect(detail.program.slug).toBe("sample-reu-site-ecology");
    expect(detail.requirements.length).toBeGreaterThan(0);
    expect(detail.citation.novusUrl).toBe("https://novus.example.org/programs/sample-reu-site-ecology");
    expect(detail.citation.license).toBe("CC-BY-4.0");
  });

  it("redirects a renamed slug and hides unpublished programs", async () => {
    const { t, app } = await setup();
    await t.db.insert(s.slugRedirects).values({ fromSlug: "sample-reu-old-name", toProgramId: sampleIds.program("sample-reu-site-ecology"), createdAt: NOW });
    const moved = await app.request("/api/v1/programs/sample-reu-old-name");
    expect(moved.status).toBe(301);
    expect(moved.headers.get("location")).toBe("/api/v1/programs/sample-reu-site-ecology");

    await t.db.update(s.programs).set({ isPublished: false }).where(eq(s.programs.id, sampleIds.program("sample-reu-site-ecology")));
    expect((await app.request("/api/v1/programs/sample-reu-site-ecology")).status).toBe(404);
    expect((await app.request("/api/v1/programs/sample-reu-old-name")).status).toBe(404);
  });

  it("lists upcoming deadlines, opportunity types, a type hub and an Organization", async () => {
    const { app } = await setup();
    const deadlines = DeadlineListResponseSchema.parse(await get(app, "/api/v1/deadlines?withinDays=120&limit=100"));
    expect(deadlines.items.length).toBeGreaterThan(0);
    const types = OpportunityTypeListResponseSchema.parse(await get(app, "/api/v1/opportunity-types"));
    expect(types.items.find((t) => t.slug === "research_program")?.programCount).toBeGreaterThan(0);
    const hub = TypeHubResponseSchema.parse(await get(app, "/api/v1/opportunity-types/research_program"));
    expect(hub.items.some((c) => c.slug === "sample-reu-site-ecology")).toBe(true);
    const org = OrganizationResponseSchema.parse(await get(app, "/api/v1/organizations/example-science-foundation"));
    expect(org.organization.isSample).toBe(true);
    expect(org.programs.some((c) => c.slug === "sample-reu-site-ecology")).toBe(true);
  });

  it("finds sample institutions by name, with LIKE wildcards treated as text", async () => {
    const { app } = await setup();
    const found = InstitutionSearchResponseSchema.parse(await get(app, "/api/v1/institutions?q=community"));
    expect(found.items.map((i) => i.name)).toEqual(["Sample Community College (sample)"]);
    const wildcard = InstitutionSearchResponseSchema.parse(await get(app, "/api/v1/institutions?q=%25%25"));
    expect(wildcard.items).toEqual([]);
  });

  it("searches the same cards the browser indexes", async () => {
    const { app } = await setup();
    const res = await app.request("/api/v1/search", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: "REU ecology" }) });
    const body = SearchResponseSchema.parse(await res.json());
    expect(body.items[0]?.card.slug).toBe("sample-reu-site-ecology");
  });

  it("judges community-college access from the institution-level rule alone", async () => {
    const { store } = await setup();
    const cards = await store.listCards(NOW);
    const bySlug = (slug: string): ProgramCard => cards.find((c) => c.slug === slug)!;
    // Two-year only and two- or four-year rules both admit a two-year student.
    expect(openToTwoYear(bySlug("sample-registered-apprenticeship"), "2026-11-11")).toBe(true);
    const fourYearOnly = structuredClone(bySlug("sample-registered-apprenticeship"));
    for (const rule of fourYearOnly.rules!.rules) {
      if (rule.id === "institution_level") rule.logic = { in: [{ var: "institutionLevel" }, ["four_year"]] };
    }
    expect(openToTwoYear(fourYearOnly, "2026-11-11")).toBe(false);
  });

  it("checks non-sensitive eligibility and leaves status rules unknown", async () => {
    const { app } = await setup();
    const res = await app.request("/api/v1/eligibility/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ programs: ["sample-reu-site-ecology", "sample-not-a-program"], profile: { classYear: "first_year" }, asOf: "2026-11-11" }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const body = EligibilityCheckResponseSchema.parse(await res.json());
    expect(body.results.map((r) => r.slug)).toEqual(["sample-reu-site-ecology"]);
    const result = body.results[0]!.result;
    // The citizenship rule is sensitive: the server can never decide it.
    expect(result.status).not.toBe("eligible");
    expect(result.rules.find((r) => r.dimension === "citizenship")?.verdict).toBe("unknown");

    const refused = await app.request("/api/v1/eligibility/check", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ programs: ["sample-reu-site-ecology"], profile: { citizenship: "us_citizen" } }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.text()).not.toContain("us_citizen");
  });
});
