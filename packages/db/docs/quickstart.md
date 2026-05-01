---
title: DB quickstart
description: Register DB, define a Drizzle schema, insert a note, and verify the JSON response.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite]
---

This guide creates one `notes` table. The route inserts a note through Drizzle and reads it back through the same `db` handle.

The example uses the local SQLite default so you can verify the app before choosing Cloudflare D1 or a hosted libSQL database.

::code-collapse

```txt [Prompt]
Set up @vitehub/db in this Vite app.

- Install @vitehub/db, drizzle-orm, h3, and vite
- Register hubDb()
- Add src/db/schema.ts with a notes table
- Add a Vite server entry that imports db and schema from @vitehub/db/drizzle
- Insert and list notes as JSON

Docs: /docs/vite/db/quickstart
```

::

::steps

### Install DB

```bash
pnpm add @vitehub/db drizzle-orm h3 vite
```

`@vitehub/db` includes the libSQL client used by the local SQLite path. Add Drizzle Kit separately when you want to generate and manage migrations.

### Register the integration

Register the Vite plugin. With no `db.connection.url`, ViteHub uses `file:.data/db/sqlite.db` in local Vite runtime.

```ts [vite.config.ts]
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  appType: 'custom',
  build: {
    rollupOptions: {
      input: resolve(import.meta.dirname, 'src/server.ts'),
    },
  },
  plugins: [hubDb()],
})
```

### Define the schema

Create the default Drizzle schema file:

```ts [src/db/schema.ts]
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})
```

ViteHub discovers `src/db/schema.ts` and `src/db/schema/*` for the default database.

### Use the database from a route

Add a Vite server entry that creates the table for the quickstart, inserts notes, and lists the newest notes first:

```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { desc, sql } from 'drizzle-orm'
import { db, schema } from '@vitehub/db/drizzle'

const app = new H3()

async function ensureNotesTable() {
  await db.run(sql`
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null
    )
  `)
}

app.get('/api/notes', async () => {
  await ensureNotesTable()
  const notes = await db.select().from(schema.notes).orderBy(desc(schema.notes.id))
  return { notes, ok: true }
})

app.post('/api/notes', async (event) => {
  await ensureNotesTable()
  const body = await readBody<{ title?: string }>(event)
  const result = await db.insert(schema.notes).values({ title: body.title || 'hello database' }).returning()
  return { note: result[0], ok: true }
})

export default app
```

`db` and `schema` are aliases for `databases.default.db` and `databases.default.schema`.

### Verify the response

Run the app, then create a note:

```bash
curl -X POST http://localhost:3000/api/notes \
  -H 'content-type: application/json' \
  -d '{"title":"first note"}'
```

Read it back:

```bash
curl http://localhost:3000/api/notes
```

Expected response:

```json
{
  "notes": [
    {
      "id": 1,
      "title": "first note"
    }
  ],
  "ok": true
}
```

::

## Hosted providers

The route code stays the same when you switch providers. Change config and deployment environment only:

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare D1
  description: Configure D1 bindings and generated Wrangler output.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure remote libSQL URLs for hosted Vercel output.
  to: ./providers/vercel
  ---
  :::
::

## Next steps

- Use [Usage](./usage) for named databases, schema discovery, and migration directories.
- Use [Runtime API](./runtime-api) for exact config shapes.
- Use [Troubleshooting](./troubleshooting) if schema discovery or hosted output fails.
