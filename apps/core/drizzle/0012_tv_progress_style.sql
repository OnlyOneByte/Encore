-- Per-room TV progress treatment.
--
-- Room-scoped because it stages one party's screen: the same deployment can drive a living-room TV
-- that wants the bar tucked on the bottom edge and a laptop that wants it in the now-singing card.
--
-- Defaults to 'card' so an existing room keeps a sensible treatment without writing a row.
ALTER TABLE `room_settings` ADD `tv_progress_style` text DEFAULT 'card' NOT NULL;
