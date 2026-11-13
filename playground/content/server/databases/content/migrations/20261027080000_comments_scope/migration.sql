ALTER TABLE `vitehub_comment_threads` ADD `scope` text DEFAULT 'pages' NOT NULL;--> statement-breakpoint
ALTER TABLE `vitehub_comment_threads` ADD `number` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `vitehub_comment_threads` ADD `metadata` text;--> statement-breakpoint
UPDATE `vitehub_comment_threads` SET `number` = (SELECT count(*) FROM `vitehub_comment_threads` AS `earlier` WHERE `earlier`.`scope` = `vitehub_comment_threads`.`scope` AND (`earlier`.`created_at` < `vitehub_comment_threads`.`created_at` OR (`earlier`.`created_at` = `vitehub_comment_threads`.`created_at` AND `earlier`.`id` <= `vitehub_comment_threads`.`id`)));--> statement-breakpoint
CREATE UNIQUE INDEX `vitehub_comment_threads_number` ON `vitehub_comment_threads` (`scope`,`number`);