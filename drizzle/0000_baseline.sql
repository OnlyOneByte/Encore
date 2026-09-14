-- SINGLE PRE-RELEASE BASELINE. Regenerated from src/lib/server/db/schema.ts; this is the whole schema
-- from an empty database in one migration, not incremental history.
--
-- COLLAPSED A SECOND TIME. The chain had grown back to thirteen files (0000 plus 0001..0012) as the
-- schema moved; owner ruling on this pass: there is still no production deployment and the dev box's
-- database is being recreated anyway, so the whole chain folds into this file again rather than being
-- maintained. The change that prompted it was dropping `media.guide_offset_ms` — a column whose
-- feature was deleted (both stems come out of one separation pass, so there was no offset to measure)
-- and which SQLite can only remove via the create-copy-drop-rename table rebuild. Folding it out of
-- the baseline is cheaper and leaves less to explain than a rebuild migration for a dead column.
--
-- Anyone still holding an OLDER dev database must delete it and let the library rebuild -- the meta/
-- sidecars are authoritative, and an old DB's __drizzle_migrations records hashes that no longer
-- exist in this folder, so it cannot be migrated forward from.
--
-- Once this ships to a real box, STOP editing this file: every schema change after that is a new
-- numbered migration that only ALTERs. The guard in tests/guards/hygiene/settings-repository.test.ts
-- enforces that, and it is the reason this header must survive any regeneration.

CREATE TABLE `global_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`default_engine` text DEFAULT 'demucs' NOT NULL,
	`default_model` text DEFAULT 'htdemucs' NOT NULL,
	`enqueue_upgrade` integer DEFAULT false NOT NULL,
	`upgrade_engine` text DEFAULT 'roformer' NOT NULL,
	`upgrade_model` text DEFAULT 'bs-roformer-1297' NOT NULL,
	`default_fetcher` text DEFAULT 'ytdlp' NOT NULL,
	`asr_model` text DEFAULT 'base' NOT NULL,
	`sync_mode` text DEFAULT 'forced' NOT NULL,
	`join_origin` text DEFAULT '' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `job_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`job_id` text NOT NULL,
	`media_id` text NOT NULL,
	`processing_id` text NOT NULL,
	`job_type` text NOT NULL,
	`attempt` integer DEFAULT 1 NOT NULL,
	`worker_id` text,
	`enqueued_at` integer NOT NULL,
	`assigned_at` integer,
	`started_at` integer,
	`finished_at` integer,
	`outcome` text,
	`error` text,
	`engine` text,
	`model` text,
	`backend` text,
	`device` text,
	`asr_model` text,
	`sync_mode` text,
	`audio_sec` integer,
	`stages` text,
	`selection` text
);
--> statement-breakpoint
CREATE INDEX `job_attempts_media_idx` ON `job_attempts` (`media_id`,`enqueued_at`);--> statement-breakpoint
CREATE INDEX `job_attempts_processing_idx` ON `job_attempts` (`processing_id`);--> statement-breakpoint
CREATE INDEX `job_attempts_job_idx` ON `job_attempts` (`job_id`);--> statement-breakpoint
CREATE INDEX `job_attempts_type_finished_idx` ON `job_attempts` (`job_type`,`finished_at`);--> statement-breakpoint
CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`processing_id` text DEFAULT '' NOT NULL,
	`singer_id` text,
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
	`view_count` integer,
	`lyrics_status` text,
	`stem_status` text DEFAULT 'none' NOT NULL,
	`instrumental_ref` text,
	`vocals_ref` text,
	`guide_mix_ref` text,
	`song_profile` text,
	`lyrics_ref` text,
	`lyrics_candidates` text,
	`lyrics_override_ref` text,
	`lyrics_override_text` text,
	`artist_canonical` text,
	`title_canonical` text,
	`artist_credit` text,
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
	`room_id` text PRIMARY KEY NOT NULL,
	`current_entry_id` text,
	`position_sec` integer DEFAULT 0 NOT NULL,
	`is_playing` integer DEFAULT false NOT NULL,
	`key_shift` integer DEFAULT 0 NOT NULL,
	`background` text,
	`guide_level` real
);
--> statement-breakpoint
CREATE TABLE `plays` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`entry_id` text NOT NULL,
	`at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `plays_at_idx` ON `plays` (`at`);--> statement-breakpoint
CREATE INDEX `plays_media_idx` ON `plays` (`media_id`,`at`);--> statement-breakpoint
CREATE UNIQUE INDEX `plays_entry_idx` ON `plays` (`entry_id`);--> statement-breakpoint
CREATE TABLE `queue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`singer_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`rotation_seq` integer NOT NULL,
	`added_at` integer NOT NULL,
	`room_id` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `queue_entries_room_idx` ON `queue_entries` (`room_id`);--> statement-breakpoint
CREATE TABLE `room_settings` (
	`room_id` text PRIMARY KEY NOT NULL,
	`queue_order` text DEFAULT 'fair' NOT NULL,
	`tv_progress_style` text DEFAULT 'card' NOT NULL,
	`tv_background_style` text DEFAULT 'off' NOT NULL,
	`tv_background_color` text DEFAULT '#001d31' NOT NULL,
	`tv_background_dim` real DEFAULT 0 NOT NULL,
	`tv_visualizer` text DEFAULT 'plasma' NOT NULL,
	`song_intro_enabled` integer DEFAULT true NOT NULL,
	`song_intro_ms` integer DEFAULT 2500 NOT NULL,
	`max_quality_rank` integer,
	`lyrics_ball` text DEFAULT 'off' NOT NULL,
	`lyrics_highlight` text DEFAULT 'word' NOT NULL,
	`lyrics_lead_ms` integer DEFAULT 300 NOT NULL,
	`lyrics_scale_pct` integer DEFAULT 100 NOT NULL,
	`lyrics_font` text DEFAULT 'system' NOT NULL,
	`lyrics_case` text DEFAULT 'natural' NOT NULL,
	`lyrics_lines_before` integer DEFAULT 2 NOT NULL,
	`lyrics_lines_after` integer DEFAULT 2 NOT NULL,
	`guide_level_default` real DEFAULT 0 NOT NULL,
	`loudness_normalization` integer DEFAULT false NOT NULL,
	`presence_grace_minutes` integer DEFAULT 90 NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `rooms_code_idx` ON `rooms` (`code`);--> statement-breakpoint
CREATE TABLE `singers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color` text NOT NULL,
	`session_token` text NOT NULL,
	`joined_at` integer NOT NULL,
	`last_sung_at` integer,
	`room_id` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `singers_session_token_idx` ON `singers` (`session_token`);--> statement-breakpoint
CREATE INDEX `singers_room_idx` ON `singers` (`room_id`);