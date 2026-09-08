-- #656: key queue_entries and singers by room, dropping the deployment-wide queue + roster.
--
-- A real numbered migration (0003, after #655's 0002_room_keyed_playback), NOT an in-place
-- baseline edit: a rewritten 0000 is never re-applied to an existing DB (drizzle keys on the
-- journal `when`, not the file hash), so room_id would never appear and boot hydrate() would read
-- the wrong room — the two workers who in-place-edited a migration (#655/#669) crashed boot this way.
--
-- drizzle-kit generated a bare `ALTER TABLE ... ADD room_id text NOT NULL`, which is the boot-failure
-- trap: SQLite refuses to add a NOT NULL column with no DEFAULT to a table that has rows, so an
-- existing party's DB would fail the migration on upgrade. There is also no sensible column DEFAULT —
-- the value is the ACTIVE ROOM's id, known only at migrate time. So the table is recreated (the
-- SQLite `__new_*` create-copy-drop-rename idiom the migration-shape guard allows) and existing rows
-- are RE-KEYED onto the active room, preserving the party's queue + roster across the upgrade.
--
-- The active room is the OLDEST one — the same room RoomRepository.ensureActive() resolves to
-- (ORDER BY created_at ASC), which is where an unqualified join lands and whose code the QR
-- advertises. A DB with queue/singer rows but NO rooms row yet (a pre-#654 database) has no room to
-- carry them onto; the WHERE guard drops those orphan rows instead of failing the NOT NULL room_id.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_queue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`singer_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`rotation_seq` integer NOT NULL,
	`added_at` integer NOT NULL,
	`pinned_seq` integer,
	`room_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_queue_entries`("id", "media_id", "singer_id", "status", "rotation_seq", "added_at", "pinned_seq", "room_id") SELECT "id", "media_id", "singer_id", "status", "rotation_seq", "added_at", "pinned_seq", (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) FROM `queue_entries` WHERE (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) IS NOT NULL;--> statement-breakpoint
DROP TABLE `queue_entries`;--> statement-breakpoint
ALTER TABLE `__new_queue_entries` RENAME TO `queue_entries`;--> statement-breakpoint
CREATE INDEX `queue_entries_room_idx` ON `queue_entries` (`room_id`);--> statement-breakpoint
CREATE TABLE `__new_singers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color` text NOT NULL,
	`session_token` text NOT NULL,
	`joined_at` integer NOT NULL,
	`last_sung_at` integer,
	`room_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_singers`("id", "display_name", "color", "session_token", "joined_at", "last_sung_at", "room_id") SELECT "id", "display_name", "color", "session_token", "joined_at", "last_sung_at", (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) FROM `singers` WHERE (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) IS NOT NULL;--> statement-breakpoint
DROP TABLE `singers`;--> statement-breakpoint
ALTER TABLE `__new_singers` RENAME TO `singers`;--> statement-breakpoint
CREATE UNIQUE INDEX `singers_session_token_idx` ON `singers` (`session_token`);--> statement-breakpoint
CREATE INDEX `singers_room_idx` ON `singers` (`room_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
