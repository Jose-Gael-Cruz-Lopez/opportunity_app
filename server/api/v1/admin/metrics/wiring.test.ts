import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { ROUTE_LIST, ROUTES } from "@shared/contracts/routes";
import { adminMetricsRoutes } from "./index";

/**
 * Mounted the way server/app.ts mounts it (under /api/v1 on the registry router), the admin metrics
 * router serves exactly its route-map entries and nothing the map does not list.
 */
const MAPPED = ["adminMetrics"] as const;

describe("admin metrics router wiring", () => {
  const app = new Hono().route("/api/v1", adminMetricsRoutes);
  const keys = new Set(app.routes.filter((r) => r.method !== "ALL").map((r) => `${r.method} ${r.path}`));

  it("registers every mapped route at its route-map path, on the registry mount", () => {
    for (const id of MAPPED) {
      expect(keys.has(`${ROUTES[id].method} ${ROUTES[id].path}`), id).toBe(true);
      expect(ROUTES[id].mount).toBe("registry");
    }
  });

  it("registers nothing the route map does not list", () => {
    expect([...keys].filter((k) => !ROUTE_LIST.some((r) => `${r.method} ${r.path}` === k))).toEqual([]);
  });
});
