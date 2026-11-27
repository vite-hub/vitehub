---
description: "Fix DATABASE_MIGRATION_SCHEMA_CONFLICT in ViteHub. Definitions on one Postgres database must set the same migrationsSchema."
seo.title: "DATABASE_MIGRATION_SCHEMA_CONFLICT"
---

Two Definitions on one Postgres database set different `migrationsSchema` values. They share one migrations table, so set the same value on each, or remove it from all of them.
