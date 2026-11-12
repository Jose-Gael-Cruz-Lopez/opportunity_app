import { AI_DEGRADED_REASONS, type AiMeta } from "@shared/contracts";
import type { AiAccessDecision } from "./age";
import { RETRY_POLICY, type AiRouteId, type RouteConfig } from "./config";
import { costMicros, estimateMicros, utcDay, utcMonth, type SpendLedger } from "./ledger";
import type { BuiltPrompt, PromptRoute } from "./prompts/common";
import type { AiErrorKind, AiLog, AiProvider, Clock, GenerateRequest, GenerateResult } from "./types";
import { parseModelJson } from "./validate";

/**
 * The one code path every AI feature runs through:
 *   precheck -> access gate -> key/kill switch -> per-user cap -> build prompt -> monthly cap
 *   -> provider (retries, fallback model) -> record spend per attempt -> parse + zod -> route
 *   checks -> one repair with the issues appended -> response, or the deterministic fallback.
 * Every exit returns a valid response; nothing here throws for provider or model problems.
 */

export type DegradedReason = (typeof AI_DEGRADED_REASONS)[number];

export interface RunDeps {
  readonly provider: AiProvider;
  readonly fallbackModel: string | null;
  readonly ledger: SpendLedger;
  readonly clock: Clock;
  readonly log: AiLog;
  readonly nonce: () => string;
  readonly routes: Readonly<Record<AiRouteId, RouteConfig>>;
  /** Set when no call may be made at all (no key, or the kill switch). */
  readonly unavailable: Extract<DegradedReason, "no_api_key" | "disabled"> | null;
}

export interface RunOptions {
  /** Hashed user key for the per-user daily cap; null for staff routes. */
  readonly userKey: string | null;
  /** Result of the minimum-age gate; omitted for routes with no student involvement. */
  readonly access?: AiAccessDecision;
}

const MAX_REPAIRS = 1;

export function degradedReasonFor(kind: AiErrorKind): DegradedReason {
  switch (kind) {
    case "no_api_key":
      return "no_api_key";
    case "timeout":
      return "timeout";
    case "rate_limited":
    case "quota_exceeded":
      return "rate_limited";
    case "safety_blocked":
      return "safety_blocked";
    default:
      return "provider_error";
  }
}

export async function runRoute<I, M, R>(
  route: PromptRoute<I, M, R>,
  input: I,
  deps: RunDeps,
  opts: RunOptions,
): Promise<R> {
  const cfg = deps.routes[route.id];
  const started = deps.clock.now();
  const meta = (fields: Pick<AiMeta, "status" | "degradedReason" | "fallback"> & { model?: string | null }): AiMeta => ({
    provider: fields.fallback ? "none" : "gemini",
    model: fields.model ?? null,
    promptVersion: cfg.version,
    status: fields.status,
    degradedReason: fields.degradedReason,
    generatedAt: new Date(deps.clock.now()).toISOString(),
    fallback: fields.fallback,
  });
  const finish = (status: string, reason: DegradedReason | null, extra: Record<string, number | string | null> = {}): void => {
    deps.log("ai.request", { route: route.id, status, reason, latencyMs: deps.clock.now() - started, ...extra });
  };
  const degrade = (reason: DegradedReason, model: string | null = null): R => {
    const status = reason === "no_api_key" || reason === "disabled" ? "unavailable" : "degraded";
    // The failed model is logged, not put in meta: meta.model names who wrote the text shown.
    finish(status, reason, { model });
    return route.fallback(input, meta({ status, degradedReason: reason, fallback: true }));
  };

  // 1. Deterministic answers that need no model (declined sensitive questions, nothing to cite).
  const pre = route.precheck?.(input);
  if (pre && !pre.proceed) {
    finish("ok", null, { precheck: "answered_without_model" });
    return pre.response(meta({ status: "ok", degradedReason: null, fallback: true }));
  }
  // 2. Age gate (Gemini terms: 18+) and 3. no key or kill switch.
  if (opts.access && !opts.access.allowed) return degrade("disabled");
  if (deps.unavailable) return degrade(deps.unavailable);

  const now = deps.clock.now();
  const day = utcDay(now);
  const month = utcMonth(now);

  // 4. Per-user daily cap.
  if (opts.userKey && cfg.dailyPerUser !== null) {
    const used = await deps.ledger.userRequests(route.id, opts.userKey, day);
    if (used >= cfg.dailyPerUser) return degrade("rate_limited");
  }

  const prompt = route.build(input, deps.nonce());
  const models = [deps.provider.model, deps.fallbackModel].filter((m): m is string => !!m);
  let totalCost = 0;

  /** Monthly cap check + call + per-attempt spend recording. */
  const call = async (inputText: string, budgetMs: number): Promise<GenerateResult | "budget_exceeded"> => {
    const estimate = estimateMicros(models, route.system.length + inputText.length, cfg.maxOutputTokens, day);
    const spent = await deps.ledger.monthSpendMicros(route.id, month);
    if (spent + estimate > cfg.monthlyCapMicros) return "budget_exceeded";
    const req: GenerateRequest = {
      route: route.id,
      systemInstruction: route.system,
      input: inputText,
      responseSchema: route.jsonSchema,
      thinking: cfg.thinking,
      maxOutputTokens: cfg.maxOutputTokens,
      budgetMs,
    };
    const result = await deps.provider.generate(req);
    for (const a of result.attempts) {
      if (!a.usage) continue;
      const cost = costMicros(a.model, a.usage, day);
      totalCost += cost;
      await deps.ledger.recordSpend({ month, route: route.id, model: a.model, usage: a.usage, costMicros: cost });
    }
    return result;
  };

  if (opts.userKey && cfg.dailyPerUser !== null) await deps.ledger.recordUserRequest(route.id, opts.userKey, day);

  let inputText = prompt.input;
  let lastFailure: DegradedReason = "validation_failed";
  for (let round = 0; round <= MAX_REPAIRS; round++) {
    const remaining = cfg.totalBudgetMs - (deps.clock.now() - started);
    if (round > 0 && remaining < RETRY_POLICY.minAttemptMs * 2) break;
    const result = await call(inputText, remaining);
    if (result === "budget_exceeded") return degrade("budget_exceeded");
    if (!result.ok) return degrade(degradedReasonFor(result.errorKind), lastModel(result));

    const okMeta = meta({ status: "ok", degradedReason: null, fallback: false, model: result.model });
    const parsed = parseModelJson(result.text, route.outputSchema);
    const outcome = parsed.ok
      ? route.finalize(parsed.value, input, prompt as BuiltPrompt, okMeta)
      : ({ ok: false, reason: "validation_failed", issues: parsed.issues } as const);
    if (outcome.ok) {
      finish("ok", null, { model: result.model, rounds: round + 1, costMicros: totalCost });
      return outcome.response;
    }
    lastFailure = outcome.reason;
    deps.log("ai.output_rejected", { route: route.id, reason: outcome.reason, issueCount: outcome.issues.length, round });
    inputText = `${prompt.input}\n\nYOUR PREVIOUS ANSWER WAS REJECTED FOR THESE REASONS:\n${outcome.issues
      .slice(0, 8)
      .map((i) => `- ${i}`)
      .join("\n")}\nReturn corrected JSON that follows every rule.`;
  }
  return degrade(lastFailure, deps.provider.model);
}

function lastModel(result: GenerateResult): string | null {
  const last = result.attempts[result.attempts.length - 1];
  return last ? last.model : null;
}
