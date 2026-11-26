---
description: "Fix DATABASE_MIGRATION_LEDGER_MISPLACED in ViteHub. Move the Drizzle migrations table into migrationsSchema, so applied migrations do not run again."
seo.title: "DATABASE_MIGRATION_LEDGER_MISPLACED"
---

A Postgres Definition sets `migrationsSchema`, but Drizzle's migrations table in the schema `drizzle` lists applied migrations that the table in `migrationsSchema` does not list. ViteHub would apply them again, so it stops before any change.

Move the table with the command in the fix, such as `vitehub database sql 'ALTER TABLE "drizzle"."__drizzle_migrations" SET SCHEMA "app"'`, or remove `migrationsSchema`. When both tables exist, the fix copies the missing rows instead. A table in `drizzle` that lists none of these migrations, such as the table of another app, does not block. See [Keep the migrations table in a schema](/docs/database/configure#keep-the-migrations-table-in-a-schema).
