import { z } from "zod";
import {
  CitizenshipSchema,
  IDENTITY_CATEGORIES,
  IDENTITY_VALUES,
  PellAnswerSchema,
  SENSITIVE_KEY_ALLOWLIST,
  SENSITIVE_KEY_STEMS,
  StatusAnswerSchema,
  type IdentityCategory,
} from "../taxonomy";

/**
 * SensitiveAnswers: BROWSER ONLY. These answers live in React state for the session and are
 * never sent to a server route, stored in a table or Web Storage, logged, put in an analytics
 * event or included in an LLM prompt. The schema exists so the browser can validate its own
 * form state; it is deliberately left out of the JSON Schema export and of every request schema.
 */

const identityShape = Object.fromEntries(
  IDENTITY_CATEGORIES.map((c) => [
    c,
    z
      .array(z.string().refine((v) => v === "prefer_not" || IDENTITY_VALUES[c].includes(v), "unknown value"))
      .max(10)
      .optional(),
  ]),
) as Record<IdentityCategory, z.ZodOptional<z.ZodArray<z.ZodEffects<z.ZodString, string, string>>>>;

export const SensitiveAnswersSchema = z
  .object({
    citizenship: z.union([CitizenshipSchema, z.literal("prefer_not")]).optional(),
    pell: PellAnswerSchema.optional(),
    financialNeed: StatusAnswerSchema.optional(),
    firstGeneration: StatusAnswerSchema.optional(),
    identity: z.object(identityShape).strict().optional(),
  })
  .strict();
export type SensitiveAnswers = Readonly<z.infer<typeof SensitiveAnswersSchema>>;

/** Splits a property name into lowercase words: `isFirstGen` -> [is, first, gen]. */
function words(key: string): string[] {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .split(/[^A-Za-z0-9]+/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
}

const ALLOW: ReadonlySet<string> = new Set(SENSITIVE_KEY_ALLOWLIST);

/**
 * True when a property name looks like it carries a status or identity answer. A stem matches
 * at a word boundary, also across joined words (`firstGen`, `greenCard`), so `traceId` or
 * `https` do not match `race` or `tps`.
 */
export function isSensitiveKey(key: string): boolean {
  if (ALLOW.has(key)) return false;
  const w = words(key);
  for (let i = 0; i < w.length; i++) {
    const tail = w.slice(i).join("");
    if (SENSITIVE_KEY_STEMS.some((stem) => tail.startsWith(stem))) return true;
  }
  return false;
}

/**
 * Lists the paths of sensitive-looking keys anywhere in a JSON value. Servers call it before
 * validation so a request carrying such a key is refused with `sensitive_field_rejected`
 * and nothing about it is logged. Returns paths only, never values.
 */
export function findSensitiveKeys(value: unknown, maxDepth = 8): string[] {
  const found: string[] = [];
  const visit = (node: unknown, path: string, depth: number): void => {
    if (depth > maxDepth || node === null || typeof node !== "object") return;
    if (Array.isArray(node)) {
      node.forEach((item, i) => visit(item, `${path}[${i}]`, depth + 1));
      return;
    }
    for (const [k, v] of Object.entries(node)) {
      const p = path ? `${path}.${k}` : k;
      if (isSensitiveKey(k)) found.push(p);
      visit(v, p, depth + 1);
    }
  };
  visit(value, "", 0);
  return found;
}
