CREATE TABLE `members` (
	`id` integer PRIMARY KEY NOT NULL,
	`email` text NOT NULL,
	`slug` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `members_email_unique` ON `members` (`email`);--> statement-breakpoint
CREATE UNIQUE INDEX `members_slug_idx` ON `members` (`slug`);