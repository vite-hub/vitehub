---
title: Use Neon Postgres with ViteHub
description: Configure a Postgres Database Definition for Neon, generate Drizzle migrations, and query rows through ViteHub.
navigation.title: Neon Postgres
navigation.order: 12
navigation.group: Databases
icon: i-lucide-database
---

Use Neon through ViteHub's Postgres driver. The driver uses postgres.js and
Drizzle. This path does not use the Neon HTTP or WebSocket driver.

Start with the Vite app from [Installation](/docs/getting-started/installation).
Create a Neon database branch for this check. Obtain a connection string from
Neon's dashboard and keep its required TLS parameters.

## Install the Postgres dependencies

```bash [Terminal]
pnpm add postgres drizzle-orm
pnpm add -D drizzle-kit
```

Enable `database: true` in your existing ViteHub options. Use `preset: 'node'`
for the first check.

## Define a Postgres table

Create `server/databases/config.ts`. If you already have a default Definition,
change that file instead of adding a second one.

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'
import { pgTable, serial, text } from 'drizzle-orm/pg-core'

export default defineDatabase({
	dialect: 'postgresql',
	connection: { url: process.env.DATABASE_URL },
	schema: {
		notes: pgTable('notes', {
			id: serial('id').primaryKey(),
			title: text('title').notNull(),
		}),
	},
})
```

Use the PostgreSQL schema builders from `pg-core`. A SQLite schema does not
become a Postgres schema when you change the URL.

Set `DATABASE_URL` in the migration shell and in the application's server
environment. Keep it out of source control and client code.

## Apply migrations and query the database

Generate a fresh Postgres migration history for the new database. Do not apply
SQLite migration files to Postgres.

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate --dry-run
pnpm vitehub db migrate
```

Use the notes POST and GET routes from
[Save your first Database row](/docs/database/get-started). Those Drizzle
queries work with this `notes` table. Start the app, insert one note, and read
it back. Check the row in the selected Neon branch.

## Choose the host connection

On Node, ViteHub uses a process-level Postgres pool. On Vercel, supply
`connection.url` in the deployed server environment. Choose the connection
endpoint according to [Neon's connection guidance](https://neon.com/docs/connect/connect-from-any-app).

For Cloudflare Workers, check the
[Postgres and Hyperdrive contract](https://github.com/vite-hub/vitehub/tree/main/packages/database#postgres).
A configured Hyperdrive binding takes precedence over the direct URL. Workers
use a client per request instead of sharing sockets across requests.

This guide configures a Postgres connection. It does not provision Neon branches
or provide Neon-specific management APIs. Read
[Database configuration](/docs/database/configure) for migration behavior.
