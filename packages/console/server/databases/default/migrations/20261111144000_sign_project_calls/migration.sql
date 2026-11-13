-- Each link now signs its calls with its own Ed25519 key pair, so a project row keeps a sealed private key and the
-- public key that the app stores, in place of the bearer token. A link made with a token cannot sign, so this migration
-- drops the old links: link those apps again. SQLite cannot add a NOT NULL column to a table with rows, and nothing
-- references `console_projects`, so the table is made again.
DROP TABLE `console_projects`;--> statement-breakpoint
CREATE TABLE `console_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`team_id` text NOT NULL,
	`url` text NOT NULL,
	`label` text,
	`key_sealed` text NOT NULL,
	`public_key` text NOT NULL,
	`created_by` text NOT NULL,
	`created_at` integer NOT NULL,
	FOREIGN KEY (`team_id`) REFERENCES `organization`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `console_projects_team_idx` ON `console_projects` (`team_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `console_projects_team_url_uidx` ON `console_projects` (`team_id`,`url`);
