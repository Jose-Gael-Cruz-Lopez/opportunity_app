import { describe, expect, it } from "vitest";
import { AI_ROUTE_IDS, DEFAULT_MODEL, FALLBACK_MODEL, MODELS, ROUTES } from "./config";
import { buildRequest, classifyHttpError, parseResponse, sendOnce, type FetchLike } from "./gemini";
import errors from "./fixtures/recorded/errors.json";
import gcOk from "./fixtures/recorded/generate-content-ok.json";
import incomplete from "./fixtures/recorded/interactions-incomplete.json";
import readinessOk from "./fixtures/recorded/interactions-readiness-ok.json";

const baseReq = {
  systemInstruction: "sys",
  input: "in",
  responseSchema: { type: "object", properties: {}, required: [] },
  thinking: "minimal" as const,
  maxOutputTokens: 800,
};

describe("buildRequest (Interactions)", () => {
  it("sets store:false on every route and every allowlisted model", () => {
    for (const model of Object.keys(MODELS)) {
      for (const route of AI_ROUTE_IDS) {
        const spec = buildRequest("interactions", "KEY", model, { ...baseReq, thinking: ROUTES[route].thinking });
        expect(spec.body.store).toBe(false);
      }
    }
  });

  it("sends the key in the x-goog-api-key header, never in the URL", () => {
    const spec = buildRequest("interactions", "PLACEHOLDER_KEY", DEFAULT_MODEL, baseReq);
    expect(spec.url).toBe("https://generativelanguage.googleapis.com/v1beta/interactions");
    expect(spec.url).not.toContain("PLACEHOLDER_KEY");
    expect(spec.headers["x-goog-api-key"]).toBe("PLACEHOLDER_KEY");
    expect(JSON.stringify(spec.body)).not.toContain("PLACEHOLDER_KEY");
  });

  it("uses structured output, explicit safety thresholds and the per-model thinking map", () => {
    const spec = buildRequest("interactions", "K", DEFAULT_MODEL, baseReq);
    expect(spec.body.response_format).toEqual({ type: "text", mime_type: "application/json", schema: baseReq.responseSchema });
    expect(spec.body.generation_config).toEqual({ max_output_tokens: 800, thinking_level: "minimal" });
    expect(spec.body.safety_settings).toHaveLength(4);
    // The fallback model is not in the thinking table: no thinking config at all.
    const fb = buildRequest("interactions", "K", FALLBACK_MODEL, baseReq);
    expect(fb.body.generation_config).toEqual({ max_output_tokens: 800 });
    // 3.8 Flash rejects "minimal": it is moved up to "low".
    const flash = buildRequest("interactions", "K", "gemini-3.8-flash", baseReq);
    expect((flash.body.generation_config as Record<string, unknown>).thinking_level).toBe("low");
  });
});

describe("buildRequest (generateContent)", () => {
  it("builds the stateless legacy body with responseJsonSchema", () => {
    const spec = buildRequest("generate_content", "K", DEFAULT_MODEL, baseReq);
    expect(spec.url).toBe(`https://generativelanguage.googleapis.com/v1beta/models/${DEFAULT_MODEL}:generateContent`);
    const gc = spec.body.generationConfig as Record<string, unknown>;
    expect(gc.responseMimeType).toBe("application/json");
    expect(gc.responseJsonSchema).toEqual(baseReq.responseSchema);
    expect(gc.thinkingConfig).toEqual({ thinkingLevel: "MINIMAL" });
    expect(spec.body.safetySettings).toHaveLength(4);
  });
});

describe("parseResponse", () => {
  it("joins every model_output text block and skips thought steps", () => {
    const r = parseResponse("interactions", readinessOk);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(JSON.parse(r.text).summary).toContain("class-year");
    expect(r.text).not.toContain("thinking summary");
    expect(r.usage).toEqual({ inputTokens: 1820, outputTokens: 160, thoughtTokens: 40, cachedTokens: 0 });
    expect(r.responseId).toBe("int_sample_0001");
  });

  it("reports incomplete (max tokens) with its billed usage", () => {
    const r = parseResponse("interactions", incomplete);
    expect(r).toMatchObject({ ok: false, kind: "incomplete" });
    if (!r.ok) expect(r.usage?.outputTokens).toBe(1500);
  });

  it("reads generateContent parts and ignores thought parts", () => {
    const r = parseResponse("generate_content", gcOk);
    expect(r).toMatchObject({ ok: true, text: '{"ok":true}' });
  });

  it("treats MAX_TOKENS and SAFETY finish reasons as failures", () => {
    expect(parseResponse("generate_content", { candidates: [{ finishReason: "MAX_TOKENS" }] })).toMatchObject({ kind: "incomplete" });
    expect(parseResponse("generate_content", { candidates: [{ finishReason: "SAFETY" }] })).toMatchObject({ kind: "safety_blocked" });
    expect(parseResponse("generate_content", { promptFeedback: { blockReason: "SAFETY" } })).toMatchObject({ kind: "safety_blocked" });
  });

  it("treats an empty output as a failure", () => {
    expect(parseResponse("interactions", { status: "completed", steps: [] })).toMatchObject({ ok: false, kind: "empty_output" });
  });
});

describe("classifyHttpError", () => {
  const cases: [keyof typeof errors, string][] = [
    ["rate_limited", "rate_limited"],
    ["quota_exceeded", "quota_exceeded"],
    ["safety", "safety_blocked"],
    ["location", "location_unsupported"],
    ["invalid_schema", "invalid_request"],
    ["model_not_found", "model_not_found"],
    ["unauthenticated", "auth"],
    ["unavailable", "server_error"],
  ];
  for (const [name, kind] of cases) {
    it(`${name} -> ${kind}`, () => {
      const e = errors[name] as { status: number; body: unknown };
      expect(classifyHttpError(e.status, e.body).kind).toBe(kind);
    });
  }
  it("408 is a timeout", () => {
    expect(classifyHttpError(408, null).kind).toBe("timeout");
  });
});

describe("sendOnce", () => {
  it("aborts at the timeout and reports a timeout, without throwing", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const spec = buildRequest("interactions", "K", DEFAULT_MODEL, baseReq);
    const out = await sendOnce(hang, spec, 5);
    expect(out.parsed).toMatchObject({ ok: false, kind: "timeout" });
  });

  it("maps a network error to network", async () => {
    const broken: FetchLike = () => Promise.reject(new TypeError("fetch failed"));
    const out = await sendOnce(broken, buildRequest("interactions", "K", DEFAULT_MODEL, baseReq), 1000);
    expect(out.parsed).toMatchObject({ ok: false, kind: "network" });
  });

  it("posts JSON and parses a 200", async () => {
    let seen: { url: string; body: unknown } | null = null;
    const ok: FetchLike = async (url, init) => {
      seen = { url, body: JSON.parse(init.body) };
      return new Response(JSON.stringify(readinessOk), { status: 200 });
    };
    const out = await sendOnce(ok, buildRequest("interactions", "K", DEFAULT_MODEL, baseReq), 1000);
    expect(out.parsed.ok).toBe(true);
    expect(seen).not.toBeNull();
    expect((seen as unknown as { body: { store: boolean } }).body.store).toBe(false);
  });
});
