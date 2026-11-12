CREATE TABLE `vitehub_comment_threads` (
	`id` text PRIMARY KEY NOT NULL,
	`page` text NOT NULL,
	`anchor` text NOT NULL,
	`status` text NOT NULL,
	`created_by` text NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `vitehub_comment_threads_page` ON `vitehub_comment_threads` (`page`,`status`);--> statement-breakpoint
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
CREATE INDEX `vitehub_comments_thread` ON `vitehub_comments` (`thread_id`,`created_at`);