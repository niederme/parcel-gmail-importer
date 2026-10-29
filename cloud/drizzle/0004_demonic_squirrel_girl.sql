CREATE TABLE `discovery_audit` (
	`operation_id` text PRIMARY KEY NOT NULL,
	`run_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`revision` integer NOT NULL,
	`old_watermark` text,
	`new_watermark` text NOT NULL,
	`operation` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `discovery_progress` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer NOT NULL,
	`state_json` text NOT NULL,
	`operation_id` text NOT NULL,
	`updated_at` text NOT NULL
);
