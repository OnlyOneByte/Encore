ALTER TABLE `queue_entries` ADD `key_shift` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `queue_entries` ADD `guide_level` real;--> statement-breakpoint
ALTER TABLE `queue_entries` ADD `deferred` integer DEFAULT false NOT NULL;