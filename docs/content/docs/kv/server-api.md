---
title: KV server API
description: Read, write, and delete KV keys from server code, and close stores when the app shuts down.
navigation.title: Server API
navigation.order: 4
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `kv` from `@vite-hub/kv` | Read and write the default store or a named store. |
| `disposeKVStores` from `@vite-hub/kv` | Close all cached stores in a shutdown hook. |
| `hubKV` from `@vite-hub/kv/vite` | Register KV in the Vite config. |
| `resolveKVViteConfig` from `@vite-hub/kv/vite` | Resolve the KV config by hand. |

`@vite-hub/kv` also exports all driver, store, module, and storage types.

## Use it at runtime

Import `kv` in server code to save and read values.

```ts [server/api/settings.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { defineEventHandler } from 'h3'
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get('settings')
  if (error) throw error
  return { settings }
})
```

When your config has more than one store, select one by name.

```ts [server/tenant-preferences.ts]
import { kv } from '@vite-hub/kv'

const preferences = kv.store('tenant-preferences')

export async function savePreferences(tenantId: string, value: unknown) {
  const [error] = await preferences.set(tenantId, value)
  if (error) throw error
}
```

### Read-only handles

Pass `{ mode: 'read' }` to `kv.store()` for code that only reads. The handle has `get()`, `has()`, `keys()`, and `list()`. Write methods (`set()`, `setIfAbsent()`, `delete()`, `clear()`, `increment()`, `getAndDelete()`) are type errors and absent at runtime. The default store is `kv.store('default', { mode: 'read' })`.

```ts [server/api/flags.get.ts]
import { defineEventHandler } from 'h3'
import { kv } from '@vite-hub/kv'

const flags = kv.store('default', { mode: 'read' })

export default defineEventHandler(async () => {
  const [error, value] = await flags.get('flags')
  if (error) throw error
  // flags.set() is a type error.
  return value
})
```

