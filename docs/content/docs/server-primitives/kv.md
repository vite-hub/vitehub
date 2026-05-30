---
title: KV
description: Store small JSON-like values behind one stable key-value Runtime Helper.
navigation.order: 4
icon: i-lucide-database-zap
---

KV is the primitive for small values addressed by key. Use it for settings, feature flags, cache records, cursors, lightweight state, and simple lookup tables.

Do not use KV for relational data, complex queries, large binary objects, or file trees. Use [Database](/docs/server-primitives/database), [Blob](/docs/server-primitives/blob), or [Workspace and Sources](/docs/server-primitives/workspace) for those.

## Install and configure

```bash
pnpm add @vite-hub/kv
```

Register the integration and choose a driver only when you need to override the default.

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'fs-lite',
  },
})
```

## Runtime API

Use `kv` from server code.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  await kv.set('settings', await readBody(event))
  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```

Common operations:

```ts
await kv.set('settings', { theme: 'system' })
await kv.get('settings')
await kv.has('settings')
await kv.del('settings')
await kv.keys('users:')
await kv.clear('cache:')
```

## Prefixes

Use prefixes when one store holds multiple logical groups.

```ts
await kv.set('users:42:profile', profile)
await kv.set('users:42:prefs', prefs)

const keys = await kv.keys('users:42:')
```

Prefixes are a convention, not a relational model. If the app needs constraints, joins, migrations, or history, move the data to Database.

## Local development

Local development should be boring. The default local path uses a file-backed store so you can run the app without provisioning a remote service.

Host-specific drivers should be tested before deployment, but route code should not change when you switch drivers.

## Cloudflare KV namespace

Cloudflare KV uses a binding and namespace id.

```ts [vite.config.ts]
export default defineConfig({
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: process.env.CLOUDFLARE_KV_NAMESPACE_ID,
  },
})
```

Cloudflare setup should stay in config and deployment metadata. Server routes should still import `kv` from `@vite-hub/kv`.

## Upstash-backed KV on Vercel

Vercel KV usually routes through Upstash credentials.

```env [.env]
KV_REST_API_URL=https://example.upstash.io
KV_REST_API_TOKEN=<upstash-rest-token>
```

```ts [vite.config.ts]
export default defineConfig({
  kv: {
    driver: 'upstash',
  },
})
```

## Using KV from an agent

This page is about app code using KV directly. To let a model read or edit scoped KV data, attach the KV Capability from the agent docs:

```ts
import { kv } from '@vite-hub/agent/capabilities'
```

Read [Agent capabilities](/docs/agents/capabilities) before exposing writable storage to a model.
