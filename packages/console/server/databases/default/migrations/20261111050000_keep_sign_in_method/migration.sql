-- SQLite serializes writes. Check and deletion belong to the same statement on libSQL, SQLite, and D1.
-- A cascading user deletion has already removed its parent row and must still be allowed.
CREATE TRIGGER `console_keep_last_passkey`
BEFORE DELETE ON `passkey`
WHEN EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
  AND NOT EXISTS (SELECT 1 FROM `passkey` WHERE `user_id` = OLD.`user_id` AND `id` <> OLD.`id`)
  AND NOT EXISTS (SELECT 1 FROM `account` WHERE `user_id` = OLD.`user_id` AND `provider_id` = 'github')
BEGIN
  SELECT RAISE(ABORT, 'Keep one way to sign in.');
END;
--> statement-breakpoint
-- Provider unlinking must not race the deletion of the last passkey either.
CREATE TRIGGER `console_keep_last_github`
BEFORE DELETE ON `account`
WHEN OLD.`provider_id` = 'github'
  AND EXISTS (SELECT 1 FROM `user` WHERE `id` = OLD.`user_id`)
  AND NOT EXISTS (SELECT 1 FROM `passkey` WHERE `user_id` = OLD.`user_id`)
  AND NOT EXISTS (SELECT 1 FROM `account` WHERE `user_id` = OLD.`user_id` AND `provider_id` = 'github' AND `id` <> OLD.`id`)
BEGIN
  SELECT RAISE(ABORT, 'Keep one way to sign in.');
END;
