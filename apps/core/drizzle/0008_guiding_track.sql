-- Guiding track: the isolated vocals stem, mixed back under the instrumental at a level the singer
-- controls. See docs/SPEC-guiding-track.md.
--
-- Purely additive (three ADD COLUMNs), so an existing database upgrades in place and a fresh one is
-- identical either way.
--
-- `guide_level` is deliberately NULLABLE with no default: NULL means "inherit the room default",
-- which is a different statement from 0 ("explicitly off for this song") — the same shape the
-- per-song `background` override next to it uses. `guide_level_default` is NOT NULL default 0, so an
-- existing room upgrades to today's behaviour — pure karaoke — rather than to a mix nobody asked for.
--
-- REAL, not integer: both are fractions, and an integer column would round every level to 0 or 1.
ALTER TABLE `media` ADD `vocals_ref` text;--> statement-breakpoint
ALTER TABLE `playback_state` ADD `guide_level` real;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `guide_level_default` real DEFAULT 0 NOT NULL;