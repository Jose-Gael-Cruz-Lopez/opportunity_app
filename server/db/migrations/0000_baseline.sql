CREATE TABLE `access_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_ref` text NOT NULL,
	`action` text NOT NULL,
	`purpose` text NOT NULL,
	`fields` text DEFAULT '[]' NOT NULL,
	`subject_key` text NOT NULL,
	`request_id` text,
	CONSTRAINT "access_audit_actor_ck" CHECK("access_audit"."actor_kind" IN ('user', 'curator', 'system', 'pipeline', 'admin')),
	CONSTRAINT "access_audit_action_ck" CHECK("access_audit"."action" IN ('read', 'export', 'update', 'delete', 'share')),
	CONSTRAINT "access_audit_fields_ck" CHECK("access_audit"."fields" IS NULL OR (json_valid("access_audit"."fields") AND json_type("access_audit"."fields") = 'array'))
);
--> statement-breakpoint
CREATE INDEX `access_audit_subject_idx` ON `access_audit` (`subject_key`,`created_at`);--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`account_id` text NOT NULL,
	`provider_id` text NOT NULL,
	`user_id` text NOT NULL,
	`access_token` text,
	`refresh_token` text,
	`id_token` text,
	`access_token_expires_at` integer,
	`refresh_token_expires_at` integer,
	`scope` text,
	`password` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `accounts_user_idx` ON `accounts` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_provider_uq` ON `accounts` (`provider_id`,`account_id`);--> statement-breakpoint
CREATE TABLE `advisor_workspaces` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`institution_id` text,
	`kind` text DEFAULT 'concierge_pilot' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`is_sample` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "advisor_workspaces_kind_ck" CHECK("advisor_workspaces"."kind" IN ('concierge_pilot', 'self_service')),
	CONSTRAINT "advisor_workspaces_approval_ck" CHECK(("advisor_workspaces"."approved_by" IS NULL) = ("advisor_workspaces"."approved_at" IS NULL))
);
--> statement-breakpoint
CREATE TABLE `alerts` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`user_id` text,
	`contact_id` text,
	`recipient_key` text NOT NULL,
	`program_cycle_id` text,
	`change_event_id` text,
	`dedupe_key` text NOT NULL,
	`priority` text DEFAULT 'p1' NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`href` text,
	`scheduled_for` integer NOT NULL,
	`read_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`change_event_id`) REFERENCES `change_events`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "alerts_recipient_ck" CHECK(("alerts"."user_id" IS NULL) <> ("alerts"."contact_id" IS NULL)),
	CONSTRAINT "alerts_recipient_key_ck" CHECK("alerts"."recipient_key" = CASE WHEN "alerts"."user_id" IS NOT NULL THEN 'u:' || "alerts"."user_id" ELSE 'c:' || "alerts"."contact_id" END),
	CONSTRAINT "alerts_type_ck" CHECK("alerts"."type" IN ('program_cycle.verified', 'deadline.changed', 'cycle.status_changed', 'eligibility.changed', 'cycle.urgent_recheck', 'cycle.prediction_changed', 'cycle.decisions_released', 'posting.opened', 'posting.closed', 'deadline.reminder', 'cycle.predicted_soon', 'roadmap.replanned', 'profile.newly_eligible', 'curator.note', 'advisor.list_item', 'account.notice', 'contact.confirmation')),
	CONSTRAINT "alerts_priority_ck" CHECK("alerts"."priority" IN ('p0', 'p1', 'p2'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alerts_dedupe_uq` ON `alerts` (`recipient_key`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `alerts_inbox_idx` ON `alerts` (`user_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `alerts_cycle_idx` ON `alerts` (`program_cycle_id`);--> statement-breakpoint
CREATE TABLE `attribution_codes` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`kind` text NOT NULL,
	`workspace_id` text,
	`identity_owned` integer DEFAULT false NOT NULL,
	`expires_at` integer,
	`revoked_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`workspace_id`) REFERENCES `advisor_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "attribution_codes_kind_ck" CHECK("attribution_codes"."kind" IN ('advisor_pilot', 'ambassador', 'partner', 'creator')),
	CONSTRAINT "attribution_codes_len_ck" CHECK(length("attribution_codes"."code") >= 10)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `attribution_codes_code_unique` ON `attribution_codes` (`code`);--> statement-breakpoint
CREATE TABLE `calendar_feeds` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`neutral_titles` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `calendar_feeds_token_hash_unique` ON `calendar_feeds` (`token_hash`);--> statement-breakpoint
CREATE INDEX `calendar_feeds_user_idx` ON `calendar_feeds` (`user_id`);--> statement-breakpoint
CREATE TABLE `change_events` (
	`id` text PRIMARY KEY NOT NULL,
	`type` text NOT NULL,
	`program_cycle_id` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`task_id` text,
	`idempotency_key` text NOT NULL,
	`release` integer,
	`fanned_out_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "change_events_type_ck" CHECK("change_events"."type" IN ('program_cycle.verified', 'deadline.changed', 'cycle.status_changed', 'eligibility.changed', 'cycle.urgent_recheck', 'cycle.prediction_changed', 'cycle.decisions_released', 'posting.opened', 'posting.closed')),
	CONSTRAINT "change_events_payload_ck" CHECK("change_events"."payload" IS NULL OR (json_valid("change_events"."payload") AND json_type("change_events"."payload") = 'object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `change_events_idempotency_key_unique` ON `change_events` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `change_events_pending_idx` ON `change_events` (`created_at`) WHERE "change_events"."fanned_out_at" IS NULL;--> statement-breakpoint
CREATE INDEX `change_events_cycle_idx` ON `change_events` (`program_cycle_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `config` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `consent_texts` (
	`version` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`locale` text DEFAULT 'en' NOT NULL,
	`text_sha256` text NOT NULL,
	`published_at` integer NOT NULL,
	CONSTRAINT "consent_texts_kind_ck" CHECK("consent_texts"."kind" IN ('sensitive_tracking', 'identity_tracking', 'health_tracking', 'analytics', 'minor_outcomes', 'advisor_scope', 'derived_results', 'school_email_alerts'))
);
--> statement-breakpoint
CREATE TABLE `consents` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`contact_id` text,
	`kind` text NOT NULL,
	`scope_type` text,
	`scope_id` text,
	`text_version` text NOT NULL,
	`method` text NOT NULL,
	`granted_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`text_version`) REFERENCES `consent_texts`(`version`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "consents_subject_ck" CHECK(("consents"."user_id" IS NULL) <> ("consents"."contact_id" IS NULL)),
	CONSTRAINT "consents_kind_ck" CHECK("consents"."kind" IN ('sensitive_tracking', 'identity_tracking', 'health_tracking', 'analytics', 'minor_outcomes', 'advisor_scope', 'derived_results', 'school_email_alerts')),
	CONSTRAINT "consents_method_ck" CHECK("consents"."method" IN ('dialog', 'email_link')),
	CONSTRAINT "consents_scope_type_ck" CHECK("consents"."scope_type" IS NULL OR "consents"."scope_type" IN ('program', 'cohort'))
);
--> statement-breakpoint
CREATE INDEX `consents_user_idx` ON `consents` (`user_id`,`kind`);--> statement-breakpoint
CREATE TABLE `contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`email_hmac` text NOT NULL,
	`hmac_key_id` text NOT NULL,
	`confirmed_at` integer,
	`user_id` text,
	`delete_after` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `contacts_hmac_uq` ON `contacts` (`email_hmac`,`hmac_key_id`);--> statement-breakpoint
CREATE INDEX `contacts_delete_idx` ON `contacts` (`delete_after`);--> statement-breakpoint
CREATE TABLE `curators` (
	`id` text PRIMARY KEY NOT NULL,
	`public_handle` text NOT NULL,
	`role` text DEFAULT 'curator' NOT NULL,
	`user_id` text,
	`active` integer DEFAULT true NOT NULL,
	`is_sample` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "curators_role_ck" CHECK("curators"."role" IN ('curator', 'moderator', 'admin'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `curators_public_handle_unique` ON `curators` (`public_handle`);--> statement-breakpoint
CREATE TABLE `cycle_models` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `cycle_predictions` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`event` text NOT NULL,
	`method` text NOT NULL,
	`p10` text NOT NULL,
	`p50` text NOT NULL,
	`p90` text NOT NULL,
	`label` text NOT NULL,
	`is_current` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "predictions_event_ck" CHECK("cycle_predictions"."event" IN ('opens', 'application_deadline', 'decisions')),
	CONSTRAINT "predictions_method_ck" CHECK("cycle_predictions"."method" IN ('official_rule', 'history', 'curator_month', 'curator_estimate')),
	CONSTRAINT "predictions_label_ck" CHECK("cycle_predictions"."label" IN ('low', 'medium', 'high')),
	CONSTRAINT "predictions_order_ck" CHECK("cycle_predictions"."p10" <= "cycle_predictions"."p50" AND "cycle_predictions"."p50" <= "cycle_predictions"."p90")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `predictions_current_uq` ON `cycle_predictions` (`program_cycle_id`,`event`) WHERE "cycle_predictions"."is_current" = 1;--> statement-breakpoint
CREATE TABLE `cycle_statuses` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deadline_kinds` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `deadlines` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`kind` text NOT NULL,
	`scope` text NOT NULL,
	`institution_id` text,
	`round_label` text DEFAULT '' NOT NULL,
	`basis` text NOT NULL,
	`precision` text NOT NULL,
	`tz_mode` text DEFAULT 'fixed' NOT NULL,
	`local_date` text,
	`local_time` text,
	`window_start` text,
	`window_end` text,
	`time_zone` text,
	`tz_source` text,
	`due_at` integer,
	`sort_at` integer,
	`revision` integer DEFAULT 1 NOT NULL,
	`verification_state` text DEFAULT 'draft' NOT NULL,
	`withdrawn_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`kind`) REFERENCES `deadline_kinds`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "dl_scope_ck" CHECK("deadlines"."scope" IN ('national', 'campus')),
	CONSTRAINT "dl_basis_ck" CHECK("deadlines"."basis" IN ('official', 'attested', 'predicted')),
	CONSTRAINT "dl_precision_ck" CHECK("deadlines"."precision" IN ('exact', 'date_only', 'month_only', 'window', 'rolling', 'tbd')),
	CONSTRAINT "dl_tz_mode_ck" CHECK("deadlines"."tz_mode" IN ('fixed', 'applicant_local')),
	CONSTRAINT "dl_tz_source_ck" CHECK("deadlines"."tz_source" IS NULL OR "deadlines"."tz_source" IN ('stated', 'org_default')),
	CONSTRAINT "dl_verification_ck" CHECK("deadlines"."verification_state" IN ('draft', 'verified', 'reverifying', 'unverified')),
	CONSTRAINT "dl_campus_ck" CHECK("deadlines"."scope" = 'national' OR "deadlines"."institution_id" IS NOT NULL),
	CONSTRAINT "dl_attested_ck" CHECK("deadlines"."basis" <> 'attested' OR "deadlines"."scope" = 'campus'),
	CONSTRAINT "dl_window_ck" CHECK((("deadlines"."precision" = 'window') = ("deadlines"."window_start" IS NOT NULL AND "deadlines"."window_end" IS NOT NULL)) AND ("deadlines"."precision" <> 'window' OR "deadlines"."basis" = 'predicted') AND ("deadlines"."basis" <> 'predicted' OR "deadlines"."precision" IN ('window', 'tbd'))),
	CONSTRAINT "dl_date_ck" CHECK(("deadlines"."local_date" IS NOT NULL) = ("deadlines"."precision" IN ('exact', 'date_only', 'month_only', 'window'))),
	CONSTRAINT "dl_time_ck" CHECK(("deadlines"."local_time" IS NOT NULL) = ("deadlines"."precision" = 'exact')),
	CONSTRAINT "dl_zone_ck" CHECK(CASE "deadlines"."tz_mode" WHEN 'applicant_local' THEN "deadlines"."time_zone" IS NULL AND "deadlines"."precision" IN ('exact', 'date_only') ELSE "deadlines"."time_zone" IS NOT NULL OR "deadlines"."precision" IN ('month_only', 'rolling', 'tbd') END),
	CONSTRAINT "dl_instant_ck" CHECK(("deadlines"."due_at" IS NOT NULL) = ("deadlines"."tz_mode" = 'fixed' AND "deadlines"."precision" IN ('exact', 'date_only')))
);
--> statement-breakpoint
CREATE INDEX `deadlines_sort_idx` ON `deadlines` (`sort_at`);--> statement-breakpoint
CREATE INDEX `deadlines_cycle_idx` ON `deadlines` (`program_cycle_id`);--> statement-breakpoint
CREATE INDEX `deadlines_campus_idx` ON `deadlines` (`institution_id`,`program_cycle_id`);--> statement-breakpoint
CREATE TABLE `eligibility_rule_sets` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`version` integer NOT NULL,
	`format` text DEFAULT 'jsonlogic-v1' NOT NULL,
	`state` text NOT NULL,
	`template_key` text,
	`body` text NOT NULL,
	`hash` text,
	`coverage_complete` integer DEFAULT false NOT NULL,
	`launch_coverage_complete` integer DEFAULT false NOT NULL,
	`diff_from_previous` text,
	`created_via` text NOT NULL,
	`from_cycle_key` text,
	`verified_at` integer,
	`verified_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_key`) REFERENCES `eligibility_templates`(`key`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by`) REFERENCES `curators`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ers_state_ck" CHECK("eligibility_rule_sets"."state" IN ('draft', 'verified', 'superseded')),
	CONSTRAINT "ers_format_ck" CHECK("eligibility_rule_sets"."format" IN ('jsonlogic-v1')),
	CONSTRAINT "ers_created_via_ck" CHECK("eligibility_rule_sets"."created_via" IN ('sheet', 'console', 'rollover', 'llm_draft', 'sample')),
	CONSTRAINT "ers_body_ck" CHECK("eligibility_rule_sets"."body" IS NULL OR (json_valid("eligibility_rule_sets"."body") AND json_type("eligibility_rule_sets"."body") = 'object')),
	CONSTRAINT "ers_diff_ck" CHECK("eligibility_rule_sets"."diff_from_previous" IS NULL OR (json_valid("eligibility_rule_sets"."diff_from_previous") AND json_type("eligibility_rule_sets"."diff_from_previous") = 'array')),
	CONSTRAINT "ers_verified_ck" CHECK("eligibility_rule_sets"."state" = 'draft' OR ("eligibility_rule_sets"."hash" IS NOT NULL AND "eligibility_rule_sets"."verified_by" IS NOT NULL AND "eligibility_rule_sets"."verified_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `ers_version_uq` ON `eligibility_rule_sets` (`program_cycle_id`,`version`);--> statement-breakpoint
CREATE UNIQUE INDEX `ers_verified_uq` ON `eligibility_rule_sets` (`program_cycle_id`) WHERE "eligibility_rule_sets"."state" = 'verified';--> statement-breakpoint
CREATE TABLE `eligibility_templates` (
	`key` text PRIMARY KEY NOT NULL,
	`body` text NOT NULL,
	`hash` text,
	`state` text DEFAULT 'draft' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "eligibility_templates_state_ck" CHECK("eligibility_templates"."state" IN ('draft', 'verified', 'superseded')),
	CONSTRAINT "eligibility_templates_body_ck" CHECK("eligibility_templates"."body" IS NULL OR (json_valid("eligibility_templates"."body") AND json_type("eligibility_templates"."body") = 'object'))
);
--> statement-breakpoint
CREATE TABLE `email_action_tokens` (
	`token_hash` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`tracker_item_id` text NOT NULL,
	`action` text NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tracker_item_id`) REFERENCES `tracker_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "email_action_tokens_action_ck" CHECK("email_action_tokens"."action" IN ('mark_submitted', 'not_applying', 'snooze'))
);
--> statement-breakpoint
CREATE INDEX `email_action_tokens_expires_idx` ON `email_action_tokens` (`expires_at`);--> statement-breakpoint
CREATE TABLE `email_suppressions` (
	`email_hmac` text NOT NULL,
	`key_id` text NOT NULL,
	`reason` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`email_hmac`, `key_id`),
	CONSTRAINT "email_suppressions_reason_ck" CHECK("email_suppressions"."reason" IN ('unsubscribe', 'bounce', 'complaint', 'manual'))
);
--> statement-breakpoint
CREATE TABLE `external_refs` (
	`id` text PRIMARY KEY NOT NULL,
	`system` text NOT NULL,
	`external_id` text NOT NULL,
	`row_kind` text NOT NULL,
	`source_id` text,
	`program_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "external_refs_kind_ck" CHECK("external_refs"."row_kind" IN ('json', 'hand'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `external_refs_uq` ON `external_refs` (`system`,`external_id`);--> statement-breakpoint
CREATE TABLE `field_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field_path` text NOT NULL,
	`basis` text NOT NULL,
	`snapshot_id` text,
	`attestation_task_id` text,
	`url` text NOT NULL,
	`quote` text NOT NULL,
	`locator` text,
	`match` text NOT NULL,
	`verified_by` text,
	`superseded_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`snapshot_id`) REFERENCES `snapshots`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by`) REFERENCES `curators`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "ev_entity_ck" CHECK("field_evidence"."entity_type" IN ('program', 'program_cycle', 'deadline', 'requirement', 'eligibility_rule_set', 'program_cycle_count', 'institution_participation', 'organization', 'official_domain')),
	CONSTRAINT "ev_basis_values_ck" CHECK("field_evidence"."basis" IN ('snapshot', 'attestation', 'api_record', 'manual_note')),
	CONSTRAINT "ev_match_ck" CHECK("field_evidence"."match" IN ('exact', 'aligned', 'manual')),
	CONSTRAINT "ev_locator_ck" CHECK("field_evidence"."locator" IS NULL OR (json_valid("field_evidence"."locator") AND json_type("field_evidence"."locator") = 'object')),
	CONSTRAINT "ev_basis_ck" CHECK(CASE "field_evidence"."basis" WHEN 'snapshot' THEN "field_evidence"."snapshot_id" IS NOT NULL WHEN 'attestation' THEN "field_evidence"."attestation_task_id" IS NOT NULL ELSE "field_evidence"."snapshot_id" IS NULL END)
);
--> statement-breakpoint
CREATE INDEX `ev_live_idx` ON `field_evidence` (`entity_type`,`entity_id`) WHERE "field_evidence"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX `ev_snapshot_idx` ON `field_evidence` (`snapshot_id`);--> statement-breakpoint
CREATE TABLE `flags` (
	`key` text PRIMARY KEY NOT NULL,
	`enabled` integer DEFAULT false NOT NULL,
	`note` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `heartbeats` (
	`name` text PRIMARY KEY NOT NULL,
	`last_seen_at` integer NOT NULL,
	`detail` text
);
--> statement-breakpoint
CREATE TABLE `institution_email_domains` (
	`domain` text PRIMARY KEY NOT NULL,
	`institution_id` text NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `institution_email_domains_inst_idx` ON `institution_email_domains` (`institution_id`);--> statement-breakpoint
CREATE TABLE `institution_participation` (
	`program_id` text NOT NULL,
	`institution_id` text NOT NULL,
	`list_year` integer NOT NULL,
	`basis` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`program_id`, `institution_id`, `list_year`),
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "institution_participation_basis_ck" CHECK("institution_participation"."basis" IN ('official_list', 'attested'))
);
--> statement-breakpoint
CREATE INDEX `institution_participation_inst_idx` ON `institution_participation` (`institution_id`);--> statement-breakpoint
CREATE TABLE `institutions` (
	`id` text PRIMARY KEY NOT NULL,
	`unit_id` text,
	`name` text NOT NULL,
	`level` text NOT NULL,
	`control` text,
	`state` text,
	`calendar` text,
	`academic_year_start_month` integer DEFAULT 8 NOT NULL,
	`time_zone` text,
	`is_hbcu` integer DEFAULT false NOT NULL,
	`is_tribal` integer DEFAULT false NOT NULL,
	`is_hsi` integer DEFAULT false NOT NULL,
	`is_sample` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "institutions_level_ck" CHECK("institutions"."level" IN ('two_year', 'four_year', 'other')),
	CONSTRAINT "institutions_control_ck" CHECK("institutions"."control" IS NULL OR "institutions"."control" IN ('public', 'private_nonprofit', 'private_for_profit')),
	CONSTRAINT "institutions_state_ck" CHECK("institutions"."state" IS NULL OR "institutions"."state" IN ('AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'GU', 'MP', 'PR', 'VI', 'UM')),
	CONSTRAINT "institutions_calendar_ck" CHECK("institutions"."calendar" IS NULL OR "institutions"."calendar" IN ('semester', 'quarter', 'trimester', 'four_one_four', 'other_academic', 'differs_by_program', 'continuous')),
	CONSTRAINT "institutions_ay_month_ck" CHECK("institutions"."academic_year_start_month" BETWEEN 1 AND 12)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `institutions_unit_id_unique` ON `institutions` (`unit_id`);--> statement-breakpoint
CREATE INDEX `institutions_name_idx` ON `institutions` (`name`);--> statement-breakpoint
CREATE TABLE `internal_nonces` (
	`nonce` text PRIMARY KEY NOT NULL,
	`key_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `internal_nonces_expires_idx` ON `internal_nonces` (`expires_at`);--> statement-breakpoint
CREATE TABLE `job_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text,
	`kind` text NOT NULL,
	`trigger` text NOT NULL,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	`outcome` text,
	`processed` integer DEFAULT 0 NOT NULL,
	`error_class` text,
	FOREIGN KEY (`job_id`) REFERENCES `jobs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "job_runs_trigger_ck" CHECK("job_runs"."trigger" IN ('tick', 'hourly', 'daily', 'lease', 'request', 'catch_up', 'manual')),
	CONSTRAINT "job_runs_outcome_ck" CHECK("job_runs"."outcome" IS NULL OR "job_runs"."outcome" IN ('ok', 'partial', 'failed', 'deferred'))
);
--> statement-breakpoint
CREATE INDEX `job_runs_kind_idx` ON `job_runs` (`kind`,`started_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`payload` text DEFAULT '{}' NOT NULL,
	`idempotency_key` text NOT NULL,
	`concurrency_key` text,
	`status` text DEFAULT 'pending' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 8 NOT NULL,
	`run_after` integer NOT NULL,
	`lease_owner` text,
	`lease_expires_at` integer,
	`last_error` text,
	`finished_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "jobs_status_ck" CHECK("jobs"."status" IN ('pending', 'leased', 'done', 'dead')),
	CONSTRAINT "jobs_payload_ck" CHECK("jobs"."payload" IS NULL OR (json_valid("jobs"."payload") AND json_type("jobs"."payload") = 'object')),
	CONSTRAINT "jobs_priority_ck" CHECK("jobs"."priority" BETWEEN 0 AND 9)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_idempotency_key_unique` ON `jobs` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `jobs_due_idx` ON `jobs` (`status`,`kind`,`priority`,`run_after`);--> statement-breakpoint
CREATE INDEX `jobs_concurrency_idx` ON `jobs` (`concurrency_key`,`status`) WHERE "jobs"."concurrency_key" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `lifecycles` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `notification_prefs` (
	`user_id` text PRIMARY KEY NOT NULL,
	`weekly_email` integer DEFAULT true NOT NULL,
	`weekly_day` integer,
	`quiet_hours_start` text DEFAULT '22:00' NOT NULL,
	`quiet_hours_end` text DEFAULT '08:00' NOT NULL,
	`exam_pause_until` text,
	`channel_email` integer DEFAULT true NOT NULL,
	`channel_in_app` integer DEFAULT true NOT NULL,
	`channel_push` integer DEFAULT false NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notification_prefs_day_ck" CHECK("notification_prefs"."weekly_day" IS NULL OR "notification_prefs"."weekly_day" BETWEEN 1 AND 7)
);
--> statement-breakpoint
CREATE TABLE `notifications` (
	`id` text PRIMARY KEY NOT NULL,
	`alert_id` text NOT NULL,
	`channel` text NOT NULL,
	`stream` text DEFAULT 'transactional' NOT NULL,
	`idempotency_key` text NOT NULL,
	`state` text DEFAULT 'queued' NOT NULL,
	`expires_at` integer NOT NULL,
	`sent_at` integer,
	`attempts` integer DEFAULT 0 NOT NULL,
	`last_error` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`alert_id`) REFERENCES `alerts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "notifications_channel_ck" CHECK("notifications"."channel" IN ('email', 'in_app', 'push')),
	CONSTRAINT "notifications_stream_ck" CHECK("notifications"."stream" IN ('transactional', 'digest')),
	CONSTRAINT "notifications_state_ck" CHECK("notifications"."state" IN ('queued', 'sent', 'failed', 'suppressed', 'expired'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `notifications_idempotency_key_unique` ON `notifications` (`idempotency_key`);--> statement-breakpoint
CREATE INDEX `notifications_queue_idx` ON `notifications` (`state`,`created_at`) WHERE "notifications"."state" = 'queued';--> statement-breakpoint
CREATE INDEX `notifications_alert_idx` ON `notifications` (`alert_id`);--> statement-breakpoint
CREATE TABLE `official_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`organization_id` text NOT NULL,
	`host` text NOT NULL,
	`role` text NOT NULL,
	`shared_platform` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "official_domains_role_ck" CHECK("official_domains"."role" IN ('site', 'application_portal', 'email_sender'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `official_domains_uq` ON `official_domains` (`organization_id`,`host`,`role`);--> statement-breakpoint
CREATE INDEX `official_domains_host_idx` ON `official_domains` (`host`);--> statement-breakpoint
CREATE TABLE `opportunity_types` (
	`slug` text PRIMARY KEY NOT NULL,
	`ordinal` integer NOT NULL,
	`label` text NOT NULL,
	`group_key` text NOT NULL,
	`in_scope` integer DEFAULT true NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `opportunity_types_ordinal_unique` ON `opportunity_types` (`ordinal`);--> statement-breakpoint
CREATE TABLE `organizations` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`kind` text NOT NULL,
	`country` text DEFAULT 'US' NOT NULL,
	`default_time_zone` text,
	`website_url` text,
	`is_sample` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "organizations_kind_ck" CHECK("organizations"."kind" IN ('federal_agency', 'state_agency', 'foundation', 'nonprofit', 'company', 'university', 'national_lab', 'professional_society', 'other')),
	CONSTRAINT "organizations_country_ck" CHECK(length("organizations"."country") = 2)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `organizations_slug_unique` ON `organizations` (`slug`);--> statement-breakpoint
CREATE TABLE `outcome_stages` (
	`outcome_id` text NOT NULL,
	`stage` text NOT NULL,
	`on_date` text,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`outcome_id`, `stage`),
	FOREIGN KEY (`outcome_id`) REFERENCES `outcomes`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outcome_stages_stage_ck" CHECK("outcome_stages"."stage" IN ('submitted', 'campus_nominated', 'not_nominated', 'interview_invited', 'interviewed', 'waitlisted'))
);
--> statement-breakpoint
CREATE TABLE `outcomes` (
	`id` text PRIMARY KEY NOT NULL,
	`public_id` text NOT NULL,
	`user_id` text NOT NULL,
	`program_cycle_id` text NOT NULL,
	`tier` text DEFAULT 'self_reported' NOT NULL,
	`decision` text,
	`decided_on` text,
	`class_year` text,
	`gpa_band` text,
	`major_family` text,
	`institution_type` text,
	`prior_feeder` text,
	`institution_id` text,
	`quality_state` text DEFAULT 'ok' NOT NULL,
	`flag_codes` text DEFAULT '[]' NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outcomes_tier_ck" CHECK("outcomes"."tier" IN ('self_reported', 'institution_email', 'letter_checked', 'email_authenticated', 'official_list')),
	CONSTRAINT "outcomes_decision_ck" CHECK("outcomes"."decision" IS NULL OR "outcomes"."decision" IN ('accepted', 'rejected', 'withdrew', 'declined_offer', 'no_response')),
	CONSTRAINT "outcomes_class_year_ck" CHECK("outcomes"."class_year" IS NULL OR "outcomes"."class_year" IN ('incoming_first_year', 'first_year', 'second_year', 'third_year', 'fourth_year', 'fifth_year_plus', 'recent_graduate', 'graduate')),
	CONSTRAINT "outcomes_gpa_band_ck" CHECK("outcomes"."gpa_band" IS NULL OR "outcomes"."gpa_band" IN ('none_yet', 'under_2_0', '2_0_to_2_49', '2_5_to_2_74', '2_75_to_2_99', '3_0_to_3_24', '3_25_to_3_49', '3_5_to_3_74', '3_75_plus', 'prefer_not')),
	CONSTRAINT "outcomes_major_family_ck" CHECK("outcomes"."major_family" IS NULL OR "outcomes"."major_family" IN ('agriculture_environment', 'arts_design', 'business', 'communication_media', 'computing', 'education', 'engineering_technology', 'health', 'humanities_languages', 'life_sciences', 'math_statistics', 'physical_sciences', 'social_sciences', 'law_policy_service', 'trades_applied', 'undeclared')),
	CONSTRAINT "outcomes_institution_type_ck" CHECK("outcomes"."institution_type" IS NULL OR "outcomes"."institution_type" IN ('two_year', 'four_year', 'other')),
	CONSTRAINT "outcomes_prior_feeder_ck" CHECK("outcomes"."prior_feeder" IS NULL OR "outcomes"."prior_feeder" IN ('yes', 'no')),
	CONSTRAINT "outcomes_quality_ck" CHECK("outcomes"."quality_state" IN ('ok', 'flagged')),
	CONSTRAINT "outcomes_flags_ck" CHECK("outcomes"."flag_codes" IS NULL OR (json_valid("outcomes"."flag_codes") AND json_type("outcomes"."flag_codes") = 'array'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outcomes_public_id_unique` ON `outcomes` (`public_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `outcomes_user_cycle_uq` ON `outcomes` (`user_id`,`program_cycle_id`);--> statement-breakpoint
CREATE INDEX `outcomes_cycle_idx` ON `outcomes` (`program_cycle_id`) WHERE "outcomes"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `program_aliases` (
	`program_id` text NOT NULL,
	`alias` text NOT NULL,
	PRIMARY KEY(`program_id`, `alias`),
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `program_aliases_alias_idx` ON `program_aliases` (`alias`);--> statement-breakpoint
CREATE TABLE `program_cycle_counts` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`stage` text NOT NULL,
	`count` integer NOT NULL,
	`kind` text NOT NULL,
	`provenance` text NOT NULL,
	`as_of` text NOT NULL,
	`verified_by` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by`) REFERENCES `curators`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "counts_stage_ck" CHECK("program_cycle_counts"."stage" IN ('campus_applicants', 'applicants', 'nominees', 'finalists', 'awards', 'alternates')),
	CONSTRAINT "counts_kind_ck" CHECK("program_cycle_counts"."kind" IN ('exact', 'lower_bound', 'approx')),
	CONSTRAINT "counts_provenance_ck" CHECK("program_cycle_counts"."provenance" IN ('official_publication', 'owner_reported')),
	CONSTRAINT "counts_nonneg_ck" CHECK("program_cycle_counts"."count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `counts_stage_uq` ON `program_cycle_counts` (`program_cycle_id`,`stage`);--> statement-breakpoint
CREATE TABLE `program_cycles` (
	`id` text PRIMARY KEY NOT NULL,
	`program_id` text NOT NULL,
	`cycle_key` text NOT NULL,
	`term_label` text NOT NULL,
	`cycle_model` text DEFAULT 'term' NOT NULL,
	`status` text DEFAULT 'expected' NOT NULL,
	`status_changed_at` integer NOT NULL,
	`status_changed_by` text NOT NULL,
	`time_zone` text,
	`opens_on` text,
	`predicted_opens_on` text,
	`prediction_label` text,
	`decision_window_start` text,
	`decision_window_end` text,
	`decisions_released_on` text,
	`event_start` text,
	`event_end` text,
	`application_url` text,
	`pell_displacement` text DEFAULT 'unknown' NOT NULL,
	`application_fee_cents` integer,
	`participant_cost_cents` integer,
	`compensation` text,
	`class_years` text DEFAULT '[]' NOT NULL,
	`verification_state` text DEFAULT 'draft' NOT NULL,
	`last_verified_at` integer,
	`verified_by` text,
	`source_checked_at` integer,
	`campus_estimate_release` integer,
	`rolled_over_from_id` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`cycle_model`) REFERENCES `cycle_models`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`status`) REFERENCES `cycle_statuses`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`verified_by`) REFERENCES `curators`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rolled_over_from_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "cycles_key_ck" CHECK("program_cycles"."cycle_key" GLOB '[a-z]*-[0-9][0-9][0-9][0-9]*'),
	CONSTRAINT "cycles_verification_ck" CHECK("program_cycles"."verification_state" IN ('draft', 'verified', 'reverifying', 'unverified')),
	CONSTRAINT "cycles_pell_ck" CHECK("program_cycles"."pell_displacement" IN ('none', 'possible', 'yes', 'unknown')),
	CONSTRAINT "cycles_prediction_label_ck" CHECK("program_cycles"."prediction_label" IS NULL OR "program_cycles"."prediction_label" IN ('low', 'medium', 'high')),
	CONSTRAINT "cycles_verified_ck" CHECK("program_cycles"."verification_state" IN ('draft', 'unverified') OR ("program_cycles"."last_verified_at" IS NOT NULL AND "program_cycles"."verified_by" IS NOT NULL)),
	CONSTRAINT "cycles_money_ck" CHECK(coalesce("program_cycles"."application_fee_cents", 0) >= 0 AND coalesce("program_cycles"."participant_cost_cents", 0) >= 0),
	CONSTRAINT "cycles_compensation_ck" CHECK("program_cycles"."compensation" IS NULL OR (json_valid("program_cycles"."compensation") AND json_type("program_cycles"."compensation") = 'object')),
	CONSTRAINT "cycles_class_years_ck" CHECK("program_cycles"."class_years" IS NULL OR (json_valid("program_cycles"."class_years") AND json_type("program_cycles"."class_years") = 'array'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `cycles_key_uq` ON `program_cycles` (`program_id`,`cycle_key`);--> statement-breakpoint
CREATE INDEX `cycles_status_idx` ON `program_cycles` (`status`,`predicted_opens_on`);--> statement-breakpoint
CREATE INDEX `cycles_fresh_idx` ON `program_cycles` (`verification_state`,`last_verified_at`);--> statement-breakpoint
CREATE TABLE `program_fields` (
	`program_id` text NOT NULL,
	`cip_prefix` text NOT NULL,
	`relation` text DEFAULT 'core' NOT NULL,
	PRIMARY KEY(`program_id`, `cip_prefix`),
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_fields_relation_ck" CHECK("program_fields"."relation" IN ('core', 'related', 'borderline')),
	CONSTRAINT "program_fields_cip_ck" CHECK("program_fields"."cip_prefix" GLOB '[0-9][0-9]*')
);
--> statement-breakpoint
CREATE TABLE `program_interest_tags` (
	`program_id` text NOT NULL,
	`tag` text NOT NULL,
	PRIMARY KEY(`program_id`, `tag`),
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `program_interest_tags_tag_idx` ON `program_interest_tags` (`tag`);--> statement-breakpoint
CREATE TABLE `program_list_items` (
	`list_id` text NOT NULL,
	`program_id` text NOT NULL,
	`cycle_key` text,
	`note` text,
	`position` integer NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`list_id`, `program_id`),
	FOREIGN KEY (`list_id`) REFERENCES `program_lists`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_list_items_note_ck" CHECK("program_list_items"."note" IS NULL OR length("program_list_items"."note") <= 500)
);
--> statement-breakpoint
CREATE TABLE `program_lists` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text DEFAULT 'workspace' NOT NULL,
	`workspace_id` text,
	`title` text NOT NULL,
	`description` text,
	`visibility` text DEFAULT 'unlisted' NOT NULL,
	`slug` text,
	`token` text,
	`restricted` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`workspace_id`) REFERENCES `advisor_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_lists_owner_ck" CHECK("program_lists"."owner_kind" IN ('workspace', 'partner', 'novus')),
	CONSTRAINT "program_lists_visibility_ck" CHECK("program_lists"."visibility" IN ('public', 'unlisted')),
	CONSTRAINT "program_lists_owner_ws_ck" CHECK(("program_lists"."owner_kind" = 'workspace') = ("program_lists"."workspace_id" IS NOT NULL)),
	CONSTRAINT "program_lists_public_ck" CHECK("program_lists"."visibility" <> 'public' OR "program_lists"."slug" IS NOT NULL),
	CONSTRAINT "program_lists_unlisted_ck" CHECK("program_lists"."visibility" <> 'unlisted' OR "program_lists"."token" IS NOT NULL)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `program_lists_slug_unique` ON `program_lists` (`slug`);--> statement-breakpoint
CREATE UNIQUE INDEX `program_lists_token_unique` ON `program_lists` (`token`);--> statement-breakpoint
CREATE INDEX `program_lists_ws_idx` ON `program_lists` (`workspace_id`);--> statement-breakpoint
CREATE TABLE `program_major_families` (
	`program_id` text NOT NULL,
	`major_family` text NOT NULL,
	PRIMARY KEY(`program_id`, `major_family`),
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "program_major_families_ck" CHECK("program_major_families"."major_family" IN ('agriculture_environment', 'arts_design', 'business', 'communication_media', 'computing', 'education', 'engineering_technology', 'health', 'humanities_languages', 'life_sciences', 'math_statistics', 'physical_sciences', 'social_sciences', 'law_policy_service', 'trades_applied', 'undeclared'))
);
--> statement-breakpoint
CREATE TABLE `program_types` (
	`program_id` text NOT NULL,
	`type_slug` text NOT NULL,
	`is_primary` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`program_id`, `type_slug`),
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`type_slug`) REFERENCES `opportunity_types`(`slug`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `program_types_type_idx` ON `program_types` (`type_slug`);--> statement-breakpoint
CREATE TABLE `programs` (
	`id` text PRIMARY KEY NOT NULL,
	`slug` text NOT NULL,
	`name` text NOT NULL,
	`organization_id` text NOT NULL,
	`summary` text,
	`official_url` text NOT NULL,
	`recurrence` text NOT NULL,
	`lifecycle` text DEFAULT 'active' NOT NULL,
	`sensitive_audience` integer DEFAULT false NOT NULL,
	`identity_audience` text DEFAULT '[]' NOT NULL,
	`campus_lead_days` integer,
	`campus_lead_median_days` integer,
	`campus_lead_n` integer,
	`is_wedge` integer DEFAULT false NOT NULL,
	`is_published` integer DEFAULT false NOT NULL,
	`is_sample` integer DEFAULT false NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`lifecycle`) REFERENCES `lifecycles`(`code`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "programs_recurrence_ck" CHECK("programs"."recurrence" IN ('annual', 'biannual', 'rolling', 'one_time', 'irregular')),
	CONSTRAINT "programs_identity_audience_ck" CHECK("programs"."identity_audience" IS NULL OR (json_valid("programs"."identity_audience") AND json_type("programs"."identity_audience") = 'array'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `programs_slug_unique` ON `programs` (`slug`);--> statement-breakpoint
CREATE INDEX `programs_org_idx` ON `programs` (`organization_id`);--> statement-breakpoint
CREATE INDEX `programs_published_idx` ON `programs` (`is_published`,`lifecycle`);--> statement-breakpoint
CREATE TABLE `publish_guards` (
	`task_id` text PRIMARY KEY NOT NULL,
	`ok` integer NOT NULL,
	`applied_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rate_limits` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`count` integer NOT NULL,
	`last_request` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rate_limits_key_unique` ON `rate_limits` (`key`);--> statement-breakpoint
CREATE TABLE `registry_audit` (
	`id` text PRIMARY KEY NOT NULL,
	`at` integer NOT NULL,
	`actor_kind` text NOT NULL,
	`actor_ref` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`field` text NOT NULL,
	`before_value` text,
	`after_value` text,
	`task_id` text,
	`snapshot_ids` text DEFAULT '[]' NOT NULL,
	CONSTRAINT "registry_audit_actor_ck" CHECK("registry_audit"."actor_kind" IN ('user', 'curator', 'system', 'pipeline', 'admin')),
	CONSTRAINT "registry_audit_entity_ck" CHECK("registry_audit"."entity_type" IN ('program', 'program_cycle', 'deadline', 'requirement', 'eligibility_rule_set', 'program_cycle_count', 'institution_participation', 'organization', 'official_domain')),
	CONSTRAINT "registry_audit_before_ck" CHECK("registry_audit"."before_value" IS NULL OR json_valid("registry_audit"."before_value")),
	CONSTRAINT "registry_audit_after_ck" CHECK("registry_audit"."after_value" IS NULL OR json_valid("registry_audit"."after_value")),
	CONSTRAINT "registry_audit_snapshots_ck" CHECK("registry_audit"."snapshot_ids" IS NULL OR (json_valid("registry_audit"."snapshot_ids") AND json_type("registry_audit"."snapshot_ids") = 'array'))
);
--> statement-breakpoint
CREATE INDEX `registry_audit_entity_idx` ON `registry_audit` (`entity_type`,`entity_id`,`at`);--> statement-breakpoint
CREATE TABLE `registry_releases` (
	`number` integer PRIMARY KEY NOT NULL,
	`state` text DEFAULT 'pending' NOT NULL,
	`client_core_key` text,
	`size_bytes` integer,
	`sha256` text,
	`contains_sample` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`built_at` integer,
	`published_at` integer,
	CONSTRAINT "registry_releases_state_ck" CHECK("registry_releases"."state" IN ('pending', 'built', 'published', 'failed'))
);
--> statement-breakpoint
CREATE TABLE `reports` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`field` text NOT NULL,
	`note` text DEFAULT '' NOT NULL,
	`reporter_user_id` text,
	`task_id` text,
	`created_at` integer NOT NULL,
	`resolved_at` integer,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reporter_user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `review_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reports_field_ck" CHECK("reports"."field" IN ('deadline', 'eligibility', 'status', 'link', 'requirements', 'other')),
	CONSTRAINT "reports_note_ck" CHECK(length("reports"."note") <= 280)
);
--> statement-breakpoint
CREATE INDEX `reports_cycle_idx` ON `reports` (`program_cycle_id`);--> statement-breakpoint
CREATE TABLE `requirement_progress` (
	`user_id` text NOT NULL,
	`subject_key` text NOT NULL,
	`program_cycle_id` text,
	`state` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `subject_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirement_progress_state_ck" CHECK("requirement_progress"."state" IN ('in_progress', 'met', 'not_applicable')),
	CONSTRAINT "requirement_progress_key_ck" CHECK("requirement_progress"."subject_key" GLOB 'req:*' OR "requirement_progress"."subject_key" GLOB 'kind:*')
);
--> statement-breakpoint
CREATE TABLE `requirements` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`detail` text,
	`quantity` integer DEFAULT 1 NOT NULL,
	`word_limit` integer,
	`deadline_id` text,
	`effort_hours` real,
	`lead_time_days` integer,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`verification_state` text DEFAULT 'draft' NOT NULL,
	`withdrawn_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deadline_id`) REFERENCES `deadlines`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "requirements_kind_ck" CHECK("requirements"."kind" IN ('recommendation', 'essay', 'campus_nomination', 'test_score', 'portfolio', 'resume', 'transcript', 'interview', 'fee', 'coursework', 'gpa_floor', 'other')),
	CONSTRAINT "requirements_verification_ck" CHECK("requirements"."verification_state" IN ('draft', 'verified', 'reverifying', 'unverified')),
	CONSTRAINT "requirements_quantity_ck" CHECK("requirements"."quantity" BETWEEN 1 AND 20)
);
--> statement-breakpoint
CREATE INDEX `requirements_cycle_idx` ON `requirements` (`program_cycle_id`);--> statement-breakpoint
CREATE TABLE `review_task_kinds` (
	`code` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `review_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`subject_type` text NOT NULL,
	`subject_id` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`reason_codes` text DEFAULT '[]' NOT NULL,
	`evidence_ids` text DEFAULT '[]' NOT NULL,
	`priority` integer DEFAULT 5 NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`due_at` integer,
	`claimed_by` text,
	`claim_expires_at` integer,
	`payload` text DEFAULT '{}' NOT NULL,
	`resolution` text,
	`active_seconds` integer DEFAULT 0 NOT NULL,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`kind`) REFERENCES `review_task_kinds`(`code`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`claimed_by`) REFERENCES `curators`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "review_tasks_state_ck" CHECK("review_tasks"."state" IN ('open', 'claimed', 'second_review', 'approved', 'applied', 'apply_failed', 'rejected', 'snoozed', 'escalated')),
	CONSTRAINT "review_tasks_subject_ck" CHECK("review_tasks"."subject_type" IN ('program', 'program_cycle', 'deadline', 'requirement', 'eligibility_rule_set', 'program_cycle_count', 'institution_participation', 'organization', 'official_domain')),
	CONSTRAINT "review_tasks_priority_ck" CHECK("review_tasks"."priority" BETWEEN 0 AND 9),
	CONSTRAINT "review_tasks_reasons_ck" CHECK("review_tasks"."reason_codes" IS NULL OR (json_valid("review_tasks"."reason_codes") AND json_type("review_tasks"."reason_codes") = 'array')),
	CONSTRAINT "review_tasks_evidence_ck" CHECK("review_tasks"."evidence_ids" IS NULL OR (json_valid("review_tasks"."evidence_ids") AND json_type("review_tasks"."evidence_ids") = 'array')),
	CONSTRAINT "review_tasks_payload_ck" CHECK("review_tasks"."payload" IS NULL OR (json_valid("review_tasks"."payload") AND json_type("review_tasks"."payload") = 'object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `review_tasks_live_uq` ON `review_tasks` (`dedupe_key`) WHERE "review_tasks"."state" IN ('open', 'claimed', 'second_review', 'snoozed');--> statement-breakpoint
CREATE INDEX `review_tasks_queue_idx` ON `review_tasks` (`state`,`priority`,`due_at`);--> statement-breakpoint
CREATE INDEX `review_tasks_subject_idx` ON `review_tasks` (`subject_type`,`subject_id`);--> statement-breakpoint
CREATE TABLE `roadmap_items` (
	`user_id` text NOT NULL,
	`item_key` text NOT NULL,
	`program_id` text,
	`pinned` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'open' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	PRIMARY KEY(`user_id`, `item_key`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "roadmap_items_state_ck" CHECK("roadmap_items"."state" IN ('open', 'done', 'dismissed'))
);
--> statement-breakpoint
CREATE TABLE `roadmap_templates` (
	`key` text PRIMARY KEY NOT NULL,
	`path` text NOT NULL,
	`body` text NOT NULL,
	`is_sample` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "roadmap_templates_path_ck" CHECK("roadmap_templates"."path" IN ('four_year', 'two_year_transfer', 'two_year_career')),
	CONSTRAINT "roadmap_templates_body_ck" CHECK("roadmap_templates"."body" IS NULL OR (json_valid("roadmap_templates"."body") AND json_type("roadmap_templates"."body") = 'object'))
);
--> statement-breakpoint
CREATE TABLE `roadmaps` (
	`user_id` text PRIMARY KEY NOT NULL,
	`template_key` text,
	`last_shown_item_keys` text DEFAULT '[]' NOT NULL,
	`last_visit_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`template_key`) REFERENCES `roadmap_templates`(`key`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "roadmaps_keys_ck" CHECK("roadmaps"."last_shown_item_keys" IS NULL OR (json_valid("roadmaps"."last_shown_item_keys") AND json_type("roadmaps"."last_shown_item_keys") = 'array'))
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`expires_at` integer NOT NULL,
	`token` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`ip_address` text,
	`user_agent` text,
	`user_id` text NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_token_unique` ON `sessions` (`token`);--> statement-breakpoint
CREATE INDEX `sessions_user_idx` ON `sessions` (`user_id`);--> statement-breakpoint
CREATE INDEX `sessions_expires_idx` ON `sessions` (`expires_at`);--> statement-breakpoint
CREATE TABLE `short_links` (
	`slug` text PRIMARY KEY NOT NULL,
	`target_path` text NOT NULL,
	`campaign_id` text,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `slug_redirects` (
	`from_slug` text PRIMARY KEY NOT NULL,
	`to_program_id` text NOT NULL,
	`reason` text DEFAULT 'rename' NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`to_program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`fetched_at` integer NOT NULL,
	`requested_url` text NOT NULL,
	`final_url` text NOT NULL,
	`redirect_chain` text DEFAULT '[]' NOT NULL,
	`http_status` integer NOT NULL,
	`content_type` text NOT NULL,
	`raw_sha256` text NOT NULL,
	`main_text_sha256` text,
	`normalizer_version` text NOT NULL,
	`raw_key` text NOT NULL,
	`text_key` text,
	`change_class` text,
	`host_policy` text NOT NULL,
	`ai_input_allowed` integer DEFAULT true NOT NULL,
	`delete_after` integer,
	`legal_hold` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "snapshots_change_ck" CHECK("snapshots"."change_class" IS NULL OR "snapshots"."change_class" IN ('none', 'cosmetic', 'minor', 'key')),
	CONSTRAINT "snapshots_policy_ck" CHECK("snapshots"."host_policy" IN ('allowed', 'api_only', 'manual_only', 'link_only', 'never')),
	CONSTRAINT "snapshots_redirects_ck" CHECK("snapshots"."redirect_chain" IS NULL OR (json_valid("snapshots"."redirect_chain") AND json_type("snapshots"."redirect_chain") = 'array')),
	CONSTRAINT "snapshots_status_ck" CHECK("snapshots"."http_status" BETWEEN 100 AND 599)
);
--> statement-breakpoint
CREATE INDEX `snapshots_source_idx` ON `snapshots` (`source_id`,`fetched_at`);--> statement-breakpoint
CREATE INDEX `snapshots_raw_idx` ON `snapshots` (`raw_sha256`);--> statement-breakpoint
CREATE INDEX `snapshots_text_idx` ON `snapshots` (`main_text_sha256`);--> statement-breakpoint
CREATE TABLE `source_hosts` (
	`host` text PRIMARY KEY NOT NULL,
	`policy` text NOT NULL,
	`policy_source` text DEFAULT 'default' NOT NULL,
	`min_interval_ms` integer DEFAULT 2000 NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT "source_hosts_policy_ck" CHECK("source_hosts"."policy" IN ('allowed', 'api_only', 'manual_only', 'link_only', 'never')),
	CONSTRAINT "source_hosts_policy_source_ck" CHECK("source_hosts"."policy_source" IN ('seed', 'default', 'curator')),
	CONSTRAINT "source_hosts_interval_ck" CHECK("source_hosts"."min_interval_ms" >= 1000)
);
--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`url` text NOT NULL,
	`host` text NOT NULL,
	`render_mode` text DEFAULT 'static' NOT NULL,
	`program_id` text,
	`organization_id` text,
	`approval` text DEFAULT 'pending_approval' NOT NULL,
	`health` text DEFAULT 'ok' NOT NULL,
	`baseline_snapshot_id` text,
	`next_check_at` integer,
	`last_fetched_at` integer,
	`opted_out_on` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`host`) REFERENCES `source_hosts`(`host`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sources_kind_ck" CHECK("sources"."kind" IN ('official_page', 'official_pdf', 'federal_api', 'ats_board', 'list_row', 'campus_page', 'hint', 'licensed')),
	CONSTRAINT "sources_render_ck" CHECK("sources"."render_mode" IN ('static', 'javascript', 'pdf', 'api', 'manual')),
	CONSTRAINT "sources_approval_ck" CHECK("sources"."approval" IN ('approved', 'pending_approval', 'rejected')),
	CONSTRAINT "sources_health_ck" CHECK("sources"."health" IN ('ok', 'degraded', 'broken', 'blocked', 'opted_out'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sources_url_unique` ON `sources` (`url`);--> statement-breakpoint
CREATE INDEX `sources_due_idx` ON `sources` (`next_check_at`) WHERE "sources"."next_check_at" IS NOT NULL;--> statement-breakpoint
CREATE INDEX `sources_program_idx` ON `sources` (`program_id`);--> statement-breakpoint
CREATE TABLE `student_profiles` (
	`user_id` text PRIMARY KEY NOT NULL,
	`class_year` text,
	`expected_graduation_term` text,
	`institution_id` text,
	`institution_level` text,
	`enrollment_intensity` text,
	`transfer_intent` text,
	`major_cip` text,
	`minor_cip` text,
	`major_family` text,
	`gpa_band` text,
	`residence_state` text,
	`time_zone` text,
	`birth_year_month` text,
	`interest_tags` text DEFAULT '[]' NOT NULL,
	`preferred_opportunity_types` text DEFAULT '[]' NOT NULL,
	`prior_experience` text DEFAULT '[]' NOT NULL,
	`weekly_prep_hours` integer,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`institution_id`) REFERENCES `institutions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "profiles_class_year_ck" CHECK("student_profiles"."class_year" IS NULL OR "student_profiles"."class_year" IN ('incoming_first_year', 'first_year', 'second_year', 'third_year', 'fourth_year', 'fifth_year_plus', 'recent_graduate', 'graduate')),
	CONSTRAINT "profiles_level_ck" CHECK("student_profiles"."institution_level" IS NULL OR "student_profiles"."institution_level" IN ('two_year', 'four_year', 'other')),
	CONSTRAINT "profiles_intensity_ck" CHECK("student_profiles"."enrollment_intensity" IS NULL OR "student_profiles"."enrollment_intensity" IN ('full_time', 'part_time', 'not_sure')),
	CONSTRAINT "profiles_transfer_ck" CHECK("student_profiles"."transfer_intent" IS NULL OR "student_profiles"."transfer_intent" IN ('planning_to_transfer', 'transferred_in', 'not_planning', 'not_sure')),
	CONSTRAINT "profiles_major_family_ck" CHECK("student_profiles"."major_family" IS NULL OR "student_profiles"."major_family" IN ('agriculture_environment', 'arts_design', 'business', 'communication_media', 'computing', 'education', 'engineering_technology', 'health', 'humanities_languages', 'life_sciences', 'math_statistics', 'physical_sciences', 'social_sciences', 'law_policy_service', 'trades_applied', 'undeclared')),
	CONSTRAINT "profiles_gpa_band_ck" CHECK("student_profiles"."gpa_band" IS NULL OR "student_profiles"."gpa_band" IN ('none_yet', 'under_2_0', '2_0_to_2_49', '2_5_to_2_74', '2_75_to_2_99', '3_0_to_3_24', '3_25_to_3_49', '3_5_to_3_74', '3_75_plus', 'prefer_not')),
	CONSTRAINT "profiles_state_ck" CHECK("student_profiles"."residence_state" IS NULL OR "student_profiles"."residence_state" IN ('AL', 'AK', 'AZ', 'AR', 'CA', 'CO', 'CT', 'DE', 'DC', 'FL', 'GA', 'HI', 'ID', 'IL', 'IN', 'IA', 'KS', 'KY', 'LA', 'ME', 'MD', 'MA', 'MI', 'MN', 'MS', 'MO', 'MT', 'NE', 'NV', 'NH', 'NJ', 'NM', 'NY', 'NC', 'ND', 'OH', 'OK', 'OR', 'PA', 'RI', 'SC', 'SD', 'TN', 'TX', 'UT', 'VT', 'VA', 'WA', 'WV', 'WI', 'WY', 'AS', 'GU', 'MP', 'PR', 'VI', 'UM')),
	CONSTRAINT "profiles_birth_ck" CHECK("student_profiles"."birth_year_month" IS NULL OR "student_profiles"."birth_year_month" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]'),
	CONSTRAINT "profiles_hours_ck" CHECK("student_profiles"."weekly_prep_hours" IS NULL OR "student_profiles"."weekly_prep_hours" BETWEEN 0 AND 60),
	CONSTRAINT "profiles_tags_ck" CHECK("student_profiles"."interest_tags" IS NULL OR (json_valid("student_profiles"."interest_tags") AND json_type("student_profiles"."interest_tags") = 'array')),
	CONSTRAINT "profiles_types_ck" CHECK("student_profiles"."preferred_opportunity_types" IS NULL OR (json_valid("student_profiles"."preferred_opportunity_types") AND json_type("student_profiles"."preferred_opportunity_types") = 'array')),
	CONSTRAINT "profiles_experience_ck" CHECK("student_profiles"."prior_experience" IS NULL OR (json_valid("student_profiles"."prior_experience") AND json_type("student_profiles"."prior_experience") = 'array'))
);
--> statement-breakpoint
CREATE TABLE `subscriptions` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text,
	`contact_id` text,
	`kind` text NOT NULL,
	`program_cycle_id` text,
	`name_in_messages` integer DEFAULT true NOT NULL,
	`delete_after` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`contact_id`) REFERENCES `contacts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "subscriptions_subject_ck" CHECK(("subscriptions"."user_id" IS NULL) <> ("subscriptions"."contact_id" IS NULL)),
	CONSTRAINT "subscriptions_kind_ck" CHECK("subscriptions"."kind" IN ('remind_me', 'tracked_cycle', 'saved_filter', 'weekly_digest'))
);
--> statement-breakpoint
CREATE INDEX `subscriptions_user_idx` ON `subscriptions` (`user_id`);--> statement-breakpoint
CREATE INDEX `subscriptions_cycle_idx` ON `subscriptions` (`program_cycle_id`);--> statement-breakpoint
CREATE TABLE `tracker_items` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`program_cycle_id` text NOT NULL,
	`status` text DEFAULT 'interested' NOT NULL,
	`status_source` text DEFAULT 'student' NOT NULL,
	`own_campus_deadline` text,
	`submitted_on` text,
	`name_in_messages` integer DEFAULT true NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "tracker_items_status_ck" CHECK("tracker_items"."status" IN ('interested', 'applying', 'submitted', 'decided', 'not_applying')),
	CONSTRAINT "tracker_items_source_ck" CHECK("tracker_items"."status_source" IN ('student', 'email_action', 'system'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tracker_items_user_cycle_uq` ON `tracker_items` (`user_id`,`program_cycle_id`);--> statement-breakpoint
CREATE INDEX `tracker_items_cycle_idx` ON `tracker_items` (`program_cycle_id`) WHERE "tracker_items"."deleted_at" IS NULL;--> statement-breakpoint
CREATE TABLE `user_roles` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`role` text NOT NULL,
	`workspace_id` text,
	`organization_id` text,
	`granted_by` text,
	`created_at` integer NOT NULL,
	`revoked_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workspace_id`) REFERENCES `advisor_workspaces`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`organization_id`) REFERENCES `organizations`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "user_roles_role_ck" CHECK("user_roles"."role" IN ('student', 'advisor', 'sponsor_admin', 'curator', 'moderator', 'admin'))
);
--> statement-breakpoint
CREATE INDEX `user_roles_user_idx` ON `user_roles` (`user_id`);--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text DEFAULT '' NOT NULL,
	`email` text NOT NULL,
	`email_verified` integer DEFAULT false NOT NULL,
	`image` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`public_id` text NOT NULL,
	`trust_level` integer DEFAULT 0 NOT NULL,
	`analytics_off_at` integer,
	`last_active_at` integer,
	`onboarded_at` integer,
	`deleted_at` integer
);
--> statement-breakpoint
CREATE UNIQUE INDEX `users_email_unique` ON `users` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `users_public_id_unique` ON `users` (`public_id`);--> statement-breakpoint
CREATE INDEX `users_deleted_idx` ON `users` (`deleted_at`) WHERE "users"."deleted_at" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `verifications` (
	`id` text PRIMARY KEY NOT NULL,
	`identifier` text NOT NULL,
	`value` text NOT NULL,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `verifications_identifier_idx` ON `verifications` (`identifier`);--> statement-breakpoint
CREATE INDEX `verifications_expires_idx` ON `verifications` (`expires_at`);