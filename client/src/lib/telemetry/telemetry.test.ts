import { describe, expect, it } from "vitest";
import { AnalyticsBatchSchema } from "@shared/contracts/api";
import { EVENT_NAMES, resultBucket } from "./events";
import { routeTemplate } from "./route";
import { inSample, SAMPLE_RATES, sampleBucket } from "./sampling";
import { SESSION_IDLE_MS, SESSION_KEY, SessionId, randomId } from "./session";
import { AGE_BLOCK_KEY, browserFamily, cleanProps, ERROR_COUNT_KEY, errorClassOf, firstPartyFrame, MAX_BATCH, Telemetry, type TelemetryEnv } from "./telemetry";

const NOW = Date.UTC(2026, 10, 11, 15, 0);
const ORIGIN = "https://novus.example";

class MemoryStore {
  map = new Map<string, string>();
  getItem(k: string) {
    return this.map.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.map.set(k, v);
  }
  removeItem(k: string) {
    this.map.delete(k);
  }
}

let seed = 1;
const random = (bytes: Uint8Array) => {
  // Math.imul keeps the LCG in 32-bit integers (a plain multiply loses the low bits past 2^53
  // and collapses to zeros); the high byte of the state is the better-mixed one.
  for (let i = 0; i < bytes.length; i++) bytes[i] = ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >>> 16) & 255;
  return bytes;
};

interface Sent {
  url: string;
  body: unknown;
  via: "beacon" | "fetch";
  init?: RequestInit;
}

function setup(over: Partial<TelemetryEnv> = {}) {
  const sent: Sent[] = [];
  const timers: (() => void)[] = [];
  let clock = NOW;
  let path = "/app/programs/some-slug";
  let gpc = false;
  const storage = new MemoryStore();
  const env: TelemetryEnv = {
    now: () => clock,
    storage,
    random,
    sendBeacon: (url, data) => {
      // Blob text is async; the test reads it back through a side channel.
      void data.text().then((t) => sent.push({ url, body: JSON.parse(t), via: "beacon" }));
      return true;
    },
    fetch: async (url, init) => {
      sent.push({ url, body: JSON.parse(String(init.body)), via: "fetch", init });
      return {};
    },
    gpc: () => gpc,
    pathname: () => path,
    origin: () => ORIGIN,
    userAgent: () => "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1",
    release: "2026.11.11-abc123",
    setTimer: (fn) => {
      timers.push(fn);
      return timers.length;
    },
    clearTimer: () => undefined,
    ...over,
  };
  const t = new Telemetry(env);
  const settle = () => new Promise((r) => setTimeout(r, 0));
  return {
    t,
    env,
    sent,
    storage,
    timers,
    settle,
    setClock: (ms: number) => (clock = ms),
    setPath: (p: string) => (path = p),
    setGpc: (v: boolean) => (gpc = v),
  };
}

describe("sampling", () => {
  it("matches the server's hash (shared test vector)", () => {
    // Same numbers as server/api/v1/events/events.test.ts.
    expect(sampleBucket("")).toBe(6_261);
    expect(sampleBucket("novus")).toBe(3_040);
    expect(inSample("x", 1)).toBe(true);
    expect(inSample("x", 0)).toBe(false);
    expect(Object.keys(SAMPLE_RATES).sort()).toEqual([...EVENT_NAMES].sort());
  });
});

describe("session id", () => {
  it("is random, url-safe, kept in session storage and rotated after 30 idle minutes", () => {
    const store = new MemoryStore();
    const s = new SessionId(store, random);
    const a = s.current(NOW);
    expect(a).toMatch(/^[0-9A-Za-z_-]{22}$/);
    expect(s.current(NOW + 10 * 60_000)).toBe(a);
    expect(s.current(NOW + 39 * 60_000)).toBe(a);
    expect(JSON.parse(store.getItem(SESSION_KEY)!).id).toBe(a);
    const b = s.current(NOW + 39 * 60_000 + SESSION_IDLE_MS);
    expect(b).not.toBe(a);
    // A clock that went backwards starts a new session rather than trusting it.
    expect(s.current(NOW)).not.toBe(b);
  });

  it("works without storage, and with storage that throws", () => {
    const s = new SessionId(null, random);
    expect(s.current(NOW)).toBe(s.current(NOW + 1000));
    const throwing = { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); } };
    const s2 = new SessionId(throwing, random);
    expect(s2.current(NOW)).toBe(s2.current(NOW + 1000));
    expect(randomId(random)).toHaveLength(22);
  });
});

