ALTER TABLE `jobs` ADD `error` text;--> statement-breakpoint
CREATE UNIQUE INDEX `jobs_live_media_type_idx` ON `jobs` (`media_id`,`job_type`) WHERE "jobs"."status" NOT IN ('failed', 'canceled');