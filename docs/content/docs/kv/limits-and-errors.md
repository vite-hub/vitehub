---
title: KV limits and errors
description: Handle KV errors by code, and fix KV configuration, runtime, provider, and tool errors before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle KV errors

Each KV operation returns `[error, value]`. An error has these fields:

- `code`: the failure name.
- `why`: what went wrong.
- `fix`: what to do.
- `docs`: a link to the code in [KV diagnostics](/docs/kv/diagnostics).
- `cause`: the provider error.

```ts [server/api/settings.get.ts]
import { defineEventHandler } from 'h3'
import { kv } from 'vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get('settings')
  if (error) {
    console.error(error.code, error.why, error.cause)
    throw error
  }
  return { settings }
})
```

`error.code` is typed per method. For example, `kv.list()` can return `KV_INVALID_CURSOR`, `KV_INVALID_LIMIT`, or `KV_OPERATION_FAILED`, and `kv.get()` `KV_KEY_TOO_LONG` or `KV_OPERATION_FAILED`.

::warning
`JSON.stringify(error)` keeps only `name`, `code`, `why`, `fix`, and `docs`. It drops `cause` and `stack`, because provider errors can contain credentials or private data. Log `cause` only on the server.
::

Configuration errors throw instead, such as an unknown store name or a missing `REDIS_URL` or Upstash variable. A retry cannot help: change the code or the deployment.

| Code | Returned by | Thrown |
| --- | --- | --- |
| `KV_INVALID_CURSOR` | `list()` | |
| `KV_INVALID_LIMIT` | `list()` | |
| `KV_INVALID_TTL` | `increment()`, `setIfAbsent()` | |
| `KV_KEY_TOO_LONG` | `delete()`, `get()`, `has()`, `set()` | |
| `KV_METADATA_TOO_LARGE`, `KV_TTL_TOO_SHORT`, `KV_VALUE_TOO_LARGE` | `set()` | |
| `KV_OPERATION_FAILED` | Every method | |
| `KV_UNSUPPORTED_OPERATION` | `deleteIfEquals()`, `getAndDelete()`, `increment()`, `setIfAbsent()` | |
| `KV_DATABASE_UNAVAILABLE`, `KV_DENO_KV_UNAVAILABLE`, `KV_DISABLED`, `KV_MISSING_ENV`, `KV_STORE_NOT_FOUND` | | When an operation starts |
| `KV_INVALID_CONFIG`, `KV_INVALID_DRIVER`, `KV_MISSING_DEFAULT_STORE` | | When Vite reads the config |

## Limits

A store with the `cloudflare-kv-binding` driver checks the [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/) before it calls the binding, and returns a named code instead of `KV_OPERATION_FAILED`. The same check runs in production and in `vite dev` with the Cloudflare host, so a key that Cloudflare rejects fails during development with the same code. When the dev runtime has no binding, the local `fs-lite` store of the Cloudflare host checks the same limits.

| Limit | Cloudflare KV | Code |
| --- | --- | --- |
| Key size, in UTF-8 bytes | 512 bytes | `KV_KEY_TOO_LONG` |
| Value size, after ViteHub serializes the value | 25 MiB | `KV_VALUE_TOO_LARGE` |
| `metadata` size, as JSON | 1024 bytes | `KV_METADATA_TOO_LARGE` |
| `expirationTtl` | At least 60 seconds | `KV_TTL_TOO_SHORT` |
| `expiration`, as Unix time in seconds | At least 60 seconds in the future | `KV_TTL_TOO_SHORT` |

The `ttl` option of `kv.set()` does not fail: on Cloudflare KV, ViteHub raises a `ttl` below 60 seconds to 60. `expirationTtl` and `expiration` below the minimum return `KV_TTL_TOO_SHORT`. A relative expiration wins over `expiration`, as on Cloudflare.

`fs-lite`, `deno-kv`, and `upstash` do not check these limits. Upstash [limits requests](https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded) to 10 MB on its Free and Pay as you go plans, and other plans differ. ViteHub does not know your plan, so a larger request fails with `KV_OPERATION_FAILED`.

## Runtime errors

### KV_INVALID_CURSOR

The `cursor` of `kv.list()` expired, is in use, belongs to another store, or is not valid. `fs-lite` and Upstash keep some cursors in process memory, so a restart or `disposeKVStores()` expires them. Cloudflare KV and Deno KV cursors carry the provider cursor, so another isolate or a restarted process can continue the listing. List again without `cursor`.

### KV_INVALID_LIMIT

`kv.list()` needs `limit` as a positive integer.

### KV_INVALID_TTL

`kv.increment(key, ttl)` and `kv.setIfAbsent()`'s `ttl` need positive seconds. Upstash rounds up to whole seconds.

### KV_KEY_TOO_LONG

The key is longer than 512 UTF-8 bytes, the Cloudflare KV limit. ViteHub measures the normalized key, so `a/b` counts as `a:b`. A non-ASCII character takes two to four bytes. Use a shorter key, or a hash of a long identifier.

### KV_METADATA_TOO_LARGE

