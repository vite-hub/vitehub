---
title: DB quickstart
description: Register DB, define one Drizzle database, insert a note, and verify the JSON response.
navigation.title: Quickstart
navigation.order: 1
icon: i-lucide-zap
frameworks: [vite]
---

## Install

```bash
pnpm add @vite-hub/cli @vite-hub/database drizzle-kit drizzle-orm h3 vite
```

## Register

```ts [vite.config.ts]
import { resolve } from 'node:path'
import { defineConfig } from 'vite'
import { hubDb } from '@vite-hub/database/vite'

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

## Define

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

## Use

```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { desc, sql } from 'drizzle-orm'
import { db, schema } from '@vite-hub/database/drizzle'

const app = new H3()

async function ensureNotesTable() {
  await db.run(sql`
    create table if not exists notes (
      id integer primary key autoincrement,
      title text not null
    )
  `)
}

app.post('/api/notes', async (event) => {
  await ensureNotesTable()
  const body = await readBody<{ title?: string }>(event)
  const result = await db.insert(schema.notes).values({ title: body.title || 'hello database' }).returning()
  return { note: result[0], ok: true }
})

app.get('/api/notes', async () => {
  await ensureNotesTable()
  const notes = await db.select().from(schema.notes).orderBy(desc(schema.notes.id))
  return { notes, ok: true }
})

export default app
```

`vitehub db generate` refreshes the generated Drizzle schema and Drizzle Kit config before migration commands run.
