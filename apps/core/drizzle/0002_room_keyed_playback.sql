-- key playback_state by room, dropping the deployment-wide 'singleton' row.
--
-- A real numbered migration (0002, after #669's 0001 job_attempts.selection), NOT an in-place
-- 0000_baseline edit: an in-place baseline rewrite is never re-applied to an existing DB (drizzle
-- keys on the journal `when`, not the file hash), so room_id would never appear and hydrate() on the
-- boot path would throw — the app would fail to start.
--
-- SQLite cannot ALTER a primary key, so the table is recreated. The old single 'singleton' row is
-- RE-KEYED onto the active room rather than dropped, preserving the party's now-playing / position /
-- key-shift / background across the upgrade. The active room is the oldest one — the same room
-- RoomRepository.ensureActive() resolves to (ORDER BY created_at ASC), which is where an unqualified
-- join lands. A DB with a persisted playback row but NO rooms row yet (a pre-change database) has no
-- room to carry it onto; the WHERE guard drops that orphan row instead of failing the NOT NULL PK.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_playback_state` (
	`room_id` text PRIMARY KEY NOT NULL,
	`current_entry_id` text,
	`position_sec` integer DEFAULT 0 NOT NULL,
	`is_playing` integer DEFAULT false NOT NULL,
	`key_shift` integer DEFAULT 0 NOT NULL,
	`background` text,
	`guide_level` real
);
--> statement-breakpoint
INSERT INTO `__new_playback_state`("room_id", "current_entry_id", "position_sec", "is_playing", "key_shift", "background", "guide_level") SELECT (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1), "current_entry_id", "position_sec", "is_playing", "key_shift", "background", "guide_level" FROM `playback_state` WHERE (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) IS NOT NULL;--> statement-breakpoint
DROP TABLE `playback_state`;--> statement-breakpoint
ALTER TABLE `__new_playback_state` RENAME TO `playback_state`;--> statement-breakpoint
PRAGMA foreign_keys=ON;
