---
title: Database
layout: landing
navigation.title: Overview
description: Define SQL tables in TypeScript and query them from your server routes with typed results.
navigation.order: 1
icon: i-lucide-database
---

::product-hero{tagline="Define SQL tables in TypeScript and query them from your routes, with typed rows." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :hero-figure{name="database"}
::

::code-tree{feature="database"}
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

:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    preset: 'node',
    // On Node, tables are saved in local SQLite
    database: true,
  },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      // On Node, tables are saved in local SQLite
      database: true,
    }),
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      preset: 'node',
      // On Node, tables are saved in local SQLite
      database: true,
    }),
  ],
})
```
:::

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
import { defineEventHandler, readValidatedBody } from 'h3'
import * as v from 'valibot'
import { useDatabase } from 'vite-hub/database/drizzle'

// Add a note and return the new row
export default defineEventHandler(async (event) => {
  const body = await readValidatedBody(event, v.object({ title: v.string() }))
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
::

::product-features
  :::product-feature-item{title="Tables in one file" icon="i-lucide-file-code-2" to="/docs/database/configure#define-a-database"}
  Write your tables with Drizzle in `src/database.ts`. ViteHub finds it and makes migrations.
  :::

  :::product-feature-item{title="Query from any route" icon="i-lucide-code-2" to="/docs/database/server-api#use-it-at-runtime"}
  `useDatabase()` gives you a Drizzle client and your tables, with typed results.
  :::

  :::product-feature-item{title="More than one database" icon="i-lucide-layers" to="/docs/database/server-api#use-named-databases"}
  Name a database to keep its data apart, with its own client and connection.
  :::

  :::product-feature-item{title="Local first, hosted later" icon="i-lucide-cloud-cog" to="/docs/database/hosts#providers"}
  Use a local SQLite file while you develop. Move to Turso or Cloudflare D1 with the same routes.
  :::

  :::product-feature-item{title="SQLite everywhere" icon="i-lucide-table-2" to="/docs/database/hosts#production-checks"}
  Every connection uses SQLite-compatible SQL, so queries work the same on each host.
  :::
::

::agent-only{skill="database"}
Use Database for relational data with Drizzle. Define tables in a Database Definition and query through the generated `useDatabase()` handle.

Import `useDatabase` from `vite-hub/database/drizzle` and select the discovered database by name. Do not import generated database definitions or provider bindings into application code. Keep migrations and transaction boundaries with the Database owner.

Prove a migration, a typed read, a write, and a restart or remote-host read. Inspect generated schema and provisioning output before deployment.
::
