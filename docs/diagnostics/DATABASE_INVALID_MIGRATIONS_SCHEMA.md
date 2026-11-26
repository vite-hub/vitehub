---
description: "Fix DATABASE_INVALID_MIGRATIONS_SCHEMA in ViteHub. Write migrationsSchema as a non-empty string literal in the Postgres Definition."
seo.title: "DATABASE_INVALID_MIGRATIONS_SCHEMA: invalid migrationsSchema"
---

`migrationsSchema` of a Postgres Definition is not a non-empty string. The build reads it from the source, so write a string literal. Remove it to keep the migrations table in the schema `drizzle`.
