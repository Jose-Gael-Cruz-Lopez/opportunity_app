import { describe, expect, it } from "vitest";
import { buildPath, MOUNT_BASES, pathParams, relativePath, ROUTE_LIST, ROUTES, routesForMount } from "./routes";

describe("route map", () => {
  it("has unique method + path pairs", () => {
    const seen = new Set<string>();
    for (const route of ROUTE_LIST) {
      const key = `${route.method} ${route.path}`;
      expect(seen.has(key), key).toBe(false);
      seen.add(key);
    }
  });

  it("puts every path under its mount base and versions every API path", () => {
    for (const route of ROUTE_LIST) {
      expect(route.path.startsWith(MOUNT_BASES[route.mount]), route.id).toBe(true);
      if (route.path.startsWith("/api/")) expect(/^\/api\/(v1|auth)\//.test(route.path), route.id).toBe(true);
      expect(route.phase).toBeLessThanOrEqual(2);
    }
  });

  it("gives write routes a body schema except bodiless actions", () => {
    // curatorImport takes a file (multipart, CSV or JSON) that the route parses and validates itself.
    const bodiless = new Set(["auth", "mcp", "emailActionConfirm", "emailUnsubscribe", "remindConfirm", "llmCalls", "cyclesRollover", "curatorImport"]);
    for (const route of ROUTE_LIST) {
      if ((route.method === "POST" || route.method === "PATCH" || route.method === "PUT") && !bodiless.has(route.id)) {
        expect(route.body, route.id).toBeDefined();
      }
    }
  });

  it("computes router-relative paths", () => {
    expect(relativePath(ROUTES.getProgram)).toBe("/programs/:slug");
    expect(relativePath(ROUTES.leaseJobs)).toBe("/jobs/lease");
    expect(relativePath(ROUTES.home)).toBe("/");
    expect(relativePath(ROUTES.mcp)).toBe("/");
    expect(routesForMount("student").every((r) => r.path.startsWith("/api/v1/me"))).toBe(true);
  });

  it("builds paths with params and queries", () => {
    expect(buildPath(ROUTES.getProgram, { slug: "sample-program" })).toBe("/api/v1/programs/sample-program");
    expect(buildPath(ROUTES.listPrograms, {}, { type: ["research_program", "grant"], limit: 10, q: undefined })).toBe(
      "/api/v1/programs?type=research_program&type=grant&limit=10",
    );
    expect(buildPath(ROUTES.clientCore, { file: "42.json" })).toBe("/data/client-core/42.json");
    expect(pathParams(ROUTES.programCalendar.path)).toEqual(["file"]);
    expect(() => buildPath(ROUTES.getProgram)).toThrow(/slug/);
  });
});
