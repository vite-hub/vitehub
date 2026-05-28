---
title: DB runtime API
description: Runtime imports and definition configuration for @vitehub/db.
navigation.title: Runtime API
navigation.order: 3
icon: i-lucide-code
frameworks: [vite]
---

## Definition

```ts
defineDatabase({
  tables: {
    notes,
  },
  connection: {
    url: process.env.TURSO_DATABASE_URL,
    authToken: process.env.TURSO_AUTH_TOKEN,
  },
  cloudflare: {
    binding: 'DB',
    databaseName: 'my-database',
    databaseId: process.env.CLOUDFLARE_D1_DATABASE_ID,
  },
  drizzle: {
    casing: 'snake_case',
  },
})
```

`tables` is required. It is the Drizzle table map used to generate Drizzle Kit schema artifacts.

## Imports

```ts
import { db, schema, databases } from '@vitehub/db/drizzle'
```

- `db` and `schema` alias the default database.
- `databases.<name>.db` and `databases.<name>.schema` access named databases.
- In all-named mode, use `databases.<name>` directly.

## Vite Config

The Vite `db` option is for integration behavior, not database definitions:

```ts
export default defineConfig({
  db: {
    cli: {
      generate: false,
      migrate: false,
    },
  },
})
```
