---
title: Rate Limit hosts
description: Inspect the generated Rate Limit manifest and deploy managed Rate Limits to Cloudflare.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Inspect generated guarantees

ViteHub writes `.vitehub/rate-limit/manifest.json` at config time for agents and tools to inspect. Application code keeps using the guard.

The manifest records `enforcement`, counter `scope`, `rejectedAttempts`, and supported `windows`. It does not repeat the optional response metadata.

```json [.vitehub/rate-limit/manifest.json]
{
  "schemaVersion": 2,
  "rateLimits": [
    {
      "name": "image-upload",
      "provider": "cloudflare",
      "capabilities": {
        "enforcement": "best-effort",
        "rejectedAttempts": "unknown",
        "scope": "location",
        "windows": [10000, 60000]
      }
    }
  ]
}
```

## Deploy to Cloudflare

With the `cloudflare` host, ViteHub uses the Cloudflare provider and sets the namespace to the deployment name. It ignores `rateLimit.namespace`. Cloudflare shares counters between Workers with the same namespace in one account. So give staging, production, and each separate Worker a unique deployment name.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'cloudflare', name: 'acme-image-service-production', rateLimit: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [
    vitehub({ host: 'cloudflare', name: 'acme-image-service-production', rateLimit: true }),
    nitro(),
  ],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'cloudflare', name: 'acme-image-service-production', rateLimit: true })],
})
```
:::
::

The deployment name comes from `name`, `WRANGLER_CI_OVERRIDE_NAME`, the `package.json` name, or the project directory, in that order.

Cloudflare native enforcement is best-effort and has only 10-second and 60-second windows. It returns no portable quota metadata, so policies it cannot meet fail the build.

Inspect the generated `wrangler.json` entries and test the deployed Worker. A Node script cannot check a request-scoped Cloudflare binding.
