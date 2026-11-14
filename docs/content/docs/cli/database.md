---
title: Database commands
description: Generate and apply Drizzle migrations, export and seed databases, and browse tables and rows of a running app with the vitehub CLI.
navigation.title: Database
navigation.order: 5
navigation.group: Commands
icon: i-lucide-database
---

The `vitehub database` commands take your schema to a live database and let you look inside it. Migrations, export, and seed need no build, and `tables` and `rows` read the running app.

## Manage Database migrations

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database generate --name add-audit-log
pnpm vitehub database generate --custom --name backfill-state
pnpm vitehub database generate --custom --schema-snapshot --name move-tables
pnpm vitehub database migrate
pnpm vitehub database up
```

`generate` and `migrate` refresh the Database Definitions, then run Drizzle Kit and pass on its arguments. When every Database is named, they run once per generated Drizzle config and stop at the first failure.

`--custom` creates an empty migration for SQL you write yourself. Drizzle Kit copies the previous snapshot into it, which suits SQL that changes only data. When your SQL changes the tables to match the current Definitions, add `--schema-snapshot`, so the migration gets their snapshot and the next `generate` has nothing to add.

`database up` converts each Drizzle Kit 0.x migrations folder, with `meta/_journal.json`, to the Drizzle Kit 1.0 layout of one folder per migration. `generate` and `migrate` refuse a 0.x folder with `DATABASE_MIGRATIONS_OLD_LAYOUT`.

## Export a Database

`database export` writes a SQL dump of each database. It reads the local SQLite file by default, and with `--remote` it reads Cloudflare D1 (through the Cloudflare API), D1 HTTP, remote libSQL, or Postgres (through `pg_dump`).

```bash [Terminal]
pnpm vitehub database export
pnpm vitehub database export --remote --stage production --output backups/database.sql
```

| Flag | What it does |
| --- | --- |
| `--remote` | Read the remote database. A database that is not a local file needs it. |
| `--stage <name>` | Load the Vite env files of this mode. Process variables win. |
| `--database <name>` | Export only this database. |
| `--output <file>` | Write this file. The default is `.vitehub/exports/database/<name>-<local\|remote>-<time>.sql`. |

See [Export a database](/docs/database/configure#export-a-database) for each driver and the dump format.

## Seed a Database

`database seed` runs the seed file of each database, `server/databases/<name>/seed.ts`, whose default export gets `{ db, schema }`. It writes the local database by default and refuses a database with pending migrations.

```bash [Terminal]
pnpm vitehub database seed
pnpm vitehub database seed --remote --stage staging --database analytics
```

It takes `--remote` to write the remote database, which a database that is not local needs, plus `--stage` and `--database` as `export` does. See [Seed data](/docs/database/configure#seed-data) for the seed file.

## Browse Database tables

`database tables` and `database rows` read the running app's Database Definitions, so they work on SQLite, D1, libSQL, and Postgres without a Drizzle Kit config. They never write.

```bash [Terminal]
pnpm vitehub database tables
pnpm vitehub database rows users --limit 20 --sort email --direction desc
pnpm vitehub database rows users --search ada --json
pnpm vitehub database rows users --database analytics --offset 20 --url https://app.example.com
```

`rows` reads at most 100 rows at a time, cuts cells at 32 KiB, and takes `--offset`, `--sort <column>`, `--direction asc|desc`, `--search <text>` to match any column, and `--database <name>`. Without a table it lists the tables, and an unknown table fails with `CONSOLE_NOT_FOUND`. Both commands are the `databases.tables` and `databases.browse` [operations](/docs/console/operations), so they need the `databases` Console section, and `databases:read` is enough.
