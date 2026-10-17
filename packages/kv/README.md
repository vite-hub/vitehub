# @vite-hub/kv

<p>
  <a href="https://vitehub.dev"><img alt="ViteHub" src="https://img.shields.io/badge/ViteHub-vitehub.dev-646cff?style=flat-square"></a>
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-ready-3178c6?style=flat-square">
  <img alt="Vite" src="https://img.shields.io/badge/Vite-config-646cff?style=flat-square">
  <img alt="KV" src="https://img.shields.io/badge/KV-stores-0f766e?style=flat-square">
</p>

`@vite-hub/kv` gives server code one small-state API for settings, flags, cache entries, and JSON-like records.

## Install

```sh
pnpm add @vite-hub/kv
```

Add `@upstash/redis` when you use the Upstash driver.

## Minimal API

```ts
// server/api/settings.put.ts
import { kv } from "@vite-hub/kv"
import { defineEventHandler, readBody } from "h3"

export default defineEventHandler(async (event) => {
  const [writeError] = await kv.set("settings", await readBody(event))
  if (writeError) throw writeError

  const [readError, settings] = await kv.get("settings")
  if (readError) throw readError
  return settings
})
```

```ts
// vite.config.ts
import { hubKv } from "@vite-hub/kv/vite"
import { defineConfig } from "vite"

export default defineConfig({
  kv: {
    driver: "fs-lite",
    base: ".vitehub/data/kv",
  },
  plugins: [hubKv()],
})
```

## Vite Integration

Use `hubKv()` in Vite to resolve KV config and expose the `kv` runtime helper to server code.

Providers include local `fs-lite`, Deno KV, [Cloudflare Workers KV](https://developers.cloudflare.com/kv/), and [Upstash Redis](https://upstash.com/docs/redis/overall/getstarted). The storage layer is built on [unstorage](https://unstorage.unjs.io/guide).

Deno KV accepts `kv.set(key, value, { ttl: seconds })` to expire a value. Omitting `ttl` keeps the value until it is deleted or replaced. Initialization failures do not disable a store for the life of the process. The next operation can retry initialization.

## Listing keys

`kv.keys(prefix)` is exhaustive. Use `kv.list({ prefix, limit, cursor })` when the caller needs bounded work. `limit` must be a positive integer. A page returns `{ keys, cursor? }`; an omitted cursor means the listing is complete.

List prefixes use the same key normalization as reads and writes. For example, `users/al` matches the stored key `users:alice`. A trailing separator, such as `users/` or `users:`, limits the prefix to children and does not match `users-other`.

Cursors are opaque and provider-specific. Pass a returned cursor back to the same store with the same prefix. Cloudflare KV, Upstash, Deno KV, and `fs-lite` stop enumeration when the requested page is full. An `fs-lite` cursor retains a directory iterator in the current process for up to 15 minutes. Upstash uses the same retention window when the provider returns more keys than requested. These process-local cursors can expire sooner when more than 32 listings are left unfinished. Calling `disposeKVStores()` from the application shutdown hook releases these process-local cursors, closes retained directory iterators, and clears their expiry timers. A pending listing cannot retain a new cursor after disposal. Callers must restart listing without a cursor when continuation fails.

KV operations return `[error, value]`. `error.code` is one of the codes of the method, for example `KV_INVALID_CURSOR` for `list()`, and `error.why`, `error.fix`, and `error.docs` explain it. Provider failures use the code `KV_OPERATION_FAILED` and keep the provider failure in `cause`. See [KV limits and errors](https://vitehub.dev/docs/kv/limits-and-errors). Configuration errors, for example an unknown named store, throw.

Upstash also supports `kv.getAndDelete(key)` and `kv.increment(key, ttl)`. These operations are atomic in the provider. Deno KV, Cloudflare KV, and `fs-lite` return `KV_UNSUPPORTED_OPERATION` because they cannot provide the same contract without extra storage or non-atomic calls.

## Application teardown

Call `disposeKVStores()` from `@vite-hub/kv` (or `vite-hub/kv`) after stopping new application work. It disposes every initialized default and named store, waits for pending store initialization and cleanup, and reports cleanup failures with an `AggregateError`. Concurrent teardown calls share one promise. Later operations create fresh stores; old process-local cursors cannot resume.

For Nitro, register the cleanup in a server plugin:

```ts
// server/plugins/kv-cleanup.ts
import { disposeKVStores } from "@vite-hub/kv"

export default defineNitroPlugin((nitroApp) => {
  nitroApp.hooks.hook("close", disposeKVStores)
})
```

## CLI

`hubKv()` contributes the `vitehub kv` CLI namespace: `list [--prefix] [--limit] [--cursor]`, `get <key>`, `has <key>`, `set <key> <value|@file> [--ttl <seconds>] [--json-value]`, and `del <key>`. Each command accepts `--store <name>` and `--json`. `get` writes stored strings unchanged, without adding a newline. JSON input rejects underflow and decimal values that change magnitude during parsing; use strings to preserve them. Write commands print what they changed. There is no `clear` command.

The commands call a guarded endpoint that exists only on the Vite Development Server. The endpoint forwards each operation into the Nitro dev environment, so it uses the same KV storage as the running app. Nuxt and plain Vite do not run Nitro in the Vite process, so the endpoint returns status 501 there. `handleKVDevRequest()` from `@vite-hub/kv/runtime/dev` is the Nitro handler; it is not a public runtime API.

Learn more at [vitehub.dev](https://vitehub.dev).
