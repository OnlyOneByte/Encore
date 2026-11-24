CREATE TABLE `night_opt_outs` (
	`subject_id` text PRIMARY KEY NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `nights` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `nights_room_idx` ON `nights` (`room_id`,`ended_at`);--> statement-breakpoint
CREATE TABLE `performances` (
	`id` text PRIMARY KEY NOT NULL,
	`room_id` text NOT NULL,
	`night_id` text NOT NULL,
	`singer_id` text NOT NULL,
	`person_id` text,
	`media_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`started_at` integer NOT NULL,
	`ended_at` integer NOT NULL,
	`end` text NOT NULL,
	`key_shift` integer DEFAULT 0 NOT NULL,
	`key_changes` integer DEFAULT 0 NOT NULL,
	`guide_level` real,
	`cheers` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `performances_entry_idx` ON `performances` (`entry_id`);--> statement-breakpoint
CREATE INDEX `performances_singer_idx` ON `performances` (`singer_id`);--> statement-breakpoint
CREATE INDEX `performances_person_idx` ON `performances` (`person_id`);--> statement-breakpoint
CREATE INDEX `performances_night_idx` ON `performances` (`night_id`);--> statement-breakpoint
CREATE INDEX `performances_ended_idx` ON `performances` (`ended_at`);