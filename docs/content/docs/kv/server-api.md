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
| `kv` from `vite-hub/kv` | Read and write the default store or a named store. |
| `disposeKVStores` from `vite-hub/kv` | Close all cached stores in a shutdown hook. |
| `getKVStoreDriver` from `vite-hub/kv` | Name the configured driver that a store uses in this server process. Driver selection occurs at build time; Rate Limit reads it at boot without opening a store connection. App tests return `fs-lite`. |
| `hubKV` from `@vite-hub/kv/vite` | Register KV in the Vite config. |
| `resolveKVViteConfig` from `@vite-hub/kv/vite` | Resolve the KV config by hand. |

`vite-hub/kv` also exports all driver, store, module, and storage types.

## Use it at runtime

Import `kv` in server code to save and read values.

```ts [server/api/settings.put.ts]
import { defineEventHandler, readBody } from 'h3'
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async (event) => {
  const [error] = await kv.set('settings', await readBody(event))
  if (error) throw error
  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { defineEventHandler } from 'h3'
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get('settings')
  if (error) throw error
  return { settings }
})
```

When your config has more than one store, select one by name.

```ts [server/tenant-preferences.ts]
import { kv } from 'vite-hub/kv'

const preferences = kv.store('tenant-preferences')

export async function savePreferences(tenantId: string, value: unknown) {
  const [error] = await preferences.set(tenantId, value)
  if (error) throw error
}
```

### Read and write many keys

`kv.getMany(keys)` reads many keys in one call. Its value has one item per key, in the order of `keys`, with `null` for a missing key. `kv.setMany(entries)` writes an array of `{ key, value }` entries:

```ts [server/api/profiles.get.ts] fragment
const [writeError] = await kv.setMany([
  { key: 'profile:ada', value: { name: 'Ada' } },
  { key: 'profile:linus', value: { name: 'Linus' } },
], { ttl: 3600 })
if (writeError) throw writeError

const [readError, profiles] = await kv.getMany<{ name: string }>(['profile:ada', 'profile:grace', 'profile:linus'])
if (readError) throw readError
// [{ name: 'Ada' }, null, { name: 'Linus' }]
```

The options work as in `get()` and `set()` and apply to every key. In `setMany()`, the last entry of a key wins, and a `value` of `undefined` deletes the key, as `set()` does. `setMany()` is not atomic: when it fails, some entries can be written. Use `setIfAbsent()` or a Database transaction when all writes must succeed together.

