---
title: Use Cloudflare D1 with ViteHub and Drizzle
description: Add D1 resource metadata to a ViteHub Database Definition, generate a Worker binding, and apply migrations with Wrangler.
navigation.title: Cloudflare D1
navigation.order: 13
navigation.group: Databases
icon: i-simple-icons-cloudflare
---

Use a native D1 binding when your app runs on Cloudflare Workers. ViteHub
writes the binding into the generated Worker config.

Start with [Save your first Database row](/docs/database/get-started) and keep
its schema and notes routes.

## Create the D1 database

A Cloudflare production build needs the database name and ID, so create the
database before the first build. Without the ID, the build stops with
[`DATABASE_MISSING_D1_RESOURCE`](/docs/database/limits-and-errors#database_missing_d1_resource).
Development does not need the database.

Create a new database with Wrangler, and note the name and the `database_id`
in the output:

```bash [Terminal]
pnpm add -D wrangler
pnpm wrangler d1 create app-db
```

Do not use a database that has its own migration history.

## Select Cloudflare and identify the database

Set `host: 'cloudflare'` and `database: true` in your ViteHub config. Add
this `cloudflare` block to the Database Definition:

```ts [server/databases/default.ts]
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

Set both variables before you build. The binding name alone does not identify
the remote database.

ViteHub can also create the database. Set only the name, then run
[`vitehub provision run --provider cloudflare`](/docs/development/provisioning).
It writes the ID to `.vitehub/provision.json`, and the build reads it there.

## Generate and apply the D1 migration

Generate the migration and build:

```bash [Terminal]
pnpm vitehub database generate
pnpm build
```

Before you apply SQL, check the ID, name, binding, and migrations directory in
the `d1_databases` entry of `.output/server/wrangler.json`.

```bash [Terminal]
pnpm wrangler d1 migrations list "$CLOUDFLARE_D1_DATABASE_NAME" \
  --remote --config .output/server/wrangler.json
pnpm wrangler d1 migrations apply "$CLOUDFLARE_D1_DATABASE_NAME" \
  --remote --config .output/server/wrangler.json
```

Wrangler applies migrations for native bindings, not `vitehub database migrate`.
Review each pending migration first.

Deploy with `pnpm exec nitro deploy --prebuilt`. Call the notes POST and GET
routes on the Worker URL, and check that the row is in D1.

## Separate local and remote development

Without `cloudflare.http`, local dev uses SQLite. A local row does not prove
that remote D1 has the same schema or data.

Use [D1 over HTTP](/docs/database/hosts) only on purpose. It shares
Cloudflare's admin API limits. For steady traffic from outside Workers, use an
authenticated proxy or a hosted database such as [Turso](/docs/guides/turso).

See [Database configuration](/docs/database/configure) for resource inheritance
and the [Cloudflare D1 docs](https://developers.cloudflare.com/d1/) for quotas
and migration tools.
