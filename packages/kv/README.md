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

export default defineEventHandler(async (event) => {
  await kv.set("settings", await readBody(event))

  return kv.get("settings")
})
```

```ts
// nitro.config.ts
import { defineNitroConfig } from "nitro/config"

export default defineNitroConfig({
  modules: ["@vite-hub/kv/nitro"],
  kv: {
    driver: "fs-lite",
    base: ".data/kv",
  },
})
```

## Vite and Nitro

Use `hubKv()` in Vite or `@vite-hub/kv/nitro` in Nitro. Both resolve the same `kv` config and expose the same `kv` runtime helper.

Providers include local `fs-lite`, [Cloudflare Workers KV](https://developers.cloudflare.com/kv/), and [Upstash Redis](https://upstash.com/docs/redis/overall/getstarted). The storage layer is built on [unstorage](https://unstorage.unjs.io/guide).

Learn more at [vitehub.dev](https://vitehub.dev).
