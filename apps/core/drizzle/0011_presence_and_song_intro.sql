ALTER TABLE `room_settings` ADD `song_intro_enabled` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `song_intro_ms` integer DEFAULT 2500 NOT NULL;--> statement-breakpoint
ALTER TABLE `room_settings` ADD `presence_grace_minutes` integer DEFAULT 90 NOT NULL;--> statement-breakpoint
-- Carry the old sentinel across before the next migration drops the column it lived in.
--
-- `interstitial_ms` encoded off as 0, which the new pair splits into a boolean plus a duration. Without
-- this, a room that had deliberately chosen a gapless hard-cut would come back from the migration with
-- the intro switched ON at the 2500 column default — the setting silently reversed by an upgrade.
--
-- A room that was off also gets a usable duration parked behind the toggle, so switching the intro back
-- on lands somewhere sensible instead of on the 0 that no longer means anything.
UPDATE `room_settings` SET `song_intro_enabled` = 0, `song_intro_ms` = 2500 WHERE `interstitial_ms` = 0;--> statement-breakpoint
UPDATE `room_settings` SET `song_intro_enabled` = 1, `song_intro_ms` = MAX(500, MIN(10000, `interstitial_ms`)) WHERE `interstitial_ms` > 0;
