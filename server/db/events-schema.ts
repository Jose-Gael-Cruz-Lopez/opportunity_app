import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { ANALYTICS_EVENT_NAMES, ERROR_KINDS, ERROR_SURFACES } from "../../shared/contracts/api";
import { createdAt, emptyJsonObject, flag, json, jsonObject, ms, oneOf, pk, version } from "./columns";

/**
 * D1 `novus-events` schema: high-volume, append-mostly tables kept apart from `novus-main` so
 * analytics and metering never queue behind Alerts (architecture 2.3.5). Nothing here holds a
 * SensitiveAnswer, a prompt, a model output or an email address.
 */

/**
 * Registered client events keyed by a device id and an HMAC of the user id. Events about a
 * sensitive- or identity-audience program never become rows here: they only increment
 * `program_daily_counts`.
 */
export const analyticsEvents = sqliteTable(
  "analytics_events",
  {
    id: pk(),
    name: text("name").notNull(),
    at: ms("at").notNull(),
    deviceId: text("device_id"),
    /** Keyed HMAC of the user id (rotatable key id alongside), never the id itself. */
    userHmac: text("user_hmac"),
    hmacKeyId: text("hmac_key_id"),
    path: text("path").notNull(),
    /** Allowlisted scalar properties only. */
    props: json<Record<string, string | number | boolean>>("props").notNull().default(emptyJsonObject),
    receivedAt: createdAt(),
  },
  (t) => [
    oneOf("analytics_events_name_ck", t.name, ANALYTICS_EVENT_NAMES),
    jsonObject("analytics_events_props_ck", t.props),
    index("analytics_events_at_idx").on(t.at),
    index("analytics_events_name_idx").on(t.name, t.at),
  ],
);

/** Day-level counters, the only record of events about sensitive- or identity-audience programs. */
export const programDailyCounts = sqliteTable(
  "program_daily_counts",
  {
    programId: text("program_id").notNull(),
    day: text("day").notNull(),
    eventName: text("event_name").notNull(),
    n: integer("n").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.programId, t.day, t.eventName] }),
    check("program_daily_counts_day_ck", sql`${t.day} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
  ],
);

export const attributionCodeDaily = sqliteTable(
  "attribution_code_daily",
  {
    codeId: text("code_id").notNull(),
    day: text("day").notNull(),
    signups: integer("signups").notNull().default(0),
    activations: integer("activations").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.codeId, t.day] })],
);

/** One row per model attempt: metering only, never prompt or output text. */
export const llmCalls = sqliteTable(
  "llm_calls",
  {
    id: pk(),
    routeId: text("route_id").notNull(),
    routeVersion: text("route_version").notNull(),
    provider: text("provider").notNull().default("gemini"),
    modelRequested: text("model_requested").notNull(),
    modelServed: text("model_served"),
    status: text("status").notNull(),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    /** Integer micro-dollars: one call costs a fraction of a cent. */
    costMicros: integer("cost_micros").notNull().default(0),
    latencyMs: integer("latency_ms"),
    requestId: text("request_id"),
    reservationId: text("reservation_id"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("llm_calls_status_ck", t.status, ["ok", "schema_invalid", "refused", "max_tokens", "timeout", "error", "degraded"]),
    index("llm_calls_route_idx").on(t.routeId, t.createdAt),
  ],
);

export const llmBudgets = sqliteTable(
  "llm_budgets",
  {
    id: pk(),
    month: text("month").notNull(),
    budgetClass: text("budget_class").notNull(),
    capMicros: integer("cap_micros").notNull(),
    reservedMicros: integer("reserved_micros").notNull().default(0),
    settledMicros: integer("settled_micros").notNull().default(0),
    version: version(),
  },
  (t) => [
    uniqueIndex("llm_budgets_uq").on(t.month, t.budgetClass),
    check("llm_budgets_month_ck", sql`${t.month} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'`),
    check("llm_budgets_nonneg_ck", sql`${t.reservedMicros} >= 0 AND ${t.settledMicros} >= 0 AND ${t.capMicros} >= 0`),
  ],
);

