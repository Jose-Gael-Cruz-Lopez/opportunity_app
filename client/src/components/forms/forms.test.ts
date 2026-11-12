import { describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS, parsePrefs, readPrefs, rootAttributes, serializePrefs, writePrefs, type KeyValueStore } from "./prefs";
import { daysLeftLabel, rulerPosition, rulerTicks } from "./ruler";
import { appHref, programHref, roadmapItemAnchor, roadmapItemHref } from "./links";
import { humanizeSlug, todayIso } from "./dates";
import { ApiError, callRoute, isApiUnreachable, isUnauthenticated } from "./request";

function memoryStore(initial: Record<string, string> = {}): KeyValueStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    getItem: (k) => (k in data ? (data[k] as string) : null),
    setItem: (k, v) => {
      data[k] = v;
    },
  };
}

describe("prefs", () => {
  it("defaults to motion and the assistant on", () => {
    expect(parsePrefs(null)).toEqual(DEFAULT_PREFS);
    expect(DEFAULT_PREFS).toEqual({ reduceMotion: false, aiAssistant: true });
  });

  it("ignores junk, wrong types and unknown keys", () => {
    expect(parsePrefs("not json")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs("[1,2]")).toEqual(DEFAULT_PREFS);
    expect(parsePrefs(JSON.stringify({ reduceMotion: "yes", aiAssistant: false, look: "meadow" }))).toEqual({ reduceMotion: false, aiAssistant: false });
  });

  it("round-trips through storage and survives storage that throws", () => {
    const store = memoryStore();
    const prefs = { reduceMotion: true, aiAssistant: false };
    expect(writePrefs(store, prefs)).toBe(true);
    expect(readPrefs(store)).toEqual(prefs);
    expect(parsePrefs(serializePrefs(prefs))).toEqual(prefs);
    const broken: KeyValueStore = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("blocked");
      },
    };
    expect(readPrefs(broken)).toEqual(DEFAULT_PREFS);
    expect(writePrefs(broken, prefs)).toBe(false);
    expect(readPrefs(null)).toEqual(DEFAULT_PREFS);
  });

  it("maps prefs to root attributes", () => {
    expect(rootAttributes(DEFAULT_PREFS)).toEqual({ "data-reduce-motion": null });
    expect(rootAttributes({ ...DEFAULT_PREFS, reduceMotion: true })).toEqual({ "data-reduce-motion": "" });
  });
});

describe("ruler", () => {
  it("places today inside a known window", () => {
    const p = rulerPosition({ opensOn: "2026-09-01", dueOn: "2026-12-04", today: "2026-11-10" });
    expect(p.windowDays).toBe(94);
    expect(p.daysLeft).toBe(24);
    expect(p.dayOfWindow).toBe(70);
    expect(p.fraction).toBeCloseTo(70 / 94, 5);
    expect(p.openedKnown).toBe(true);
  });

  it("uses a fallback window when the opening is unknown and clamps past and future", () => {
    const unknown = rulerPosition({ opensOn: null, dueOn: "2026-12-11", today: "2026-11-11", fallbackWindowDays: 60 });
    expect(unknown).toMatchObject({ windowDays: 60, daysLeft: 30, openedKnown: false });
    expect(unknown.fraction).toBeCloseTo(0.5, 5);
    expect(rulerPosition({ opensOn: null, dueOn: "2026-11-01", today: "2026-11-11" }).fraction).toBe(1);
    expect(rulerPosition({ opensOn: "2026-12-01", dueOn: "2027-01-01", today: "2026-11-11" }).fraction).toBe(0);
    // An opening date on or after the due date is treated as unknown.
    expect(rulerPosition({ opensOn: "2027-01-01", dueOn: "2027-01-01", today: "2026-11-11" }).openedKnown).toBe(false);
  });

  it("draws ticks with majors and words for screen readers", () => {
    const ticks = rulerTicks(9, 4);
    expect(ticks).toEqual([true, false, false, false, true, false, false, false, true]);
    expect(rulerTicks(0).length).toBe(2);
    expect(daysLeftLabel(24)).toBe("24 days left");
    expect(daysLeftLabel(1)).toBe("1 day left");
    expect(daysLeftLabel(0)).toBe("Due today");
    expect(daysLeftLabel(-1)).toBe("Closed yesterday");
    expect(daysLeftLabel(-5)).toBe("Closed 5 days ago");
  });
});

describe("links and dates", () => {
  it("builds base-independent app links and item anchors", () => {
    expect(appHref("/roadmap")).toBe("~/app/roadmap");
    expect(appHref("settings")).toBe("~/app/settings");
    expect(appHref("/")).toBe("~/app");
    expect(roadmapItemAnchor("apply:abc:summer-2027")).toBe("item-apply-abc-summer-2027");
    expect(roadmapItemHref("prep:x")).toBe("~/app/roadmap#item-prep-x");
    expect(programHref("noaa hollings")).toBe("~/app/programs/noaa%20hollings");
  });

  it("formats today in local time and humanizes slugs", () => {
    expect(todayIso(new Date(2026, 10, 11, 23, 59))).toBe("2026-11-11");
    expect(todayIso(new Date(2027, 0, 2))).toBe("2027-01-02");
    expect(humanizeSlug("sample-coastal-science")).toBe("Sample coastal science");
  });
});

describe("callRoute", () => {
  const json = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("builds the path, sends JSON and validates the response", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "queued" }));
    await expect(callRoute("exportData", { body: {}, fetchImpl })).resolves.toEqual({ status: "queued" });
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/v1/me/export");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
  });

  it("rejects a response that breaks the contract", async () => {
    const fetchImpl = vi.fn(async () => json({ status: "done" }));
    await expect(callRoute("exportData", { body: {}, fetchImpl })).rejects.toThrow();
  });

  it("tells a signed-out answer apart from a missing API", async () => {
    const problem = { type: "about:blank", title: "Sign in required", status: 401, code: "unauthenticated" };
    const err = await callRoute("getRoadmap", { fetchImpl: async () => json(problem, 401) }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).code).toBe("unauthenticated");
    expect(isUnauthenticated(err)).toBe(true);
    expect(isApiUnreachable(err)).toBe(false);

    const offline = await callRoute("getRoadmap", {
      fetchImpl: async () => {
        throw new TypeError("Failed to fetch");
      },
    }).catch((e: unknown) => e);
    expect(offline).toBeInstanceOf(ApiError);
    expect(isApiUnreachable(offline)).toBe(true);
    expect(isUnauthenticated(offline)).toBe(false);
  });

  it("treats an HTML page or a bare 404 for an API path as no API", async () => {
    const html = await callRoute("getRoadmap", {
      fetchImpl: async () => new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } }),
    }).catch((e: unknown) => e);
    expect(isApiUnreachable(html)).toBe(true);
    const bare404 = await callRoute("getRoadmap", { fetchImpl: async () => new Response("Not found", { status: 404 }) }).catch((e: unknown) => e);
    expect(isApiUnreachable(bare404)).toBe(true);
  });
});
