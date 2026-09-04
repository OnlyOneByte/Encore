ALTER TABLE `playback_state` ADD `background` text;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `tv_background_style` text DEFAULT 'off' NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `tv_background_hue` integer DEFAULT 240 NOT NULL;