CREATE TABLE `band_models` (
	`id` text PRIMARY KEY NOT NULL,
	`model_key` text NOT NULL,
	`program_id` text NOT NULL,
	`opportunity_type` text NOT NULL,
	`from_stage` text NOT NULL,
	`to_stage` text NOT NULL,
	`model_version` text NOT NULL,
	`algo` text NOT NULL,
	`fitted_on` text NOT NULL,
	`gate_pooled` integer DEFAULT false NOT NULL,
	`gate_held_out` text NOT NULL,
	`gate_representativeness` integer DEFAULT false NOT NULL,
	`gate_fairness` integer DEFAULT false NOT NULL,
	`gate_usefulness` integer DEFAULT false NOT NULL,
	`gate_approved` integer DEFAULT false NOT NULL,
	`program_eligible` integer DEFAULT false NOT NULL,
	`n_eff` real NOT NULL,
	`pass_reports` integer NOT NULL,
	`fail_reports` integer NOT NULL,
	`model` text NOT NULL,
	`created_at` integer NOT NULL,
	`superseded_at` integer,
	FOREIGN KEY (`program_id`) REFERENCES `programs`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "band_models_from_ck" CHECK("band_models"."from_stage" IN ('campus_applicants', 'applicants', 'nominees', 'finalists', 'awards', 'alternates')),
	CONSTRAINT "band_models_to_ck" CHECK("band_models"."to_stage" IN ('campus_applicants', 'applicants', 'nominees', 'finalists', 'awards', 'alternates')),
	CONSTRAINT "band_models_held_out_ck" CHECK("band_models"."gate_held_out" IN ('pass', 'fail_skill', 'fail_calibration', 'not_evaluated')),
	CONSTRAINT "band_models_counts_ck" CHECK("band_models"."n_eff" >= 0 AND "band_models"."pass_reports" >= 0 AND "band_models"."fail_reports" >= 0),
	CONSTRAINT "band_models_fitted_ck" CHECK("band_models"."fitted_on" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "band_models_model_ck" CHECK("band_models"."model" IS NULL OR (json_valid("band_models"."model") AND json_type("band_models"."model") = 'object'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `band_models_live_uq` ON `band_models` (`model_key`,`program_id`) WHERE "band_models"."superseded_at" IS NULL;--> statement-breakpoint
CREATE INDEX `band_models_program_idx` ON `band_models` (`program_id`) WHERE "band_models"."superseded_at" IS NULL;--> statement-breakpoint
CREATE TABLE `outcome_cycle_holds` (
	`id` text PRIMARY KEY NOT NULL,
	`program_cycle_id` text NOT NULL,
	`reason` text NOT NULL,
	`review_task_id` text,
	`frozen_at` integer NOT NULL,
	`released_at` integer,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`program_cycle_id`) REFERENCES `program_cycles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`review_task_id`) REFERENCES `review_tasks`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "outcome_cycle_holds_reason_ck" CHECK("outcome_cycle_holds"."reason" IN ('over_count', 'curator')),
	CONSTRAINT "outcome_cycle_holds_order_ck" CHECK("outcome_cycle_holds"."released_at" IS NULL OR "outcome_cycle_holds"."released_at" >= "outcome_cycle_holds"."frozen_at")
);
--> statement-breakpoint
CREATE UNIQUE INDEX `outcome_cycle_holds_live_uq` ON `outcome_cycle_holds` (`program_cycle_id`,`reason`) WHERE "outcome_cycle_holds"."released_at" IS NULL;--> statement-breakpoint
CREATE INDEX `outcome_cycle_holds_cycle_idx` ON `outcome_cycle_holds` (`program_cycle_id`);