-- SQUASHED BASELINE. This is not original history.
--
-- Fourteen incremental migrations (0000-0013) were collapsed into this one file while no production
-- deployment existed, so there was no database anywhere that needed the intermediate steps. Squashing
-- while that is true costs nothing and removes fourteen files' worth of read-path; squashing after a
-- deploy would strand it, because a live database's `__drizzle_migrations` records hashes that no
-- longer exist here.
--
-- SO: once this is deployed to a real box, STOP editing this file. Every schema change after that is a
-- new numbered migration, forever.
--
-- Equivalence with the old chain was verified when it was collapsed: databases built from each were
-- introspected and compared, and were identical across all tables.
--
-- Regenerated since, still pre-deploy, to add media.lyrics_status — the lyrics half of the cook gate
-- (see packages/shared/src/gates.ts). NULL on a row written before the gate existed, which the gate
-- reads as "done if a lyrics artifact is already present", so an existing library does not become
-- unsingable on upgrade.

CREATE TABLE `global_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`default_engine` text DEFAULT 'demucs' NOT NULL,
	`default_model` text DEFAULT 'htdemucs' NOT NULL,
	`enqueue_upgrade` integer DEFAULT false NOT NULL,
	`upgrade_engine` text DEFAULT 'roformer' NOT NULL,
	`upgrade_model` text DEFAULT 'bs-roformer-1297' NOT NULL,
	`default_fetcher` text DEFAULT 'ytdlp' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`job_type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`worker_id` text,
	`stage` text,
	`progress_pct` integer DEFAULT 0 NOT NULL,
	`eta_sec` integer,
	`error` text,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_live_media_type_idx` ON `jobs` (`media_id`,`job_type`) WHERE "jobs"."status" NOT IN ('failed', 'canceled');--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_ref` text NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`duration_sec` integer NOT NULL,
	`thumbnail` text,
	`lyrics_status` text,
	`stem_status` text DEFAULT 'none' NOT NULL,
	`instrumental_ref` text,
	`lyrics_ref` text,
	`lyrics_candidates` text,
	`pitch_ref` text,
	`artist_canonical` text,
	`title_canonical` text,
	`mbid` text,
	`annotation_source` text,
	`annotation_confidence` text,
	`album` text,
	`year` integer
);
--> statement-breakpoint
CREATE TABLE `media_tags` (
	`media_id` text NOT NULL,
	`kind` text NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `media_tags_kind_value_idx` ON `media_tags` (`kind`,`value`);--> statement-breakpoint
CREATE INDEX `media_tags_media_idx` ON `media_tags` (`media_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `media_tags_unique_idx` ON `media_tags` (`media_id`,`kind`,`value`);--> statement-breakpoint
CREATE TABLE `playback_state` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`current_entry_id` text,
	`position_sec` integer DEFAULT 0 NOT NULL,
	`is_playing` integer DEFAULT false NOT NULL,
	`key_shift` integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `queue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`singer_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`rotation_seq` integer NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `room_settings` (
	`room_id` text PRIMARY KEY NOT NULL,
	`tv_progress_style` text DEFAULT 'card' NOT NULL,
	`interstitial_ms` integer DEFAULT 2500 NOT NULL,
	`max_quality_rank` integer
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `singers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color` text NOT NULL,
	`session_token` text NOT NULL,
	`joined_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `singers_session_token_idx` ON `singers` (`session_token`);