---
title: KV
description: Read and write key-value data through one portable runtime handle across Vite, Nitro, and Nuxt.
navigation.title: Overview
navigation.order: 0
icon: i-lucide-database-zap
frameworks: [vite, nitro, nuxt]
---

`@vitehub/kv` gives Vite, Nitro, and Nuxt apps one `kv` handle for application state that fits a key-value shape.

Use KV when route code needs to read or write small JSON-serializable values without carrying provider-specific SDK calls through the app. The provider choice stays in config. Runtime code keeps the same `kv.get()`, `kv.set()`, and `kv.del()` calls.

::code-group
```ts [server/api/settings.put.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  await kv.set('settings', {
    theme: 'system',
    onboardingComplete: true,
  })

  return { ok: true }
})
```

```ts [server/api/settings.get.ts]
import { kv } from '@vitehub/kv'

export default defineEventHandler(async () => {
  return {
    settings: await kv.get('settings'),
  }
})
```

```json [Response]
{
  "settings": {
    "theme": "system",
    "onboardingComplete": true
  }
}
```
::

## What KV Solves

Provider storage SDKs are useful, but they couple route code to deployment infrastructure.

KV puts the provider behind the Nitro storage mount:

::card-group
  :::card
  ---
  icon: i-lucide-key-round
  title: Portable runtime calls
  ---
  Use the same `kv` handle for local development, Cloudflare KV, and Upstash-backed Vercel deployments.
  :::

  :::card
  ---
  icon: i-lucide-route
  title: Config-based routing
  ---
  Pick `fs-lite`, `cloudflare-kv-binding`, or `upstash` in config or let ViteHub infer the driver.
  :::

  :::card
  ---
  icon: i-lucide-database
  title: Nitro storage backing
  ---
  Mount the active driver as Nitro storage at `kv`, then expose a small typed wrapper.
  :::

  :::card
  ---
  icon: i-lucide-shield-check
  title: Secret-safe Upstash setup
  ---
  Keep Upstash credentials in runtime environment variables instead of serializing them into build output.
  :::
::

## One Portable Flow

The same shape works across supported frameworks:

1. Install `@vitehub/kv`.
2. Register `hubKv()`, `@vitehub/kv/nitro`, or `@vitehub/kv/nuxt`.
3. Choose a driver or let ViteHub resolve one.
4. Import `kv` from `@vitehub/kv` in server/runtime code.
5. Read and write values with `get`, `set`, `has`, `del`, `keys`, and `clear`.

::callout{icon="i-lucide-info" color="info"}
Provider-specific setup belongs in framework config and deployment environment variables. Application call sites should stay provider-neutral unless you intentionally pass driver-specific options.
::

## Driver Routing

ViteHub resolves KV config in this order:

| Priority | Signal | Resolved driver |
| --- | --- | --- |
| 1 | Explicit `kv.driver` | The configured driver |
| 2 | `KV_REST_API_URL` and `KV_REST_API_TOKEN` | `upstash` |
| 3 | `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` | `upstash` |
| 4 | Vercel hosting | `upstash` |
| 5 | Cloudflare hosting | `cloudflare-kv-binding` |
| 6 | Everything else | `fs-lite` |

Explicit config always wins. That means you can force `fs-lite` locally, force Cloudflare for a Worker, or force Upstash for any runtime.

## Framework Support

::fw{id="vite:dev vite:build"}
Vite registers `hubKv()` and exposes resolved config through `virtual:@vitehub/kv/config`.

Use this path when Vite owns the app setup. Runtime access to `kv` still depends on a Nitro-compatible server runtime.
::

::fw{id="nitro:dev nitro:build"}
Nitro registers `@vitehub/kv/nitro`, writes resolved config to runtime config, mounts storage at `kv`, and aliases `@vitehub/kv` to the runtime implementation.
::

::fw{id="nuxt:dev nuxt:build"}
Nuxt registers `@vitehub/kv/nuxt`, which installs the Nitro module and forwards top-level `kv` config to Nitro.
::

## Supported Providers

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Cloudflare
  description: Use Cloudflare KV bindings with Workers or Pages.
  icon: i-simple-icons-cloudflare
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Use Vercel with the Upstash-backed KV driver.
  icon: i-simple-icons-vercel
  to: ./providers/vercel
  ---
  :::
::

## Start Here

Start with [Quickstart](./quickstart) for a complete local setup. Use [When to use KV](./when-to-use) when you are deciding between KV, Blob, Queue, or a database.

## Next Steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Configure KV and read back a settings value.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use keys, prefixes, deletes, lists, clears, and provider-specific options.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, config shapes, methods, and virtual modules.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Troubleshooting
  description: Fix missing mounts, provider routing, bindings, and Upstash credentials.
  to: ./troubleshooting
  ---
  :::
  :::u-page-card
  ---
  title: NuxtHub migration
  description: Move existing NuxtHub KV apps to ViteHub KV.
  to: ./migration-from-nuxthub
  ---
  :::
::
