import { describe, expect, it } from "vitest";
import { DEFAULT_MODEL, FALLBACK_MODEL } from "./config";
import type { FetchLike } from "./gemini";
import { backoffDelay, CircuitBreaker, createGeminiProvider } from "./provider";
import errors from "./fixtures/recorded/errors.json";
import readinessOk from "./fixtures/recorded/interactions-readiness-ok.json";
import type { AiLogFields, GenerateRequest } from "./types";

/** A fake clock that sleep() advances, so retries run instantly and deterministically. */
function fakeTime(start = 1_000_000) {
  let t = start;
  const slept: number[] = [];
  return {
    clock: { now: () => t },
    sleep: async (ms: number) => {
      slept.push(ms);
      t += ms;
    },
    slept,
  };
}

type Scripted = { status: number; body: unknown };

function scriptedFetch(script: Scripted[]) {
  const calls: { model: string; body: Record<string, unknown> }[] = [];
  const fetchFn: FetchLike = async (_url, init) => {
    const body = JSON.parse(init.body) as Record<string, unknown>;
    calls.push({ model: String(body.model), body });
    const next = script.shift();
    if (!next) throw new Error("no scripted response left");
    return new Response(JSON.stringify(next.body), { status: next.status });
  };
  return { fetchFn, calls };
}

const req: GenerateRequest = {
  route: "readiness.explain",
  systemInstruction: "sys",
  input: "in",
  responseSchema: { type: "object" },
  thinking: "minimal",
  maxOutputTokens: 800,
  budgetMs: 9_000,
};

const OK: Scripted = { status: 200, body: readinessOk };
const e = (name: keyof typeof errors): Scripted => errors[name] as Scripted;

function provider(script: Scripted[], random = () => 0.5) {
  const time = fakeTime();
  const { fetchFn, calls } = scriptedFetch(script);
  const logs: { event: string; fields: AiLogFields }[] = [];
  const p = createGeminiProvider({
    apiKey: "K",
    model: DEFAULT_MODEL,
    fallbackModel: FALLBACK_MODEL,
    transport: "interactions",
    fetch: fetchFn,
    clock: time.clock,
    sleep: time.sleep,
    random,
    breaker: new CircuitBreaker(time.clock),
    log: (event, fields) => logs.push({ event, fields }),
  });
  return { p, calls, time, logs };
}

describe("retry and fallback policy", () => {
  it("retries 503 with backoff and succeeds on the primary model", async () => {
    const { p, calls, time } = provider([e("unavailable"), e("unavailable"), OK]);
    const r = await p.generate(req);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual([DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL]);
    expect(time.slept).toEqual([1000, 2000]); // base 1s, then 2s, jitter factor 1.0 at random=0.5
    expect(r.attempts).toHaveLength(3);
  });

  it("moves to the fallback model after retries run out", async () => {
    const { p, calls } = provider([e("unavailable"), e("unavailable"), e("unavailable"), OK]);
    const r = await p.generate(req);
    expect(r.ok && r.model).toBe(FALLBACK_MODEL);
    expect(calls.map((c) => c.model)).toEqual([DEFAULT_MODEL, DEFAULT_MODEL, DEFAULT_MODEL, FALLBACK_MODEL]);
    // No thinking config is sent to the fallback model.
    expect(calls[3]?.body.generation_config).toEqual({ max_output_tokens: 800 });
  });

  it("does not retry a daily quota error; goes straight to the fallback", async () => {
    const { p, calls, time } = provider([e("quota_exceeded"), OK]);
    const r = await p.generate(req);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual([DEFAULT_MODEL, FALLBACK_MODEL]);
    expect(time.slept).toEqual([]);
  });

  it("switches to the fallback on 404 and logs an alert", async () => {
    const { p, calls, logs } = provider([e("model_not_found"), OK]);
    const r = await p.generate(req);
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(logs.some((l) => l.event === "ai.alert_model_not_found")).toBe(true);
  });

  for (const name of ["safety", "invalid_schema", "unauthenticated", "location"] as const) {
    it(`never retries or falls back on ${name}`, async () => {
      const { p, calls } = provider([e(name)]);
      const r = await p.generate(req);
      expect(r.ok).toBe(false);
      expect(calls).toHaveLength(1);
    });
  }

  it("stops when the time budget cannot fit another attempt", async () => {
    const { p, calls } = provider([e("unavailable"), e("unavailable"), e("unavailable"), e("unavailable")]);
    const r = await p.generate({ ...req, budgetMs: 2_000 });
    expect(r.ok).toBe(false);
    expect(calls.length).toBeLessThanOrEqual(2);
  });

  it("logs codes and statuses only, never prompt text", async () => {
    const { p, logs } = provider([e("safety")]);
    await p.generate({ ...req, input: "UNIQUE-PROMPT-TEXT-123" });
    expect(JSON.stringify(logs)).not.toContain("UNIQUE-PROMPT-TEXT-123");
  });
});

describe("backoffDelay", () => {
  it("is capped and jittered within [0.5, 1.5)", () => {
    expect(backoffDelay(0, () => 0)).toBe(500);
    expect(backoffDelay(0, () => 0.999)).toBeLessThan(1500);
    expect(backoffDelay(5, () => 0.5)).toBe(4000);
  });
});

describe("CircuitBreaker", () => {
  it("opens after 5 consecutive failures and closes after 60s", () => {
    let t = 0;
    const b = new CircuitBreaker({ now: () => t });
    for (let i = 0; i < 4; i++) b.failure("m");
    expect(b.isOpen("m")).toBe(false);
    b.failure("m");
    expect(b.isOpen("m")).toBe(true);
    t += 60_000;
    expect(b.isOpen("m")).toBe(false);
  });

  it("skips an open model and uses the fallback", async () => {
    const time = fakeTime();
    const breaker = new CircuitBreaker(time.clock);
    for (let i = 0; i < 5; i++) breaker.failure(DEFAULT_MODEL);
    const { fetchFn, calls } = scriptedFetch([OK]);
    const p = createGeminiProvider({
      apiKey: "K",
      model: DEFAULT_MODEL,
      fallbackModel: FALLBACK_MODEL,
      transport: "interactions",
      fetch: fetchFn,
      clock: time.clock,
      sleep: time.sleep,
      random: () => 0.5,
      breaker,
      log: () => {},
    });
    const r = await p.generate(req);
    expect(r.ok).toBe(true);
    expect(calls.map((c) => c.model)).toEqual([FALLBACK_MODEL]);
  });
});
