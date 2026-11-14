---
title: Database commands
description: Generate and apply Drizzle migrations, export and seed databases, and browse tables and rows of a running app with the vitehub CLI.
navigation.title: Database
navigation.order: 5
navigation.group: Commands
icon: i-lucide-database
---

The `vitehub database` commands come from the Database package and the framework. Migrations, export, and seed work on files and need no build. `tables` and `rows` read the running app.

## Manage Database migrations

The Database commands refresh the Database Definitions, then run Drizzle Kit. When every Database is named, ViteHub runs once per generated Drizzle config and stops at the first failure.

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database generate --name add-audit-log
pnpm vitehub database generate --custom --name backfill-state
pnpm vitehub database generate --custom --schema-snapshot --name move-tables
pnpm vitehub database migrate
pnpm vitehub database up
```

`database up` converts each migrations folder of Drizzle Kit 0.x, with `meta/_journal.json`, to one folder per migration, as Drizzle Kit 1.0 writes them. `database generate` and `database migrate` refuse a 0.x folder with `DATABASE_MIGRATIONS_OLD_LAYOUT`.

`database generate` forwards Drizzle Kit arguments, supports `--name <name>` for a migration name, and uses `--custom` to create an empty custom migration. Drizzle Kit copies the previous snapshot into a custom migration, for SQL that changes only data. When the SQL changes the tables to the current Database Definitions, add `--schema-snapshot`: the migration then gets the snapshot of those Definitions, so the next `database generate` has nothing to add. `database migrate` accepts forwarded Drizzle Kit migration arguments.

## Export a Database

`database export` writes a SQL dump of each database, with no build. It reads the local SQLite file by default. `--remote` reads Cloudflare D1 (through the Cloudflare API), D1 HTTP, remote libSQL, or Postgres (through `pg_dump`).

```bash [Terminal]
pnpm vitehub database export
pnpm vitehub database export --remote --stage production --output backups/database.sql
```

| Option | Description |
| --- | --- |
| `--remote` | Read the remote database. Needed for a database that is not a local file. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Export only this database. |
| `--output <file>` | Write this file. Defaults to `.vitehub/exports/database/<name>-<local\|remote>-<time>.sql`. |

See [Export a database](/docs/database/configure#export-a-database) for each driver and the dump format.

## Seed a Database

`database seed` runs the seed file of each database, `server/databases/<name>/seed.ts`, with no build. Its default export gets `{ db, schema }`. It writes the local database by default, and refuses a database with pending migrations.

```bash [Terminal]
pnpm vitehub database seed
pnpm vitehub database seed --remote --stage staging --database analytics
```

| Option | Description |
| --- | --- |
| `--remote` | Write the remote database. Needed for a database that is not local. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Seed only this database. |

See [Seed data](/docs/database/configure#seed-data) for the seed file.

## Browse Database tables

`database tables` and `database rows` run `databases.tables` and `databases.browse`, the [operations](/docs/console/operations) of the Console Databases section. They read the running app's Database Definitions, so they work on SQLite, D1, libSQL, and Postgres without a Drizzle Kit config. They never write.

```bash [Terminal]
pnpm vitehub database tables
pnpm vitehub database rows users --limit 20 --sort email --direction desc
pnpm vitehub database rows users --search ada --json
pnpm vitehub database rows users --database analytics --offset 20 --url https://app.example.com
```

`database rows` reads at most 100 rows at a time and cuts cells at 32 KiB. `--offset` pages, `--sort <column>` and `--direction asc|desc` sort, and `--search <text>` matches any column. Without a table, it reads the tables only. A table that does not exist fails with `CONSOLE_NOT_FOUND`. `--database` picks a named database. Access needs the `databases` section, and `databases:read` is enough.
