CREATE TABLE `jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`job_type` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`priority` integer DEFAULT 0 NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`worker_id` text,
	`stage` text,
	`progress_pct` integer DEFAULT 0 NOT NULL,
	`eta_sec` integer,
	`lease_expires_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `media` (
	`id` text PRIMARY KEY NOT NULL,
	`source` text NOT NULL,
	`source_ref` text NOT NULL,
	`title` text NOT NULL,
	`artist` text,
	`duration_sec` integer NOT NULL,
	`thumbnail` text,
	`stem_status` text DEFAULT 'none' NOT NULL,
	`play_mode` text DEFAULT 'iframe' NOT NULL
);
--> statement-breakpoint
CREATE TABLE `playback_state` (
	`id` text PRIMARY KEY DEFAULT 'singleton' NOT NULL,
	`current_entry_id` text,
	`position_sec` integer DEFAULT 0 NOT NULL,
	`is_playing` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `queue_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`media_id` text NOT NULL,
	`singer_id` text NOT NULL,
	`status` text DEFAULT 'queued' NOT NULL,
	`rotation_seq` integer NOT NULL,
	`added_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `rooms` (
	`id` text PRIMARY KEY NOT NULL,
	`code` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `singers` (
	`id` text PRIMARY KEY NOT NULL,
	`display_name` text NOT NULL,
	`color` text NOT NULL,
	`session_token` text NOT NULL,
	`joined_at` integer NOT NULL
);
