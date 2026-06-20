---
title: First server primitive
description: Add KV to an app and call it from server code.
navigation.order: 3
icon: i-lucide-server-cog
---

KV stores small values by key behind one stable Runtime Helper. It is the fastest first primitive because server code can use it after the Vite Integration resolves the local or hosted store.

## Install KV

```bash [Terminal]
pnpm add @vite-hub/kv
```

Register the KV integration.

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubKv()],
})
```

Local development uses a file-backed store by default. Add Cloudflare, Vercel, or Upstash configuration only when deployment needs it.

## Write a value

Create a server route that writes a small JSON-like value through the `kv` Runtime Helper.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

## Read the value

Read from the same Runtime Helper in another server route.

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```

The route imports `kv` from `@vite-hub/kv`. It does not import a Cloudflare, Vercel, or local driver directly.

## Inspect it

Run the app and call the two routes.

```bash [Terminal]
pnpm dev
```

```bash [Terminal]
curl -X PUT http://localhost:5173/api/settings \
  -H 'content-type: application/json' \
  -d '{"theme":"system"}'

curl http://localhost:5173/api/settings
```

With the default local driver, KV data is stored under `.data/kv`. The important proof is that route code stays stable while the Vite Integration owns the selected store.

## Next steps

- Read the full [KV](/docs/server-primitives/kv) page for prefixes, named stores, and hosted drivers.
- Use [Database](/docs/server-primitives/database) when data needs relationships, joins, migrations, or history.
- Read [Runtime Helpers and stable imports](/docs/concepts/runtime-helpers-and-stable-imports) to understand why server code imports `kv` instead of a provider driver.