export const llmReservations = sqliteTable(
  "llm_reservations",
  {
    id: pk(),
    idempotencyKey: text("idempotency_key").notNull().unique(),
    routeId: text("route_id").notNull(),
    budgetClass: text("budget_class").notNull(),
    estimateMicros: integer("estimate_micros").notNull(),
    actualMicros: integer("actual_micros"),
    state: text("state").notNull().default("reserved"),
    expiresAt: ms("expires_at").notNull(),
    createdAt: createdAt(),
  },
  (t) => [oneOf("llm_reservations_state_ck", t.state, ["reserved", "settled", "released"]), index("llm_reservations_expires_idx").on(t.state, t.expiresAt)],
);

/** Email send ledger: provider outcome per Notification, no address or body. */
export const emailSendLedger = sqliteTable(
  "email_send_ledger",
  {
    id: pk(),
    notificationId: text("notification_id").notNull(),
    stream: text("stream").notNull(),
    outcome: text("outcome").notNull(),
    providerMessageId: text("provider_message_id"),
    dryRun: flag("dry_run"),
    createdAt: createdAt(),
  },
  (t) => [
    oneOf("email_send_ledger_stream_ck", t.stream, ["transactional", "digest"]),
    oneOf("email_send_ledger_outcome_ck", t.outcome, ["sent", "failed", "suppressed", "quota_deferred"]),
    index("email_send_ledger_day_idx").on(t.createdAt),
    index("email_send_ledger_notification_idx").on(t.notificationId),
  ],
);

/**
 * Gemini spend ledger (server/ai/ledger.ts D1Ledger; AI_LEDGER_DDL is the same shape). Holds
 * token counts and cost only, never prompts or answers.
 */
export const aiSpendMonthly = sqliteTable(
  "ai_spend_monthly",
  {
    month: text("month").notNull(),
    route: text("route").notNull(),
    model: text("model").notNull(),
    attempts: integer("attempts").notNull().default(0),
    inputTokens: integer("input_tokens").notNull().default(0),
    outputTokens: integer("output_tokens").notNull().default(0),
    thoughtTokens: integer("thought_tokens").notNull().default(0),
    cachedTokens: integer("cached_tokens").notNull().default(0),
    costMicros: integer("cost_micros").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.month, t.route, t.model] })],
);

/** Per-user daily assistant request counts, keyed by an opaque user key; pruned after 7 days. */
export const aiUserDaily = sqliteTable(
  "ai_user_daily",
  {
    day: text("day").notNull(),
    userKey: text("user_key").notNull(),
    route: text("route").notNull(),
    requests: integer("requests").notNull().default(0),
  },
  (t) => [primaryKey({ columns: [t.day, t.userKey, t.route] })],
);

/**
 * Client crash reports as day counters (POST /api/v1/error-reports, server/api/v1/events): one
 * row per day and crash site, `n` counts reports. No session, device or user key, no message,
 * stack, URL or query string. `sweep` prunes rows after 90 days (judgment; s09 retention class
 * "ops_metrics").
 */
export const clientErrorDaily = sqliteTable(
  "client_error_daily",
  {
    day: text("day").notNull(),
    kind: text("kind").notNull(),
    surface: text("surface").notNull(),
    errorClass: text("error_class").notNull(),
    route: text("route").notNull(),
    release: text("release").notNull(),
    browser: text("browser").notNull(),
    file: text("file").notNull().default(""),
    line: integer("line").notNull().default(0),
    n: integer("n").notNull().default(0),
  },
  (t) => [
    primaryKey({ columns: [t.day, t.kind, t.surface, t.errorClass, t.route, t.release, t.browser, t.file, t.line] }),
    check("client_error_daily_day_ck", sql`${t.day} GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'`),
    oneOf("client_error_daily_kind_ck", t.kind, ERROR_KINDS),
    oneOf("client_error_daily_surface_ck", t.surface, ERROR_SURFACES),
    index("client_error_daily_day_idx").on(t.day),
  ],
);
