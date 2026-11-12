import { GEMINI_API_REVISION, GEMINI_BASE_URL, thinkingFor, type ThinkingLevel } from "./config";
import type { AiErrorKind, GenerateRequest, TokenUsage } from "./types";

/**
 * Gemini REST transport over plain fetch (no SDK: it has no Workers support statement and adds
 * bundle weight). Two surfaces sit behind `buildRequest` / `parseResponse`:
 *
 * - "interactions" (default): POST /v1beta/interactions, GA and recommended for new projects. It
 *   STORES interactions unless told not to (55 days on paid, 1 day on free), so every body we
 *   build sets `store: false`, and a test asserts it.
 * - "generate_content": POST /v1beta/models/{model}:generateContent, documented as legacy but
 *   fully supported and stateless by default. Kept so a founder decision can swap surfaces here.
 *
 * Docs: https://aistudio.google.com/docs/interactions-overview and /api-reference/generate-content
 */

export type GeminiTransport = "interactions" | "generate_content";

/** Explicit thresholds: Gemini's default for 2.5+ models is OFF, which is wrong for students. */
export const SAFETY_CATEGORIES = ["harassment", "hate_speech", "sexually_explicit", "dangerous_content"] as const;
const SAFETY_THRESHOLD = "block_medium_and_above";

const GENERATE_CONTENT_CATEGORY: Record<(typeof SAFETY_CATEGORIES)[number], string> = {
  harassment: "HARM_CATEGORY_HARASSMENT",
  hate_speech: "HARM_CATEGORY_HATE_SPEECH",
  sexually_explicit: "HARM_CATEGORY_SEXUALLY_EXPLICIT",
  dangerous_content: "HARM_CATEGORY_DANGEROUS_CONTENT",
};

export interface HttpRequestSpec {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Record<string, unknown>;
}

/** Builds the HTTP request for one attempt on one model. Pure; the API key goes in a header. */
export function buildRequest(
  transport: GeminiTransport,
  apiKey: string,
  model: string,
  req: Pick<GenerateRequest, "systemInstruction" | "input" | "responseSchema" | "thinking" | "maxOutputTokens">,
): HttpRequestSpec {
  const headers = {
    "x-goog-api-key": apiKey,
    "content-type": "application/json",
    "api-revision": GEMINI_API_REVISION,
  };
  const thinking = thinkingFor(model, req.thinking);
  if (transport === "interactions") {
    return { url: `${GEMINI_BASE_URL}/interactions`, headers, body: interactionsBody(model, req, thinking) };
  }
  return {
    url: `${GEMINI_BASE_URL}/models/${encodeURIComponent(model)}:generateContent`,
    headers,
    body: generateContentBody(req, thinking),
  };
}

function interactionsBody(
  model: string,
  req: Pick<GenerateRequest, "systemInstruction" | "input" | "responseSchema" | "maxOutputTokens">,
  thinking: ThinkingLevel | null,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = { max_output_tokens: req.maxOutputTokens };
  if (thinking) generationConfig.thinking_level = thinking;
  return {
    model,
    // Never let Google keep student context: store defaults to true on this surface.
    store: false,
    system_instruction: req.systemInstruction,
    input: req.input,
    response_format: { type: "text", mime_type: "application/json", schema: req.responseSchema },
    generation_config: generationConfig,
    safety_settings: SAFETY_CATEGORIES.map((type) => ({ type, threshold: SAFETY_THRESHOLD })),
  };
}

function generateContentBody(
  req: Pick<GenerateRequest, "systemInstruction" | "input" | "responseSchema" | "maxOutputTokens">,
  thinking: ThinkingLevel | null,
): Record<string, unknown> {
  const generationConfig: Record<string, unknown> = {
    responseMimeType: "application/json",
    responseJsonSchema: req.responseSchema,
    maxOutputTokens: req.maxOutputTokens,
  };
  if (thinking) generationConfig.thinkingConfig = { thinkingLevel: thinking.toUpperCase() };
  return {
    systemInstruction: { parts: [{ text: req.systemInstruction }] },
    contents: [{ role: "user", parts: [{ text: req.input }] }],
    generationConfig,
    safetySettings: SAFETY_CATEGORIES.map((c) => ({
      category: GENERATE_CONTENT_CATEGORY[c],
      threshold: SAFETY_THRESHOLD.toUpperCase(),
    })),
  };
}

// ---------------------------------------------------------------------------------------------
// Responses
// ---------------------------------------------------------------------------------------------

export type ParsedResponse =
  | { readonly ok: true; readonly text: string; readonly usage: TokenUsage; readonly responseId: string | null }
  | {
      readonly ok: false;
      readonly kind: AiErrorKind;
      readonly code: string | null;
      readonly usage: TokenUsage | null;
    };

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : 0;
}

