ALTER TABLE `room_settings` ADD `lyrics_ball` text DEFAULT 'bounce' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `lyrics_highlight` text DEFAULT 'word' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `lyrics_lead_ms` integer DEFAULT 300 NOT NULL;