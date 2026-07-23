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
    base: ".data/kv",
  },
  plugins: [hubKv()],
})
```

## Vite Integration

Use `hubKv()` in Vite to resolve KV config and expose the `kv` runtime helper to server code.

Providers include local `fs-lite`, [Cloudflare Workers KV](https://developers.cloudflare.com/kv/), and [Upstash Redis](https://upstash.com/docs/redis/overall/getstarted). The storage layer is built on [unstorage](https://unstorage.unjs.io/guide).

KV operations return `[error, value]`. Provider failures use `ViteHubError` with code `KV_OPERATION_FAILED`, operation/store details, and the provider failure in `cause`. Invalid configuration and unknown named stores still throw before provider execution.

Learn more at [vitehub.dev](https://vitehub.dev).
