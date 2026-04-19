---
title: Cloudflare Sandbox
description: Configure Cloudflare Sandbox on top of Durable Objects.
icon: i-simple-icons-cloudflare
navigation.title: Cloudflare
---

Use Cloudflare Sandbox when isolated runs should stay close to the rest of a Cloudflare-based stack. ViteHub handles the Durable Object integration and keeps the Cloudflare-specific settings in the top-level `sandbox` config.

## Before you start

Install the Cloudflare SDK alongside `@vitehub/sandbox`.

```bash [Terminal]
pnpm add https://pkg.pr.new/vite-hub/vitehub/@vitehub/sandbox@main @cloudflare/sandbox
```

You also need a Cloudflare deployment so ViteHub can provision the sandbox runtime.

## Configure Cloudflare

::fw{#vite}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

export default defineConfig({
  plugins: [hubSandbox()],
})
```
::
::fw{#nitro}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
})
```
::
::fw{#nuxt}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/sandbox/nuxt'],
})
```
::

On Cloudflare hosting, ViteHub uses the Durable Object sandbox provider automatically. Set `binding` only when you need to override the default Durable Object binding name.

The shipped sandbox examples also support `SANDBOX_PROVIDER=cloudflare` when you want to force the Cloudflare provider locally before deploying.

## Cloudflare-specific options

Set Cloudflare-specific options such as `sandboxId`, `keepAlive`, `sleepAfter`, and `normalizeId` in the top-level `sandbox` config. These are provider settings, not definition options.

::fw{#vite}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubSandbox } from '@vitehub/sandbox/vite'

export default defineConfig({
  plugins: [hubSandbox()],
  sandbox: {
    sandboxId: 'release-notes',
    keepAlive: true,
    sleepAfter: '10m',
  },
})
```
::

::fw{#nitro}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/sandbox/nitro'],
  sandbox: {
    sandboxId: 'release-notes',
    keepAlive: true,
    sleepAfter: '10m',
  },
})
```
::

::fw{#nuxt}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/sandbox/nuxt'],
  sandbox: {
    sandboxId: 'release-notes',
    keepAlive: true,
    sleepAfter: '10m',
  },
})
```
::

## What changes on Cloudflare

| Concern | Behavior |
| --- | --- |
| Sandbox identity | Use `sandboxId` when repeated calls should reuse the same Cloudflare sandbox identity. |
| Binding resolution | ViteHub resolves the Durable Object binding from `sandbox.binding` or falls back to the default Cloudflare binding. |
| Provider options | Use `keepAlive`, `sleepAfter`, and `normalizeId` in the top-level `sandbox` config. |

## Related pages

- [Quickstart](../quickstart)
- [Reuse a sandbox](../guides/reuse-a-sandbox)