describe("route templates", () => {
  it("never sends a slug, id or query string", () => {
    expect(routeTemplate("/app/programs/sample-program?x=1")).toBe("/app/programs/:slug");
    expect(routeTemplate("/app/readiness/0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f")).toBe("/app/readiness/:programCycleId");
    expect(routeTemplate("/app")).toBe("/app");
    expect(routeTemplate("/app/")).toBe("/app");
    expect(routeTemplate("/app/settings/privacy")).toBe("/app/settings");
    expect(routeTemplate("/app/start/quiz")).toBe("/app/start");
    expect(routeTemplate("/curate/tasks/abc")).toBe("/curate");
    expect(routeTemplate("/app/unknown-page")).toBe("other");
    expect(routeTemplate("/cal/u/token.ics")).toBe("other");
  });
});

describe("track", () => {
  it("batches events with the session id, the route template and allowlisted props", async () => {
    const h = setup();
    h.t.track("page_view", { surface: "app" });
    h.t.track("tracker_add", { programId: "0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f", source: "self" });
    expect(h.sent).toHaveLength(0);
    expect(h.timers).toHaveLength(1);
    h.timers[0]!();
    await h.settle();
    expect(h.sent).toHaveLength(1);
    const body = h.sent[0]!.body as { events: { deviceId: string; path: string; props: unknown }[] };
    expect(h.sent[0]!.url).toBe("/api/v1/events");
    expect(AnalyticsBatchSchema.safeParse(body).success).toBe(true);
    expect(body.events.map((e) => e.path)).toEqual(["/app/programs/:slug", "/app/programs/:slug"]);
    expect(new Set(body.events.map((e) => e.deviceId)).size).toBe(1);
    expect(JSON.stringify(body)).not.toContain("some-slug");
  });

  it("an under-16 answer turns telemetry off for the tab, drops the queue and forgets the session id", async () => {
    const h = setup();
    h.t.track("page_view", { surface: "app" });
    h.t.reportError(new TypeError("x"), "error");
    await h.settle();
    const before = h.sent.length;
    expect(h.storage.map.has(SESSION_KEY)).toBe(true);
    h.t.blockForUnderAge();
    expect(h.storage.map.has(SESSION_KEY)).toBe(false);
    expect(h.storage.map.has(ERROR_COUNT_KEY)).toBe(false);
    expect(h.storage.map.get(AGE_BLOCK_KEY)).toBe("1");
    // The queued page_view is dropped; consent cannot turn it back on (TelemetryWiring).
    h.t.setConsent(true);
    h.t.track("page_view", { surface: "app" });
    h.t.flush();
    expect(h.t.reportError(new RangeError("y"), "error")).toBeNull();
    await h.settle();
    expect(h.sent).toHaveLength(before);
    expect(h.sent.every((x) => x.url !== "/api/v1/events")).toBe(true);
    // A reload in the same tab reads the flag and stays off.
    const reloaded = new Telemetry(h.env);
    expect(reloaded.enabled()).toBe(false);
    reloaded.setConsent(true);
    expect(reloaded.enabled()).toBe(false);
    // Another tab (fresh sessionStorage) is not blocked.
    expect(setup().t.enabled()).toBe(true);
  });

  it("flushes at 20 events and on demand", async () => {
    const h = setup();
    for (let i = 0; i < MAX_BATCH; i++) h.t.track("page_view", { surface: "app" });
    await h.settle();
    expect(h.sent).toHaveLength(1);
    expect((h.sent[0]!.body as { events: unknown[] }).events).toHaveLength(MAX_BATCH);
    h.t.track("readiness_open", {});
    h.t.flush();
    await h.settle();
    expect(h.sent).toHaveLength(2);
  });

  it("sends nothing under Global Privacy Control or without consent, and drops the queue", async () => {
    const h = setup();
    h.setGpc(true);
    h.t.track("page_view", { surface: "app" });
    h.t.flush();
    h.setGpc(false);
    h.t.track("page_view", { surface: "app" });
    h.t.setConsent(false);
    h.t.flush();
    h.t.track("page_view", { surface: "app" });
    h.t.flush();
    expect(h.t.reportError(new TypeError("x"), "error")).toBeNull();
    await h.settle();
    expect(h.sent).toHaveLength(0);
    h.t.setConsent(true);
    h.t.track("page_view", { surface: "app" });
    h.t.flush();
    await h.settle();
    expect(h.sent).toHaveLength(1);
  });

  it("sends a restricted program's event alone, without cookies, with a one-time id and the day only", async () => {
    const h = setup();
    h.t.track("page_view", { surface: "app" });
    h.t.track("program_view", { programId: "0190f7a2-5c3e-7b4d-8e9f-0a1b2c3d4e5f" }, { restricted: true });
    await h.settle();
    expect(h.sent).toHaveLength(1);
    const alone = h.sent[0]!;
    expect(alone.via).toBe("fetch");
    expect(alone.init?.credentials).toBe("omit");
    const ev = (alone.body as { events: { deviceId: string; at: string }[] }).events;
    expect(ev).toHaveLength(1);
    expect(ev[0]!.at).toBe("2026-11-11T00:00:00.000Z");
    h.t.flush();
    await h.settle();
    const keyed = (h.sent[1]!.body as { events: { deviceId: string }[] }).events[0]!;
    expect(ev[0]!.deviceId).not.toBe(keyed.deviceId);
    // The one-time id is not the session id kept in storage either.
    expect(h.storage.getItem(SESSION_KEY)).not.toContain(ev[0]!.deviceId);
  });

  it("drops events with sensitive keys, long strings or non-scalar values", () => {
    expect(cleanProps({ citizenship: "x" })).toBeNull();
    expect(cleanProps({ step: "x".repeat(65) })).toBeNull();
    expect(cleanProps({ nested: { a: 1 } })).toBeNull();
    expect(cleanProps({ stepIndex: 2, step: "quiz", skip: undefined })).toEqual({ stepIndex: 2, step: "quiz" });
    const h = setup();
    h.t.track("filter_change", { pellStatus: "yes" } as never);
    h.t.flush();
    expect(h.sent).toHaveLength(0);
  });

  it("buckets search results without the query", () => {
    expect([0, 1, 9, 10, 500].map(resultBucket)).toEqual(["0", "1-9", "1-9", "10+", "10+"]);
  });
});

