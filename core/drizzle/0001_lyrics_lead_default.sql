PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_room_settings` (
	`room_id` text PRIMARY KEY NOT NULL,
	`queue_order` text DEFAULT 'fair' NOT NULL,
	`tv_progress_style` text DEFAULT 'edge' NOT NULL,
	`tv_background_style` text DEFAULT 'off' NOT NULL,
	`tv_background_color` text DEFAULT '#001d31' NOT NULL,
	`tv_background_dim` real DEFAULT 0 NOT NULL,
	`tv_visualizer` text DEFAULT 'plasma' NOT NULL,
	`song_intro_enabled` integer DEFAULT true NOT NULL,
	`song_intro_ms` integer DEFAULT 2500 NOT NULL,
	`max_quality_rank` integer,
	`lyrics_ball` text DEFAULT 'off' NOT NULL,
	`lyrics_highlight` text DEFAULT 'word' NOT NULL,
	`lyrics_lead_ms` integer DEFAULT 40 NOT NULL,
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
INSERT INTO `__new_room_settings`("room_id", "queue_order", "tv_progress_style", "tv_background_style", "tv_background_color", "tv_background_dim", "tv_visualizer", "song_intro_enabled", "song_intro_ms", "max_quality_rank", "lyrics_ball", "lyrics_highlight", "lyrics_lead_ms", "lyrics_scale_pct", "lyrics_font", "lyrics_case", "lyrics_lines_before", "lyrics_lines_after", "guide_level_default", "loudness_normalization", "presence_grace_minutes") SELECT "room_id", "queue_order", "tv_progress_style", "tv_background_style", "tv_background_color", "tv_background_dim", "tv_visualizer", "song_intro_enabled", "song_intro_ms", "max_quality_rank", "lyrics_ball", "lyrics_highlight", "lyrics_lead_ms", "lyrics_scale_pct", "lyrics_font", "lyrics_case", "lyrics_lines_before", "lyrics_lines_after", "guide_level_default", "loudness_normalization", "presence_grace_minutes" FROM `room_settings`;--> statement-breakpoint
DROP TABLE `room_settings`;--> statement-breakpoint
ALTER TABLE `__new_room_settings` RENAME TO `room_settings`;--> statement-breakpoint
-- THE NEW DEFAULT ON ITS OWN REACHES NO ROOM THAT ALREADY EXISTS, so this backfill is hand-added to the
-- generated ALTER above (W5 review r1-spec-15 / r1-tests-18). `SettingsRepository.setRoom` writes EVERY
-- column on every save and `getRoom` returns the stored row verbatim — nothing reads a column default at
-- runtime — so a room that has ever touched a TV or lyrics setting holds `lyrics_lead_ms = 0`, the OLD
-- default, and would have kept rendering at an effective lead of zero after the upgrade. That is the whole
-- measured gain: 73.2% -> 78.6% of published word onsets inside ITU-R BT.1359's asymmetric band
-- (DEFAULT_LYRICS_LEAD_MS, docs/FRONTEND.md), delivered only to rooms created afterwards, with two rooms on
-- one install rendering differently and nothing in the UI saying why.
-- WHY A BACKFILL IS HONEST HERE: a stored 0 and the old default are INDISTINGUISHABLE — the knob shipped at
-- 0, so no one can have chosen it against a measurement that did not exist — and this is the pre-release
-- window, the only moment that is true. A room that wants 0 sets it again and keeps it: the WHERE clause
-- makes this exactly as narrow as the default change it completes, and a migration never runs twice.
UPDATE `room_settings` SET `lyrics_lead_ms` = 40 WHERE `lyrics_lead_ms` = 0;--> statement-breakpoint
PRAGMA foreign_keys=ON;