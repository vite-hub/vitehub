---
title: KV limits and errors
description: Handle KV errors by code, and repair KV configuration errors.
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

The type of `error.code` is the union of the codes that the method can return. For example, `kv.list()` can return `KV_INVALID_CURSOR`, `KV_INVALID_LIMIT`, or `KV_OPERATION_FAILED`, and `kv.get()` can return only `KV_OPERATION_FAILED`.

`JSON.stringify(error)` includes only `name`, `code`, `why`, `fix`, and `docs`. It does not include `cause` or `stack`, because provider errors can contain credentials or private data. Log `cause` only on the server.

Configuration errors throw instead. They mean that the code or the deployment must change, so a retry cannot help. Examples are an unknown store name and a missing Upstash environment variable.

| Code | Returned by | Thrown |
| --- | --- | --- |
| `KV_INVALID_CURSOR` | `list()` | |
| `KV_INVALID_LIMIT` | `list()` | |
| `KV_INVALID_TTL` | `increment()` | |
| `KV_OPERATION_FAILED` | Every method | |
| `KV_UNSUPPORTED_OPERATION` | `getAndDelete()`, `increment()` | |
| `KV_DENO_KV_UNAVAILABLE`, `KV_DISABLED`, `KV_MISSING_ENV`, `KV_STORE_NOT_FOUND` | | When an operation starts |
| `KV_INVALID_CONFIG`, `KV_INVALID_DRIVER`, `KV_MISSING_DEFAULT_STORE` | | When Vite reads the config |

## Runtime errors

### KV_INVALID_CURSOR

The `cursor` of `kv.list()` expired, is in use by another call, belongs to another store, or is not valid. Process-local drivers keep cursors in memory, so a cursor also expires when the server restarts or `disposeKVStores()` runs. Start the listing again without `cursor`.

### KV_INVALID_LIMIT

`kv.list()` needs `limit` as a positive integer.

### KV_INVALID_TTL

`kv.increment(key, ttl)` needs `ttl` as a positive number of seconds. Upstash rounds the TTL up to whole seconds.

### KV_OPERATION_FAILED

The provider failed. `error.why` names the operation and the store. Read `error.cause` for the provider error. A retry can help when the provider is available again.

### KV_UNSUPPORTED_OPERATION

`getAndDelete()` and `increment()` need atomic operations. Only the `upstash` driver supports them. Deno KV, Cloudflare KV, and `fs-lite` return this code. For request budgets, use the [Rate Limit primitive](/docs/rate-limit).

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
