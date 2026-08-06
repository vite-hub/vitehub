---
title: Server primitives
description: Choose the server API you need and use it from application code across ViteHub hosts.
navigation.group: Start here
navigation.order: 2
icon: i-lucide-server
---

Server primitives give application code APIs for common server features, including environment values, databases, queues, messages, files, and isolated commands. You call them from routes, handlers, jobs, and workers without writing a separate host-specific implementation for each provider.

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

### Configure

Add ViteHub to the configuration used by your framework. ViteHub relies on the [Vite Environment API](https://vite.dev/guide/api-environment), so Vite 7+, Nitro 3+, and Nuxt 5+ are supported for now.

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

Create a Database Definition file that ViteHub can discover automatically. Its file name becomes the database name, and the file defines the schema and options.

::tabs{class="framework-tabs"}
  :::tabs-item{label="Vite" icon="i-simple-icons-vite"}
    ```ts [src/notes.database.ts]
    import { defineDatabase } from '@vite-hub/database'
    import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

    export default defineDatabase({
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
    import { defineDatabase } from '@vite-hub/database'
    import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

    export default defineDatabase({
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
    import { defineDatabase } from '@vite-hub/database'
    import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

    export default defineDatabase({
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

Import the Runtime Helper in server code and query the named database. `useDatabase('notes')` is fully typed from the discovered database definitions, including the selected schema.

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('notes')
  return db.select().from(schema.notes)
})
```

::

Choose a package page from the table when you know the feature you need. Read [Definitions and discovery](/docs/concepts/definitions-and-discovery) when you need to understand file-based setup, or open [First server primitive](/docs/getting-started/first-server-primitive) for a complete example.
