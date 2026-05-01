---
title: DB usage
description: Practical patterns for Drizzle schemas, default aliases, named databases, migrations, and hosted fallbacks.
navigation.title: Usage
navigation.order: 3
icon: i-lucide-database
frameworks: [vite]
---

After the quickstart works, most DB code falls into five patterns: define schema files, use the default aliases, add named databases, keep migration paths explicit, and configure hosted providers without changing route code.

## Define the default schema

The default database discovers schema files from these paths:

- `src/db/schema.ts`
- every TypeScript or JavaScript file in `src/db/schema/`

```ts [src/db/schema.ts]
import { integer, sqliteTable, text } from 'drizzle-orm/sqlite-core'

export const notes = sqliteTable('notes', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  title: text('title').notNull(),
})
```

Use the generated schema export with the default `db` handle:

```ts
import { db, schema } from '@vitehub/db/drizzle'

await db.insert(schema.notes).values({ title: 'hello' })
const notes = await db.select().from(schema.notes)
```

## Use named databases

Add entries under `db.databases` when a feature needs a separate database, schema tree, migration directory, or provider binding.

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  plugins: [hubDb()],
  db: {
    databases: {
      analytics: {},
    },
  },
})
```

Named database defaults are derived from the name:

| Database | Local URL | Schema discovery | Migrations dir | Cloudflare binding |
| --- | --- | --- | --- | --- |
| `analytics` | `file:.data/db/analytics.sqlite.db` | `src/db/analytics/schema.ts` and `src/db/analytics/schema/*` | `src/db/analytics/migrations` | `DB_ANALYTICS` |

Use `databases.<name>` in route code:

```ts
import { databases } from '@vitehub/db/drizzle'

await databases.analytics.db
  .insert(databases.analytics.schema.analyticsEvents)
  .values({ name: 'page-view' })
```

## Add explicit schema paths

Set `db.drizzle.schemaPaths` when schema files live outside the default discovery paths.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubDb()],
  db: {
    drizzle: {
      schemaPaths: ['src/database/schema.ts'],
    },
  },
})
```

Explicit paths are merged with discovered default paths. If an explicit path does not exist, ViteHub fails during config resolution.

## Configure migration directories

ViteHub records migration directories in the resolved DB config and Cloudflare output. It does not run migrations for you.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubDb()],
  db: {
    drizzle: {
      migrationsDirs: ['src/db/migrations'],
    },
    databases: {
      analytics: {
        drizzle: {
          migrationsDirs: ['src/db/analytics/migrations'],
        },
      },
    },
  },
})
```

Run migrations with your Drizzle or provider workflow, then keep route code on the same `@vitehub/db/drizzle` runtime import.

## Keep hosted code provider-neutral

Application code should not branch on Cloudflare or Vercel:

```ts
import { db, schema } from '@vitehub/db/drizzle'

await db.insert(schema.notes).values({ title: 'portable write' })
```

Provider details belong in config:

::tabs{sync="provider"}
  :::tabs-item{label="Cloudflare" icon="i-simple-icons-cloudflare" class="p-4"}
    ```ts
    db: {
      cloudflare: {
        binding: 'DB',
        databaseName: 'vitehub-notes',
        databaseId: process.env.VITEHUB_D1_DATABASE_ID,
      },
    }
    ```
  :::

  :::tabs-item{label="Vercel" icon="i-simple-icons-vercel" class="p-4"}
    ```ts
    db: {
      connection: {
        authToken: process.env.TURSO_AUTH_TOKEN,
        url: process.env.TURSO_DATABASE_URL,
      },
    }
    ```
  :::
::

Cloudflare hosted output can use D1 bindings. Vercel hosted output requires remote libSQL URLs because local SQLite files and D1 bindings are not available there.

## Configure a Cloudflare fallback URL

Set both `cloudflare` and `connection` when the same app should run on Cloudflare and in non-Cloudflare hosted environments:

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubDb()],
  db: {
    connection: {
      authToken: process.env.TURSO_AUTH_TOKEN,
      url: process.env.TURSO_DATABASE_URL,
    },
    cloudflare: {
      binding: 'DB',
      databaseName: 'vitehub-notes',
      databaseId: process.env.VITEHUB_D1_DATABASE_ID,
    },
  },
})
```

At runtime, ViteHub uses the active D1 binding first. If no binding exists, it falls back to the libSQL URL.

## Next steps

- Use [Cloudflare D1](./providers/cloudflare) for generated `wrangler.json` behavior.
- Use [Vercel](./providers/vercel) for hosted libSQL requirements.
- Use [Runtime API](./runtime-api) for exact fields and defaults.
