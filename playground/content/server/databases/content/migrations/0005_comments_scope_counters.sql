CREATE TABLE `vitehub_comment_scope_counters` (
  `scope` text PRIMARY KEY NOT NULL,
  `last_number` integer NOT NULL
);--> statement-breakpoint
INSERT INTO `vitehub_comment_scope_counters` (`scope`, `last_number`)
SELECT `scope`, max(`number`) FROM `vitehub_comment_threads` GROUP BY `scope`
ON CONFLICT (`scope`) DO UPDATE SET `last_number` = max(`last_number`, excluded.`last_number`);
