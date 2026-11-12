import { describe, expect, it } from "vitest";
import { ROUTE_LIST } from "@shared/contracts/routes";
import { createApp } from "./app";

/**
 * Drift guard between shared/contracts/routes.ts (the route map that CORS, the internal key
 * scopes and the typed client read) and the routes the Worker actually registers.
 *
 * The two lists below freeze today's known gaps so that no NEW drift can land: a route added to
 * the map without a handler, or a handler added without a map entry, fails this test. Each list
 * must also only shrink: when a gap is closed, the test fails until its line is deleted here.
 * Closing the gaps needs shared/contracts/routes.ts changes (mapping the extra routes, marking
 * unbuilt ones), which belong to the shared contracts owner.
 */

/** Route-map ids with no registered handler yet (unbuilt features). */
const KNOWN_UNBUILT: readonly string[] = [
  // Public pages and links.
  "card",
  "shortLink",
  "referral",
  "emailClick",
  "emailActionView",
  "emailActionConfirm",
  // API.
  "reportError",
];

/** Registered API, calendar, internal and MCP routes the map does not list yet. */
const KNOWN_UNMAPPED: readonly string[] = [
  "GET /api/auth/novus/second-factor",
  "POST /api/auth/novus/second-factor/enroll",
  "POST /api/auth/novus/second-factor/enroll/confirm",
  "POST /api/auth/novus/second-factor/verify",
  "POST /api/auth/novus/second-factor/recovery",
  "GET /api/v1/opportunity-types/:type",
  "GET /api/v1/organizations/:slug",
  "GET /api/v1/onboarding/state",
  "POST /api/v1/onboarding/quiz",
  "POST /api/v1/onboarding/resume/extract",
  "POST /api/v1/onboarding/matches",
  "POST /api/v1/onboarding/first-door",
  "GET /api/v1/workspaces/:workspaceId/lists/:listId",
  "DELETE /api/v1/workspaces/:workspaceId/lists/:listId",
  "GET /api/v1/workspaces/:workspaceId/lists/:listId/export.csv",
  "GET /api/v1/workspaces/:workspaceId/campus-deadlines",
  "GET /api/v1/workspaces/:workspaceId/progress",
  "GET /api/v1/workspaces/:workspaceId/reports/:period/export.csv",
  "GET /api/v1/lists/by-slug/:slug",
  "GET /api/v1/lists/u/:token",
  "PUT /internal/v1/snapshots/raw/:sha256",
  "GET /internal/v1/snapshots/raw/:sha256",
  "GET /internal/v1/snapshots/:id",
  "POST /internal/v1/sources/upsert",
];

function registered() {
  const app = createApp();
  const handlers = app.routes.filter((r) => !(r.method === "ALL" && r.path.endsWith("*")));
  const has = (method: string, path: string) => app.routes.some((r) => (r.method === method || r.method === "ALL") && r.path === path);
  const unbuilt = ROUTE_LIST.filter((r) => !has(r.method, r.path)).map((r) => r.id);
  const unmapped = [
    ...new Set(handlers.filter((r) => /^\/(api|cal|internal|mcp)(\/|$)/.test(r.path)).map((r) => `${r.method} ${r.path}`)),
  ].filter((key) => !ROUTE_LIST.some((r) => `${r.method} ${r.path}` === key));
  return { unbuilt, unmapped };
}

describe("route map and registered routes", () => {
  const { unbuilt, unmapped } = registered();

  it("registers every mapped route except the frozen list of unbuilt ones", () => {
    expect(unbuilt.filter((id) => !KNOWN_UNBUILT.includes(id))).toEqual([]);
  });

  it("maps every registered API route except the frozen list", () => {
    expect(unmapped.filter((key) => !KNOWN_UNMAPPED.includes(key))).toEqual([]);
  });

  it("keeps the frozen lists current: a closed gap must be removed from them", () => {
    expect(KNOWN_UNBUILT.filter((id) => !unbuilt.includes(id))).toEqual([]);
    expect(KNOWN_UNMAPPED.filter((key) => !unmapped.includes(key))).toEqual([]);
  });

  it("serves the Phase 1 privacy routes the Settings page calls", () => {
    for (const id of ["deleteAccount", "exportData"]) expect(unbuilt).not.toContain(id);
  });
});
