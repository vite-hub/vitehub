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

## Agent Tools

```ts
import { createDbTools } from '@vitehub/db/agent'
```

`createDbTools()` returns ViteHub Agent-compatible Tools backed by the same `@vitehub/db/drizzle` runtime handles:

```ts
createDbTools({ access: 'read' })
createDbTools({ database: 'analytics', access: 'write' })
createDbTools({ database: 'analytics', access: 'schema' })
```

| Access | Tools |
| --- | --- |
| `read` | List schema tables, select rows, and run `SELECT` SQL for the configured database. |
| `write` | Includes `read`, plus seed-style insert, update, and delete operations through Drizzle tables. |
| `schema` | Includes `write`, plus approval-gated runtime DDL SQL execution through Drizzle SQL primitives. |

Each factory call is scoped to one database. `database` can be omitted when only one database is configured; pass it when multiple databases are configured. The default database exposes `db_*` Tool names. Named databases expose `<database>_db_*` Tool names, or use `prefix` to choose a different Tool prefix.

Schema Tools execute explicit runtime DDL. They do not replace Drizzle Kit, provider migration commands, or the deployment migration workflow.

## Runtime Resolution

For each database entry, ViteHub resolves the runtime in this order:

1. Use the active Cloudflare D1 binding when the configured `cloudflare.binding` exists in the request environment.
2. Otherwise use `db.connection.url` through the libSQL driver.
3. Otherwise throw a named configuration error.

## Hosted Output Rules

- Cloudflare output emits `wrangler.json.d1_databases` for entries that define `cloudflare.databaseId`.
- Cloudflare output requires `cloudflare.databaseName` whenever `cloudflare.databaseId` is set.
- Vercel output requires `db.connection.url` for every D1-backed named database that must run there.
- File-based SQLite defaults are for local Vite runtime, not hosted deployment output.