describe("client errors", () => {
  const withStack = (name: string, stack: string) => {
    const e = new Error("message with secret@example.org and /cal/u/token");
    e.name = name;
    e.stack = stack;
    return e;
  };

  it("sends the class, route template, release, browser and first-party frame only", async () => {
    const h = setup();
    const err = withStack(
      "TypeError",
      [
        "TypeError: message with secret@example.org",
        "    at x (chrome-extension://abc/content.js:1:2)",
        `    at render (${ORIGIN}/assets/index-BX12ab.js:120:33)`,
        `    at y (${ORIGIN}/assets/vendor-1.js:5:6)`,
      ].join("\n"),
    );
    const report = h.t.reportError(err, "boundary");
    expect(report).toEqual({
      kind: "boundary",
      surface: "spa",
      errorClass: "TypeError",
      route: "/app/programs/:slug",
      release: "2026.11.11-abc123",
      browser: "safari",
      file: "index-BX12ab.js",
      line: 120,
      column: 33,
    });
    await h.settle();
    expect(h.sent[0]!.url).toBe("/api/v1/error-reports");
    const wire = JSON.stringify(h.sent[0]!.body);
    expect(wire).not.toContain("secret");
    expect(wire).not.toContain("token");
    expect(wire).not.toContain("chrome-extension");
    expect(wire).not.toContain(ORIGIN);
  });

  it("dedupes per page and caps per page and per session", () => {
    const h = setup();
    expect(h.t.reportError(new TypeError("a"), "error")).not.toBeNull();
    expect(h.t.reportError(new TypeError("b"), "error")).toBeNull();
    const classes = ["RangeError", "SyntaxError", "URIError", "EvalError", "AbortError", "NotFoundError"];
    const accepted = classes.map((c) => h.t.reportError(withStack(c, ""), "error")).filter(Boolean);
    expect(accepted).toHaveLength(4);

    // Per session: a fresh page in the same tab shares the session counter.
    const store = new MemoryStore();
    store.setItem("nv.terr", "20");
    const h2 = setup({ storage: store });
    expect(h2.t.reportError(new TypeError("a"), "error")).toBeNull();
  });

  it("names classes without messages and families without versions", () => {
    expect(errorClassOf(new RangeError("x"))).toBe("RangeError");
    expect(errorClassOf("a thrown string with text")).toBe("NonError");
    expect(errorClassOf({ name: "bad name: with text" })).toBe("NonError");
    expect(firstPartyFrame(new Error("x"), ORIGIN)).toBeNull();
    expect(firstPartyFrame(withStack("E", "at a (https://evil.example/assets/x.js:1:1)"), ORIGIN)).toBeNull();
    expect(browserFamily("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 Chrome/131.0 Mobile Safari/537.36 Instagram 350.0")).toBe("in_app");
    expect(browserFamily("Mozilla/5.0 (X11; Linux x86_64; rv:133.0) Gecko/20100101 Firefox/133.0")).toBe("firefox");
    expect(browserFamily("Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 SamsungBrowser/26.0 Chrome/122.0 Mobile Safari/537.36")).toBe("samsung");
  });
});
