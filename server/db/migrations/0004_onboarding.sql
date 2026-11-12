CREATE TABLE `onboarding_records` (
	`user_id` text PRIMARY KEY NOT NULL,
	`preferences` text,
	`signals` text,
	`step` text,
	`completed_at` integer,
	`first_door` text,
	`version` integer DEFAULT 1 NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`deleted_at` integer,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "onboarding_records_step_ck" CHECK("onboarding_records"."step" IS NULL OR (length("onboarding_records"."step") BETWEEN 1 AND 40)),
	CONSTRAINT "onboarding_records_preferences_ck" CHECK("onboarding_records"."preferences" IS NULL OR json_type("onboarding_records"."preferences") = 'object'),
	CONSTRAINT "onboarding_records_signals_ck" CHECK("onboarding_records"."signals" IS NULL OR json_type("onboarding_records"."signals") = 'object'),
	CONSTRAINT "onboarding_records_first_door_ck" CHECK("onboarding_records"."first_door" IS NULL OR json_type("onboarding_records"."first_door") = 'object')
);
--> statement-breakpoint
CREATE TABLE `reminders` (
	`id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`reminder_key` text NOT NULL,
	`tracker_item_id` text NOT NULL,
	`kind` text NOT NULL,
	`step_id` text NOT NULL,
	`send_on` text NOT NULL,
	`send_at` text NOT NULL,
	`time_zone` text NOT NULL,
	`neutral` integer DEFAULT false NOT NULL,
	`state` text DEFAULT 'scheduled' NOT NULL,
	`sent_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`tracker_item_id`) REFERENCES `tracker_items`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "reminders_kind_ck" CHECK("reminders"."kind" IN ('step_due', 'intention', 'submit_buffer')),
	CONSTRAINT "reminders_state_ck" CHECK("reminders"."state" IN ('scheduled', 'sent', 'cancelled')),
	CONSTRAINT "reminders_send_on_ck" CHECK("reminders"."send_on" GLOB '[0-9][0-9][0-9][0-9]-[0-1][0-9]-[0-3][0-9]'),
	CONSTRAINT "reminders_send_at_ck" CHECK("reminders"."send_at" GLOB '[0-2][0-9]:[0-5][0-9]')
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reminders_user_key_uq` ON `reminders` (`user_id`,`reminder_key`);--> statement-breakpoint
CREATE INDEX `reminders_due_idx` ON `reminders` (`state`,`send_on`);--> statement-breakpoint
CREATE INDEX `reminders_tracker_idx` ON `reminders` (`tracker_item_id`);