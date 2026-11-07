---
title: Save your first Database row
description: Create a local SQLite table, insert a note, and read it through a separate API route.
layout: tutorial
codePanel: true
navigation.title: Get started
navigation.order: 2
icon: i-lucide-rocket
---

You make a `notes` table in a local SQLite database. Then you add a note with one API request and read it back with a second request.

You need:

- the working app from [Installation](/docs/getting-started/installation), with its Node.js, pnpm, Vite, Nitro, and H3 setup

You do not need a database server or a cloud account. The data goes in a file on your computer.

::tutorial-step{title="Install"}
## Install

Install the packages:

```bash [commands/install]
pnpm add @vite-hub/database drizzle-orm
pnpm add -D drizzle-kit
```

- `@vite-hub/database` connects your server routes to the database.
- `drizzle-orm` lets you write the table shape and the queries in TypeScript.
- `drizzle-kit` writes the SQL that creates your tables. The `vitehub db` commands below use it.

The `vite-hub` package that you installed before gives you the `vitehub` command.

Add `database: true` to the `vitehub()` options in `vite.config.ts`. Keep the other options and plugins that you have.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  server: { port: 3000, strictPort: true },
  plugins: [vitehub({ preset: 'node', database: true })],
})
```

If you chose Nuxt in Installation, add `database: true` to the options of the `vite-hub/nuxt` module. The files below are the same for Nuxt.

::

::tutorial-step{title="Create the table"}
## Create the table

Create `server/databases/config.ts`. This file tells ViteHub which tables your database has. ViteHub finds the file and names this database `default`.

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

- `id` is a number. The database gives each new row the next number.
- `title` is text. Each row must have a title.

If your app already has a `server/databases/config.ts` file, add `notes` to its `schema`. Do not make a second file.

This file only describes the table. It does not create the table. Run these two commands from the app root to create it:

```bash [commands/generate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

- `generate` writes the SQL that creates the table. The SQL goes in `server/databases/migrations/`. These files are called migrations.
- `migrate` runs the new SQL on your local database file, `.vitehub/data/database/sqlite.db`.

The server does not need to run for these commands. Make sure that both commands finish without an error.

::

::tutorial-step{title="Add a note"}
## Add a note

Create `server/api/notes.post.ts`. Nitro uses the file name to make the route `POST /api/notes`.

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

The route checks that the request has a title. Then it adds a row and sends back the new row in an array.

`useDatabase('default')` gives you `db`, to run queries, and `schema`, your tables. A query gives you the rows directly. If a query fails, it throws an error. See [Limits and errors](/docs/database/limits-and-errors).

::

::tutorial-step{title="Read the notes"}
## Read the notes

Create `server/api/notes.get.ts`. This route reads all rows in ID order. It does not change them.

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from 'vite-hub/database/drizzle'

export default defineEventHandler(async () => {
  const { db, schema } = useDatabase('default')
  return await db.select().from(schema.notes).orderBy(schema.notes.id)
})
```

These routes work only when the app runs them, because the app loads your database file at start. They work in the Vite and the Nuxt setup.

::

::tutorial-step{title="Run it"}
## Run it

Start the app. If it already runs, restart it, because you changed `vite.config.ts`.

```bash [commands/start]
pnpm dev
```

Keep it running. In a second terminal, add a note:

```bash [commands/request]
curl -X POST http://localhost:3000/api/notes \
  -H 'content-type: application/json' \
  -d '{"title":"My first note"}'
```

On a new database, you see:

```json [output/insert.json]
[{ "id": 1, "title": "My first note" }]
```

The row is in the table, and the database gave it the ID `1`.

Now read the table in a new request:

```bash [commands/read]
curl http://localhost:3000/api/notes
```

You see:

```json [output/response.json]
[{ "id": 1, "title": "My first note" }]
```

The second request found the note, so the first request saved it in the database. If you send more POST requests, you get more rows. If you read before you add a note, you get `[]`.

> [!NOTE]
> The rows stay in `.vitehub/data/database/sqlite.db` when you restart the app. If a route says that the table is missing, run `pnpm vitehub db migrate` from the app root. When you change the schema, run `generate` and `migrate` again. Commit the schema and the migrations to Git.

::

## Next steps

- [Server API](/docs/database/server-api): use more than one database, and see the database work of each request.
- [Hosts](/docs/database/hosts): use Cloudflare D1 or Postgres when you deploy.
