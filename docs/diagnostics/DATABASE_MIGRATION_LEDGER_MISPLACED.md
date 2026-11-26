---
description: "Fix DATABASE_MIGRATION_LEDGER_MISPLACED in ViteHub. Let the role read the Drizzle migrations table in drizzle, so applied migrations do not run again."
seo.title: "DATABASE_MIGRATION_LEDGER_MISPLACED"
---

A Postgres Definition sets `migrationsSchema`, and the migrations table in that schema lists none of its migrations. Drizzle's migrations table in the schema `drizzle` can list them, but the role cannot read it. ViteHub cannot tell which migrations ran, so it stops before any change.

Run the `GRANT` statements in the fix once, as the owner of the schema `drizzle`, such as `vitehub database sql 'GRANT USAGE ON SCHEMA "drizzle" TO "app_runtime"'` and `vitehub database sql 'GRANT SELECT ON "drizzle"."__drizzle_migrations" TO "app_runtime"'`. ViteHub then records the migrations that the table in `drizzle` lists in the table in `migrationsSchema`. It does not change the table in `drizzle`, because another app can use it. When the table in `migrationsSchema` lists every migration, ViteHub does not read `drizzle`. See [Keep the migrations table in a schema](/docs/database/configure#keep-the-migrations-table-in-a-schema).
