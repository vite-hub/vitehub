---
title: First server primitive
description: Add KV to an app and call it from server code.
navigation.order: 3
icon: i-lucide-server-cog
---

KV is the fastest first server primitive because it stores small values by key and does not require a Definition file.

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

Local development uses a local store by default. Add host configuration later when you deploy.

## Write a value

Create a server route that writes a small JSON-like value.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

## Read the value

Read from the same Runtime Helper in any server route.

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```

The route imports `kv` from `@vite-hub/kv`. It does not import a Cloudflare, Vercel, or local driver directly.

## Continue with the full KV page

The full [KV](/docs/server-primitives/kv) page covers prefixes, host storage, and using KV from an Agent Capability.

Use [Database](/docs/server-primitives/database) instead when the data needs relationships, constraints, joins, migrations, or history.

