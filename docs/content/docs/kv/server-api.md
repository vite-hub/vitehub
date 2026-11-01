---
title: KV server API
description: Read, write, and delete KV keys from server code with the public imports, the runtime helper, and application teardown.
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

Use `setIfAbsent()` for single-use tokens, such as upload tickets, invite codes, and nonces. It writes the value only when the key has no value, in one atomic step, and returns `true` to the one call that wrote it:

```ts [server/api/uploads/[ticket].put.ts]
const [claimError, claimed] = await kv.setIfAbsent(`uploads:${ticket}`, 1, { ttl: 600 })
if (claimError) throw claimError
if (!claimed) throw createError({ statusCode: 409, statusMessage: 'Ticket already used' })
```

`setIfAbsent()` needs a value: `undefined` fails with `KV_OPERATION_FAILED`, because it cannot mean "remove" as it does for `set()`. Do not use `kv.get()` and then `kv.set()` for this. Two requests can both read a missing key and both write it.

| Driver | `setIfAbsent()` |
| --- | --- |
| `upstash` | Atomic. One `SET NX` command, with `EX` when you pass `ttl`. |
| `deno-kv` | Atomic. One atomic commit that checks that the key is missing. Deno KV deletes an expired key some time after the TTL, so the key can stay set for longer than `ttl`. |
| `fs-lite` | Atomic on one disk, also across processes. It writes a temporary file and links it into place, so other calls see the whole value or none. `fs-lite` never expires keys, so the key stays until you delete it. |
| `cloudflare-kv-binding` | Returns `KV_UNSUPPORTED_OPERATION`. Workers KV is eventually consistent, so two requests can both see a missing key. Use D1 with `INSERT ... ON CONFLICT DO NOTHING`, or a Durable Object. |

`increment()` applies the TTL only when it creates the counter. Deno KV accepts a new relative expiry on each write, so matching that fixed window would require a hidden deadline and cleanup. Deno KV, Cloudflare KV, and local `fs-lite` stores therefore return `KV_UNSUPPORTED_OPERATION` for both methods. Use the [Rate Limit primitive](/docs/rate-limit) when provider-managed request budgets fit the application.

## Runtime helper

`kv` implements `KVStorage`.

| Method | Description |
| --- | --- |
| `kv.get<T>(key)` | Reads a value or returns `null`. |
| `kv.getAndDelete<T>(key)` | Atomically returns and deletes a value on Upstash. |
| `kv.set<T>(key, value)` | Writes a value. |
| `kv.setIfAbsent<T>(key, value, { ttl? })` | Atomically writes a value only when the key has none. Returns `true` when this call wrote it. Not on Cloudflare KV. |
| `kv.has(key)` | Checks whether a key exists. |
| `kv.increment(key, ttl)` | Atomically increments a counter on Upstash. |
| `kv.del(key)` | Deletes one key. |
| `kv.keys(base?)` | Lists keys under an optional base prefix. |
| `kv.list({ limit, prefix?, cursor? })` | Reads one page of keys. Pass the returned `cursor` to read the next page. |
| `kv.clear(base?)` | Deletes keys under an optional base prefix. |
| `kv.store(name)` | Selects a named KV Store. |

Every async method returns `[error, value]`. The type of `error.code` lists the codes that the method can return, and `error.why`, `error.fix`, and `error.docs` explain each failure. A provider failure has the code `KV_OPERATION_FAILED` and keeps the provider error in `cause`. Application code can log, retry, ignore, or translate the error without `try/catch`. Configuration errors, for example an unknown named store, throw. See [Limits and errors](/docs/kv/limits-and-errors) for each code.

## Application teardown

After stopping new application work, call `disposeKVStores()` from your shutdown hook. It releases cached default and named stores, including retained filesystem iterators and Upstash overflow pages. Concurrent calls share one cleanup promise. Cleanup failures reject with an `AggregateError`. Later operations create fresh stores, so restart process-local listings without an old cursor.

For Nitro, register the hook in a server plugin:

```ts [server/plugins/kv-cleanup.ts]
import { disposeKVStores } from '@vite-hub/kv'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', disposeKVStores)
})
```
