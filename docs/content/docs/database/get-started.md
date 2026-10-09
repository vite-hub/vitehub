---

title: Query your first Database
description: Create a SQLite notes table with Drizzle and query it from a server route.
layout: tutorial
navigation.title: Tutorial
navigation.order: 2
icon: i-lucide-rocket
---

Create a SQLite `notes` table and read it from an API route. You will declare the table with Drizzle, generate a migration, and apply it before starting the app. The first query returns `[]` because the table has no rows yet.

You need Node.js 24.15 or newer, pnpm, and a Vite application. Run the commands from its root. This uses local SQLite and needs no provider account. See [Hosts](/docs/database/hosts) when you need a database shared by several app instances.

::tutorial-step{title="Install and configure"}
## Install and configure

Install the Database runtime and Drizzle. The CLI and `drizzle-kit` generate and apply the SQL migration.

```bash [commands/install]
pnpm add @vite-hub/database drizzle-orm nitro h3
pnpm add -D @vite-hub/cli drizzle-kit vite
```

Add `hubDb()` to your existing Vite config. It discovers Database Definitions and generates the runtime lookup used by the route.

```ts [vite.config.ts]
import { hubDb } from '@vite-hub/database/vite'
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'

export default defineConfig({
  plugins: [hubDb(), nitro() as never],
})
```

::

::tutorial-step{title="Create and migrate the table"}
## Create and migrate the table

The schema has an integer primary key and a required title. This file creates the Definition; a migration creates the actual table.

```ts [src/database.ts]
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

Run both commands once after creating the schema. `generate` writes a migration beside the Definition; `migrate` applies pending migrations to the local database.

```bash [commands/generate]
pnpm vitehub db generate
pnpm vitehub db migrate
```

`useDatabase('default')` returns the Drizzle client and the declared schema. The query selects all columns from all rows in `notes`.

```ts [server/api/notes.get.ts]
import { defineEventHandler } from 'h3'
import { useDatabase } from '@vite-hub/database/drizzle'

export default defineEventHandler(() => {
  const { db, schema } = useDatabase('default')
  return db.select().from(schema.notes)
})
```

::

::tutorial-step{title="Query the table"}
## Query the table

Start Vite and call the route:

```bash [commands/start]
pnpm vite dev
```

Keep the server running. In another terminal, run:

```bash [commands/request]
curl http://localhost:5173/api/notes
```

The response is `[]`. This confirms that the migration created the table and the route can query it. If you see a missing-table error, run `pnpm vitehub db migrate` from the app root and check its output.

Add insert and update operations with the [Server API](/docs/database/server-api). After you change the schema, generate and apply a new migration before querying the new columns.

::
