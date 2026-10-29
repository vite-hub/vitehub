---
title: Use Cloudflare D1 with ViteHub and Drizzle
description: Add D1 resource metadata to a ViteHub Database Definition, generate a Worker binding, and apply migrations with Wrangler.
navigation.title: Cloudflare D1
navigation.order: 13
navigation.group: Databases
icon: i-simple-icons-cloudflare
---

Use a native D1 binding when the app runs on Cloudflare Workers. ViteHub keeps
the Drizzle schema in a Database Definition and writes the binding into the
generated Worker configuration.

Start with [Save your first Database row](/docs/database/get-started). Keep its
SQLite schema and notes routes. Create a new D1 database for this check and
record its name and ID. Do not point these first migrations at an existing
database with its own migration history.

## Select Cloudflare and identify the database

Set `preset: 'cloudflare'` and `database: true` in the existing ViteHub config.
Add this literal `cloudflare` block to the tutorial's Database Definition:

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
	cloudflare: {
		binding: 'DB',
		databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
		databaseName: process.env.CLOUDFLARE_D1_DATABASE_NAME,
	},
	schema: {
		notes: sqliteTable('notes', {
			id: integer('id').primaryKey({ autoIncrement: true }),
			title: text('title').notNull(),
		}),
	},
})
```

Set both resource variables before the build. A native D1 deployment must
resolve the database ID and name. The binding name alone does not identify
the remote database.

## Generate and apply the D1 migration

Install Wrangler in the app if it is absent:

```bash [Terminal]
pnpm add -D wrangler
pnpm vitehub db generate
pnpm build
```

Inspect the `d1_databases` entry in `.output/server/wrangler.json`. Confirm the
database ID, name, binding, and migrations directory before applying SQL.

```bash [Terminal]
pnpm wrangler d1 migrations list "$CLOUDFLARE_D1_DATABASE_NAME" \
  --remote --config .output/server/wrangler.json
pnpm wrangler d1 migrations apply "$CLOUDFLARE_D1_DATABASE_NAME" \
  --remote --config .output/server/wrangler.json
```

Wrangler applies migrations for native bindings. `vitehub db migrate` is not
the native-binding migration runner. Review each pending migration first.

Deploy with `pnpm exec nitro deploy --prebuilt`. Call the notes POST and GET
routes on the Worker URL. Confirm that the inserted row appears in D1.

## Separate local and remote development

Without `cloudflare.http`, ordinary local development uses SQLite. A local row
does not prove that the remote D1 database has the same schema or data.

Use [D1 over HTTP](/docs/database/hosts) only when remote access is intentional.
Cloudflare's direct D1 REST API shares administrative API limits. For sustained
application traffic outside Workers, assess an authenticated proxy or a hosted
database such as [Turso](/docs/guides/turso).

Read [Database configuration](/docs/database/configure) for resource inheritance
and [Cloudflare D1 documentation](https://developers.cloudflare.com/d1/) for
current quotas and migration tools.
