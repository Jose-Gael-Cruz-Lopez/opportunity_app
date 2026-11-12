CREATE TABLE `client_error_daily` (
	`day` text NOT NULL,
	`kind` text NOT NULL,
	`surface` text NOT NULL,
	`error_class` text NOT NULL,
	`route` text NOT NULL,
	`release` text NOT NULL,
	`browser` text NOT NULL,
	`file` text DEFAULT '' NOT NULL,
	`line` integer DEFAULT 0 NOT NULL,
	`n` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `kind`, `surface`, `error_class`, `route`, `release`, `browser`, `file`, `line`),
	CONSTRAINT "client_error_daily_day_ck" CHECK("client_error_daily"."day" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
	CONSTRAINT "client_error_daily_kind_ck" CHECK("client_error_daily"."kind" IN ('error', 'unhandledrejection', 'boundary', 'island')),
	CONSTRAINT "client_error_daily_surface_ck" CHECK("client_error_daily"."surface" IN ('spa', 'island', 'console'))
);
--> statement-breakpoint
CREATE INDEX `client_error_daily_day_idx` ON `client_error_daily` (`day`);