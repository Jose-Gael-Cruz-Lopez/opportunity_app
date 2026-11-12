import type { AiErrorKind, AiProvider, GenerateRequest, GenerateResult, TokenUsage } from "./types";

/**
 * A scripted provider for tests and local demos. Each call consumes the next step; the requests
 * it saw are kept so tests can assert what would have been sent (and what never is).
 */

export type MockStep =
  | { readonly json: unknown; readonly usage?: TokenUsage; readonly model?: string }
  | { readonly text: string; readonly usage?: TokenUsage; readonly model?: string }
  | { readonly error: AiErrorKind; readonly usage?: TokenUsage };

export interface MockProvider extends AiProvider {
  readonly calls: GenerateRequest[];
  /** Steps not yet consumed. */
  remaining(): number;
}

const MOCK_USAGE: TokenUsage = { inputTokens: 1_000, outputTokens: 200, thoughtTokens: 0, cachedTokens: 0 };

export function createMockProvider(steps: readonly MockStep[], model = "mock-model"): MockProvider {
  const queue = [...steps];
  const calls: GenerateRequest[] = [];
  return {
    name: "mock",
    model,
    calls,
    remaining: () => queue.length,
    async generate(req: GenerateRequest): Promise<GenerateResult> {
      calls.push(req);
      const step = queue.shift();
      if (!step) throw new Error("mock provider: no scripted step left");
      if ("error" in step) {
        return {
          ok: false,
          errorKind: step.error,
          attempts: [
            {
              model,
              ok: false,
              httpStatus: null,
              errorKind: step.error,
              errorCode: null,
              usage: step.usage ?? null,
              latencyMs: 0,
            },
          ],
        };
      }
      const used = step.model ?? model;
      const text = "json" in step ? JSON.stringify(step.json) : step.text;
      return {
        ok: true,
        text,
        model: used,
        responseId: `mock-${calls.length}`,
        attempts: [
          { model: used, ok: true, httpStatus: 200, errorKind: null, errorCode: null, usage: step.usage ?? MOCK_USAGE, latencyMs: 1 },
        ],
      };
    },
  };
}
