CREATE TABLE `session_second_factors` (
	`session_id` text PRIMARY KEY NOT NULL,
	`user_id` text NOT NULL,
	`method` text NOT NULL,
	`verified_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "session_second_factors_method_ck" CHECK("session_second_factors"."method" IN ('totp', 'recovery_code'))
);
--> statement-breakpoint
CREATE INDEX `session_second_factors_user_idx` ON `session_second_factors` (`user_id`);--> statement-breakpoint
CREATE INDEX `session_second_factors_expires_idx` ON `session_second_factors` (`expires_at`);--> statement-breakpoint
CREATE TABLE `staff_second_factors` (
	`user_id` text PRIMARY KEY NOT NULL,
	`secret_enc` text NOT NULL,
	`confirmed_at` integer,
	`last_used_step` integer,
	`failed_count` integer DEFAULT 0 NOT NULL,
	`locked_until` integer,
	`recovery_code_hashes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "staff_second_factors_codes_ck" CHECK(json_valid("staff_second_factors"."recovery_code_hashes") AND json_type("staff_second_factors"."recovery_code_hashes") = 'array')
);