The `metadata` option of `kv.set()` is larger than 1024 bytes as JSON, the Cloudflare KV limit. Keep small fields in `metadata` and put the rest in the value.

### KV_OPERATION_FAILED

The provider failed. `error.why` names the operation and the store. `error.cause` has the provider error. A retry can help when the provider is back.

An invalid key also returns this code, before any provider call: an empty key such as `''` or `':'`, or a `.` or `..` segment such as `'a/../b'`. `error.cause.message` is `[unstorage] Invalid key: ""` with the key. Use another key; a retry cannot help.

### KV_TTL_TOO_SHORT

`kv.set()` got an `expirationTtl` below 60 seconds, or an `expiration` less than 60 seconds ahead, the Cloudflare KV minimum. Use 60 or more. `ttl` never returns this code, because ViteHub raises it to 60.

### KV_UNSUPPORTED_OPERATION

`deleteIfEquals()`, `getAndDelete()`, and `increment()` need atomic operations. The `redis`, `database`, and `upstash` drivers support them. Deno KV, Cloudflare KV, and `fs-lite` return this code. For request budgets, use the [Rate Limit primitive](/docs/rate-limit).

`setIfAbsent()` works on `redis`, `database`, `upstash`, `deno-kv`, and `fs-lite`. Cloudflare KV returns this code, because Workers KV is eventually consistent and cannot write a key only when it is missing. On Cloudflare, keep single-use tokens in D1 with `INSERT ... ON CONFLICT DO NOTHING`, or in a Durable Object.

### KV_VALUE_TOO_LARGE

The serialized value is larger than 25 MiB, the Cloudflare KV limit. Store large files in [Blob](/docs/blob) and keep the pathname in KV.

## Configuration errors

### KV_DATABASE_UNAVAILABLE

A `database` store cannot reach its Database. The app has no Database with the name in `database` (default `"default"`), or the Database is on D1. The `database` driver works on Postgres and libSQL. Add a Database Definition, such as `server/database.ts` with `defineDatabase({ dialect: 'postgresql', schema: {} })`, or select another driver. On Cloudflare, use `cloudflare-kv-binding`.

### KV_DENO_KV_UNAVAILABLE

The `deno-kv` driver needs `Deno.openKv()`. Run on Deno with KV enabled, or pick another driver.

### KV_DISABLED

The runtime has no KV config. Set `kv` in `vitehub()` to `true` or to a KV config. With `@vite-hub/kv` alone, add `hubKV()` to the Vite plugins and do not pass `false` to it.

### KV_INVALID_CONFIG

`kv` or `kv.stores` is not a plain object.

### KV_INVALID_DRIVER

`kv.driver` is not `cloudflare-kv-binding`, `database`, `deno-kv`, `fs-lite`, `redis`, or `upstash`.

### KV_INVALID_REMOTE

`remote` of a store is not `true` or `false`. Set `remote: true` to use the real store in `vite dev`, or remove it to keep the store local.

### KV_INVALID_BATCH

`kv.getMany()` got something other than an array of keys, or `kv.setMany()` something other than an array of `{ key, value }` entries. KV throws, because the code must change. Pass an array, for example `kv.getMany(['a', 'b'])`.

### KV_INVALID_STORE_MODE

`kv.store(name, { mode })` got a mode other than `'read'` or `'write'`, so KV throws instead of returning a writable handle. Pass `{ mode: 'read' }` for a [read-only handle](/docs/kv/server-api#read-only-handles), or omit `mode`.

### KV_MISSING_DEFAULT_STORE

A config with `kv.stores` must have a `default` store.

### KV_MISSING_ENV

The `upstash` driver needs `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, at runtime.

The `redis` driver needs the variable of its `url`, `REDIS_URL` by default, in the server environment when the store starts.

### KV_REMOTE_CONFLICT

In `vite dev`, `remote` conflicts with the driver of the store. `remote: true` cannot apply to `fs-lite` or `deno-kv`, which are local, or to an inferred store that has no hosted store to use. `remote: false` cannot apply to `upstash`, which is always remote. Remove `remote`, or select another driver. Builds ignore boolean `remote` flags. See [Development stays local](/docs/kv/configure#development-stays-local).

### KV_STORE_NOT_FOUND

`kv.store(name)` uses a name that is not in `kv.stores`.

## Provider and tool errors

A KV operation does not return these errors.

### KV_INVALID_COUNTER

The Database driver cannot increment the stored value because it is not a canonical integer below `Number.MAX_SAFE_INTEGER`. The value stays unchanged. This diagnostic is the `cause` of `KV_OPERATION_FAILED`. Delete the key or replace it with a valid integer, then retry.

### KV_PROVIDER_INVALID_RESPONSE

The provider returned a page or value that ViteHub cannot use. It is the `cause` of `KV_OPERATION_FAILED`. Retry. If it fails again, open an issue with the driver name.

### KV_PROVISION_FAILED

`vitehub provision run` got a Cloudflare response that it cannot use. Run it again with `--dry-run` and check the Cloudflare token permissions.

### KV_CLI_USAGE

`vitehub kv` got an option or value that it cannot use. Run `vitehub kv --help`.
