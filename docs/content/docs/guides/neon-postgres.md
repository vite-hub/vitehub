---
title: Use Neon Postgres with ViteHub
description: Configure a Postgres Database Definition for Neon, generate Drizzle migrations, and query rows through ViteHub.
navigation.title: Neon Postgres
navigation.order: 12
navigation.group: Databases
icon: i-lucide-database
---

Use Neon through ViteHub's Postgres driver, which uses postgres.js and
Drizzle, not the Neon HTTP or WebSocket driver.

Start with the app from [Installation](/docs/getting-started/installation).
Create a Neon branch for this check. Copy its connection string from the Neon
dashboard, with its TLS parameters.

## Install the Postgres dependencies

```bash [Terminal]
pnpm add postgres drizzle-orm
pnpm add -D drizzle-kit
```

Set `database: true` and `host: 'node'` in your ViteHub options.

## Define a Postgres table

Create the Database Definition `server/databases/default.ts`. If it exists,
change it instead of adding a second one.

```ts [server/databases/default.ts]
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

Use the schema builders from `pg-core`. Changing the URL does not turn a SQLite
schema into a Postgres one.

Set `DATABASE_URL` in the migration shell and the server environment. Keep it
out of Git and client code.

## Apply migrations and query the database

Generate a new Postgres migration history. Do not apply SQLite migrations to
Postgres.

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database migrate --dry-run
pnpm vitehub database migrate
```

The notes POST and GET routes from
[Save your first Database row](/docs/database/get-started) work with this
table. Start the app, insert a note, read it back, and find the row in your
Neon branch.

## Choose the host connection

On Node, ViteHub uses one Postgres pool per process. On Vercel, set
`connection.url` in the server environment. Pick the endpoint with
[Neon's connection guide](https://neon.com/docs/connect/connect-from-any-app).

For Cloudflare Workers, check the
[Postgres and Hyperdrive contract](https://github.com/vite-hub/vitehub/tree/main/packages/database#postgres).
A Hyperdrive binding wins over the direct URL. Workers use one client per
request and do not share sockets.

ViteHub does not create Neon branches or offer Neon management APIs. See
[Database configuration](/docs/database/configure) for migrations.
