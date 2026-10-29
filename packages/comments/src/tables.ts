/**
 * The tables of `commentsSchema` as SQLite statements that are safe to run on every start. A database that Comments
 * opens itself gets them on first use; a ViteHub Database gets the same tables from `vitehub db generate` instead.
 */
export const commentsTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_threads` (`id` text PRIMARY KEY NOT NULL, `scope` text DEFAULT 'pages' NOT NULL, `number` integer DEFAULT 0 NOT NULL, `page` text NOT NULL, `anchor` text NOT NULL, `context` text, `metadata` text, `status` text NOT NULL, `created_by` text NOT NULL, `resolved_by` text, `resolved_at` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_threads_page` ON `vitehub_comment_threads` (`page`,`status`)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_comment_threads_number` ON `vitehub_comment_threads` (`scope`,`number`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_threads_updated` ON `vitehub_comment_threads` (`updated_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_scope_counters` (`scope` text PRIMARY KEY NOT NULL, `last_number` integer NOT NULL)",
  "INSERT INTO `vitehub_comment_scope_counters` (`scope`, `last_number`) SELECT `scope`, max(`number`) FROM `vitehub_comment_threads` GROUP BY `scope` ON CONFLICT (`scope`) DO UPDATE SET `last_number` = max(`last_number`, excluded.`last_number`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_comments` (`id` text PRIMARY KEY NOT NULL, `thread_id` text NOT NULL, `body` text NOT NULL, `mentions` text NOT NULL, `author` text NOT NULL, `created_at` integer NOT NULL, `edited_at` integer, FOREIGN KEY (`thread_id`) REFERENCES `vitehub_comment_threads`(`id`) ON UPDATE no action ON DELETE cascade)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comments_thread` ON `vitehub_comments` (`thread_id`,`created_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_forge` (`id` text PRIMARY KEY NOT NULL, `thread_id` text, `repository` text NOT NULL, `pull_request` integer NOT NULL, `remote_id` text, `node_id` text, `url` text, `digest` text, `posted_as` text, `minimized` integer DEFAULT false NOT NULL, `error` text, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_forge_thread` ON `vitehub_comment_forge` (`thread_id`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_forge_pull_request` ON `vitehub_comment_forge` (`repository`,`pull_request`)",
]
