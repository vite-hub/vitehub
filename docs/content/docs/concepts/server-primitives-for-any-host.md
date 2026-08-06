---
title: Server primitives
description: Build server-backed features with databases, queues, storage, and more while keeping your application portable across hosts.
navigation.title: Overview
navigation.order: 1
navigation.lanes: [server-primitives]
icon: i-lucide-server
---

Server Primitives are APIs that application code calls to work with server-side artifacts such as environment values, databases, queues, workflows, files, and sandboxes.

ViteHub connects each primitive to the implementation supported by the current development or deployment host, so application code keeps the same API across Cloudflare, Vercel, Docker, and other platforms.

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

Add ViteHub to your configuration. ViteHub relies heavily on the [Vite Environment API](https://vite.dev/guide/api-environment), so Vite 7+, Nitro 3+, and Nuxt 5+ are the supported versions for now.

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

Import the generated Runtime Helper in a server route and query the named database. ViteHub connects that call to the provider configured for the current environment.

```ts [server/api/notes.get.ts]
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('notes')
  return db.select().from(schema.notes)
})
```

::

That is the complete path: configure ViteHub, define the primitive when it needs a name or schema, and call its Runtime Helper from server code. Your application keeps the same API while ViteHub connects it to the current development or deployment host.
