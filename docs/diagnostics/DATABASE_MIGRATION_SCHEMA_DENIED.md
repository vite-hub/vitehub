---
description: "Fix DATABASE_MIGRATION_SCHEMA_DENIED in ViteHub. Grant the Postgres role USAGE or CREATE for the migrations table, or set migrationsSchema."
seo.title: "DATABASE_MIGRATION_SCHEMA_DENIED"
---

The Postgres role cannot use the schema of Drizzle's migrations table. ViteHub checks this before it reads the table, and stops before any change, on start, in `vitehub database migrate`, and in `--dry-run`. `error.why` names the role and the missing privilege:

- No `USAGE` on the schema, so the role cannot read the table.
- The schema `drizzle` is missing, and the role has no `CREATE` on the database to create it.
- The table is missing, and the role has no `CREATE` on its schema to create it.

As a role that owns the database, run the `GRANT` in the fix in a SQL client. Or run it with `vitehub database sql --remote --database default 'GRANT CREATE ON DATABASE "app" TO "app_user"'`, with that role in `connection.url`. Or set [`migrationsSchema`](/docs/database/configure#keep-the-migrations-table-in-a-schema) to an existing schema where the role has `USAGE` and `CREATE`.

A runtime role that only reads an existing table needs `USAGE` on its schema and `SELECT` on the table. It needs no `CREATE`. See [Several instances on Postgres](/docs/database/configure#several-instances-on-postgres).
