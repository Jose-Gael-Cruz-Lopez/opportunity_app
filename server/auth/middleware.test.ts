/**
 * Guard middleware with a stubbed user (no database): status codes, problem+json bodies, the
 * second-factor problem type and private caching.
 */
import { describe, expect, it } from "vitest";
import { Hono } from "hono";
import { createMiddleware } from "hono/factory";
import { requirePermission, requireRole, requireUser, toPublicSessionUser, SECOND_FACTOR_PROBLEM_TYPE } from "./session";
import { SessionUserSchema } from "@shared/contracts/student";
import type { AuthEnv, RoleGrant, SessionUser } from "./types";

function makeUser(grants: RoleGrant[], verified: boolean): SessionUser {
  const all: RoleGrant[] = [{ role: "student", scope: { kind: "global" } }, ...grants];
  return {
    id: "u1",
    publicId: "PubSample0000001A",
    email: "sample@example.org",
    displayName: "Sample Student",
    roles: [...new Set(all.map((g) => g.role))],
    onboarded: false,
    grants: all,
    sessionId: "s1",
    sessionExpiresAt: Date.now() + 60_000,
    surface: "app",
    secondFactor: { enrolled: verified, verified },
  };
}

function appWith(user: SessionUser | null) {
  const app = new Hono<AuthEnv>();
  app.use(
    "*",
    createMiddleware<AuthEnv>(async (c, next) => {
      if (user) c.set("user", user);
      await next();
    }),
  );
  app.get("/me", requireUser, (c) => c.json({ ok: true }));
  app.get("/curate", requireRole("curator", "admin"), (c) => c.json({ ok: true }));
  app.get("/student", requireRole("student"), (c) => c.json({ ok: true }));
  app.get("/ws/:workspaceId/lists", requirePermission("workspace.lists.manage", (c) => ({ workspaceId: c.req.param("workspaceId") })), (c) =>
    c.json({ ok: true }),
  );
  return app;
}

const curator = (verified: boolean) => makeUser([{ role: "curator", scope: { kind: "global" } }], verified);

describe("requireUser", () => {
  it("answers 401 problem+json when signed out", async () => {
    const res = await appWith(null).request("/me");
    expect(res.status).toBe(401);
    expect(res.headers.get("content-type")).toBe("application/problem+json");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(await res.json()).toMatchObject({ code: "unauthenticated", status: 401 });
  });

  it("passes a signed-in user and marks the response private", async () => {
    const res = await appWith(makeUser([], false)).request("/me");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("private, no-store");
  });
});

describe("requireRole", () => {
  it("401 signed out, 403 for a student", async () => {
    expect((await appWith(null).request("/curate")).status).toBe(401);
    const res = await appWith(makeUser([], false)).request("/curate");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden", type: "/problems/forbidden" });
  });

  it("asks a curator without TOTP to step up", async () => {
    const res = await appWith(curator(false)).request("/curate");
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ code: "forbidden", type: SECOND_FACTOR_PROBLEM_TYPE });
  });

  it("lets a verified curator through", async () => {
    expect((await appWith(curator(true)).request("/curate")).status).toBe(200);
  });

  it("needs no second factor for the student role", async () => {
    expect((await appWith(curator(false)).request("/student")).status).toBe(200);
  });

  it("does not count a workspace-scoped advisor grant as a global curator", async () => {
    const advisor = makeUser([{ role: "advisor", scope: { kind: "workspace", workspaceId: "w1", level: "advisor" } }], true);
    expect((await appWith(advisor).request("/curate")).status).toBe(403);
  });
});

describe("requirePermission", () => {
  const advisor = (verified: boolean) =>
    makeUser([{ role: "advisor", scope: { kind: "workspace", workspaceId: "w1", level: "advisor" } }], verified);

  it("checks the scope from the path", async () => {
    expect((await appWith(advisor(true)).request("/ws/w1/lists")).status).toBe(200);
    expect((await appWith(advisor(true)).request("/ws/w2/lists")).status).toBe(403);
  });

  it("maps denials to 401, step-up and 403", async () => {
    expect((await appWith(null).request("/ws/w1/lists")).status).toBe(401);
    const step = await appWith(advisor(false)).request("/ws/w1/lists");
    expect(step.status).toBe(403);
    expect(await step.json()).toMatchObject({ type: SECOND_FACTOR_PROBLEM_TYPE });
  });
});

describe("toPublicSessionUser", () => {
  it("matches the strict wire contract and drops internal fields", () => {
    const wire = toPublicSessionUser(curator(true));
    expect(SessionUserSchema.parse(wire)).toEqual(wire);
    expect(JSON.stringify(wire)).not.toContain('"u1"');
    expect(JSON.stringify(wire)).not.toContain("s1");
  });
});
