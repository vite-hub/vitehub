-- Site access in the Console: the passes of browsers, guest invites, and one-time codes. This migration only adds tables.
CREATE TABLE `console_site_grants` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`user_id` text,
	`name` text NOT NULL,
	`roles` text NOT NULL,
	`secret_hash` text NOT NULL,
	`device` text NOT NULL,
	`link_id` text,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`revoked_at` integer,
	CONSTRAINT `fk_console_site_grants_project_id_console_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `console_projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_console_site_grants_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `console_site_links` (
	`id` text PRIMARY KEY,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`secret_hash` text NOT NULL,
	`user_id` text,
	`name` text,
	`roles` text,
	`path` text NOT NULL,
	`created_by` text NOT NULL,
	`created_by_name` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`used_at` integer,
	`revoked_at` integer,
	CONSTRAINT `fk_console_site_links_project_id_console_projects_id_fk` FOREIGN KEY (`project_id`) REFERENCES `console_projects`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_console_site_links_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `console_site_grants_secret_hash_uidx` ON `console_site_grants` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `console_site_grants_project_idx` ON `console_site_grants` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_site_links_secret_hash_uidx` ON `console_site_links` (`secret_hash`);--> statement-breakpoint
CREATE INDEX `console_site_links_project_idx` ON `console_site_links` (`project_id`);