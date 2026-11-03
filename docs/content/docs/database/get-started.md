---
title: Save your first Database row
description: Create a local SQLite table, insert a note, and read it through a separate API route.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

Create a SQLite `notes` table, insert a note from an API route, and read it back in a second request. You will define the schema with Drizzle and apply a migration before using the table.

Start with the working app from [Installation](/docs/getting-started/installation). Use its Node.js, pnpm, Vite, Nitro, and H3 setup. Run every command from the app root so the CLI and server use the same local database. This tutorial needs no provider account. The default SQLite file is `.vitehub/data/database/sqlite.db`.

::tutorial-step{title="Enable Database"}
## Enable Database

Install the Database package, Drizzle for the schema, and Drizzle Kit for migration commands. The existing `vite-hub` dependency provides the CLI.

```bash [commands/install]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

Add `database: true` to the existing `vitehub()` options in `vite.config.ts`. Keep any other enabled features and plugins.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'node', database: true })],
})
```

If you chose Nuxt in Installation, add `database: true` to the options of the existing `vite-hub/nuxt` module. Use the same Definition and server routes below.

::

::tutorial-step{title="Create and migrate the table"}
## Create and migrate the table

Create `server/databases/config.ts`. ViteHub discovers this file as the `default` Database Definition. The schema has an auto-incrementing integer ID and a required title.

```ts [server/databases/config.ts]
import { defineDatabase } from 'vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export default defineDatabase({
  schema: {
    notes: sqliteTable('notes', {
      id: integer('id').primaryKey({ autoIncrement: true }),
      title: text('title').notNull(),
    }),
  },
})
```

If your app already has a default Definition, add `notes` to its schema instead of creating a second Definition. A Definition describes tables; it does not create them in the database.

Generate and apply the migration from the app root:

```bash [commands/generate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

`generate` writes SQL and migration metadata to `server/databases/migrations/`. `migrate` applies pending SQL to the local SQLite file. Neither command needs a running server or a previous build. Check that both commands finish successfully before querying the table.

::

::tutorial-step{title="Insert a note"}
## Insert a note

Create `server/api/notes.post.ts`. Nitro maps this file to `POST /api/notes`. The route checks the title, inserts a row, and returns the inserted rows as an array.

```ts [server/api/notes.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { useDatabase } from 'vite-hub/database/drizzle'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ title?: unknown }>(event)
  if (typeof body?.title !== 'string' || !body.title.trim()) {
    throw createError({ statusCode: 400, message: 'Send a non-empty title.' })
  }

  const { db, schema } = useDatabase('default')
  return await db.insert(schema.notes)
    .values({ title: body.title.trim() })
    .returning()
})
```

`useDatabase('default')` returns the Drizzle client and the schema. Drizzle queries return rows or driver results directly. They reject on failure, so do not destructure a query as an `[error, data]` tuple. See [Limits and errors](/docs/database/limits-and-errors).

::

::tutorial-step{title="Read the notes"}
## Read the notes

Create `server/api/notes.get.ts`. This route reads rows in ID order without changing them.

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from 'vite-hub/database/drizzle'

export default defineEventHandler(async () => {
  const { db, schema } = useDatabase('default')
  return await db.select().from(schema.notes).orderBy(schema.notes.id)
})
```

The explicit H3 imports work with the Vite and Nuxt setups from Installation. Run these routes through the app so ViteHub can load the generated Database registry.

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start or restart the app after the config change:

```bash [commands/start]
pnpm dev
```

Keep it running. In another terminal, insert a note:

```bash [commands/request]
curl -X POST http://localhost:3000/api/notes \
  -H 'content-type: application/json' \
  -d '{"title":"My first note"}'
```

On a fresh database, the response is:

```json [output/insert.json]
[{ "id": 1, "title": "My first note" }]
```

Read the table in a separate request:

```bash [commands/read]
curl http://localhost:3000/api/notes
```

After that first insert, the response is:

```json [output/response.json]
[{ "id": 1, "title": "My first note" }]
```

Every POST adds a row with a new ID. GET returns all rows, so an existing database can return more notes. Before the first insert, GET returns `[]`. The rows remain after an app restart.

If the route reports a missing table, run `pnpm vitehub db migrate` from the same app root. After schema changes, run both `generate` and `migrate` again. Keep the schema and generated migrations in version control.

Continue with [Server API](/docs/database/server-api) for queries and [Hosts](/docs/database/hosts) for hosted databases.
::
