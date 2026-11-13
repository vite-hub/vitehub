---
title: Use Turso with ViteHub and Drizzle
description: Connect a ViteHub Database to hosted libSQL on Turso, apply Drizzle migrations, and query it from server routes.
navigation.title: Turso
navigation.order: 11
navigation.group: Databases
icon: i-lucide-database
---

Use Turso for hosted libSQL with your SQLite Drizzle schema. ViteHub connects
through its libSQL driver. It does not copy local rows to Turso.

First, complete [Save your first Database row](/docs/database/get-started) and
keep its Database Definition and notes routes. Create a new Turso database and
copy its URL and auth token.

## Configure the hosted connection

Read the values from the environment at runtime, not the build config.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
import { env } from 'vite-hub/env'

export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
  	host: 'node',
  	database: {
  		connection: {
  			url: env({ source: env.source('TURSO_DATABASE_URL') }),
  			authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
  		},
  	},
  },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
	plugins: [vitehub({
		host: 'node',
		database: {
			connection: {
				url: env({ source: env.source('TURSO_DATABASE_URL') }),
				authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
			},
		},
	}), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
	plugins: [vitehub({
		host: 'node',
		database: {
			connection: {
				url: env({ source: env.source('TURSO_DATABASE_URL') }),
				authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
			},
		},
	})],
})
```
:::
::

A connection in the Database Definition wins over these options. If the app
still reads SQLite, remove the old connection from the Definition.

Set the variables in the migration shell and the server environment:

```bash [Terminal]
export TURSO_DATABASE_URL='libsql://your-database.turso.io'
export TURSO_AUTH_TOKEN='your-auth-token'
```

For Vercel, use `host: 'vercel'` with the same connection and routes. The
provider stays Turso.

## Apply the schema and check a row

Generate a migration if the schema changed. Review the SQL before you apply it:

```bash [Terminal]
pnpm vitehub database generate
pnpm vitehub database migrate --dry-run
pnpm vitehub database migrate
pnpm dev
```

In another terminal, call the notes routes:

```bash [Terminal]
curl --fail-with-body http://localhost:3000/api/notes \
  -H 'content-type: application/json' -d '{"title":"Stored in Turso"}'
curl --fail-with-body http://localhost:3000/api/notes
```

The read includes the note. Restart, repeat the GET, and find the row in Turso.
An older database can return more rows.

## Diagnose connection errors

- Missing table: the database lacks the migration. Check the URL before you
  apply SQL.
- Authentication error: use a valid token for that database.
- Local rows: a Definition probably overrides the hosted connection.

Back up a database before you change its schema. See
[Database configuration](/docs/database/configure) for migration checks and the
[Turso docs](https://docs.turso.tech/) for access and limits.
