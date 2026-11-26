CREATE TABLE `held_completions` (
	`job_id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`message` text NOT NULL,
	`held_at` integer NOT NULL
);
