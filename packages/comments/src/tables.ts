/**
 * The tables of `commentsSchema` as SQLite statements that are safe to run on every start. A database that Comments
 * opens itself gets them on first use; a ViteHub Database gets the same tables from `vitehub db generate` instead.
 * On a database that still has the tables of the live-site model, the subject index fails with
 * "no such column: subject_kind": run `migrateComments()` once.
 */
export const commentsTables: readonly string[] = [
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_threads` (`id` text PRIMARY KEY NOT NULL, `scope` text NOT NULL, `n` integer NOT NULL, `subject_kind` text NOT NULL, `subject_id` text NOT NULL, `anchor` text NOT NULL, `status` text NOT NULL, `resolved_by` text, `resolved_at` integer, `author_id` text NOT NULL, `author_name` text, `author_image` text, `actor` text, `metadata` text, `context` text, `revision` integer, `created_at` integer NOT NULL, `updated_at` integer NOT NULL)",
  "CREATE UNIQUE INDEX IF NOT EXISTS `vitehub_comment_threads_scope_n` ON `vitehub_comment_threads` (`scope`,`n`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_threads_subject` ON `vitehub_comment_threads` (`subject_kind`,`subject_id`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_threads_status` ON `vitehub_comment_threads` (`status`,`updated_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_messages` (`id` text PRIMARY KEY NOT NULL, `thread_id` text NOT NULL, `body` text NOT NULL, `author_id` text NOT NULL, `author_name` text, `author_image` text, `actor` text, `mentions` text NOT NULL, `attachments` text NOT NULL, `created_at` integer NOT NULL, `edited_at` integer)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_messages_thread` ON `vitehub_comment_messages` (`thread_id`,`created_at`)",
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_counters` (`scope` text PRIMARY KEY NOT NULL, `next` integer NOT NULL)",
  "CREATE TABLE IF NOT EXISTS `vitehub_comment_forge` (`id` text PRIMARY KEY NOT NULL, `thread_id` text, `repository` text NOT NULL, `pull_request` integer NOT NULL, `remote_id` text, `node_id` text, `url` text, `digest` text, `posted_as` text, `minimized` integer DEFAULT false NOT NULL, `error` text, `updated_at` integer NOT NULL)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_forge_thread` ON `vitehub_comment_forge` (`thread_id`)",
  "CREATE INDEX IF NOT EXISTS `vitehub_comment_forge_pull_request` ON `vitehub_comment_forge` (`repository`,`pull_request`)",
]
