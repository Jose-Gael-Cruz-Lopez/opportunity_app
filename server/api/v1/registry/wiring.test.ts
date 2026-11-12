import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ProgramListResponseSchema, SearchResponseSchema } from "@shared/contracts/api";
import type { AppEnv, Env } from "@server/env";
import { composeApp } from "@server/lib/app-factory";
import type { FlagSnapshot } from "@server/lib/flags";
import { calRoutes } from "@server/cal";
import { seededDb } from "@server/db/testing/fixtures";
import { registryRoutes } from "./index";

/**
 * The production modules (D1 store, shared card cache) inside the real middleware stack, with
 * stub routers for the parts other modules own. Proves the mounts, the sensitive-key guard and
 * the ETag middleware work with these handlers.
 */

async function setup() {
  const t = await seededDb();
  const empty = () => new Hono<AppEnv>();
  const app = composeApp(
    {
      authRoutes: empty(),
      registryRoutes,
      studentRoutes: empty(),
      advisorRoutes: empty(),
      calRoutes,
      internalRoutes: empty(),
      mcpRoutes: empty(),
      // Release files are served by server/pages (tested there), the only /data/* router.
      pageRoutes: empty(),
    },
    { loadFlags: async () => ({ values: {}, rollouts: {}, fetchedAt: 0, source: "defaults" }) as unknown as FlagSnapshot },
  );
  const env = { DB: t.raw.d1, APP_ORIGIN: "https://novus.example.org", ENVIRONMENT: "local" } as unknown as Env;
  return { app, env };
}

describe("registry and calendar routes in the composed app", () => {
  it("serves lists with an ETag and answers revalidation with 304", async () => {
    const { app, env } = await setup();
    const res = await app.request("https://novus.example.org/api/v1/programs?limit=5", {}, env);
    expect(res.status).toBe(200);
    expect(ProgramListResponseSchema.parse(await res.json()).items).toHaveLength(5);
    const etag = res.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await app.request("https://novus.example.org/api/v1/programs?limit=5", { headers: { "if-none-match": etag! } }, env);
    expect(again.status).toBe(304);
  });

  it("refuses a sensitive key in a search body before the handler runs", async () => {
    const { app, env } = await setup();
    const res = await app.request(
      "https://novus.example.org/api/v1/search",
      { method: "POST", headers: { "content-type": "application/json", origin: "https://novus.example.org" }, body: JSON.stringify({ query: "research", immigrationStatus: "canary-value" }) },
      env,
    );
    expect(res.status).toBe(400);
    expect(await res.text()).not.toContain("canary-value");
    const ok = await app.request(
      "https://novus.example.org/api/v1/search",
      { method: "POST", headers: { "content-type": "application/json", origin: "https://novus.example.org" }, body: JSON.stringify({ query: "research" }) },
      env,
    );
    expect(ok.status).toBe(200);
    expect(SearchResponseSchema.parse(await ok.json()).items.length).toBeGreaterThan(0);
  });

  it("mounts the program calendar", async () => {
    const { app, env } = await setup();
    const ics = await app.request("https://novus.example.org/cal/p/sample-reu-site-ecology.ics", {}, env);
    expect(ics.status).toBe(200);
    expect(await ics.text()).toContain("BEGIN:VCALENDAR");
  });
});
