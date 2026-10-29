CREATE TABLE `brief_labels` (
	`pair` text PRIMARY KEY NOT NULL,
	`description_hash` text NOT NULL,
	`company` text NOT NULL,
	`item` text,
	`attested_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `parcel_cache` ADD `status_code` integer;
--> statement-breakpoint
ALTER TABLE `parcel_cache` ADD `is_active` integer;
