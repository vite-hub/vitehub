---
title: KV server API
description: Read, write, and delete KV keys from server code.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `kv` from `@vite-hub/kv` | Read and write the Default KV Store or a named KV Store. |
| `disposeKVStores` from `@vite-hub/kv` | Dispose all cached stores from an application shutdown hook. |
| `hubKv` from `@vite-hub/kv/vite` | Register KV runtime configuration. |
| `resolveKVViteConfig` from `@vite-hub/kv/vite` | Resolve KV Vite runtime config manually. |

All KV driver, store, module, and storage types are exported from `@vite-hub/kv`.

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

Upstash provides atomic single-use reads and counters:

```ts [server/verification.ts]
const [consumeError, token] = await kv.getAndDelete('verification:token')
if (consumeError) throw consumeError

const [incrementError, attempts] = await kv.increment('rate-limit:user', 60)
if (incrementError) throw incrementError
```

`increment()` applies the TTL only when it creates the counter. Deno KV accepts a new relative expiry on each write, so matching that fixed window would require a hidden deadline and cleanup. Deno KV, Cloudflare KV, and local `fs-lite` stores therefore reject both methods. Use the [Rate Limit primitive](/docs/rate-limit) when provider-managed request budgets fit the application.

## Runtime helper

`kv` implements `KVStorage`.

| Method | Description |
| --- | --- |
| `kv.get<T>(key)` | Reads a value or returns `null`. |
| `kv.getAndDelete<T>(key)` | Atomically returns and deletes a value on Upstash. |
| `kv.set<T>(key, value)` | Writes a value. |
| `kv.has(key)` | Checks whether a key exists. |
| `kv.increment(key, ttl)` | Atomically increments a counter on Upstash. |
| `kv.del(key)` | Deletes one key. |
| `kv.keys(base?)` | Lists keys under an optional base prefix. |
| `kv.clear(base?)` | Deletes keys under an optional base prefix. |
| `kv.store(name)` | Selects a named KV Store. |

Every async method returns `[error, value]`. Provider failures are `ViteHubError` values with code `KV_OPERATION_FAILED`, operation/store details, and the provider failure in `cause`. Application code can log, retry, ignore, or translate the error without `try/catch`. Invalid configuration and unknown named stores still throw before provider execution.

## Application teardown

After stopping new application work, call `disposeKVStores()` from your shutdown hook. It releases cached default and named stores, including retained filesystem iterators and Upstash overflow pages. Concurrent calls share one cleanup promise. Cleanup failures reject with an `AggregateError`. Later operations create fresh stores, so restart process-local listings without an old cursor.

For Nitro, register the hook in a server plugin:

```ts [server/plugins/kv-cleanup.ts]
import { disposeKVStores } from '@vite-hub/kv'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', disposeKVStores)
})
```
