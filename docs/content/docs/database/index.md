---
title: Database
navigation.title: Overview
description: Define SQL tables in TypeScript and query them from your server routes with typed results.
navigation.order: 1
icon: i-lucide-database
---

::product-hero{tagline="Define SQL tables in TypeScript and query them from your routes, with typed rows." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [src/database.ts]
  import { defineDatabase } from 'vite-hub/database'
  import {
    integer,
    sqliteTable,
    text,
  } from 'drizzle-orm/sqlite-core'

  // Your tables, written with Drizzle
  export default defineDatabase({
    schema: {
      notes: sqliteTable('notes', {
        id: integer('id').primaryKey(),
        title: text('title').notNull(),
      }),
    },
  })
  ```

  ```ts [vite.config.ts]
  import { nitro } from 'nitro/vite'
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      // Local SQLite while you develop
      vitehub({ preset: 'node', database: true }),
      nitro() as never,
    ],
  })
  ```

  ```ts [server/api/notes.get.ts]
  import { defineEventHandler } from 'h3'
  import { useDatabase } from 'vite-hub/database/drizzle'

  // List every note
  export default defineEventHandler(() => {
    const { db, schema } = useDatabase('default')
    return db.select().from(schema.notes)
  })
  ```

  ```ts [server/api/notes.post.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { useDatabase } from 'vite-hub/database/drizzle'

  // Add a note and return the new row
  export default defineEventHandler(async (event) => {
    const body = await readBody<{ title: string }>(event)
    const { db, schema } = useDatabase('default')

    const [note] = await db
      .insert(schema.notes)
      .values({ title: body.title })
      .returning()
    return note
  })
  ```

  ```ts [server/api/notes/[id].get.ts]
  import { eq } from 'drizzle-orm'
  import { defineEventHandler, getRouterParam } from 'h3'
  import { useDatabase } from 'vite-hub/database/drizzle'

  // Read one note by its id
  export default defineEventHandler(async (event) => {
    const id = Number(getRouterParam(event, 'id'))
    const { db, schema } = useDatabase('default')

    const [note] = await db
      .select()
      .from(schema.notes)
      .where(eq(schema.notes.id, id))
    return note ?? null
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="Tables in one file" icon="i-lucide-file-code-2" to="/docs/database/configure#define-a-database"}
  Write your tables with Drizzle in `src/database.ts`. ViteHub finds the file and makes migrations from it.
  :::

  :::product-feature-item{title="Query from any route" icon="i-lucide-code-2" to="/docs/database/server-api#use-it-at-runtime"}
  `useDatabase()` gives you a Drizzle client and your tables. Results have the types of your columns.
  :::

  :::product-feature-item{title="More than one database" icon="i-lucide-layers" to="/docs/database/server-api#use-named-databases"}
  Give a database a name to keep its data apart. Each one has its own client and connection.
  :::

  :::product-feature-item{title="Local first, hosted later" icon="i-lucide-cloud-cog" to="/docs/database/hosts#providers"}
  Use a local SQLite file while you develop. Move to Turso or Cloudflare D1 without changing your routes.
  :::

  :::product-feature-item{title="SQLite everywhere" icon="i-lucide-table-2" to="/docs/database/hosts#production-checks"}
  Every connection uses SQLite-compatible SQL, so your queries work the same on each host.
  :::
::
