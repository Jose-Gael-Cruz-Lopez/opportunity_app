CREATE TABLE `ai_spend_monthly` (
	`month` text NOT NULL,
	`route` text NOT NULL,
	`model` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`input_tokens` integer DEFAULT 0 NOT NULL,
	`output_tokens` integer DEFAULT 0 NOT NULL,
	`thought_tokens` integer DEFAULT 0 NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_micros` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`month`, `route`, `model`)
);
--> statement-breakpoint
CREATE TABLE `ai_user_daily` (
	`day` text NOT NULL,
	`user_key` text NOT NULL,
	`route` text NOT NULL,
	`requests` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`day`, `user_key`, `route`)
);
