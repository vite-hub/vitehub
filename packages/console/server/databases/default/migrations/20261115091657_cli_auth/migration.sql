-- Sign-in for the ViteHub CLI: the device codes of RFC 8628, and API keys that keep only a SHA-256 hash of the key.
-- This migration only adds tables.
CREATE TABLE `console_api_keys` (
	`id` text PRIMARY KEY,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`name` text NOT NULL,
	`start` text NOT NULL,
	`key_hash` text NOT NULL,
	`project_ids` text,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`last_used_at` integer,
	CONSTRAINT `fk_console_api_keys_team_id_organization_id_fk` FOREIGN KEY (`team_id`) REFERENCES `organization`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_console_api_keys_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE TABLE `device_code` (
	`id` text PRIMARY KEY,
	`device_code` text NOT NULL,
	`user_code` text NOT NULL,
	`user_id` text,
	`expires_at` integer NOT NULL,
	`status` text NOT NULL,
	`last_polled_at` integer,
	`polling_interval` integer,
	`client_id` text,
	`scope` text,
	`client_name` text,
	`team_id` text,
	CONSTRAINT `fk_device_code_user_id_user_id_fk` FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON DELETE CASCADE,
	CONSTRAINT `fk_device_code_team_id_organization_id_fk` FOREIGN KEY (`team_id`) REFERENCES `organization`(`id`) ON DELETE CASCADE
);
--> statement-breakpoint
CREATE UNIQUE INDEX `console_api_keys_key_hash_uidx` ON `console_api_keys` (`key_hash`);--> statement-breakpoint
CREATE INDEX `console_api_keys_user_idx` ON `console_api_keys` (`user_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_device_code_uidx` ON `device_code` (`device_code`);--> statement-breakpoint
CREATE UNIQUE INDEX `device_code_user_code_uidx` ON `device_code` (`user_code`);--> statement-breakpoint
CREATE INDEX `device_code_user_idx` ON `device_code` (`user_id`);