| Driver | `getMany()` | `setMany()` |
| --- | --- | --- |
| `redis` | `MGET`, 1000 keys per command. | One pipeline. |
| `database` | One `SELECT` per 200 keys. | One `INSERT ... ON CONFLICT` per 200 entries. |
| `upstash` | One `MGET`. | One request per entry, 16 at a time. |
| `cloudflare-kv-binding` | One bulk `get()` per 100 keys. | One `put()` per entry, 16 at a time. It checks every entry against the [Workers KV limits](/docs/kv/limits-and-errors#limits) before it writes any. |
| `deno-kv`, `fs-lite` | One read per key, 16 at a time. | One write per key, 16 at a time. |

### Read-only handles

Pass `{ mode: 'read' }` to `kv.store()` for code that only reads. The handle has `get()`, `getMany()`, `has()`, `keys()`, and `list()`. Write methods (`set()`, `setMany()`, `setIfAbsent()`, `delete()`, `deleteIfEquals()`, `clear()`, `increment()`, `getAndDelete()`) are type errors and absent at runtime. The default store is `kv.store('default', { mode: 'read' })`.

```ts [server/api/flags.get.ts]
import { defineEventHandler } from 'h3'
import { kv } from 'vite-hub/kv'

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

The `redis`, `database`, and `upstash` drivers provide atomic single-use reads and counters:

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
| `redis` | Atomic. One `SET NX` command, with `PX` when you pass `ttl`. |
| `database` | Atomic. One `INSERT ... ON CONFLICT` statement that also replaces an expired key. Expiry uses the clock of the Database. |
| `upstash` | Atomic. One `SET NX` command, with `EX` when you pass `ttl`. |
| `deno-kv` | Atomic. One commit that checks the key is missing. Deno KV deletes expired keys some time after the TTL, so a key can stay longer than `ttl`. |
| `fs-lite` | Atomic on one disk, also across processes. It writes a temporary file and links it into place, so other calls see the whole value or none. `fs-lite` never expires keys. |
| `cloudflare-kv-binding` | Returns `KV_UNSUPPORTED_OPERATION`. Workers KV is eventually consistent, so two requests can both see a missing key. Use D1 with `INSERT ... ON CONFLICT DO NOTHING`, or a Durable Object. |

`increment()` applies the TTL only when it creates the counter. Redis and Upstash round it up to whole seconds. A stored value that is not an integer, or that is already `Number.MAX_SAFE_INTEGER`, returns `KV_OPERATION_FAILED` and does not change. Deno KV accepts a new relative expiry on each write, so matching that fixed window would require a hidden deadline and cleanup. Deno KV, Cloudflare KV, and local `fs-lite` stores therefore return `KV_UNSUPPORTED_OPERATION` for both methods.

`deleteIfEquals(key, expected)` deletes the key only when it holds `expected`, in one atomic step, and returns `true` when this call deleted it. Use it to free a token that only its owner may free:

```ts [server/jobs/report.ts] fragment
const owner = crypto.randomUUID()
const [claimError, claimed] = await kv.setIfAbsent('jobs:report', owner, { ttl: 60 })
if (claimError) throw claimError
if (claimed) {
  // ... run the job ...
  const [releaseError] = await kv.deleteIfEquals('jobs:report', owner)
  if (releaseError) throw releaseError
}
```

KV compares the stored text with `expected` serialized as `set()` stores it, so objects with the same fields in another order are not equal. The `redis`, `database`, and `upstash` drivers support it. Other drivers return `KV_UNSUPPORTED_OPERATION`. The type `KVDriversWith<'deleteIfEquals'>` lists the drivers that support an operation. Use the [Rate Limit primitive](/docs/rate-limit) when provider-managed request budgets fit the application.

## Runtime helper

`kv` implements `KVStorage`.

| Method | Description |
| --- | --- |
| `kv.get<T>(key, { type? })` | Reads a value or returns `null`. Pass `type` to convert it, see [Typed reads](#typed-reads). |
| `kv.getMany<T>(keys, { type? })` | Reads many keys in one call. Returns one value or `null` per key, in the order of `keys`. See [Read and write many keys](#read-and-write-many-keys). |
| `kv.getAndDelete<T>(key, { type? })` | Atomically returns and deletes a value on `redis`, `database`, and Upstash. `{ type: 'text' }` returns the stored text. |
| `kv.set<T>(key, value, { ttl? })` | Writes a value. The driver applies `ttl` in seconds. `fs-lite`, the local store of `vite dev`, ignores it, so the key stays until you delete it. |
| `kv.setMany<T>(entries, { ttl? })` | Writes an array of `{ key, value }` entries. Not atomic. |
| `kv.setIfAbsent<T>(key, value, { ttl? })` | Writes only when the key is empty, in one step. Returns `true` when this call wrote. Not on Cloudflare KV. |
| `kv.has(key)` | Checks whether a key exists. |
| `kv.increment(key, ttl)` | Atomically increments a counter on `redis`, `database`, and Upstash. |
| `kv.delete(key)` | Deletes one key. |
| `kv.deleteIfEquals<T>(key, expected)` | Atomically deletes the key when it holds `expected`. Returns `true` when this call deleted it. On `redis`, `database`, and Upstash. |
| `kv.keys(base?)` | Lists keys under an optional base prefix. |
| `kv.list({ limit, prefix?, cursor? })` | Reads one page of keys. Pass the returned `cursor` to read the next page. |
| `kv.clear(base?)` | Deletes keys under an optional base prefix. `kv.clear('users')` deletes `users:alice` but not `users-old:alice`. The store deletes in batches: one statement on `database`, 1000 keys per command on Redis, one command on Upstash. Cloudflare KV deletes one key per call. |
| `kv.store(name, options?)` | Selects a named KV Store. `{ mode: 'read' }` returns a [read-only handle](#read-only-handles). |

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

After the app stops taking new work, call `disposeKVStores()` in your shutdown hook. It closes cached stores, including Redis connections, open filesystem iterators, and Upstash overflow pages. When a store can use Redis, ViteHub registers it on Nitro's `close` hook for you, so the process can exit after a stop signal.

- Calls at the same time share one cleanup promise.
- Cleanup failures reject with an `AggregateError`.
- Later operations create new stores, so restart in-process listings without an old cursor.

In Nitro, register the hook in a server plugin:

```ts [server/plugins/kv-cleanup.ts] fragment
import { disposeKVStores } from 'vite-hub/kv'

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook('close', disposeKVStores)
})
```
