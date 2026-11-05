---
title: KV limits and errors
description: Handle KV errors by stable code, and repair KV configuration, runtime, provider, and tool errors before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Handle KV errors

Each KV operation returns `[error, value]`. When `error` is set, `error.code` names the failure, `error.why` tells what went wrong, `error.fix` tells what to do, and `error.docs` links to the code on this page. `error.cause` keeps the provider error.

```ts [server/api/settings.get.ts]
import { kv } from '@vite-hub/kv'

export default defineEventHandler(async () => {
  const [error, settings] = await kv.get('settings')
  if (error) {
    console.error(error.code, error.why, error.cause)
    throw error
  }
  return { settings }
})
```

The type of `error.code` is the union of the codes that the method can return. For example, `kv.list()` can return `KV_INVALID_CURSOR`, `KV_INVALID_LIMIT`, or `KV_OPERATION_FAILED`, and `kv.get()` can return `KV_KEY_TOO_LONG` or `KV_OPERATION_FAILED`.

`JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`. It does not include `cause` or `stack`, because provider errors can contain credentials or private data. Log `cause` only on the server.

Configuration errors throw instead. They mean that the code or the deployment must change, so a retry cannot help. Examples are an unknown store name and a missing Upstash environment variable.

| Code | Returned by | Thrown |
| --- | --- | --- |
| `KV_INVALID_CURSOR` | `list()` | |
| `KV_INVALID_LIMIT` | `list()` | |
| `KV_INVALID_TTL` | `increment()`, `setIfAbsent()` | |
| `KV_KEY_TOO_LONG` | `del()`, `get()`, `has()`, `set()` | |
| `KV_METADATA_TOO_LARGE`, `KV_TTL_TOO_SHORT`, `KV_VALUE_TOO_LARGE` | `set()` | |
| `KV_OPERATION_FAILED` | Every method | |
| `KV_UNSUPPORTED_OPERATION` | `getAndDelete()`, `increment()`, `setIfAbsent()` | |
| `KV_DENO_KV_UNAVAILABLE`, `KV_DISABLED`, `KV_MISSING_ENV`, `KV_STORE_NOT_FOUND` | | When an operation starts |
| `KV_INVALID_CONFIG`, `KV_INVALID_DRIVER`, `KV_MISSING_DEFAULT_STORE` | | When Vite reads the config |

## Limits

