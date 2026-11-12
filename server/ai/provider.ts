import { CIRCUIT_POLICY, RETRY_POLICY } from "./config";
import { buildRequest, isRetryable, sendOnce, warrantsFallback, type FetchLike, type GeminiTransport } from "./gemini";
import type { AiErrorKind, AiLog, AiProvider, AttemptRecord, Clock, GenerateRequest, GenerateResult } from "./types";

/**
 * Availability policy around the transport:
 *   try(primary) with capped exponential backoff and jitter on 408/429/5xx/network,
 *   -> on 404, daily quota, exhausted retries or an open circuit: try(fallback) once,
 *   -> else fail, and the runner returns deterministic text with meta.status "degraded".
 * Never retried: 400 (schema, safety, location), 401, 403. Delays: min(cap, base*2^n)*U(0.5,1.5).
 */

/** Per-isolate breaker: after N consecutive availability failures a model is skipped for a while. */
export class CircuitBreaker {
  private readonly failures = new Map<string, number>();
  private readonly openUntil = new Map<string, number>();

  constructor(
    private readonly clock: Clock,
    private readonly threshold: number = CIRCUIT_POLICY.failureThreshold,
    private readonly openMs: number = CIRCUIT_POLICY.openMs,
  ) {}

  isOpen(model: string): boolean {
    const until = this.openUntil.get(model);
    if (until === undefined) return false;
    if (this.clock.now() >= until) {
      this.openUntil.delete(model);
      this.failures.set(model, 0);
      return false;
    }
    return true;
  }

  success(model: string): void {
    this.failures.set(model, 0);
  }

  failure(model: string): void {
    const n = (this.failures.get(model) ?? 0) + 1;
    this.failures.set(model, n);
    if (n >= this.threshold) this.openUntil.set(model, this.clock.now() + this.openMs);
  }
}

/** Only failures that say "this model is unavailable" trip the breaker; a 400 is our bug. */
function countsAgainstAvailability(kind: AiErrorKind): boolean {
  return isRetryable(kind) || kind === "quota_exceeded" || kind === "model_not_found";
}

export function backoffDelay(attempt: number, random: () => number): number {
  const { baseDelayMs, capDelayMs, jitterMin, jitterMax } = RETRY_POLICY;
  const raw = Math.min(capDelayMs, baseDelayMs * 2 ** attempt);
  return Math.round(raw * (jitterMin + (jitterMax - jitterMin) * random()));
}

export interface GeminiProviderOptions {
  readonly apiKey: string;
  readonly model: string;
  readonly fallbackModel: string | null;
  readonly transport: GeminiTransport;
  readonly fetch: FetchLike;
  readonly clock: Clock;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
  readonly breaker: CircuitBreaker;
  readonly log: AiLog;
}

export function createGeminiProvider(opts: GeminiProviderOptions): AiProvider {
  const models = opts.fallbackModel && opts.fallbackModel !== opts.model ? [opts.model, opts.fallbackModel] : [opts.model];

  async function generate(req: GenerateRequest): Promise<GenerateResult> {
    const deadline = opts.clock.now() + req.budgetMs;
    const attempts: AttemptRecord[] = [];
    let lastKind: AiErrorKind = "network";

    for (const [index, model] of models.entries()) {
      const isFallback = index > 0;
      if (opts.breaker.isOpen(model)) {
        lastKind = "circuit_open";
        attempts.push({ model, ok: false, httpStatus: null, errorKind: "circuit_open", errorCode: null, usage: null, latencyMs: 0 });
        continue;
      }
      // The fallback model gets one attempt: it exists for availability, not persistence.
      const maxRetries = isFallback ? 0 : RETRY_POLICY.maxRetries;
      for (let attempt = 0; attempt <= maxRetries; attempt++) {
        const remaining = deadline - opts.clock.now();
        if (remaining < RETRY_POLICY.minAttemptMs) {
          lastKind = "timeout";
          break;
        }
        const spec = buildRequest(opts.transport, opts.apiKey, model, req);
        const started = opts.clock.now();
        const { parsed, httpStatus } = await sendOnce(opts.fetch, spec, Math.min(RETRY_POLICY.attemptTimeoutMs, remaining));
        const latencyMs = opts.clock.now() - started;
        if (parsed.ok) {
          attempts.push({ model, ok: true, httpStatus, errorKind: null, errorCode: null, usage: parsed.usage, latencyMs });
          opts.breaker.success(model);
          return { ok: true, text: parsed.text, model, responseId: parsed.responseId, attempts };
        }
        attempts.push({
          model,
          ok: false,
          httpStatus,
          errorKind: parsed.kind,
          errorCode: parsed.code,
          usage: parsed.usage,
          latencyMs,
        });
        lastKind = parsed.kind;
        opts.log("ai.attempt_failed", { model, httpStatus, kind: parsed.kind, code: parsed.code, attempt, route: req.route });
        if (countsAgainstAvailability(parsed.kind)) opts.breaker.failure(model);
        if (parsed.kind === "model_not_found") opts.log("ai.alert_model_not_found", { model, route: req.route });
        if (parsed.kind === "invalid_request") opts.log("ai.alert_invalid_request", { model, route: req.route, code: parsed.code });
        if (!isRetryable(parsed.kind) || attempt === maxRetries) break;
        const delay = backoffDelay(attempt, opts.random);
        if (opts.clock.now() + delay + RETRY_POLICY.minAttemptMs > deadline) break;
        await opts.sleep(delay);
      }
      if (!warrantsFallback(lastKind)) break;
    }
    return { ok: false, errorKind: lastKind, attempts };
  }

  return { name: "gemini", model: opts.model, generate };
}

/** The no-key (or kill-switch) stub: never calls out, always degrades. */
export function createDisabledProvider(kind: Extract<AiErrorKind, "no_api_key">): AiProvider {
  return {
    name: "none",
    model: null,
    generate: async () => ({ ok: false, errorKind: kind, attempts: [] }),
  };
}

export const systemClock: Clock = { now: () => Date.now() };

export const realSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
