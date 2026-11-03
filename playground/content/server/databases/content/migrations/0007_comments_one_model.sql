-- Moves the live-site comment tables to one model. See https://vitehub.dev/docs/comments/configure#upgrade-to-one-model
ALTER TABLE `vitehub_comment_threads` RENAME TO `vitehub_comment_threads_live`;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vitehub_comment_threads` (`id` text PRIMARY KEY NOT NULL, `scope` text NOT NULL, `n` integer NOT NULL, `subject_kind` text NOT NULL, `subject_id` text NOT NULL, `anchor` text NOT NULL, `status` text NOT NULL, `resolved_by` text, `resolved_at` integer, `author_id` text NOT NULL, `author_name` text, `author_image` text, `actor` text, `metadata` text, `context` text, `revision` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_comment_threads_scope_n` ON `vitehub_comment_threads` (`scope`,`n`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vitehub_comment_threads_subject` ON `vitehub_comment_threads` (`subject_kind`,`subject_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vitehub_comment_threads_status` ON `vitehub_comment_threads` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vitehub_comment_messages` (`id` text PRIMARY KEY NOT NULL, `thread_id` text NOT NULL, `body` text NOT NULL, `author_id` text NOT NULL, `author_name` text, `author_image` text, `actor` text, `mentions` text NOT NULL, `attachments` text NOT NULL, `created_at` integer NOT NULL, `edited_at` integer);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vitehub_comment_messages_thread` ON `vitehub_comment_messages` (`thread_id`,`created_at`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vitehub_comment_counters` (`scope` text PRIMARY KEY NOT NULL, `next` integer NOT NULL);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vitehub_comment_forge` (`id` text PRIMARY KEY NOT NULL, `thread_id` text, `repository` text NOT NULL, `pull_request` integer NOT NULL, `remote_id` text, `node_id` text, `url` text, `digest` text, `posted_as` text, `minimized` integer DEFAULT false NOT NULL, `error` text, `updated_at` integer NOT NULL);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vitehub_comment_forge_thread` ON `vitehub_comment_forge` (`thread_id`);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS `vitehub_comment_forge_pull_request` ON `vitehub_comment_forge` (`repository`,`pull_request`);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `vitehub_comment_scope_counters` (`scope` text PRIMARY KEY NOT NULL, `last_number` integer NOT NULL);
--> statement-breakpoint
INSERT INTO `vitehub_comment_threads` (`id`, `scope`, `n`, `subject_kind`, `subject_id`, `anchor`, `status`, `resolved_by`, `resolved_at`, `author_id`, `author_name`, `author_image`, `actor`, `metadata`, `context`, `revision`, `created_at`, `updated_at`) SELECT `id`, CASE WHEN `scope` = 'pages' THEN 'site' ELSE `scope` END, `number`, CASE WHEN `scope` = 'pages' THEN 'page' WHEN instr(`scope`, ':') > 1 THEN substr(`scope`, 1, instr(`scope`, ':') - 1) ELSE `scope` END, CASE WHEN `scope` = 'pages' THEN `page` WHEN instr(`scope`, ':') > 1 THEN substr(`scope`, instr(`scope`, ':') + 1) ELSE `page` END, CASE WHEN `anchor` IS NULL OR `anchor` = 'null' THEN '{"kind":"page"}' ELSE json_set(`anchor`, '$.kind', 'element') END, `status`, `resolved_by`, `resolved_at`, CASE WHEN json_extract(`created_by`, '$.guest') = 1 AND substr(json_extract(`created_by`, '$.id'), 1, 6) <> 'guest:' THEN 'guest:' || json_extract(`created_by`, '$.id') ELSE json_extract(`created_by`, '$.id') END, json_extract(`created_by`, '$.name'), json_extract(`created_by`, '$.image'), NULL, `metadata`, `context`, NULL, `created_at`, `updated_at` FROM `vitehub_comment_threads_live`;
--> statement-breakpoint
INSERT INTO `vitehub_comment_messages` (`id`, `thread_id`, `body`, `author_id`, `author_name`, `author_image`, `actor`, `mentions`, `attachments`, `created_at`, `edited_at`) SELECT `c`.`id`, `c`.`thread_id`, `c`.`body`, CASE WHEN json_extract(`c`.`author`, '$.guest') = 1 AND substr(json_extract(`c`.`author`, '$.id'), 1, 6) <> 'guest:' THEN 'guest:' || json_extract(`c`.`author`, '$.id') ELSE json_extract(`c`.`author`, '$.id') END, json_extract(`c`.`author`, '$.name'), json_extract(`c`.`author`, '$.image'), NULL, coalesce((SELECT json_group_array(json_extract(`m`.`value`, '$.id')) FROM json_each(`c`.`mentions`) AS `m`), '[]'), '[]', `c`.`created_at`, `c`.`edited_at` FROM `vitehub_comments` AS `c` WHERE `c`.`thread_id` IN (SELECT `id` FROM `vitehub_comment_threads_live`);
--> statement-breakpoint
INSERT INTO `vitehub_comment_counters` (`scope`, `next`) SELECT CASE WHEN `scope` = 'pages' THEN 'site' ELSE `scope` END, max(`number`) + 1 FROM `vitehub_comment_threads_live` GROUP BY 1 ON CONFLICT (`scope`) DO UPDATE SET `next` = max(`next`, excluded.`next`);
--> statement-breakpoint
INSERT INTO `vitehub_comment_counters` (`scope`, `next`) SELECT CASE WHEN `scope` = 'pages' THEN 'site' ELSE `scope` END, `last_number` + 1 FROM `vitehub_comment_scope_counters` WHERE true ON CONFLICT (`scope`) DO UPDATE SET `next` = max(`next`, excluded.`next`);
