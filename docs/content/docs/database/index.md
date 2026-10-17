---
title: Database
navigation.title: Overview
description: Define relational data with Drizzle and query it through generated ViteHub imports.
navigation.order: 1
icon: i-lucide-database
---

::agent-only{skill="database"}
Use Database for relational data with Drizzle. Define tables in a Database Definition and query through the generated `useDatabase()` handle.

Read [Get started](/docs/database/get-started), [Configure](/docs/database/configure), [Server API](/docs/database/server-api), or [Hosts](/docs/database/hosts).

Import `useDatabase` from `vite-hub/database/drizzle` and select the discovered database by name. Do not import generated database definitions or provider bindings into application code. Keep migrations and transaction boundaries with the Database owner.

Prove a migration, a typed read, a write, and a restart or remote-host read. Inspect generated schema and provisioning output before deployment.
::

::product-hero{tagline="Relational tables defined with Drizzle and queried through one typed client on local SQLite, hosted libSQL, Cloudflare D1, and Postgres." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::code-group
  ```ts [Route]
  import { useDatabase } from '@vite-hub/database/drizzle'

  export default defineEventHandler(async (event) => {
    const { title, body } = await readBody<{ title: string, body: string }>(event)

    const app = useDatabase('default')
    const [note] = await app.db.insert(app.schema.notes).values({ title, body }).returning()

    // A Named Database has its own typed client and connection.
    const analytics = useDatabase('analytics')
    await analytics.db.insert(analytics.schema.events).values({ name: 'note.created' })

    return note
  })
  ```

  ```ts [Definition]
  import { defineDatabase } from '@vite-hub/database'
  import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

  export default defineDatabase({
    schema: {
      notes: sqliteTable('notes', {
        id: integer('id').primaryKey(),
        title: text('title').notNull(),
        body: text('body').notNull(),
      }),
    },
  })
  ```

  ```ts [Agent]
  import { defineAgent } from 'vite-hub/agent'
  import { db } from 'vite-hub/agent/capabilities'

  export default defineAgent({
    driver: { model: 'openai/gpt-5.1-mini' },
    capabilities: [
      db({ mode: 'write', policy: 'require-approval' }),
    ],
  })
  ```

  ```bash [CLI]
  pnpm vitehub db generate
  pnpm vitehub db migrate
  ```
  :::
::


::product-features
  :::product-feature-item{title="The Drizzle schema is the source of truth" icon="i-lucide-code-2" to="/docs/database/configure"}
  ViteHub discovers `src/database.ts` and generates the Drizzle artifacts.
  :::

  :::product-feature-item{title="Generate migrations from the Definition" icon="i-lucide-terminal" to="/docs/database/get-started"}
  `vitehub db generate` writes migrations; `vitehub db migrate` applies them.
  :::

  :::product-feature-item{title="One typed client for each database name" icon="i-lucide-database" to="/docs/database/server-api"}
  `useDatabase()` returns `db` and `schema` for `default` or a Named Database.
  :::

  :::product-feature-item{title="Guarded SQL for an Agent" icon="i-lucide-bot" to="/docs/database/agent-capability"}
  `db_query` and `db_schema`, plus `db_exec` in write mode.
  :::

  :::product-feature-item{title="Change the connection, keep the route" icon="i-lucide-cloud-cog" to="/docs/database/hosts"}
  Local SQLite, hosted libSQL, Cloudflare D1, or Postgres through Hyperdrive, with the same imports.
  :::

  :::product-feature-item{title="Queries return typed rows" icon="i-lucide-table-2" to="/docs/database/server-api"}
  Keep joins, constraints, and migrations in the database layer.
  :::
::
