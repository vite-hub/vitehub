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

    function runPostgresLosses(...migrations: string[][]) {
      const run = migrations.map(statements => ({ dataLoss: findDataLoss(statements, new Map()), statements }))
      return withoutNewTableDataLoss(run, "postgresql").flatMap(migration => migration.dataLoss.map(loss => loss.reason))
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

    it.each([
      "TABLE users",
      "TABLE ONLY \"public\".\"users\"",
      "TABLE notes UNION ALL TABLE users",
    ])("flags a copy of older rows with %s", (query) => {
      expect(runLosses(createNotes, [`CREATE TABLE copy AS ${query};`, "DROP TABLE copy;"])).toEqual(["drops table \"copy\""])
      expect(runLosses(
        [...createNotes, "CREATE TABLE copy (id integer);", "DROP TABLE copy;"],
        [`CREATE TABLE copy AS ${query};`, "DROP TABLE copy;"],
      )).toEqual(["drops table \"copy\""])
    })

    it("accepts a TABLE query that only copies rows from a table created by the run", () => {
      expect(runLosses(createNotes, ["CREATE TABLE copy AS TABLE notes;", "DROP TABLE copy;"])).toEqual([])
    })

    it("flags older rows copied by INSERT with a TABLE query", () => {
      expect(runLosses(createNotes, ["INSERT INTO notes TABLE users;", "DROP TABLE notes;"])).toEqual(["drops table \"notes\""])
    })

    it.each([
      "TRUNCATE TABLE ONLY notes, ONLY users;",
      "TRUNCATE ONLY notes, ONLY users;",
      "TRUNCATE TABLE ONLY notes, ONLY users RESTART IDENTITY;",
    ])("checks every target of %s", (statement) => {
      expect(runLosses(createNotes, [statement])).toEqual(["deletes every row of \"notes\"; deletes every row of \"users\""])
      expect(runLosses([...createNotes, "CREATE TABLE users (id integer);"], [statement])).toEqual([])
    })

    it("records qualified TRUNCATE targets separately", () => {
      const statement = "TRUNCATE TABLE ONLY \"public\".\"notes\", ONLY \"public\".\"users\";"
      expect(findDataLoss([statement])).toEqual([{
        reason: "deletes every row of \"notes\"; deletes every row of \"users\"",
        statement,
        tables: ["public.notes", "public.users"],
      }])
    })

    it.each(["notes", '"notes"'])("retains unqualified PostgreSQL losses on %s across search_path schemas", (name) => {
      // The first drop can expose an older table of the same name in a later search_path schema.
      expect(runPostgresLosses(
        [`CREATE TABLE ${name} (id integer);`],
        [`DROP TABLE ${name};`, `DROP TABLE ${name};`],
      )).toEqual(['drops table "notes"', 'drops table "notes"'])
    })

    it("accepts PostgreSQL losses with a stable schema-qualified identity", () => {
      expect(runPostgresLosses(
        ['CREATE TABLE "public"."notes" (id integer);'],
        ["TRUNCATE ONLY public.notes RESTRICT;", "DROP TABLE public.notes;", "DROP TABLE IF EXISTS public.notes;"],
      )).toEqual([])
    })

    it("does not confuse a PostgreSQL table name containing a dot with a qualified name", () => {
      expect(runPostgresLosses(
        ['CREATE TABLE "public.notes" (id integer);'],
        ['DROP TABLE "public.notes";', 'DROP TABLE "public.notes";'],
      )).toEqual(['drops table "public.notes"', 'drops table "public.notes"'])
    })

    it("retains a qualified PostgreSQL copy when its unqualified source can resolve elsewhere", () => {
      expect(runPostgresLosses(
        ["CREATE TABLE public.notes (id integer);", "CREATE TABLE public.copy AS TABLE notes;"],
        ["DROP TABLE public.copy;"],
      )).toEqual(['drops table "copy"'])
    })

    it.each([
      "INSERT INTO notes SELECT * FROM public.users;",
      "UPDATE notes SET id = (SELECT max(id) FROM public.users);",
    ])("invalidates qualified PostgreSQL tables after an unqualified write: %s", (statement) => {
      expect(runPostgresLosses(["CREATE TABLE public.notes (id integer);"], [statement, "DROP TABLE public.notes;"])).toEqual(['drops table "notes"'])
    })

    it("invalidates a qualified PostgreSQL name after renaming an older table to it", () => {
      expect(runPostgresLosses(
        ["CREATE TABLE public.notes (id integer);", "DROP TABLE public.notes;"],
        ["ALTER TABLE public.users RENAME TO notes;"],
        ["DROP TABLE public.notes;"],
      )).toEqual(['drops table "notes"'])
    })

    it.each([
      "TRUNCATE public.fresh CASCADE;",
      "TRUNCATE TABLE ONLY public.fresh RESTART IDENTITY CASCADE;",
      "TRUNCATE public.fresh;",
      "TRUNCATE TABLE public.fresh * RESTRICT;",
      "TRUNCATE TABLE ONLY public.fresh, public.other;",
    ])("retains implicit PostgreSQL targets of %s", (statement) => {
      const losses = runPostgresLosses(
        ["CREATE TABLE public.fresh (id integer PRIMARY KEY);", "INSERT INTO public.fresh VALUES (1);", "CREATE TABLE public.other (id integer);"],
        ["ALTER TABLE public.existing ADD CONSTRAINT fresh_fk FOREIGN KEY (id) REFERENCES public.fresh (id);"],
        [statement],
      )
      expect(losses).toEqual([statement.includes("public.other")
        ? 'deletes every row of "fresh"; deletes every row of "other"'
        : 'deletes every row of "fresh"'])
      expect(findDataLoss([statement])[0]?.tables).toEqual([])
    })

    it("does not treat a quoted TRUNCATE target as a CASCADE clause", () => {
      expect(runPostgresLosses(['CREATE TABLE public."cascade" (id integer);'], ['TRUNCATE ONLY public."cascade";'])).toEqual([])
    })

    it.each(["TRUNCATE public.fresh;", "DELETE FROM public.fresh;"])("retains %s after adding a pre-existing descendant", (statement) => {
      expect(runPostgresLosses(
        ["CREATE TABLE public.fresh (id integer);"],
        ["ALTER TABLE public.existing INHERIT public.fresh;"],
        [statement],
      )).toEqual(['deletes every row of "fresh"'])
    })

    it("flags truncation after attaching a pre-existing partition", () => {
      expect(runLosses(
        ["CREATE TABLE fresh (id integer) PARTITION BY RANGE (id);"],
        ["ALTER TABLE fresh ATTACH PARTITION existing FOR VALUES FROM (0) TO (100);"],
        ["TRUNCATE TABLE fresh;"],
      )).toEqual(["deletes every row of \"fresh\""])
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
