-- re-key the durable room_settings row from the literal 'main' onto the ACTIVE room.
--
-- A real numbered migration (0004, after #656's 0003_room_keyed_queue), NOT an in-place baseline
-- edit: a rewritten 0000 is never re-applied to an existing DB (drizzle keys on the journal `when`,
-- not the file hash), so an existing party's configured settings would silently revert to default on
-- upgrade -- the exact availability trap #655/#669 hit. This migration replays only on DBs that have
-- not recorded idx:4.
--
-- WHY: before #728 SettingsRepository defaulted every reader AND the writer route to DEFAULT_ROOM_ID
-- ('main'), so a configured box wrote its room_settings row under 'main'. An earlier change moved every reader
-- (and the writer fallback) onto app.activeRoomId -- a minted ULID (RoomRepository.ensureActive =
-- ORDER BY created_at ASC), NOT 'main'. Without this re-key the readers would look up the active room
-- and find no row, silently serving defaults; the operator's persisted choices would vanish.
--
-- SCHEMA UNCHANGED: room_settings keeps its bare `room_id text PRIMARY KEY` (no column added), so this
-- is a data-only UPDATE, not the __new_ create-copy-drop-rename idiom 0002/0003 needed for a PK change.
--
-- The active room is the OLDEST one -- the same room ensureActive() resolves to and where an
-- unqualified join lands. Guards:
--   * A DB with a 'main' settings row but NO rooms row yet (a pre-change database) has no room to carry
--     it onto -- the subquery is NULL and the WHERE drops the UPDATE, leaving the row untouched.
--   * If the active room ALREADY has its own row (a client that sent ?roomId=<active> wrote one), the
--     explicit per-room row wins: we DELETE the orphan 'main' row rather than collide on the PK.
--   * If the active room IS literally 'main', the UPDATE is a no-op self-assignment and the guards skip.
PRAGMA foreign_keys=OFF;--> statement-breakpoint
DELETE FROM `room_settings`
WHERE `room_id` = 'main'
  AND (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) IS NOT NULL
  AND (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) <> 'main'
  AND EXISTS (
    SELECT 1 FROM `room_settings` rs2
    WHERE rs2.`room_id` = (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1)
  );--> statement-breakpoint
UPDATE `room_settings`
SET `room_id` = (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1)
WHERE `room_id` = 'main'
  AND (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) IS NOT NULL
  AND (SELECT `id` FROM `rooms` ORDER BY `created_at` ASC LIMIT 1) <> 'main';--> statement-breakpoint
PRAGMA foreign_keys=ON;
