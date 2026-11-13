---
title: Save your first Database row
description: Create a local SQLite table, insert a note, and read it through a separate API route.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

A Database is where your app keeps data that must stay after a restart, such as notes, users, or orders. You describe your tables in one file. ViteHub gives your server code a client to read and write them.

In this tutorial, you create a `notes` table, add a note from one API route, and read it back from another.

> [!NOTE] Before you start
> Use the app from [Installation](/docs/getting-started/installation). You need no account and no API key. The data goes in a SQLite file on your computer, at `.vitehub/data/database/sqlite.db`. Run every command from the app root, so the CLI and the server use the same file.

::tutorial-step{title="Enable Database"}
## Enable Database

Database is a separate package. Add it, with [Drizzle](https://orm.drizzle.team) to write your tables and Drizzle Kit to make migrations:

```bash pm [commands/install]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

Then add `database: true` to the ViteHub options of your app. Keep the other options of your app.

:::tabs{sync="framework"}
::::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', database: true },
})
```
::::

::::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'node', database: true }), nitro()],
})
```
::::

::::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ host: 'node', database: true })],
})
```
::::
:::

::

::tutorial-step{title="Create and migrate the table"}
## Create and migrate the table

Create `server/databases/default.ts`. This file is the Definition of your `default` database: it lists its tables.

```ts [server/databases/default.ts]
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

- `notes` gets an `id` that counts up by itself and a `title` that must have a value.
- If your app already has `server/databases/default.ts`, add `notes` to its `schema`. Do not make a second file.

The Definition only describes the table. To create the table in the database, make a migration and apply it:

```bash [commands/generate]
pnpm vitehub database generate
pnpm vitehub database migrate
```

- `generate` writes the SQL for your tables to `server/databases/default/migrations/`.
- `migrate` runs that SQL on the SQLite file.

You do not need a running server for these commands. Make sure both finish without an error before you go on.

::

::tutorial-step{title="Insert a note"}
## Insert a note

Create `server/api/notes.post.ts`. This file is the route `POST /api/notes`. It checks the title, adds a row, and sends back the new row.

```ts [server/api/notes.post.ts]
import { createError, defineEventHandler, readBody } from 'h3'
import { useDatabase } from 'vite-hub/database'

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

- `useDatabase('default')` gives you `db`, the Drizzle client, and `schema`, your tables.
- A query returns the rows. If it fails, it throws an error. It does not return an `[error, data]` pair. See [Limits and errors](/docs/database/limits-and-errors).

::

::tutorial-step{title="Read the notes"}
## Read the notes

Create `server/api/notes.get.ts`. This route reads all notes, in ID order.

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from 'vite-hub/database'

export default defineEventHandler(async () => {
  const { db, schema } = useDatabase('default')
  return await db.select().from(schema.notes).orderBy(schema.notes.id)
})
```

::

::tutorial-step{title="Run and check the result"}
## Run and check the result

Start the dev server. If it already runs, restart it, so it reads the new config:

```bash [commands/start]
pnpm dev
```

Open a second terminal in the same folder, and add a note:

```bash [commands/request]
curl -X POST http://localhost:3000/api/notes \
  -H 'content-type: application/json' \
  -d '{"title":"My first note"}'
```

On a new database, the response is:

```json [output/insert.json]
[{ "id": 1, "title": "My first note" }]
```

Read the notes:

```bash [commands/read]
curl http://localhost:3000/api/notes
```

The response has your note:

```json [output/response.json]
[{ "id": 1, "title": "My first note" }]
```

Each POST adds a row with a new ID, and GET returns all rows. Restart the server and send the GET again: the note is still there.

If the route fails and the server terminal shows `no such table: notes`, run `pnpm vitehub database migrate` again from the app root. Each time you change the schema, run `generate` and then `migrate`. Commit the schema file and the `migrations` folder.

::

## Next steps

::card-group
:::card{title="Server API" icon="i-lucide-code" to="/docs/database/server-api"}
Write queries and use more than one database.
:::

:::card{title="Configure" icon="i-lucide-sliders-horizontal" to="/docs/database/configure"}
Run migrations when the server starts, and see every option.
:::

:::card{title="Hosts" icon="i-lucide-cloud-cog" to="/docs/database/hosts"}
Use Cloudflare D1, Turso, or Postgres when you deploy.
:::
::
