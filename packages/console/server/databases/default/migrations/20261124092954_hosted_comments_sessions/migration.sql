CREATE TABLE `console_comment_sessions` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`user_id` text,
	`grant_id` text,
	`challenge` text NOT NULL,
	`code_hash` text,
	`token_hash` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	CONSTRAINT `fk_console_comment_sessions_project_id_console_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `console_projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_console_comment_sessions_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_console_comment_sessions_grant_id_console_site_grants_id_fk` FOREIGN KEY (`grant_id`) REFERENCES `console_site_grants`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `console_comment_sessions_code_hash_uidx` ON `console_comment_sessions` (`code_hash`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_comment_sessions_token_hash_uidx` ON `console_comment_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `console_comment_sessions_project_idx` ON `console_comment_sessions` (`project_id`,`expires_at`);