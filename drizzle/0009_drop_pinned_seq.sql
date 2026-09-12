-- step 3: drop the queue_entries.pinned_seq column — pinning is deleted as a concept.
--
-- pinned_seq held a HOST's durable global-reorder pin. Under the stored-list model that steps 1+2 built
-- the queue IS the stored ordered list and a drag rewrites it in place, so there is no re-derivation
-- for a pin to survive and nothing reads pinned_seq any more (the move-global/unpin ops, placePins,
-- and QueueEntry.pinnedSeq all go with it).
--
-- Owner ruling C on the re-triage: no live room crosses this upgrade (the party box's DB is wiped
-- between parties), so the column is dropped clean — no backfill, no read-time remap, no data
-- migration. Existing queue rows are preserved verbatim minus this one column.
--
-- SQLite has no bare DROP COLUMN that is safe on every version this ships to, so the column goes via
-- the create-copy-drop-rename table-rebuild idiom (the same shape 0003_room_keyed_queue.sql uses, and
-- the only shape the migration-shape guard allows). The INSERT copies every surviving column, so the
-- rows carry across. The room index is recreated on the new table — losing it would silently drop the
-- per-room queue read (schema.ts queue_entries_room_idx).
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_queue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`singer_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`rotation_seq` integer NOT NULL,
	`added_at` integer NOT NULL,
	`room_id` text NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_queue_entries`("id", "media_id", "singer_id", "status", "rotation_seq", "added_at", "room_id") SELECT "id", "media_id", "singer_id", "status", "rotation_seq", "added_at", "room_id" FROM `queue_entries`;--> statement-breakpoint
DROP TABLE `queue_entries`;--> statement-breakpoint
ALTER TABLE `__new_queue_entries` RENAME TO `queue_entries`;--> statement-breakpoint
CREATE INDEX `queue_entries_room_idx` ON `queue_entries` (`room_id`);--> statement-breakpoint
PRAGMA foreign_keys=ON;
