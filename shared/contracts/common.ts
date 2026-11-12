import { z } from "zod";
import { PRODUCT } from "../config/product";
import { isIsoDate, isIsoMonth, LOCAL_TIME_PATTERN, parseIsoInstant } from "../time/iso";
import { isValidTimeZone } from "../time/zones";
import { withJsonSchema } from "./json-schema";

/**
 * Wire primitives. Instants travel as ISO 8601 strings with a zone designator; published dates
 * as `YYYY-MM-DD` (or `YYYY-MM` for month-only), never as instants.
 */

/** Internal UUIDv7 keys. They embed creation time, so user-linked records expose `publicId` instead. */
export const IdSchema = z.string().uuid();
export type Id = z.infer<typeof IdSchema>;

/** 128-bit random id, base62 (about 22 chars), for user-linked records exposed outside. */
export const PublicIdSchema = z.string().regex(/^[0-9A-Za-z]{16,32}$/, "public id");
export type PublicId = z.infer<typeof PublicIdSchema>;

export const SlugSchema = z
  .string()
  .min(1)
  .max(120)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase slug with hyphens");
export type Slug = z.infer<typeof SlugSchema>;

export const IsoDateSchema = withJsonSchema(z.string().refine(isIsoDate, "date as YYYY-MM-DD"), { format: "date" });
export type IsoDate = z.infer<typeof IsoDateSchema>;

/** A published date: a full date, or a month for month-only rows. */
export const PublishedDateSchema = withJsonSchema(
  z.string().refine((v) => isIsoDate(v) || isIsoMonth(v), "date as YYYY-MM-DD or YYYY-MM"),
  { pattern: "^\\d{4}-\\d{2}(-\\d{2})?$" },
);
export type PublishedDate = z.infer<typeof PublishedDateSchema>;

export const YearMonthSchema = withJsonSchema(z.string().refine(isIsoMonth, "month as YYYY-MM"), { pattern: "^\\d{4}-\\d{2}$" });

export const IsoDateTimeSchema = withJsonSchema(
  z.string().refine((v) => parseIsoInstant(v) !== null, "ISO 8601 instant with Z or an offset"),
  { format: "date-time" },
);
export type IsoDateTime = z.infer<typeof IsoDateTimeSchema>;

export const LocalTimeSchema = z.string().regex(LOCAL_TIME_PATTERN, "time as HH:MM");

export const TimeZoneSchema = withJsonSchema(z.string().refine(isValidTimeZone, "IANA time zone such as America/Chicago"), {
  description: "IANA time zone, e.g. America/Chicago",
});
export type TimeZone = z.infer<typeof TimeZoneSchema>;

