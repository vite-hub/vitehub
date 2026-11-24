CREATE TABLE `console_comment_counters` (
	`scope` text PRIMARY KEY,
	`next` integer NOT NULL,
	CONSTRAINT `fk_console_comment_counters_scope_console_projects_id_fk` FOREIGN KEY (`scope`) REFERENCES `console_projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `console_comment_messages` (
	`id` text PRIMARY KEY,
	`thread_id` text NOT NULL,
	`body` text NOT NULL,
	`author_id` text NOT NULL,
	`author_name` text,
	`author_image` text,
	`actor` text,
	`mentions` text NOT NULL,
	`attachments` text NOT NULL,
	`created_at` integer NOT NULL,
	`edited_at` integer
);
--> statement-breakpoint
CREATE TABLE `console_comment_threads` (
	`id` text PRIMARY KEY,
	`scope` text NOT NULL,
	`n` integer NOT NULL,
	`subject_kind` text NOT NULL,
	`subject_id` text NOT NULL,
	`anchor` text NOT NULL,
	`status` text NOT NULL,
	`resolved_by` text,
	`resolved_at` integer,
	`author_id` text NOT NULL,
	`author_name` text,
	`author_image` text,
	`actor` text,
	`metadata` text,
	`context` text,
	`revision` integer,
	`request_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_console_comment_threads_scope_console_projects_id_fk` FOREIGN KEY (`scope`) REFERENCES `console_projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `console_comment_messages_thread` ON `console_comment_messages` (`thread_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_comment_threads_scope_n` ON `console_comment_threads` (`scope`,`n`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_comment_threads_scope_request` ON `console_comment_threads` (`scope`,`request_id`);--> statement-breakpoint
CREATE INDEX `console_comment_threads_subject` ON `console_comment_threads` (`subject_kind`,`subject_id`);--> statement-breakpoint
CREATE INDEX `console_comment_threads_status` ON `console_comment_threads` (`status`,`updated_at`);
--> statement-breakpoint
CREATE TRIGGER `console_comment_threads_delete_messages`
AFTER DELETE ON `console_comment_threads`
BEGIN
	DELETE FROM `console_comment_messages` WHERE `thread_id` = OLD.`id`;
END;
