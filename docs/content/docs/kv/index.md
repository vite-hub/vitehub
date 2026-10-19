---
title: KV
navigation.title: Overview
description: Save small values such as settings and flags under a key, and read them back from any server route.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="Save small values like settings and flags under a key, then read them back from any route." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files
  ```ts [vite.config.ts]
  import { nitro } from 'nitro/vite'
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      // On Node, values are saved in .vitehub/data/kv
      vitehub({ preset: 'node', kv: true }),
      nitro() as never,
    ],
  })
  ```
Read [Get started](/docs/kv/get-started), [Configure](/docs/kv/configure), [Server API](/docs/kv/server-api), [Hosts](/docs/kv/hosts), or [Limits and errors](/docs/kv/limits-and-errors).

  ```ts [server/api/settings.get.ts]
  import { defineEventHandler } from 'h3'
  import { kv } from 'vite-hub/kv'

  // Read the value saved under "settings"
  export default defineEventHandler(async () => {
    const [error, settings] = await kv.get('settings')
    if (error) throw error
    return settings
  })
  ```

  ```ts [server/api/settings.put.ts]
  import { defineEventHandler, readBody } from 'h3'
  import { kv } from 'vite-hub/kv'

  // Save the request body under "settings"
  export default defineEventHandler(async (event) => {
    const settings = await readBody(event)
    const [error] = await kv.set('settings', settings)
    if (error) throw error
    return { ok: true }
  })
  ```

  ```ts [server/api/settings.delete.ts]
  import { defineEventHandler } from 'h3'
  import { kv } from 'vite-hub/kv'

  // Remove the key and its value
  export default defineEventHandler(async () => {
    const [error] = await kv.del('settings')
    if (error) throw error
    return { ok: true }
  })
  ```
  :::
::

::product-features
  :::product-feature-item{title="Save and read by key" icon="i-lucide-key-round" to="/docs/kv/server-api#use-it-at-runtime"}
  `kv.set()` saves a value under a key. `kv.get()` reads it back, or returns `null`.
  :::product-feature-item{title="Errors are values" size="large" icon="i-lucide-code-2" to="/docs/kv/limits-and-errors"}
  `[error, value]` on every method. Each code has a `why` and a `fix`.
  :::

  :::product-feature-item{title="Check errors without try/catch" icon="i-lucide-code-2" to="/docs/kv/server-api#runtime-helper"}
  Every call returns `[error, value]`. Check the error first, then use the value.
  :::

  :::product-feature-item{title="Keep data apart" icon="i-lucide-layers" to="/docs/kv/configure#configuration-options"}
  Add more than one store in your config. Select one with `kv.store(name)`.
  :::

  :::product-feature-item{title="Same code on every host" icon="i-lucide-server" to="/docs/kv/configure#providers"}
  Values stay on your disk while you develop. On Cloudflare, Deno, or Upstash, your routes do not change.
  :::

  :::product-feature-item{title="Counters and one-time values" icon="i-lucide-circle-plus" to="/docs/kv/server-api#use-it-at-runtime"}
  With Upstash, `increment()` counts and `getAndDelete()` reads a value only once.
  :::

  :::product-feature-item{title="Know when to use a database" icon="i-lucide-database" to="/docs/kv/hosts#production-checks"}
  KV is for values you read by key. Use Database when you need tables, joins, or queries.
  :::
::
