import { describe, expect, it } from "vitest"

import { findDataLoss, splitSqlStatements, withoutNewTableDataLoss } from "../src/internal/migration-sql.ts"

function reasons(sql: string | string[], before?: Map<string, string[]>) {
  return findDataLoss(Array.isArray(sql) ? sql : [sql], before).map(loss => loss.reason)
}

describe("migration data loss", () => {
  it.each([
    ["DROP TABLE `notes`;", "drops table \"notes\""],
    ["DROP TABLE IF EXISTS \"public\".\"notes\" CASCADE;", "drops table \"notes\""],
    ["ALTER TABLE `notes` DROP COLUMN `body`;", "drops column \"body\" from \"notes\""],
    ["ALTER TABLE \"notes\" DROP COLUMN IF EXISTS \"body\";", "drops column \"body\" from \"notes\""],
    ["alter table notes drop body;", "drops column \"body\" from \"notes\""],
    ["TRUNCATE TABLE \"notes\";", "deletes every row of \"notes\""],
    ["DELETE FROM `notes`;", "deletes every row of \"notes\""],
    ["DELETE FROM \"where\";", "deletes every row of \"where\""],
    ["DROP SCHEMA \"reports\" CASCADE;", "drops schema \"reports\""],
  ])("flags %s", (sql, reason) => {
    expect(reasons(sql)).toEqual([reason])
  })

  it.each([
    "CREATE TABLE `notes` (`id` integer PRIMARY KEY NOT NULL);",
    "ALTER TABLE `notes` ADD `body` text;",
    "ALTER TABLE \"notes\" DROP CONSTRAINT \"notes_owner_fk\";",
    "ALTER TABLE \"notes\" ALTER COLUMN \"body\" DROP NOT NULL;",
    "ALTER TABLE \"notes\" DROP DEFAULT;",
    "DELETE FROM `notes` WHERE `id` = 1;",
    "DELETE FROM `notes` WHERE `label` = 'WHERE';",
    "DROP INDEX `notes_title_idx`;",
    "INSERT INTO `notes` (`title`) VALUES ('DROP TABLE notes; DELETE FROM notes');",
    "-- DROP TABLE notes;\nCREATE INDEX `notes_title_idx` ON `notes` (`title`);",
  ])("keeps %s", (sql) => {
    expect(reasons(sql)).toEqual([])
  })

  it("splits statements outside quotes and comments", () => {
    expect(splitSqlStatements("SELECT '; -- not a comment'; /* ; */ DROP TABLE `a``b`; -- ;\nSELECT 1")).toEqual(["SELECT '; -- not a comment';", "DROP TABLE `a``b`;", "SELECT 1"])
  })

  const rebuild = [
    "PRAGMA foreign_keys=OFF;",
    "CREATE TABLE `__new_notes` (\n\t`id` integer PRIMARY KEY NOT NULL,\n\t`title` text NOT NULL\n);\n",
    "INSERT INTO `__new_notes`(\"id\", \"title\") SELECT \"id\", \"title\" FROM `notes`;",
    "DROP TABLE `notes`;",
    "ALTER TABLE `__new_notes` RENAME TO `notes`;",
    "PRAGMA foreign_keys=ON;",
  ]

  it("accepts a SQLite table rebuild that copies every column", () => {
    expect(reasons(rebuild, new Map([["notes", ["id", "title"]]]))).toEqual([])
  })

  it("flags a SQLite table rebuild that leaves out a column", () => {
    expect(reasons(rebuild, new Map([["notes", ["id", "title", "body"]]]))).toEqual([
      "rebuilds table \"notes\" without column \"body\"",
    ])
  })

  it("flags a SQLite table rebuild when the previous columns are unknown", () => {
    expect(reasons(rebuild)).toEqual([
      "rebuilds table \"notes\", and ViteHub cannot confirm that the copy keeps every column",
    ])
  })

  describe("in one run of pending migrations", () => {
    function runLosses(...migrations: string[][]) {
      const run = migrations.map(statements => ({ dataLoss: findDataLoss(statements, new Map()), statements }))
      return withoutNewTableDataLoss(run).flatMap(migration => migration.dataLoss.map(loss => loss.reason))
    }

    const createNotes = ["CREATE TABLE `notes` (`id` integer PRIMARY KEY NOT NULL, `body` text);"]

    it("accepts data loss on tables that an earlier migration of the run created", () => {
      expect(runLosses(createNotes, ["INSERT INTO `notes` (`id`) VALUES (1);", "DROP TABLE `notes`;"])).toEqual([])
      expect(runLosses(createNotes, ["ALTER TABLE `notes` DROP COLUMN `body`;", "DELETE FROM notes;"])).toEqual([])
      expect(runLosses(createNotes, ["ALTER TABLE `notes` RENAME TO `posts`;"], ["DROP TABLE `posts`;"])).toEqual([])
      expect(runLosses(createNotes, ["DROP TABLE `notes`;"], ["DROP TABLE IF EXISTS `notes`;"])).toEqual([])
    })

    it("accepts a rebuild of a table that the run created, and a drop after it", () => {
      expect(runLosses(createNotes, rebuild, ["DROP TABLE `notes`;"])).toEqual([])
    })

    it("accepts a drop after a trigger that writes into another table", () => {
      const trigger = "CREATE TRIGGER `count_views` AFTER INSERT ON `views` BEGIN\n  INSERT OR IGNORE INTO `totals` (`id`, `n`) VALUES (NEW.id, 0);\n  UPDATE `totals` SET `n` = `n` + 1 WHERE `id` = NEW.id;\nEND;"
      expect(runLosses([...createNotes, trigger], ["DROP TABLE `notes`;"])).toEqual([])
    })

    it("flags data loss on tables that existed before the run", () => {
      expect(runLosses(["DROP TABLE `notes`;"])).toEqual(["drops table \"notes\""])
      expect(runLosses(["CREATE TABLE IF NOT EXISTS `notes` (`id` integer);"], ["DROP TABLE `notes`;"])).toEqual(["drops table \"notes\""])
      expect(runLosses(createNotes, ["DROP TABLE `notes`, `users`;"])).toEqual(["drops table \"notes\"; drops table \"users\""])
      expect(runLosses(createNotes, ["DROP SCHEMA `main`;"])).toEqual(["drops schema \"main\""])
    })

    it("flags data loss on a new table that holds rows of an older table", () => {
      expect(runLosses(rebuild, ["DROP TABLE `notes`;"])).toEqual([
        "rebuilds table \"notes\", and ViteHub cannot confirm that the copy keeps every column",
        "drops table \"notes\"",
      ])
      expect(runLosses(createNotes, ["INSERT INTO `notes` SELECT * FROM `users`;", "DROP TABLE `notes`;"])).toEqual(["drops table \"notes\""])
      expect(runLosses(createNotes, ["UPDATE `notes` SET `body` = (SELECT `name` FROM `users`);", "DROP TABLE `notes`;"])).toEqual(["drops table \"notes\""])
      expect(runLosses(["CREATE TABLE `copy` AS SELECT * FROM `users`;", "DROP TABLE `copy`;"])).toEqual(["drops table \"copy\""])
      expect(runLosses([...createNotes, "CREATE TABLE `copy` (`id` integer);"], ["INSERT INTO `copy` SELECT `id` FROM `notes`, `users`;", "DROP TABLE `copy`;"])).toEqual(["drops table \"copy\""])
      expect(runLosses(["CREATE TABLE `posts` (`id` integer);", "DROP TABLE `posts`;"], ["ALTER TABLE `users` RENAME TO `posts`;"], ["DROP TABLE `posts`;"])).toEqual(["drops table \"posts\""])
      expect(runLosses(createNotes, ["CREATE TRIGGER `copy_users` AFTER INSERT ON `users` BEGIN INSERT INTO `notes` SELECT * FROM `users`; END;"], ["DROP TABLE `notes`;"])).toEqual(["drops table \"notes\""])
    })
  })
})
