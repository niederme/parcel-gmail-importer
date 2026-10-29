CREATE TABLE `summary_refresh` (
	`id` integer PRIMARY KEY NOT NULL,
	`failures` integer NOT NULL,
	`retry_at` integer,
	`last_error` text,
	`last_attempt_at` integer
);
