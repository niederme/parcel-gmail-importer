CREATE TABLE `parcel_cache` (
	`pair` text PRIMARY KEY NOT NULL,
	`description_hash` text
);
--> statement-breakpoint
CREATE TABLE `control` (
	`id` integer PRIMARY KEY NOT NULL,
	`token` text,
	`locked_at` integer,
	`cache_at` integer,
	`migration_digest` text,
	`migration_at` integer,
	`verified_at` integer
);
--> statement-breakpoint
CREATE TABLE `ledger` (
	`pair` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`description_hash` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_ledger_status` ON `ledger` (`status`);--> statement-breakpoint
CREATE TABLE `quota` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `idx_quota_kind_at` ON `quota` (`kind`,`at`);