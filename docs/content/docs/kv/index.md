---
title: KV
layout: landing
navigation.title: Overview
description: Save small values such as settings under a key, and read them from any server route.
navigation.order: 1
icon: i-lucide-database-zap
---

::product-hero{tagline="Save small values like settings under a key. Read them from any route." hosts="Node, Docker, Cloudflare, Vercel, Netlify, Deno"}
  :hero-figure{name="kv"}
::

::code-tree{feature="kv"}
:::framework{name="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: {
    host: 'node',
    // Node supports shared stores and local files
    kv: true,
  },
})
```
:::
:::framework{name="Nitro"}
```ts [vite.config.ts]
import { nitro } from 'nitro/vite'
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      // Node supports shared stores and local files
      kv: true,
    }),
    nitro(),
  ],
})
```
:::
:::framework{name="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({
      host: 'node',
      // Node supports shared stores and local files
      kv: true,
    }),
  ],
})
```
:::
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
  const [error] = await kv.delete('settings')
  if (error) throw error
  return { ok: true }
})
```
::

::product-features
  :::product-feature-item{title="Save and read by key" icon="i-lucide-key-round" to="/docs/kv/server-api#use-it-at-runtime"}
  `kv.set()` saves a value under a key. `kv.get()` reads it back or returns `null`.
  :::

  :::product-feature-item{title="Check errors without try/catch" icon="i-lucide-code-2" to="/docs/kv/limits-and-errors"}
  Each call returns `[error, value]`. Errors have a `code`, `why`, and `fix`.
  :::

  :::product-feature-item{title="Keep data apart" icon="i-lucide-layers" to="/docs/kv/configure#configuration-options"}
  Declare named stores in your config and pick one with `kv.store(name)`.
  :::

  :::product-feature-item{title="Same code on every host" icon="i-lucide-server" to="/docs/kv/configure#providers"}
  Values stay on disk in development. On Cloudflare, Deno, Redis, Postgres, or Upstash, your routes do not change.
  :::

  :::product-feature-item{title="Counters and one-time values" icon="i-lucide-circle-plus" to="/docs/kv/server-api#use-it-at-runtime"}
  `setIfAbsent()` writes a token once. With Redis, a Database, or Upstash, `increment()` counts and `getAndDelete()` reads a value only once.
  :::

  :::product-feature-item{title="Many keys in one call" icon="i-lucide-list" to="/docs/kv/server-api#read-and-write-many-keys"}
  `kv.getMany()` reads a list of keys. `kv.setMany()` writes a list of values.
  :::

  :::product-feature-item{title="Run a job once at a time" icon="i-lucide-lock" to="/docs/kv/server-api#locks"}
  With Redis, a Database, or Upstash, `kv.lock()` lets one server run a cron job or a sync while the others skip it.
  :::

  :::product-feature-item{title="Know when to use a database" icon="i-lucide-database" to="/docs/kv/hosts#production-checks"}
  Use KV to read by key. Use Database for tables, joins, or queries.
  :::
::

::agent-only{skill="kv"}
Use KV for small values addressed by a key, such as flags, cursors, short-lived state, or counters that do not require relational queries.

Turn KV on with `vitehub add kv`. Where the host needs an explicit driver, such as Upstash on Netlify, pass it with `--option kv.driver=<driver>`. Keep key names and serialization in application code. KV operations are not a substitute for atomic Rate Limit enforcement or relational transactions.

Read or write many keys with `kv.getMany(keys)` and `kv.setMany([{ key, value }])`, not a loop of `get()` or `set()`. `setMany()` is not atomic. To stop two servers from running the same job, use `kv.lock(key, { ttl }).run(fn)` and return when `acquired` is `false`. Only the `redis`, `database`, and `upstash` drivers support `lock()`; the others return `KV_UNSUPPORTED_OPERATION`. For work that must renew its hold, use a Database lease.

Prove put, get, list with a prefix, and delete. Restart local storage or query the hosted provider to confirm the durability you need.
::
