CREATE TABLE `saved_songs` (
	`id` text PRIMARY KEY NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`source` text NOT NULL,
	`source_ref` text NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`saved_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `saved_songs_owner_song_idx` ON `saved_songs` (`owner_kind`,`owner_id`,`source`,`source_ref`);