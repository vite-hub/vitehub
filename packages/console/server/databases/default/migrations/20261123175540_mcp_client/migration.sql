CREATE TABLE `console_mcp_clients` (
	`id` text PRIMARY KEY,
	`sealed` text NOT NULL,
	`created_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `console_mcp_connections` (
	`id` text PRIMARY KEY,
	`user_id` text NOT NULL,
	`project_id` text NOT NULL,
	`sealed` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	CONSTRAINT `fk_console_mcp_connections_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_console_mcp_connections_project_id_console_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `console_projects`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE INDEX `console_mcp_connections_owner_idx` ON `console_mcp_connections` (`user_id`,`project_id`);