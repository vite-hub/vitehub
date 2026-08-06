---
title: Server primitives
description: Build server-backed features with databases, queues, storage, and more while keeping your application portable across hosts.
navigation.group: Start here
navigation.order: 2
icon: i-lucide-server
---

Server Primitives are APIs that application code calls to work with server-side artifacts such as environment values, databases, queues, workflows, files, and sandboxes.

## Choose a primitive for the job

| You need | Start with |
| --- | --- |
| Configure the app | [Env](/docs/server-primitives/env), [Auth](/docs/server-primitives/auth), or [Rate Limit](/docs/server-primitives/rate-limit) |
| Store data and files | [Database](/docs/server-primitives/database), [KV](/docs/server-primitives/kv), [Blob](/docs/server-primitives/blob), [Workspace](/docs/server-primitives/workspace), or [Source](/docs/server-primitives/source) |
| Send or receive messages | [Email](/docs/server-primitives/email) or [Channels](/docs/agents/channels) |
| Run work later | [Queue](/docs/server-primitives/queue), [Schedule](/docs/server-primitives/schedule), or [Workflow](/docs/server-primitives/workflows) |
| Run isolated automation | [Browser](/docs/server-primitives/browser), [Shell](/docs/server-primitives/shell), or [Sandbox](/docs/server-primitives/sandbox) |

## How a primitive works in your app

Database shows the pattern in a small Vite app. Enable the package integration first:

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubDb()],
})
```

Define the schema in the location supported by the Database integration:

```ts [src/database.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
})

export default defineDatabase({
  schema: { notes },
})
```

Then call the generated Runtime Surface from server code:

```ts [server/api/notes.get.ts]
import { db, schema } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  return db.select().from(schema.notes)
})
```

ViteHub discovers the Database Definition, generates the Drizzle Runtime Surface, and adapts the provider output for development and deployment. Other primitives follow the same shape, but their Definition locations and Runtime Helpers differ.

## Inspect the boundary

Look for the package's Vite Integration, Runtime Helper, and generated Provider Output. The primitive page documents the package contract; the [runtime and host support matrix](/docs/frameworks-hosts/support-matrix) shows where that contract is currently proven.

Read [Definitions and discovery](/docs/concepts/definitions-and-discovery), [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports), or [Vite Integrations and Provider Output](/docs/concepts/vite-integrations-and-provider-output) for the details, or open [First server primitive](/docs/getting-started/first-server-primitive) to build one.
