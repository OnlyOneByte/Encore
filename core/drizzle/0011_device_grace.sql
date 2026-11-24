ALTER TABLE `person_devices` ADD `prev_token_hash` text;--> statement-breakpoint
ALTER TABLE `person_devices` ADD `prev_valid_until` integer;--> statement-breakpoint
ALTER TABLE `person_devices` ADD `rotation_salt` text;