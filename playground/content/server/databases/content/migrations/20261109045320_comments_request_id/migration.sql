ALTER TABLE `vitehub_comment_threads` ADD `request_id` text;--> statement-breakpoint
CREATE UNIQUE INDEX `vitehub_comment_threads_scope_request` ON `vitehub_comment_threads` (`scope`,`request_id`);