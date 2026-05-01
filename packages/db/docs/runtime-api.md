---
title: Runtime API
description: Review DB config shape, default aliases, named database exports, and hosted-output behavior.
navigation.order: 30
frameworks: [vite]
---

## Config Shape

`@vitehub/db/vite` accepts one default database plus an optional named database map:

```ts
db: {
  connection?: { url?: string, authToken?: string }
  drizzle?: {
    casing?: 'snake_case' | 'camelCase'
    migrationsDirs?: string[]
    schemaPaths?: string[]
  }
  cloudflare?: {
    binding?: string
    databaseId?: string
    previewDatabaseId?: string
    databaseName?: string
    migrationsDir?: string
    migrationsTable?: string
  }
  databases?: {
    analytics?: {
      connection?: { url?: string, authToken?: string }
      drizzle?: {
        casing?: 'snake_case' | 'camelCase'
        migrationsDirs?: string[]
        schemaPaths?: string[]
      }
      cloudflare?: {
        binding?: string
        databaseId?: string
        previewDatabaseId?: string
        databaseName?: string
        migrationsDir?: string
        migrationsTable?: string
      }
    }
  }
}
```

## Runtime Exports

```ts
import { databases, db, schema } from '@vitehub/db/drizzle'
```

- `db` is `databases.default.db`.
- `schema` is `databases.default.schema`.
- `databases.default` and every `databases.<name>` entry expose `{ db, schema }`.

## Runtime Resolution

For each database entry, ViteHub resolves the runtime in this order:

1. Use the active Cloudflare D1 binding when the configured `cloudflare.binding` exists in the request environment.
2. Otherwise use `db.connection.url` through the libSQL driver.
3. Otherwise throw a named configuration error.

## Hosted Output Rules

- Cloudflare output emits `wrangler.json.d1_databases` for entries that define `cloudflare.databaseId`.
- Vercel output requires a remote libSQL `db.connection.url` for every database that must run there.
- File-based SQLite defaults are for local Vite runtime, not hosted deployment output.
