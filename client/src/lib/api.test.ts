import { describe, expect, it, vi } from "vitest";
import { ApiError, createApiClient, describeApiError } from "./api";
import { sampleProgramCards } from "./fixtures/programs";

const NOW = Date.parse("2026-11-11T15:00:00Z");

function jsonResponse(body: unknown, status = 200, type = "application/json"): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
}

describe("api client", () => {
  it("builds paths from the route map, with params and repeated query values", () => {
    const client = createApiClient({ fetch: vi.fn() });
    expect(client.url("getProgram", { params: { slug: "a-b" } })).toBe("/api/v1/programs/a-b");
    expect(client.url("listPrograms", { query: { type: ["research_program", "grant"], q: "lab" } })).toBe("/api/v1/programs?type=research_program&type=grant&q=lab");
    expect(client.url("updateRoadmapItem", { params: { itemKey: "prep:x" } })).toBe("/api/v1/me/roadmap/items/prep%3Ax");
  });

  it("validates a good response and returns parsed data", async () => {
    const cards = sampleProgramCards(NOW);
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ items: cards.slice(0, 2), page: { nextCursor: null, limit: 25 }, release: 3 }));
    const client = createApiClient({ fetch });
    const res = await client.call("listPrograms");
    expect(res.items).toHaveLength(2);
    expect(res.release).toBe(3);
    const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/v1/programs");
    expect(init.method).toBe("GET");
    expect(init.credentials).toBe("same-origin");
  });

  it("refuses a body with status or identity keys before any request", async () => {
    const fetch = vi.fn();
    const client = createApiClient({ fetch });
    // `as never`: the body is wrong at the type level on purpose; this is the mistake the guard catches.
    const err = await client
      .call("updateProfile", { body: { classYear: "second_year", citizenship: "us_citizen" } as never })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).kind).toBe("sensitive_blocked");
    expect((err as ApiError).paths).toContain("citizenship");
    expect(fetch).not.toHaveBeenCalled();
    expect(describeApiError(err)).toMatch(/stays on this device/);
  });

  it("validates request bodies against the route schema", async () => {
    const fetch = vi.fn();
    const client = createApiClient({ fetch });
    const err = await client.call("updateTracker", { params: { id: "x" }, body: { status: "bogus" } as never }).catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("invalid_request");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a validated JSON body with the route's method", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
    const client = createApiClient({ fetch });
    await client.call("updateRoadmapItem", { params: { itemKey: "prep:a" }, body: { action: "complete" } });
    const [, init] = fetch.mock.calls[0] as [string, RequestInit];
    expect(init.method).toBe("PATCH");
    expect(JSON.parse(String(init.body))).toEqual({ action: "complete" });
    expect((init.headers as Record<string, string>)["content-type"]).toBe("application/json");
  });

  it("turns problem+json into an ApiError with the code", async () => {
    const fetch = vi.fn().mockResolvedValue(
      jsonResponse({ type: "https://example.org/problems/unauthenticated", title: "Sign in required", status: 401, code: "unauthenticated" }, 401, "application/problem+json"),
    );
    const err = await createApiClient({ fetch }).call("listTracker").catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("problem");
    expect((err as ApiError).code).toBe("unauthenticated");
    expect((err as ApiError).status).toBe(401);
  });

  it("flags HTML or plain-text answers as not_api", async () => {
    const fetch = vi.fn().mockResolvedValue(new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }));
    const err = await createApiClient({ fetch }).call("meSession").catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("not_api");
  });

  it("flags network failures", async () => {
    const fetch = vi.fn().mockRejectedValue(new TypeError("Failed to fetch"));
    const err = await createApiClient({ fetch }).call("meSession").catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("network");
  });

  it("rejects responses that break the contract", async () => {
    const fetch = vi.fn().mockResolvedValue(jsonResponse({ user: { publicId: "bad id" }, profile: null }));
    const err = await createApiClient({ fetch }).call("meSession").catch((e: unknown) => e);
    expect((err as ApiError).kind).toBe("invalid_response");
  });

  it("refuses routes that are not JSON APIs", async () => {
    const client = createApiClient({ fetch: vi.fn() });
    await expect(client.call("home" as never)).rejects.toThrow(/not a JSON API route/);
  });
});
