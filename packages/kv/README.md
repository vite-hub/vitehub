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

Providers include local `fs-lite`, [Cloudflare Workers KV](https://developers.cloudflare.com/kv/), and [Upstash Redis](https://upstash.com/docs/redis/overall/getstarted). The storage layer is built on [unstorage](https://unstorage.unjs.io/guide).

## Listing keys

`kv.keys(prefix)` is exhaustive. Use `kv.list({ prefix, limit, cursor })` when the caller needs bounded work. `limit` must be a positive integer. A page returns `{ keys, cursor? }`; an omitted cursor means the listing is complete.

Cursors are opaque and provider-specific. Pass a returned cursor back to the same store with the same prefix. Cloudflare KV, Upstash, Deno KV, and `fs-lite` stop enumeration when the requested page is full. An `fs-lite` cursor retains a directory iterator in the current process for up to 15 minutes. Upstash uses the same retention window when the provider returns more keys than requested. These process-local cursors can expire sooner when more than 32 listings are left unfinished. Callers must restart listing without a cursor when continuation fails.

KV operations return `[error, value]`. Provider failures use `ViteHubError` with code `KV_OPERATION_FAILED`, operation/store details, and the provider failure in `cause`. Invalid configuration and unknown named stores still throw before provider execution.

Upstash also supports `kv.getAndDelete(key)` and `kv.increment(key, ttl)`. These operations are atomic in the provider. Deno KV, Cloudflare KV, and `fs-lite` reject them because they cannot provide the same contract without extra storage or non-atomic calls.

Learn more at [vitehub.dev](https://vitehub.dev).
