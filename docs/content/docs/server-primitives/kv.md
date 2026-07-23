---
title: KV
description: Store small key-addressed values behind one stable key-value Runtime Helper.
navigation.order: 4
icon: i-lucide-database-zap
---

KV stores small values addressed by key. Use it for settings, feature flags, cursors, cache records, lightweight state, and simple lookup tables.

KV does not model relationships, constraints, joins, large binary objects, or file trees. Use [Database](/docs/server-primitives/database), [Blob](/docs/server-primitives/blob), or [Workspace](/docs/server-primitives/workspace) for those boundaries.

## Quick start

::steps{level="3"}

### Install

```bash [Terminal]
pnpm add @vite-hub/kv
```

### Configure

```ts [vite.config.ts]
import { hubKv } from '@vite-hub/kv/vite'
import { defineConfig } from 'vite'

export default defineConfig({
  plugins: [hubKv()],
})
```

### Start using it

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

::

## Public imports

| Import | Use |
| --- | --- |
| `kv` from `@vite-hub/kv` | Read and write the Default KV Store or a named KV Store. |
| `hubKv` from `@vite-hub/kv/vite` | Register KV runtime configuration. |
| `resolveKVViteConfig` from `@vite-hub/kv/vite` | Resolve KV Vite runtime config manually. |

All KV driver, store, module, and storage types are exported from `@vite-hub/kv`.

## Configuration options

Configure a default store directly, or configure named stores with `kv.stores`.

```ts [vite.config.ts]
export default defineConfig({
  plugins: [hubKv()],
  kv: {
    stores: {
      default: { driver: 'fs-lite' },
      rateLimit: { driver: 'upstash' },
    },
  },
})
```

| Shape | Description |
| --- | --- |
| `kv: false` | Disables KV runtime configuration. |
| `kv: { driver: 'fs-lite', base?: string }` | Uses local filesystem-backed KV. Default `base`: `.data/kv`. |
| `kv: { driver: 'cloudflare-kv-binding', binding?: string, namespaceId?: string }` | Uses Cloudflare KV. Default `binding`: `KV`. `namespaceId` can come from `KV_NAMESPACE_ID`. |
| `kv: { driver: 'deno-kv', path?: string }` | Uses native Deno KV through `Deno.openKv()`. |
| `kv: { driver: 'upstash', url?: string, token?: string }` | Uses Upstash REST KV. Values can come from `KV_REST_API_URL` and `KV_REST_API_TOKEN`. |
| `kv: { stores: Record<string, KVStoreConfig> }` | Defines named KV Stores. `stores.default` is required. |

## Providers

| Provider | Driver | Default resolution |
| --- | --- | --- |
| Local filesystem | `fs-lite` | Used for local/non-hosted development when no hosted env is detected. |
| Cloudflare KV | `cloudflare-kv-binding` | Used on Cloudflare hosting. |
| Deno KV | `deno-kv` | Used on Deno hosting. |
| Upstash | `upstash` | Used when Upstash env vars are present or when Vercel hosting is detected. |

## Use it at runtime

Use the `kv` Runtime Helper from server code.

```ts [server/api/settings.put.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get('settings')
  if (error) throw error
  return { settings }
})
```

Use named stores when configuration defines multiple KV Stores.

```ts [server/tenant-preferences.ts]
import { kv } from '@vite-hub/kv'

const preferences = kv.store('tenant-preferences')

export async function savePreferences(tenantId: string, value: unknown) {
  const [error] = await preferences.set(tenantId, value)
  if (error) throw error
}
```

KV does not provide the atomic consume contract required for request budgets. Use the [Rate Limit primitive](/docs/server-primitives/rate-limit) instead of composing `get()` and `set()` under concurrency.

## Runtime Helper

`kv` implements `KVStorage`.

| Method | Description |
| --- | --- |
| `kv.get<T>(key)` | Reads a value or returns `null`. |
| `kv.set<T>(key, value)` | Writes a value. |
| `kv.has(key)` | Checks whether a key exists. |
| `kv.del(key)` | Deletes one key. |
| `kv.keys(base?)` | Lists keys under an optional base prefix. |
| `kv.clear(base?)` | Deletes keys under an optional base prefix. |
| `kv.store(name)` | Selects a named KV Store. |

Every async method returns `[error, value]`. Provider failures are `ViteHubError` values with code `KV_OPERATION_FAILED`, operation/store details, and the provider failure in `cause`. Application code can log, retry, ignore, or translate the error without `try/catch`. Invalid configuration and unknown named stores still throw before provider execution.

## Provider output

The KV Package owns Default KV Store behavior, named KV Store selection, generated store-name types, and the KV Driver Boundary. Provider-specific namespaces, bindings, and credentials belong in integration configuration and deployment setup.

Application code should keep importing `kv` from `@vite-hub/kv` when switching between local, Cloudflare, Deno, Vercel-compatible, or other drivers.

## Connect it to Agents

Direct KV access is for app and server code. To let a model inspect or edit scoped key-value data, attach the KV Capability from the agent capability catalog.

```ts [server/agents/support/agent.ts]
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
