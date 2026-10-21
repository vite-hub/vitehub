import { describe, expect, it } from "vitest"

import { findDataLoss, splitSqlStatements } from "../src/internal/migration-sql.ts"

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
})