`mode` defaults to `'write'`. Another value throws [`KV_INVALID_STORE_MODE`](/docs/kv/limits-and-errors#kv_invalid_store_mode).

::warning
The mode limits this API, not the host. The Cloudflare KV binding, the Upstash token, and `fs-lite` files keep full access, and code can still import the full `kv`. It is not a security boundary. Use it to show intent and keep writes out of read-only code.
::

Upstash has atomic single-use reads and counters:

```ts [server/verification.ts] fragment
const [consumeError, token] = await kv.getAndDelete('verification:token')
if (consumeError) throw consumeError

const [incrementError, attempts] = await kv.increment('rate-limit:user', 60)
if (incrementError) throw incrementError
```

Use `setIfAbsent()` for single-use tokens, such as upload tickets, invite codes, and nonces. It writes only when the key is empty, in one atomic step. It returns `true` to the one call that wrote:

```ts [server/api/uploads/[ticket].put.ts] fragment
const [claimError, claimed] = await kv.setIfAbsent(`uploads:${ticket}`, 1, { ttl: 600 })
if (claimError) throw claimError
if (!claimed) throw createError({ statusCode: 409, statusMessage: 'Ticket already used' })
```

`setIfAbsent()` needs a value: `undefined` fails with `KV_OPERATION_FAILED`, because it cannot mean "remove" as in `set()`. Do not use `kv.get()` then `kv.set()`: two requests can both see a missing key and both write.

| Driver | `setIfAbsent()` |
| --- | --- |
| `upstash` | Atomic. One `SET NX` command, with `EX` when you pass `ttl`. |
| `deno-kv` | Atomic. One commit that checks the key is missing. Deno KV deletes expired keys some time after the TTL, so a key can stay longer than `ttl`. |
| `fs-lite` | Atomic on one disk, also across processes. It writes a temporary file and links it into place, so other calls see the whole value or none. `fs-lite` never expires keys. |
| `cloudflare-kv-binding` | Returns `KV_UNSUPPORTED_OPERATION`. Workers KV is eventually consistent, so two requests can both see a missing key. Use D1 with `INSERT ... ON CONFLICT DO NOTHING`, or a Durable Object. |

`increment()` sets the TTL only when it creates the counter. Deno KV sets a new expiry on each write, so a fixed window would need a hidden deadline and cleanup. So Deno KV, Cloudflare KV, and `fs-lite` return `KV_UNSUPPORTED_OPERATION` for `increment()` and `getAndDelete()`. For request budgets, use [Rate Limit](/docs/rate-limit).

## Runtime helper

`kv` implements `KVStorage`.

| Method | Description |
| --- | --- |
| `kv.get<T>(key, { type? })` | Reads a value or returns `null`. `type` converts it ([Typed reads](#typed-reads)). |
| `kv.getAndDelete<T>(key, { type? })` | Returns and deletes a value in one step on Upstash. `{ type: 'text' }` returns the stored text. |
| `kv.set<T>(key, value)` | Writes a value. |
| `kv.setIfAbsent<T>(key, value, { ttl? })` | Writes only when the key is empty, in one step. Returns `true` when this call wrote. Not on Cloudflare KV. |
| `kv.has(key)` | Checks whether a key exists. |
| `kv.increment(key, ttl)` | Adds one to a counter in one step on Upstash. |
| `kv.delete(key)` | Deletes one key. |
| `kv.keys(base?)` | Lists keys, optionally under a prefix. |
| `kv.list({ limit, prefix?, cursor? })` | Reads one page of keys. Pass the returned `cursor` for the next page. |
| `kv.clear(base?)` | Deletes keys, optionally under a prefix. |
| `kv.store(name, options?)` | Selects a named store. `{ mode: 'read' }` returns a [read-only handle](#read-only-handles). |

Every async method returns `[error, value]`, so you need no `try/catch`. `error.code` is typed per method, and `why`, `fix`, and `docs` explain it. Provider failures are `KV_OPERATION_FAILED`, with the provider error in `cause`. Configuration errors, such as an unknown store, throw. Read [Limits and errors](/docs/kv/limits-and-errors) for each code.

Keys are strings such as `users:alice` or `users/alice`. Both `/` and `:` separate segments. A key needs at least one segment and no `.` or `..` segment, so `''`, `':'`, and `'a/../b'` return `KV_OPERATION_FAILED`. On Cloudflare KV, a key above 512 UTF-8 bytes returns `KV_KEY_TOO_LONG` ([Limits](/docs/kv/limits-and-errors#limits)).

## Typed reads

`kv.get()` parses a stored string as JSON, so the string `'123'` reads back as the number `123`, and `'true'` as `true`. Pass `type` to get a fixed form:

```ts [server/invite.ts] fragment
const [error, code] = await kv.get('invite:alice', { type: 'text' })
// code is the string '123456', not the number 123456
```

| `type` | Returns |
| --- | --- |
| `'text'` | The stored text as a `string`. Objects and arrays come back as JSON text. |
| `'json'` | The parsed JSON value, as without `type`. |
| `'bytes'` | A `Uint8Array`. |
| `'blob'` | A `Blob`. |
| `'stream'` | A `ReadableStream<Uint8Array>`. |

The return type follows `type`: `kv.get(key, { type: 'text' })` is `string | null`. A missing key is `null` for every `type`. `kv.getAndDelete()` accepts `{ type: 'text' }`. The Upstash client parses JSON first, so on Upstash `'text'` returns the JSON text of the value.

## Application teardown

After the app stops taking new work, call `disposeKVStores()` in your shutdown hook. It closes cached stores, with open filesystem iterators and Upstash overflow pages.

- Calls at the same time share one cleanup promise.
- Cleanup failures reject with an `AggregateError`.
- Later operations create new stores, so restart in-process listings without an old cursor.

In Nitro, register the hook in a server plugin:

```ts [server/plugins/kv-cleanup.ts] fragment
import { disposeKVStores } from '@vite-hub/kv'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', disposeKVStores)
})
```