A store with the `cloudflare-kv-binding` driver checks the [Workers KV limits](https://developers.cloudflare.com/kv/platform/limits/) before it calls the binding, and returns a named code instead of `KV_OPERATION_FAILED`. The same check runs in production and in `vite dev` with the Cloudflare preset, so a key that Cloudflare rejects fails during development with the same code.

| Limit | Cloudflare KV | Code |
| --- | --- | --- |
| Key size, in UTF-8 bytes | 512 bytes | `KV_KEY_TOO_LONG` |
| Value size, after ViteHub serializes the value | 25 MiB | `KV_VALUE_TOO_LARGE` |
| `metadata` size, as JSON | 1024 bytes | `KV_METADATA_TOO_LARGE` |
| `expirationTtl` | At least 60 seconds | `KV_TTL_TOO_SHORT` |

The `ttl` option of `kv.set()` does not fail, because ViteHub raises a `ttl` below 60 seconds to 60 seconds on Cloudflare KV. Only an `expirationTtl` that you pass to the binding returns `KV_TTL_TOO_SHORT`.

`fs-lite`, `deno-kv`, and `upstash` stores do not check these limits. Upstash [limits the request size](https://upstash.com/docs/redis/troubleshooting/max_request_size_exceeded) to 10 MB on its Free and Pay as you go plans, and other plans have other limits. ViteHub does not know the plan of your database, so it does not check this limit. A request above it fails with `KV_OPERATION_FAILED`.

## Runtime errors

### KV_INVALID_CURSOR

The `cursor` of `kv.list()` expired, is in use by another call, belongs to another store, or is not valid. Process-local drivers keep cursors in memory, so a cursor also expires when the server restarts or `disposeKVStores()` runs. Start the listing again without `cursor`.

### KV_INVALID_LIMIT

`kv.list()` needs `limit` as a positive integer.

### KV_INVALID_TTL

`kv.increment(key, ttl)` and the `ttl` option of `kv.setIfAbsent()` need a positive number of seconds. Upstash rounds the TTL up to whole seconds.

### KV_KEY_TOO_LONG

The key is longer than 512 bytes in UTF-8, the Cloudflare KV limit. ViteHub measures the key after it normalizes it, so `a/b` counts as `a:b`. A character outside ASCII takes two to four bytes. Use a shorter key. To keep a long identifier, store a hash of it as the key.

### KV_METADATA_TOO_LARGE

The `metadata` option of `kv.set()` is larger than 1024 bytes as JSON, the Cloudflare KV limit. Keep only small fields in `metadata`, and put the other data in the value.

### KV_OPERATION_FAILED

The provider failed. `error.why` names the operation and the store. Read `error.cause` for the provider error. A retry can help when the provider is available again.

An invalid key returns this code too, before ViteHub calls the provider: an empty key such as `''` or `':'`, or a key with a `.` or `..` segment such as `'a/../b'`. `error.cause.message` is `[unstorage] Invalid key: ""` with the key. A retry cannot help; use another key.

### KV_TTL_TOO_SHORT

The `expirationTtl` option of `kv.set()` is less than 60 seconds, the Cloudflare KV minimum. Pass 60 or more. The `ttl` option does not return this code, because ViteHub raises it to 60 seconds.

### KV_UNSUPPORTED_OPERATION

`getAndDelete()` and `increment()` need atomic operations. Only the `upstash` driver supports them. Deno KV, Cloudflare KV, and `fs-lite` return this code. For request budgets, use the [Rate Limit primitive](/docs/rate-limit).

`setIfAbsent()` works on `upstash`, `deno-kv`, and `fs-lite`. Cloudflare KV returns this code, because Workers KV is eventually consistent and cannot write a key only when it is missing. On Cloudflare, keep single-use tokens in D1 with `INSERT ... ON CONFLICT DO NOTHING`, or in a Durable Object.

### KV_VALUE_TOO_LARGE

The value is larger than 25 MiB after ViteHub serializes it, the Cloudflare KV limit. Store large files in [Blob](/docs/blob), and keep the Blob pathname in KV.

## Configuration errors

### KV_DENO_KV_UNAVAILABLE

The `deno-kv` driver needs `Deno.openKv()`. Run on Deno with KV enabled, or select another driver.

### KV_DISABLED

The runtime has no KV configuration. Add `hubKv()` to the Vite config, and do not set `kv: false`.

### KV_INVALID_CONFIG

`kv` or `kv.stores` is not a plain object.

### KV_INVALID_DRIVER

`kv.driver` is not `cloudflare-kv-binding`, `deno-kv`, `upstash`, or `fs-lite`.

### KV_MISSING_DEFAULT_STORE

A config with `kv.stores` must have a `default` store.

### KV_MISSING_ENV

The `upstash` driver needs `KV_REST_API_URL` and `KV_REST_API_TOKEN`, or `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN`, in the runtime environment.

### KV_STORE_NOT_FOUND

`kv.store(name)` uses a name that is not in `kv.stores`.

## Provider and tool errors

These errors do not come back from a KV operation.

### KV_PROVIDER_INVALID_RESPONSE

The provider returned a page or a value that ViteHub cannot use. KV returns it as the `cause` of `KV_OPERATION_FAILED`. Retry the operation. If it fails again, open an issue with the driver name.

### KV_PROVISION_FAILED

`vitehub provision run` received a response from Cloudflare that it cannot use. Run it again with `--dry-run`, and check the permissions of the Cloudflare token.

### KV_CLI_USAGE

`vitehub kv` received an option or a value that it cannot use. Run `vitehub kv --help`.
