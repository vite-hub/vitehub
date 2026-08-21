---
title: Server primitives
description: Build server-backed features with databases, queues, storage, and more while keeping your application portable across hosts.
navigation.title: Overview
navigation.order: 1
navigation.lanes: [server-primitives]
icon: i-lucide-server
---

Server Primitives are APIs for environment values, databases, queues, workflows, files, sandboxes, and other server features.

Application code calls the ViteHub API. The Vite integration connects that call to the implementation supported by the current development or deployment host.

## Choose a primitive for the job

| You need | Start with |
| --- | --- |
| Configure the app | [Env](/docs/server-primitives/env), [Auth](/docs/server-primitives/auth), or [Rate Limit](/docs/server-primitives/rate-limit) |
| Store data and files | [Database](/docs/server-primitives/database), [KV](/docs/server-primitives/kv), [Blob](/docs/server-primitives/blob), [Workspace](/docs/server-primitives/workspace), or [Source](/docs/server-primitives/source) |
| Send or receive messages | [Email](/docs/server-primitives/email) or [Channels](/docs/agents/channels) |
| Run work later | [Queue](/docs/server-primitives/queue), [Schedule](/docs/server-primitives/schedule), or [Workflow](/docs/server-primitives/workflows) |
| Run isolated automation | [Browser](/docs/server-primitives/browser), [Shell](/docs/server-primitives/shell), or [Sandbox](/docs/server-primitives/sandbox) |

## How a primitive works in your app

Most ViteHub primitives follow the same pattern:

::steps{level="3"}

### Configure ViteHub

Add ViteHub to your configuration. ViteHub uses the [Vite Environment API](https://vite.dev/guide/api-environment), which requires Vite 8+, Nitro 3+, or Nuxt 5+.

::tabs{class="framework-tabs"}
  :::tabs-item{label="Vite" icon="i-simple-icons-vite"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { vitehub } from 'vite-hub'

    export default defineConfig({
      plugins: [
        vitehub({ preset: 'node', database: true }),
      ],
    })
    ```
  :::

  :::tabs-item{label="Nuxt 5" icon="i-simple-icons-nuxtdotjs"}
    ```ts [nuxt.config.ts]
    import viteHubNuxt from 'vite-hub/nuxt'

    export default defineNuxtConfig({
      modules: [
        [viteHubNuxt, { preset: 'node', database: true }],
      ],
    })
    ```
  :::

  :::tabs-item{label="Nitro 3" icon="i-unjs-nitro"}
    ```ts [vite.config.ts]
    import { defineConfig } from 'vite'
    import { nitro } from 'nitro/vite'
    import { vitehub } from 'vite-hub'

    export default defineConfig({
      plugins: [
        vitehub({ preset: 'node', database: true }),
        nitro(),
      ],
    })
    ```
  :::
::

### Define the database

Create a Database Definition file that ViteHub discovers automatically. Its file name becomes the database name, and the file defines the schema and options.

::tabs{class="framework-tabs"}
  :::tabs-item{label="Vite" icon="i-simple-icons-vite"}
    ```ts [src/notes.database.ts]
    import { defineDatabase } from 'vite-hub/database'
    import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

    export default defineDatabase({
      name: 'notes',
      schema: {
        notes: sqliteTable('notes', {
          id: integer('id').primaryKey(),
          title: text('title').notNull(),
        }),
      },
    })
    ```
  :::

  :::tabs-item{label="Nuxt 5" icon="i-simple-icons-nuxtdotjs"}
    ```ts [server/databases/notes/config.ts]
    import { defineDatabase } from 'vite-hub/database'
    import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

    export default defineDatabase({
      name: 'notes',
      schema: {
        notes: sqliteTable('notes', {
          id: integer('id').primaryKey(),
          title: text('title').notNull(),
        }),
      },
    })
    ```
  :::

  :::tabs-item{label="Nitro 3" icon="i-unjs-nitro"}
    ```ts [server/databases/notes/config.ts]
    import { defineDatabase } from 'vite-hub/database'
    import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

    export default defineDatabase({
      name: 'notes',
      schema: {
        notes: sqliteTable('notes', {
          id: integer('id').primaryKey(),
          title: text('title').notNull(),
        }),
      },
    })
    ```
  :::
::

### Use it from server code

Import the database API in a server route and query the named database. ViteHub connects that call to the provider configured for the current environment.

::tabs{class="framework-tabs"}
  :::tabs-item{label="Vite" icon="i-simple-icons-vite"}
    ```ts [src/server.ts]
    import { useDatabase } from 'vite-hub/database/drizzle'

    export default {
      async fetch() {
        const { db, schema } = useDatabase('notes')
        return Response.json(await db.select().from(schema.notes))
      },
    }
    ```
  :::

  :::tabs-item{label="Nuxt 5" icon="i-simple-icons-nuxtdotjs"}
    ```ts [server/api/notes.get.ts]
    import { useDatabase } from 'vite-hub/database/drizzle'

    export default defineEventHandler(() => {
      const { db, schema } = useDatabase('notes')
      return db.select().from(schema.notes)
    })
    ```
  :::

  :::tabs-item{label="Nitro 3" icon="i-unjs-nitro"}
    ```ts [server/api/notes.get.ts]
    import { useDatabase } from 'vite-hub/database/drizzle'

    export default defineEventHandler(() => {
      const { db, schema } = useDatabase('notes')
      return db.select().from(schema.notes)
    })
    ```
  :::
::

::

The same path applies to other Server Primitives. Configure ViteHub, add a definition when the feature needs a name or schema, and call its server API. Check the [host support matrix](/docs/frameworks-hosts/support-matrix) before choosing a deployment target.
