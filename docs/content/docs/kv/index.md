---
title: KV
layout: landing
navigation.title: Overview
description: Save small values such as settings under a key, and read them from any server route.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="Save small values like settings under a key. Read them from any route." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :::product-files{feature="kv"}
  ::::framework{name="Nuxt"}
  ```ts [nuxt.config.ts]
  export default defineNuxtConfig({
    modules: ['vite-hub/nuxt'],
    vitehub: {
      preset: 'node',
      // On Node, values are saved in .vitehub/data/kv
      kv: true,
    },
  })
  ```
  ::::
  ::::framework{name="Nitro"}
  ```ts [vite.config.ts]
  import { nitro } from 'nitro/vite'
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'node',
        // On Node, values are saved in .vitehub/data/kv
        kv: true,
      }),
      nitro(),
    ],
  })
  ```
  ::::
  ::::framework{name="Vite"}
  ```ts [vite.config.ts]
  import { defineConfig } from 'vite'
  import { vitehub } from 'vite-hub'

  export default defineConfig({
    plugins: [
      vitehub({
        preset: 'node',
        // On Node, values are saved in .vitehub/data/kv
        kv: true,
      }),
    ],
  })
  ```
  ::::
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
  `kv.set()` saves a value. `kv.get()` reads it, or returns `null`.
  :::

  :::product-feature-item{title="Check errors without try/catch" icon="i-lucide-code-2" to="/docs/kv/limits-and-errors"}
  Each call returns `[error, value]`. Errors have a `code`, `why`, and `fix`.
  :::

  :::product-feature-item{title="Keep data apart" icon="i-lucide-layers" to="/docs/kv/configure#configuration-options"}
  Add named stores in config. Select one with `kv.store(name)`.
  :::

  :::product-feature-item{title="Same code on every host" icon="i-lucide-server" to="/docs/kv/configure#providers"}
  Values stay on disk in development. Your routes do not change on Cloudflare, Deno, or Upstash.
  :::

  :::product-feature-item{title="Counters and one-time values" icon="i-lucide-circle-plus" to="/docs/kv/server-api#use-it-at-runtime"}
  `setIfAbsent()` writes a token once. On Upstash, `increment()` counts and `getAndDelete()` reads a value once.
  :::

  :::product-feature-item{title="Know when to use a database" icon="i-lucide-database" to="/docs/kv/hosts#production-checks"}
  Use KV to read by key. Use Database for tables, joins, or queries.
  :::
::

::agent-only{skill="kv"}
Use KV for small values addressed by a key, such as flags, cursors, short-lived state, or counters that do not require relational queries.

Choose the driver in Vite config. Keep key names and serialization in application code. KV operations are not a substitute for atomic Rate Limit enforcement or relational transactions.

Prove put, get, list with a prefix, and delete. Restart local storage or query the hosted provider to confirm the durability you need.
::
