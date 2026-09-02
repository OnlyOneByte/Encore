ALTER TABLE `media` ADD `instrumental_ref` text;--> statement-breakpoint
-- Backfill rows cooked under the OLD scheme, where markMediaReady overwrote source_ref with the
-- instrumental key. Move that key to its proper column so those songs still PLAY correctly.
-- Their origin id (youtube video id / file key) was destroyed by the overwrite and cannot be
-- recovered here; such a row will be duplicated once by the next search for that song, after which
-- the new row carries a correct origin. Only pre-release test data is affected.
UPDATE `media`
SET `instrumental_ref` = `source_ref`
WHERE `instrumental_ref` IS NULL
  AND `stem_status` = 'ready'
  AND `play_mode` = 'file'
  AND `source_ref` LIKE 'stems/%';