export const UrlSchema = z
  .string()
  .url()
  .max(2048)
  .refine((v) => /^https?:\/\//i.test(v), "http(s) URL");

/** Money is integer cents. */
export const CentsSchema = z.number().int().nonnegative();

export const Sha256Schema = z.string().regex(/^[0-9a-f]{64}$/, "lowercase hex SHA-256");

/** Curator role handle shown in "Verified by" (never a person's name). */
export const CuratorHandleSchema = z.string().min(1).max(60);

/** Labels sample/demo data so it is never presented as verified fact. */
export const SampleFlagSchema = z.boolean().default(false);

// ---------------------------------------------------------------------------------------------
// Pagination: cursor-based, `limit` at most 100.
// ---------------------------------------------------------------------------------------------

export const CursorQuerySchema = z
  .object({
    cursor: z.string().min(1).max(512).optional(),
    limit: z.coerce
      .number()
      .int()
      .min(1)
      .max(PRODUCT.pagination.maxLimit)
      .default(PRODUCT.pagination.defaultLimit),
  })
  .strict();
export type CursorQuery = z.infer<typeof CursorQuerySchema>;

export const PageInfoSchema = z
  .object({
    nextCursor: z.string().nullable(),
    limit: z.number().int().min(1).max(PRODUCT.pagination.maxLimit),
  })
  .strict();
export type PageInfo = z.infer<typeof PageInfoSchema>;

/** Builds a page schema `{ items, page }` around an item schema. */
export function paginated<T extends z.ZodTypeAny>(item: T) {
  return z.object({ items: z.array(item), page: PageInfoSchema }).strict();
}
export type Paginated<T> = { items: T[]; page: PageInfo };

// ---------------------------------------------------------------------------------------------
// Errors: RFC 9457 problem+json with no internal messages and no echoed input values.
// ---------------------------------------------------------------------------------------------

export const API_ERROR_CODES = [
  "bad_request",
  "validation_failed",
  "sensitive_field_rejected",
  "unauthenticated",
  "forbidden",
  "not_found",
  "conflict",
  "consent_required",
  "version_conflict",
  "precondition_failed",
  "payload_too_large",
  "rate_limited",
  "ai_unavailable",
  "unavailable",
  "internal",
] as const;
export const ApiErrorCodeSchema = z.enum(API_ERROR_CODES);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const API_ERROR_STATUS: Record<ApiErrorCode, number> = {
  bad_request: 400,
  validation_failed: 400,
  sensitive_field_rejected: 400,
  unauthenticated: 401,
  forbidden: 403,
  not_found: 404,
  conflict: 409,
  consent_required: 409,
  version_conflict: 409,
  precondition_failed: 412,
  payload_too_large: 413,
  rate_limited: 429,
  ai_unavailable: 503,
  unavailable: 503,
  internal: 500,
};

/** A field-level problem: the path and a fixed message, never the submitted value. */
export const FieldIssueSchema = z
  .object({ path: z.string().max(200), message: z.string().max(200) })
  .strict();

export const ProblemDetailsSchema = z
  .object({
    type: z.string().max(300),
    title: z.string().max(200),
    status: z.number().int().min(400).max(599),
    code: ApiErrorCodeSchema,
    detail: z.string().max(500).optional(),
    instance: z.string().max(300).optional(),
    requestId: z.string().max(100).optional(),
    errors: z.array(FieldIssueSchema).max(50).optional(),
  })
  .strict();
export type ProblemDetails = z.infer<typeof ProblemDetailsSchema>;

const ERROR_TITLES: Record<ApiErrorCode, string> = {
  bad_request: "Bad request",
  validation_failed: "Request did not match the schema",
  sensitive_field_rejected: "This endpoint does not accept status or identity answers",
  unauthenticated: "Sign in required",
  forbidden: "Not allowed",
  not_found: "Not found",
  conflict: "Conflict",
  consent_required: "Consent required",
  version_conflict: "The record changed; reload and try again",
  precondition_failed: "Precondition failed",
  payload_too_large: "Request too large",
  rate_limited: "Too many requests",
  ai_unavailable: "The assistant is unavailable right now",
  unavailable: "Service unavailable",
  internal: "Something went wrong",
};

/** Builds a problem document with the standard status and title for a code. */
export function problem(
  code: ApiErrorCode,
  extra: Partial<Omit<ProblemDetails, "code" | "status">> = {},
): ProblemDetails {
  return {
    // A relative URI reference (RFC 9457 3.1.1) so no deployment domain is baked in.
    type: `/problems/${code.replace(/_/g, "-")}`,
    title: ERROR_TITLES[code],
    status: API_ERROR_STATUS[code],
    code,
    ...extra,
  };
}

/**
 * Fixed messages per zod issue code. zod 3's default messages quote the submitted value for some
 * codes (an invalid enum names the value sent), so no default message is ever passed through.
 */
export const ZOD_ISSUE_MESSAGES: Readonly<Record<string, string>> = {
  invalid_type: "Wrong type",
  invalid_literal: "Unexpected value",
  unrecognized_keys: "Unrecognized key",
  invalid_union: "Does not match any allowed shape",
  invalid_union_discriminator: "Unknown kind",
  invalid_enum_value: "Not an allowed value",
  invalid_arguments: "Invalid arguments",
  invalid_return_type: "Invalid return type",
  invalid_date: "Invalid date",
  invalid_string: "Invalid format",
  too_small: "Too small or too short",
  too_big: "Too large or too long",
  invalid_intersection_types: "Conflicting values",
  not_multiple_of: "Not an allowed step",
  not_finite: "Must be a finite number",
};

/** Only identifier-shaped key names are echoed as paths; anything else could be free text. */
const SAFE_KEY = /^[A-Za-z0-9_-]{1,60}$/;

/**
 * Converts zod issues to field issues without echoing values. Every code maps to a fixed
 * message; `custom` issues keep theirs, because those strings are authored in shared/contracts
 * refinements, never derived from input. Unrecognized keys report identifier-shaped key names as
 * paths (a key name is schema-shaped; sensitive keys are refused before parsing by callers).
 * Path segments are schema keys or array indexes, except record keys, so non-identifier
 * segments are masked too.
 */
export function issuesFromZod(error: z.ZodError, max = 50): z.infer<typeof FieldIssueSchema>[] {
  const out: z.infer<typeof FieldIssueSchema>[] = [];
  for (const issue of error.issues) {
    if (out.length >= max) break;
    const base = issue.path.map((seg) => (typeof seg === "number" || SAFE_KEY.test(seg) ? String(seg) : "(key)")).join(".");
    if (issue.code === "unrecognized_keys") {
      for (const rawKey of issue.keys) {
        if (out.length >= max) break;
        const key = SAFE_KEY.test(rawKey) ? rawKey : "(key)";
        out.push({ path: (base ? `${base}.${key}` : key).slice(0, 200), message: ZOD_ISSUE_MESSAGES.unrecognized_keys! });
      }
      continue;
    }
    const message = issue.code === "custom" ? issue.message.slice(0, 200) : (ZOD_ISSUE_MESSAGES[issue.code] ?? "Invalid value");
    out.push({ path: (base || "(root)").slice(0, 200), message });
  }
  return out;
}
