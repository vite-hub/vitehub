CREATE TABLE `vitehub_content_sessions` (
	`workspace` text NOT NULL,
	`collection` text NOT NULL,
	`document` text NOT NULL,
	`session` text NOT NULL,
	`user_id` text NOT NULL,
	`user_name` text,
	`user_image` text,
	`kind` text NOT NULL,
	`acquired_at` integer,
	`renewed_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_input_at` integer,
	PRIMARY KEY(`workspace`, `collection`, `document`, `session`)
);
--> statement-breakpoint
CREATE INDEX `vitehub_content_sessions_expiry` ON `vitehub_content_sessions` (`workspace`,`expires_at`);--> statement-breakpoint
CREATE TABLE `vitehub_comment_forge` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text,
	`repository` text NOT NULL,
	`pull_request` integer NOT NULL,
	`remote_id` text,
	`node_id` text,
	`url` text,
	`digest` text,
	`posted_as` text,
	`minimized` integer DEFAULT false NOT NULL,
	`error` text,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vitehub_comment_forge_thread` ON `vitehub_comment_forge` (`thread_id`);--> statement-breakpoint
CREATE INDEX `vitehub_comment_forge_pull_request` ON `vitehub_comment_forge` (`repository`,`pull_request`);--> statement-breakpoint
CREATE TABLE `vitehub_comment_scope_counters` (
	`scope` text PRIMARY KEY NOT NULL,
	`last_number` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `vitehub_comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`scope` text DEFAULT 'pages' NOT NULL,
	`number` integer DEFAULT 0 NOT NULL,
	`page` text NOT NULL,
	`anchor` text NOT NULL,
	`context` text,
	`metadata` text,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vitehub_comment_threads_page` ON `vitehub_comment_threads` (`page`,`status`);--> statement-breakpoint
CREATE UNIQUE INDEX `vitehub_comment_threads_number` ON `vitehub_comment_threads` (`scope`,`number`);--> statement-breakpoint
CREATE INDEX `vitehub_comment_threads_updated` ON `vitehub_comment_threads` (`updated_at`);--> statement-breakpoint
CREATE TABLE `vitehub_comments` (
	`id` text PRIMARY KEY NOT NULL,
	`thread_id` text NOT NULL,
	`body` text NOT NULL,
	`mentions` text NOT NULL,
	`author` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer,
	FOREIGN KEY (`thread_id`) REFERENCES `vitehub_comment_threads`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `vitehub_comments_thread` ON `vitehub_comments` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE TABLE `workspace_history_metadata` (
	`workspace` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	PRIMARY KEY(`workspace`, `key`)
);
--> statement-breakpoint
CREATE TABLE `workspace_history_objects` (
	`workspace` text NOT NULL,
	`digest` text NOT NULL,
	`size` integer NOT NULL,
	PRIMARY KEY(`workspace`, `digest`)
);
--> statement-breakpoint
CREATE TABLE `workspace_history_refs` (
	`workspace` text NOT NULL,
	`ref` text NOT NULL,
	`head` text,
	`sequence` integer DEFAULT 0 NOT NULL,
	PRIMARY KEY(`workspace`, `ref`)
);
--> statement-breakpoint
CREATE TABLE `workspace_history_revisions` (
	`workspace` text NOT NULL,
	`id` text NOT NULL,
	`ref` text NOT NULL,
	`parent_id` text,
	`sequence` integer NOT NULL,
	`created_at` text NOT NULL,
	`message` text,
	`metadata` text,
	`files` integer NOT NULL,
	`bytes` integer NOT NULL,
	`entries` text NOT NULL,
	`committed` integer DEFAULT false NOT NULL,
	PRIMARY KEY(`workspace`, `id`)
);
--> statement-breakpoint
CREATE INDEX `workspace_history_timeline` ON `workspace_history_revisions` (`workspace`,`ref`,`committed`,`sequence`);--> statement-breakpoint
CREATE TABLE `workspace_history_workspaces` (
	`workspace` text PRIMARY KEY NOT NULL,
	`deleted` integer DEFAULT false NOT NULL
);
