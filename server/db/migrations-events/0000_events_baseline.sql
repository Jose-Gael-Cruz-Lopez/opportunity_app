CREATE TABLE `analytics_events` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`at` integer NOT NULL,
	`device_id` text,
	`user_hmac` text,
	`hmac_key_id` text,
	`path` text NOT NULL,
	`props` text DEFAULT '{}' NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "analytics_events_name_ck" CHECK("analytics_events"."name" IN ('page_view', 'program_view', 'apply_click', 'remind_me_submit', 'tracker_add', 'onboarding_step', 'search', 'filter_change', 'readiness_open', 'ai_explain_open')),
	CONSTRAINT "analytics_events_props_ck" CHECK("analytics_events"."props" IS NULL OR (json_valid("analytics_events"."props") AND json_type("analytics_events"."props") = 'object'))
);
--> statement-breakpoint
CREATE INDEX `analytics_events_at_idx` ON `analytics_events` (`at`);--> statement-breakpoint
CREATE INDEX `analytics_events_name_idx` ON `analytics_events` (`name`,`at`);--> statement-breakpoint
CREATE TABLE `attribution_code_daily` (
	`code_id` text NOT NULL,
	`day` text NOT NULL,
	`signups` integer DEFAULT 0 NOT NULL,
	`activations` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`code_id`, `day`)
);
--> statement-breakpoint
CREATE TABLE `email_send_ledger` (
	`id` text PRIMARY KEY NOT NULL,
	`notification_id` text NOT NULL,
	`stream` text NOT NULL,
	`outcome` text NOT NULL,
	`provider_message_id` text,
	`dry_run` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "email_send_ledger_stream_ck" CHECK("email_send_ledger"."stream" IN ('transactional', 'digest')),
	CONSTRAINT "email_send_ledger_outcome_ck" CHECK("email_send_ledger"."outcome" IN ('sent', 'failed', 'suppressed', 'quota_deferred'))
);
--> statement-breakpoint
CREATE INDEX `email_send_ledger_day_idx` ON `email_send_ledger` (`created_at`);--> statement-breakpoint
CREATE INDEX `email_send_ledger_notification_idx` ON `email_send_ledger` (`notification_id`);--> statement-breakpoint
CREATE TABLE `llm_budgets` (
	`id` text PRIMARY KEY NOT NULL,
	`month` text NOT NULL,
	`budget_class` text NOT NULL,
	`cap_micros` integer NOT NULL,
	`reserved_micros` integer DEFAULT 0 NOT NULL,
	`settled_micros` integer DEFAULT 0 NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	CONSTRAINT "llm_budgets_month_ck" CHECK("llm_budgets"."month" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "llm_budgets_nonneg_ck" CHECK("llm_budgets"."reserved_micros" >= 0 AND "llm_budgets"."settled_micros" >= 0 AND "llm_budgets"."cap_micros" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_budgets_uq` ON `llm_budgets` (`month`,`budget_class`);--> statement-breakpoint
CREATE TABLE `llm_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`route_id` text NOT NULL,
	`route_version` text NOT NULL,
	`provider` text DEFAULT 'gemini' NOT NULL,
	`model_requested` text NOT NULL,
	`model_served` text,
	`status` text NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	`latency_ms` integer,
	`request_id` text,
	`reservation_id` text,
	`created_at` integer NOT NULL,
	CONSTRAINT "llm_calls_status_ck" CHECK("llm_calls"."status" IN ('ok', 'schema_invalid', 'refused', 'max_tokens', 'timeout', 'error', 'degraded'))
);
--> statement-breakpoint
CREATE INDEX `llm_calls_route_idx` ON `llm_calls` (`route_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `llm_reservations` (
	`id` text PRIMARY KEY NOT NULL,
	`idempotency_key` text NOT NULL,
	`route_id` text NOT NULL,
	`budget_class` text NOT NULL,
	`estimate_micros` integer NOT NULL,
	`actual_micros` integer,
	`state` text DEFAULT 'reserved' NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "llm_reservations_state_ck" CHECK("llm_reservations"."state" IN ('reserved', 'settled', 'released'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `llm_reservations_idempotency_key_unique` ON `llm_reservations` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `llm_reservations_expires_idx` ON `llm_reservations` (`state`,`expires_at`);--> statement-breakpoint
CREATE TABLE `program_daily_counts` (
	`program_id` text NOT NULL,
	`day` text NOT NULL,
	`event_name` text NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`program_id`, `day`, `event_name`),
	CONSTRAINT "program_daily_counts_day_ck" CHECK("program_daily_counts"."day" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]')
);
