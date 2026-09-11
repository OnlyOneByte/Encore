-- room_settings.tv_background_hue (an ANGLE) becomes tv_background_color (a REAL COLOUR).
--
-- A real numbered migration (0005, after #728's 0004_rekey_room_settings), NOT an in-place edit of
-- 0000_baseline.sql: a rewritten baseline is never re-applied to an existing DB (drizzle keys on the
-- journal `when`, not the file hash), so the new column would never appear on an upgraded box and
-- `runMigrations()` would throw at boot the first time a reader selected it. That is the exact trap
-- and #669 each hit; 0004's header records it too. This migration replays only on DBs that have
-- not recorded idx:5.
--
-- WHY: the stage used to store a hue angle, quantised to 15 degrees and rendered at a pinned stage
-- lightness by `stageHueToHex`, so that no room could produce a field bright enough to wash out the
-- word-timed lyric reel it sits behind. The owner retired that bound and replaced the job it
-- was doing with a different mechanism -- the reel now paints its own `-webkit-text-stroke` outline
-- (b764d92), which holds on any field AND over a music video, which a bound on the stage colour
-- never reached. So the room now names a colour outright.
--
-- WHAT HAPPENS TO EXISTING ROWS -- every row keeps the colour it is showing today. The old column is
-- quantised to the 24 wheel stops (`SINGER_HUE_STEP = 15`) and wrapped to 0..359 by the settings
-- validator, so there are exactly 24 legal values and each maps to one hex: the CASE below IS
-- `stageHueToHex` evaluated at each of them, transcribed. SQL cannot run an OKLCH conversion, which
-- is why the table is spelled out rather than computed -- and a guard test asserts each of these 24
-- pairs still equals `stageHueToHex(hue)`, so a change to the stage tier cannot silently leave this
-- migration behind.
--
-- The default 240 becomes '#001d31', a very dark navy -- the blue that tested cleanest against the
-- pink active word, at the stage tier's L 0.22 / C 0.07. So a box that never opened Settings looks
-- byte-identical after the upgrade, and one that did keeps its pick.
--
-- A hand-edited DB holding an off-step or out-of-range hue falls to the ELSE and lands on the default
-- colour rather than on nothing: NOT NULL means there is no third option, and silently defaulting an
-- illegal value is what the settings validator already does with one.
--
-- SCHEMA CHANGE ONLY ON THIS COLUMN: room_settings keeps its `room_id text PRIMARY KEY`, so this is a
-- plain ADD/UPDATE/DROP and not the __new_ create-copy-drop-rename idiom 0002/0003 needed for a PK
-- change. `DROP COLUMN` is used rather than leaving a dead column behind so the DB and the drizzle
-- snapshot keep describing the same table; the column carries no index, view or generated reference,
-- which is what SQLite requires for it.
ALTER TABLE `room_settings` ADD `tv_background_color` text DEFAULT '#001d31' NOT NULL;--> statement-breakpoint
UPDATE `room_settings` SET `tv_background_color` = CASE `tv_background_hue`
	WHEN 0 THEN '#20000a'
	WHEN 15 THEN '#280006'
	WHEN 30 THEN '#2e0402'
	WHEN 45 THEN '#330c00'
	WHEN 60 THEN '#2c1300'
	WHEN 75 THEN '#281600'
	WHEN 90 THEN '#241900'
	WHEN 105 THEN '#1e1b00'
	WHEN 120 THEN '#181e00'
	WHEN 135 THEN '#0a2100'
	WHEN 150 THEN '#002208'
	WHEN 165 THEN '#002215'
	WHEN 180 THEN '#00201b'
	WHEN 195 THEN '#002020'
	WHEN 210 THEN '#001f25'
	WHEN 225 THEN '#001f2a'
	WHEN 240 THEN '#001d31'
	WHEN 255 THEN '#011a3a'
	WHEN 270 THEN '#0e173b'
	WHEN 285 THEN '#181439'
	WHEN 300 THEN '#1b0b30'
	WHEN 315 THEN '#1b0425'
	WHEN 330 THEN '#1a0019'
	WHEN 345 THEN '#18000d'
	ELSE '#001d31'
END;--> statement-breakpoint
ALTER TABLE `room_settings` DROP COLUMN `tv_background_hue`;
