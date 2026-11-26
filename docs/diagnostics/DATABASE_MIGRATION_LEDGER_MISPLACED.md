---
description: "Fix DATABASE_MIGRATION_LEDGER_MISPLACED in ViteHub. Copy the rows that drizzle records to the migrationsSchema ledger, or change the SQL of a new folder."
seo.title: "DATABASE_MIGRATION_LEDGER_MISPLACED"
---

A Postgres Definition sets `migrationsSchema`, and the migrations table in that schema does not list some of its migrations. Drizzle's migrations table in the schema `drizzle` may list them, so the database probably applied them before `migrationsSchema` was set. ViteHub reads only the table in `migrationsSchema`, so it could apply them again. It stops before any change, in `--dry-run` too. ViteHub never reads history from `drizzle` to mark a migration applied, and never writes to it.

ViteHub compares each row in `drizzle` with the local migration folders:

- A row with a name records the folder of that name only when its SQL hash is the hash of that folder.
- A row without a name, from Drizzle Kit 0.x, records the one folder with the same SQL hash and the same `created_at` second.
- A row that records no folder cannot say which folder ran. It lists a folder name with other SQL, for example because the file was edited after it ran or another app has a migration with the same name, or it lists SQL under a name that no folder has, for example because the folder was renamed. The folder of that name, and a pending migration with that SQL hash, are unverified.

ViteHub stops when a pending migration is recorded or unverified. A new folder with the SQL of an applied migration still runs when the row in `drizzle` records the applied folder.

For a recorded migration, verify that this database applied it, because another app that shares `drizzle` can apply the same migrations. Then run the SQL in the fix once, as a role that can create tables in the schema. It creates the table in `migrationsSchema` and inserts one row for each recorded migration.

The fix prints no row for an unverified migration, because `drizzle` does not show that its exact SQL ran. A hash or a name alone can only stop a migration, never mark one applied. If the folder is new, change its SQL text, for example with a SQL comment. If it ran on this database, insert its row into the table in `migrationsSchema` by hand.

An empty table in `migrationsSchema` does not prove that the table in `drizzle` is safe to use. Only remove `migrationsSchema` if you have verified that `drizzle` lists all migrations this app has applied and does not mistake another app's migrations for yours. If the chosen ledger already lists migrations or the guard cannot verify a match, keep `migrationsSchema` and verify your history before recording any row.

See [Keep the migrations table in a schema](/docs/database/configure#keep-the-migrations-table-in-a-schema).
