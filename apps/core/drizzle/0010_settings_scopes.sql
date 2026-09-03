-- Split settings into two scopes.
--
-- 0009 created `room_settings` holding separator policy, but those values are properties of the
-- DEPLOYMENT and its worker fleet (an engine is only usable if some worker advertises its
-- capability), not of one party. Rename that table to `global_settings`, then create a real
-- per-room `room_settings` keyed by room id so multi-room is a row per room rather than a
-- migration later.
--
-- The rename preserves any values already written; the new table starts empty and every room falls
-- back to defaults until it writes one.
ALTER TABLE `room_settings` RENAME TO `global_settings`;
--> statement-breakpoint
CREATE TABLE `room_settings` (
	`room_id` text PRIMARY KEY NOT NULL,
	`interstitial_ms` integer DEFAULT 2500 NOT NULL,
	`max_quality_rank` integer
);
