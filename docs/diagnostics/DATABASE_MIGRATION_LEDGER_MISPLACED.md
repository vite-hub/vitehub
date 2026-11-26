---
description: "Fix DATABASE_MIGRATION_LEDGER_MISPLACED in ViteHub. Copy the rows from drizzle to the migrationsSchema ledger, or remove migrationsSchema."
seo.title: "DATABASE_MIGRATION_LEDGER_MISPLACED"
---

A Postgres Definition sets `migrationsSchema`, and the migrations table in that schema does not list some of its migrations. Drizzle's migrations table in the schema `drizzle` lists the same SQL by hash, so the database probably applied them before `migrationsSchema` was set. ViteHub reads only the table in `migrationsSchema`, so it would apply them again. It stops before any change, in `--dry-run` too. ViteHub never reads history from `drizzle` and never writes to it.

Remove `migrationsSchema` to keep the table in `drizzle`. Or verify that this database applied the listed migrations, because another app that shares `drizzle` can apply the same SQL. Then run the SQL in the fix once, as a role that can create tables in the schema. It creates the table in `migrationsSchema` and inserts one row for each listed migration. See [Keep the migrations table in a schema](/docs/database/configure#keep-the-migrations-table-in-a-schema).
