import { getEligibilityField, type EligibilityFieldKey, type EligibilityResult, type EligibilityRuleSet } from "../contracts/eligibility";
import { SensitiveAnswersSchema, type SensitiveAnswers } from "../contracts/sensitive";
import type { IdentityCategory } from "../taxonomy";
import { evaluateCore, type EvaluateOptions } from "./evaluate";
import type { DeviceInputs, EligibilityProfile } from "./fields";

/**
 * BROWSER ONLY. Evaluates rules on citizenship, Pell, financial need, first-generation status and
 * identity, and attestations, from answers that live in React state on the student's device.
 *
 * Rules this module enforces:
 * - Nothing in server/** or pipeline/** may import it, and shared/eligibility/index.ts does not
 *   re-export it; shared/eligibility/privacy-boundary.test.ts walks the import graph to prove it.
 * - Answers are held in an AnswerBox whose fields are private (#) and whose toJSON throws, so
 *   JSON.stringify, fetch bodies, analytics payloads and structuredClone never carry them.
 * - The result of evaluateWithAnswers reveals status (a "met" citizenship rule), so it is frozen
 *   and its toJSON throws too: render it and drop it, never send or store it.
 * - It refuses to run inside a Cloudflare Worker.
 */

export class SensitiveSerializationError extends Error {
  constructor(what: string) {
    super(`${what} are device-only and must never be serialized, sent, stored or logged`);
    this.name = "SensitiveSerializationError";
  }
}

export class DeviceOnlyError extends Error {
  constructor() {
    super("sensitive eligibility runs in the browser only");
    this.name = "DeviceOnlyError";
  }
}

const INSPECT = Symbol.for("nodejs.util.inspect.custom");

/** Attestation answers: a set of confirmed ids, or a map of id -> confirmed (true) / declined (false). */
export type AttestationAnswers = ReadonlySet<string> | ReadonlyMap<string, boolean>;

/**
 * Holds SensitiveAnswers for one evaluation. Private class fields are invisible to
 * JSON.stringify, Object.keys, spread and structuredClone; toJSON throws so an accidental
 * serialization fails loudly instead of silently sending `{}`.
 */
export class AnswerBox {
  readonly #answers: SensitiveAnswers;
  readonly #attestations: AttestationAnswers;

  constructor(answers: SensitiveAnswers, attestations: AttestationAnswers = new Set()) {
    // Validate so a typo or an unexpected key never silently reads as "not answered".
    this.#answers = Object.freeze(SensitiveAnswersSchema.parse(answers)) as SensitiveAnswers;
    this.#attestations = attestations;
    Object.freeze(this);
  }

  sensitiveValue(field: EligibilityFieldKey): string | readonly string[] | undefined {
    const def = getEligibilityField(field);
    if (!def?.sensitive) return undefined;
    if (field.startsWith("identity.")) {
      const category = field.slice("identity.".length) as IdentityCategory;
      return this.#answers.identity?.[category];
    }
    switch (field) {
      case "citizenship":
        return this.#answers.citizenship;
      case "pell":
        return this.#answers.pell;
      case "financialNeed":
        return this.#answers.financialNeed;
      case "firstGeneration":
        return this.#answers.firstGeneration;
      default:
        return undefined;
    }
  }

  attestation(id: string): boolean | undefined {
    const a = this.#attestations;
    if (a instanceof Map) return a.get(id);
    return (a as ReadonlySet<string>).has(id) ? true : undefined;
  }

  toJSON(): never {
    throw new SensitiveSerializationError("SensitiveAnswers");
  }

  toString(): string {
    return "[SensitiveAnswers]";
  }

  [INSPECT](): string {
    return "[SensitiveAnswers]";
  }
}

export function createAnswerBox(answers: SensitiveAnswers, attestations?: AttestationAnswers): AnswerBox {
  return new AnswerBox(answers, attestations);
}

function assertDevice(): void {
  const nav = (globalThis as { navigator?: { userAgent?: string } }).navigator;
  if (nav?.userAgent === "Cloudflare-Workers") throw new DeviceOnlyError();
}

/** A result that carries device-only verdicts: frozen, and it refuses to serialize. */
export type DeviceEligibilityResult = Readonly<EligibilityResult> & { readonly toJSON: () => never };

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const v of Object.values(value as Record<string, unknown>)) deepFreeze(v);
  }
  return value;
}

export interface DeviceEvaluateOptions extends EvaluateOptions {
  readonly answers: AnswerBox | SensitiveAnswers;
  readonly attestations?: AttestationAnswers;
}

/**
 * Evaluates every rule, sensitive ones included, with answers from this device. Monotone with
 * the server: for the same rule set, profile and date it never contradicts evaluateEligibility,
 * it only resolves rules the server left unknown.
 */
export function evaluateWithAnswers(ruleSet: EligibilityRuleSet | null, profile: EligibilityProfile, opts: DeviceEvaluateOptions): DeviceEligibilityResult {
  assertDevice();
  const box = opts.answers instanceof AnswerBox ? opts.answers : new AnswerBox(opts.answers, opts.attestations);
  const device: DeviceInputs = {
    sensitiveValue: (field) => box.sensitiveValue(field),
    attestation: (id) => box.attestation(id),
  };
  const result = evaluateCore(ruleSet, profile, { asOf: opts.asOf, context: opts.context }, device);
  Object.defineProperty(result, "toJSON", {
    value: (): never => {
      throw new SensitiveSerializationError("Eligibility results computed from SensitiveAnswers");
    },
    enumerable: false,
  });
  return deepFreeze(result) as DeviceEligibilityResult;
}