function asRecord(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function interactionsUsage(body: Record<string, unknown>): TokenUsage {
  const u = asRecord(body.usage);
  return {
    inputTokens: num(u.total_input_tokens),
    outputTokens: num(u.total_output_tokens),
    thoughtTokens: num(u.total_thought_tokens),
    cachedTokens: num(u.total_cached_tokens),
  };
}

function generateContentUsage(body: Record<string, unknown>): TokenUsage {
  const u = asRecord(body.usageMetadata);
  return {
    inputTokens: num(u.promptTokenCount),
    outputTokens: num(u.candidatesTokenCount),
    thoughtTokens: num(u.thoughtsTokenCount),
    cachedTokens: num(u.cachedContentTokenCount),
  };
}

/**
 * Reads a 200 response. On Interactions the text lives in steps[type=model_output].content[
 * type=text]; the SDK's output_text joins only trailing blocks, so we walk every step.
 */
export function parseResponse(transport: GeminiTransport, json: unknown): ParsedResponse {
  const body = asRecord(json);
  if (transport === "interactions") {
    const usage = interactionsUsage(body);
    const status = typeof body.status === "string" ? body.status : null;
    if (status === "incomplete") return { ok: false, kind: "incomplete", code: "incomplete", usage };
    if (status === "failed" || status === "cancelled") return { ok: false, kind: "server_error", code: status, usage };
    let text = "";
    for (const step of asArray(body.steps)) {
      const s = asRecord(step);
      if (s.type !== "model_output") continue;
      for (const part of asArray(s.content)) {
        const p = asRecord(part);
        if (p.type === "text" && typeof p.text === "string") text += p.text;
      }
    }
    if (text.trim() === "") return { ok: false, kind: "empty_output", code: null, usage };
    return { ok: true, text, usage, responseId: typeof body.id === "string" ? body.id : null };
  }
  const usage = generateContentUsage(body);
  const feedback = asRecord(body.promptFeedback);
  if (typeof feedback.blockReason === "string") return { ok: false, kind: "safety_blocked", code: "safety", usage };
  const candidate = asRecord(asArray(body.candidates)[0]);
  const finish = typeof candidate.finishReason === "string" ? candidate.finishReason : null;
  if (finish === "MAX_TOKENS") return { ok: false, kind: "incomplete", code: "max_tokens", usage };
  if (finish && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "RECITATION"].includes(finish)) {
    return { ok: false, kind: "safety_blocked", code: finish.toLowerCase(), usage };
  }
  let text = "";
  for (const part of asArray(asRecord(candidate.content).parts)) {
    const p = asRecord(part);
    if (p.thought === true) continue;
    if (typeof p.text === "string") text += p.text;
  }
  if (text.trim() === "") return { ok: false, kind: "empty_output", code: null, usage };
  return { ok: true, text, usage, responseId: typeof body.responseId === "string" ? body.responseId : null };
}

const SAFETY_CODES = new Set(["safety", "jailbreak", "prohibited_content", "blocklist"]);

/**
 * Maps an HTTP error to a kind. Body is {error:{code,message}}: on Interactions `code` is a
 * string ("rate_limit_exceeded", "safety"), on generateContent a number with a `status` string.
 * The message is inspected only for two well-known phrases and is never logged.
 */
export function classifyHttpError(httpStatus: number, json: unknown): { kind: AiErrorKind; code: string | null } {
  const err = asRecord(asRecord(json).error);
  const rawCode = typeof err.code === "string" ? err.code : typeof err.status === "string" ? err.status : null;
  const code = rawCode ? rawCode.toLowerCase() : null;
  const message = typeof err.message === "string" ? err.message.toLowerCase() : "";
  if (httpStatus === 408) return { kind: "timeout", code };
  if (httpStatus === 429) {
    // Daily quota resets at midnight Pacific: retrying now only burns the budget.
    const daily = code === "quota_exceeded" || /per day|daily|requests per day|rpd/.test(message);
    return { kind: daily ? "quota_exceeded" : "rate_limited", code };
  }
  if (httpStatus >= 500) return { kind: "server_error", code };
  if (httpStatus === 404) return { kind: "model_not_found", code };
  if (httpStatus === 401 || httpStatus === 403) return { kind: "auth", code };
  if (httpStatus === 400) {
    if (code && SAFETY_CODES.has(code)) return { kind: "safety_blocked", code };
    if (message.includes("location is not supported")) return { kind: "location_unsupported", code };
    return { kind: "invalid_request", code };
  }
  return { kind: "invalid_request", code };
}

/** Kinds worth another attempt on the same model. */
export function isRetryable(kind: AiErrorKind): boolean {
  return kind === "timeout" || kind === "rate_limited" || kind === "server_error" || kind === "network";
}

/** Kinds after which the fallback model gets one try. */
export function warrantsFallback(kind: AiErrorKind): boolean {
  return isRetryable(kind) || kind === "quota_exceeded" || kind === "model_not_found" || kind === "circuit_open";
}

export type FetchLike = (input: string, init: { method: string; headers: Record<string, string>; body: string; signal: AbortSignal }) => Promise<Response>;

export interface AttemptOutcome {
  readonly parsed: ParsedResponse;
  readonly httpStatus: number | null;
}

/** One HTTP attempt with a hard timeout. Never throws. */
export async function sendOnce(fetchFn: FetchLike, spec: HttpRequestSpec, timeoutMs: number): Promise<AttemptOutcome> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const res = await fetchFn(spec.url, {
      method: "POST",
      headers: { ...spec.headers },
      body: JSON.stringify(spec.body),
      signal: controller.signal,
    });
    let json: unknown = null;
    try {
      json = await res.json();
    } catch {
      json = null;
    }
    if (!res.ok) {
      const { kind, code } = classifyHttpError(res.status, json);
      return { parsed: { ok: false, kind, code, usage: null }, httpStatus: res.status };
    }
    const transport: GeminiTransport = spec.url.endsWith("/interactions") ? "interactions" : "generate_content";
    return { parsed: parseResponse(transport, json), httpStatus: res.status };
  } catch (err) {
    const aborted = controller.signal.aborted || (err instanceof Error && err.name === "AbortError");
    return { parsed: { ok: false, kind: aborted ? "timeout" : "network", code: null, usage: null }, httpStatus: null };
  } finally {
    clearTimeout(timer);
  }
}
