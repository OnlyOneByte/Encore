CREATE TABLE `job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`media_id` text NOT NULL,
	`cook_id` text NOT NULL,
	`job_type` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`worker_id` text,
	`enqueued_at` integer NOT NULL,
	`assigned_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`outcome` text,
	`error` text,
	`engine` text,
	`model` text,
	`backend` text,
	`device` text,
	`asr_model` text,
	`sync_mode` text,
	`audio_sec` integer
);
--> statement-breakpoint
CREATE INDEX `job_attempts_media_idx` ON `job_attempts` (`media_id`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `job_attempts_cook_idx` ON `job_attempts` (`cook_id`);--> statement-breakpoint
CREATE INDEX `job_attempts_job_idx` ON `job_attempts` (`job_id`);--> statement-breakpoint
CREATE INDEX `job_attempts_type_finished_idx` ON `job_attempts` (`job_type`,`finished_at`);--> statement-breakpoint
CREATE TABLE `plays` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plays_at_idx` ON `plays` (`at`);--> statement-breakpoint
CREATE INDEX `plays_media_idx` ON `plays` (`media_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `plays_entry_idx` ON `plays` (`entry_id`);--> statement-breakpoint
ALTER TABLE `jobs` ADD `cook_id` text DEFAULT '' NOT NULL;