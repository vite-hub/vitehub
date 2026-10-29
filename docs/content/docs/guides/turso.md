---
title: Use Turso with ViteHub and Drizzle
description: Connect a ViteHub Database to hosted libSQL on Turso, apply Drizzle migrations, and query it from server routes.
navigation.title: Turso
navigation.order: 11
navigation.group: Databases
icon: i-lucide-database
---

Use Turso when you want hosted libSQL while keeping a SQLite Drizzle schema.
ViteHub connects through its libSQL driver. It does not move existing local rows
to the hosted database.

Complete [Save your first Database row](/docs/database/get-started). Keep its
Database Definition and notes routes. Create a separate Turso database for this
check and obtain its URL and authentication token.

## Configure the hosted connection

Enable Database and declare runtime environment sources. Keep secrets out of
literal build configuration.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'
import { env } from 'vite-hub/env'

export default defineConfig({
	plugins: [vitehub({
		preset: 'node',
		database: {
			connection: {
				url: env({ source: env.source('TURSO_DATABASE_URL') }),
				authToken: env({ secret: true, source: env.source('TURSO_AUTH_TOKEN') }),
			},
		},
	})],
})
```

A connection declared on a Database Definition takes precedence over matching
integration options. Remove an old local connection from the Definition if the
app still reads SQLite.

Set the variables in the shell used for migrations and in the deployment's
server environment:

```bash [Terminal]
export TURSO_DATABASE_URL='libsql://your-database.turso.io'
export TURSO_AUTH_TOKEN='your-auth-token'
```

Use `preset: 'vercel'` for a Vercel build. Keep the same connection declaration
and routes. The provider remains Turso.

## Apply the schema and check a row

Generate the migration if your schema has changed. Review the SQL before
applying it to the new hosted database:

```bash [Terminal]
pnpm vitehub db generate
pnpm vitehub db migrate --dry-run
pnpm vitehub db migrate
pnpm dev
```

Call the notes routes in another terminal:

```bash [Terminal]
curl --fail-with-body http://localhost:3000/api/notes \
  -H 'content-type: application/json' -d '{"title":"Stored in Turso"}'
curl --fail-with-body http://localhost:3000/api/notes
```

The read includes the new note. Restart the app and repeat the GET request.
Confirm the same row in Turso. An existing database can return additional rows.

## Diagnose connection errors

- A missing table means the target database lacks the migration. Check the URL
  before applying SQL.
- An authentication error requires a valid token for that database.
- Unexpected local rows usually mean a Definition overrides the hosted connection.

Back up an existing database before changing its schema. Read
[Database configuration](/docs/database/configure) for migration checks and
[Turso documentation](https://docs.turso.tech/) for current database access and
service limits.
