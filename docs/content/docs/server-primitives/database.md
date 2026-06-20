---
title: Database
description: Define Drizzle-backed relational data and query it through generated ViteHub runtime surfaces.
navigation.order: 5
icon: i-lucide-database
---

Database owns relational application data for ViteHub apps. Use it when the app needs schema, constraints, joins, migrations, history, or queryable state.

Database is not KV, Blob, or Workspace. Use KV for small key-addressed values, Blob for object storage, and Workspace for file-tree state.

## Define a database

Database Definitions keep the Database Table Schema close to the server code that owns it.

```ts [server/databases/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey(),
  title: text('title').notNull(),
  body: text('body').notNull(),
})

export default defineDatabase({
  tables: { notes },
})
```

A project uses either one Default Database or a set of Named Databases. Do not mix both modes in one app.

## Use it at runtime

Use the generated Drizzle Runtime Surface from server code.

```ts [server/api/notes.get.ts]
import { db, schema } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  return db.select().from(schema.notes)
})
```

Use Named Databases when separate data boundaries need explicit names.

```ts [server/databases/analytics/config.ts]
import { defineDatabase } from '@vite-hub/database'
import { events } from './schema'

export default defineDatabase({
  tables: { events },
})
```

Named databases should represent real ownership or operational boundaries, not folder organization.

## Provider output

The Database Package discovers Database Definitions, generates the Drizzle Runtime Surface, produces generated schema artifacts, and wires provider-specific output. Provider bindings are integration details; the public database identity is the Default Database or Named Database.

Cloudflare D1 bindings, hosted libSQL URLs, and Nuxt host resources belong in Database configuration or host setup. Route code should keep using the generated Drizzle Runtime Surface.

## Connect it to Agents

Direct Database access is for server code. To let a model inspect schema or run guarded statements, attach the Database Capability.

The Database Capability is not a raw Drizzle client proxy. It uses agent-facing guardrails such as schema mode, data mode, write approvals, and the single-statement SQL guardrail. Read [Official capabilities](/docs/capabilities/official-capabilities) before exposing database access to an Agent.

## Production boundaries

Database Table Schema is the source schema in code. Live Database Schema can diverge when migrations have not run or when an Agent has explicit schema write permission.

Keep provider credentials in Server Env. Keep migrations, backup behavior, and hosted database lifecycle in deployment workflows instead of hiding them in route code.

## Next steps

- Store small key values with [KV](/docs/server-primitives/kv).
- Store file-shaped objects with [Blob](/docs/server-primitives/blob).
- Learn shared discovery rules in [Definitions and discovery](/docs/concepts/definitions-and-discovery).
