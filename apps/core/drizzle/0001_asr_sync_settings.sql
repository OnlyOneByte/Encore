ALTER TABLE `global_settings` ADD `asr_model` text DEFAULT 'base' NOT NULL;--> statement-breakpoint
ALTER TABLE `global_settings` ADD `sync_mode` text DEFAULT 'forced' NOT NULL;