---
description: "Fix DATABASE_MIGRATION_SCHEMA_MISSING in ViteHub. Create the schema that migrationsSchema names, because ViteHub does not create it on a Postgres server."
seo.title: "DATABASE_MIGRATION_SCHEMA_MISSING"
---

A Postgres Definition sets `migrationsSchema`, but the database has no schema with that name. On a Postgres server, ViteHub does not create a schema that you choose, and it stops before any change. On PGlite, it creates the schema.

Create the schema as a role that owns the database, such as `vitehub database sql 'CREATE SCHEMA "app"'`, or fix the name. See [Keep the migrations table in a schema](/docs/database/configure#keep-the-migrations-table-in-a-schema).
