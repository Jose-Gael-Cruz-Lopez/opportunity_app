import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ROUTE_LIST, ROUTES } from "@shared/contracts/routes";
import { curatorRoutes } from "./index";

/**
 * Mounted the way server/app.ts mounts it (under /api/v1), the router serves exactly the ten
 * Curator routes in the route map, and nothing the map does not list.
 */

const MAPPED = [
  "listReviewTasks",
  "getReviewTask",
  "claimReviewTask",
  "resolveReviewTask",
  "releaseReviewTask",
  "recheckReviewTask",
  "reviewTaskOfficialOpened",
  "opsPipeline",
  "retryJob",
  "releaseRollback",
] as const;

const CURATOR_UNMAPPED: readonly string[] = [];

describe("curator router wiring", () => {
  const app = new Hono().route("/api/v1", curatorRoutes);
  const keys = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));

  it("registers every mapped Curator route at its route-map path", () => {
    for (const id of MAPPED) expect(keys.has(`${ROUTES[id].method} ${ROUTES[id].path}`), id).toBe(true);
  });

  it("adds only the documented unmapped routes", () => {
    const unmapped = [...keys].filter((k) => !ROUTE_LIST.some((r) => `${r.method} ${r.path}` === k));
    expect(unmapped.sort()).toEqual([...CURATOR_UNMAPPED].sort());
  });

  it("guards the mapped routes with the auth class the map gives them", () => {
    for (const id of MAPPED) expect(["curator", "admin"]).toContain(ROUTES[id].auth);
    expect(ROUTES.releaseRollback.auth).toBe("admin");
  });
});
