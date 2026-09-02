CREATE TABLE `media_tags` (
	`media_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_tags_kind_value_idx` ON `media_tags` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `media_tags_media_idx` ON `media_tags` (`media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_tags_unique_idx` ON `media_tags` (`media_id`,`kind`,`value`);--> statement-breakpoint
ALTER TABLE `media` ADD `artist_canonical` text;--> statement-breakpoint
ALTER TABLE `media` ADD `album` text;--> statement-breakpoint
ALTER TABLE `media` ADD `year` integer;