CREATE TABLE `room_settings` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`default_engine` text DEFAULT 'demucs' NOT NULL,
	`default_model` text DEFAULT 'htdemucs' NOT NULL,
	`enqueue_upgrade` integer DEFAULT false NOT NULL,
	`upgrade_engine` text DEFAULT 'roformer' NOT NULL,
	`upgrade_model` text DEFAULT 'bs-roformer-1297' NOT NULL
);
