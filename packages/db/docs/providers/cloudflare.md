---
title: Cloudflare
description: Configure named Cloudflare D1 bindings for @vitehub/db and understand generated Wrangler output.
navigation.group: Providers
frameworks: [vite]
---

Cloudflare support for `@vitehub/db` centers on named D1 bindings.

Use the default database when one binding is enough, or add `db.databases.<name>` entries when separate bindings, schema trees, or migration directories should be visible in the same app.

## Example

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  plugins: [hubDb()],
  db: {
    cloudflare: {
      binding: 'DB',
      databaseId: process.env.VITEHUB_D1_DATABASE_ID,
    },
    databases: {
      analytics: {
        cloudflare: {
          binding: 'DB_ANALYTICS',
          databaseId: process.env.VITEHUB_D1_ANALYTICS_DATABASE_ID,
        },
      },
    },
  },
})
```

When `databaseId` is present, ViteHub emits the binding into generated `wrangler.json`:

```json
{
  "d1_databases": [
    {
      "binding": "DB",
      "database_id": "<default-id>"
    },
    {
      "binding": "DB_ANALYTICS",
      "database_id": "<analytics-id>"
    }
  ]
}
```

## D1-Only And Fallback Modes

- A database entry with `cloudflare.databaseId` and no `connection.url` is treated as D1-only.
- If both are configured, Cloudflare runtime uses the binding first and keeps the libSQL URL as fallback for non-Cloudflare environments.
- Binding names default to `DB` for the default database and `DB_<NAME>` for named entries when `binding` is omitted.

## Runtime Expectation

Application code stays provider-neutral:

```ts
import { databases, db } from '@vitehub/db/drizzle'

await db.select()
await databases.analytics.db.select()
```

The D1 binding is resolved from the active request environment, not from browser code or static client bundles.
