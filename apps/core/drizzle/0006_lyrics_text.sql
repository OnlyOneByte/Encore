ALTER TABLE `room_settings` ADD `lyrics_scale_pct` integer DEFAULT 100 NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `lyrics_font` text DEFAULT 'system' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `lyrics_case` text DEFAULT 'natural' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `lyrics_lines_before` integer DEFAULT 2 NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `lyrics_lines_after` integer DEFAULT 2 NOT NULL;