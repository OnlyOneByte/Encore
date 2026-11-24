CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `person_devices` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`token_hash` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_devices_token_idx` ON `person_devices` (`token_hash`);--> statement-breakpoint
CREATE INDEX `person_devices_person_idx` ON `person_devices` (`person_id`);--> statement-breakpoint
ALTER TABLE `singers` ADD `person_id` text;--> statement-breakpoint
CREATE INDEX `singers_person_idx` ON `singers` (`person_id`);