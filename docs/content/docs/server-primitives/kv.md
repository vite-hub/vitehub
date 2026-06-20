---
title: KV
description: Store small key-addressed values behind one stable key-value Runtime Helper.
navigation.order: 4
icon: i-lucide-database-zap
---

KV stores small values addressed by key. Use it for settings, feature flags, cursors, cache records, lightweight state, and simple lookup tables.

KV does not model relationships, constraints, joins, large binary objects, or file trees. Use [Database](/docs/server-primitives/database), [Blob](/docs/server-primitives/blob), or [Workspace](/docs/server-primitives/workspace) for those boundaries.

## Configure KV

Install the package and register the Vite Integration.

```bash [Terminal]
pnpm add @vite-hub/kv
```

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubKv()],
})
```

Local development can use the default local store. Choose a provider in config only when the app needs specific hosted behavior.

## Use it at runtime

Use the `kv` Runtime Helper from server code.

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

Use named stores when configuration defines multiple KV Stores.

```ts [server/rate-limit.ts]
import { kv } from '@vite-hub/kv'

const rateLimitStore = kv.store('rate-limit')

export async function recordHit(key: string) {
  await rateLimitStore.set(key, { seenAt: Date.now() })
}
```

## Provider output

The KV Package owns Default KV Store behavior, named KV Store selection, generated store-name types, and the KV Driver Boundary. Provider-specific namespaces, bindings, and credentials belong in integration configuration and deployment setup.

Application code should keep importing `kv` from `@vite-hub/kv` when switching between local, Cloudflare, Vercel-compatible, or other drivers.

## Connect it to Agents

Direct KV access is for app and server code. To let a model inspect or edit scoped key-value data, attach the KV Capability from the agent capability catalog.

```ts [server/agents/support/config.ts]
import { kv } from '@vite-hub/agent/capabilities'
```

Keep model-facing prefixes narrow and make write behavior explicit. Read [Official capabilities](/docs/capabilities/official-capabilities) for storage Capability modes and write approvals.

## Production boundaries

KV prefixes are conventions, not relational models. Move data to Database when you need constraints, joins, migrations, history, or complex queries.

Do not build public coordination locks on top of basic `kv.get()` and `kv.set()`. ViteHub runtime coordination uses package-owned internal APIs when stronger guarantees are required.

## Next steps

- Use [Database](/docs/server-primitives/database) for relational data.
- Use [Blob](/docs/server-primitives/blob) for object storage.
- Expose scoped model access through [Official capabilities](/docs/capabilities/official-capabilities).
