---
title: Vercel
description: Use hosted libSQL databases with @vitehub/db on Vercel and understand the D1-only limitation.
navigation.group: Providers
frameworks: [vite]
---

Vercel support for `@vitehub/db` uses hosted libSQL URLs.

## Example

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubDb } from '@vitehub/db/vite'

export default defineConfig({
  plugins: [hubDb()],
  db: {
    connection: {
      authToken: process.env.TURSO_AUTH_TOKEN,
      url: process.env.TURSO_DATABASE_URL,
    },
    databases: {
      analytics: {
        connection: {
          authToken: process.env.TURSO_AUTH_TOKEN,
          url: process.env.TURSO_ANALYTICS_DATABASE_URL,
        },
      },
    },
  },
})
```

## Important Limitation

Vercel output does not run Cloudflare D1 bindings. That means:

- named databases that should run on Vercel need `connection.url`
- D1-only named databases are rejected during ViteHub hosted output generation
- keeping a libSQL fallback URL on a Cloudflare-backed database is the portable option when the same app also targets Vercel

## Runtime Behavior

The runtime import stays the same:

```ts
import { databases, db, schema } from '@vitehub/db/drizzle'

await db.insert(schema.notes).values({ title: 'hello' })
await databases.analytics.db.select()
```

Vercel never resolves `cloudflare.binding`; it uses the configured hosted libSQL URLs directly.
