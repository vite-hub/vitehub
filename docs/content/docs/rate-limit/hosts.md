---
title: Rate Limit hosts
description: Inspect the generated Rate Limit manifest and deploy managed Rate Limits to Cloudflare.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Inspect generated guarantees

The integration writes `.vitehub/rate-limit/manifest.json` during configuration. Agents and tooling can inspect it. Application code keeps using the guard.

The manifest records `enforcement`, counter `scope`, `rejectedAttempts`, and supported `windows` without duplicating optional response metadata contracts.

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

With the `cloudflare` preset, ViteHub selects the Cloudflare provider and sets the Rate Limit namespace to the deployment name. It ignores a configured `rateLimit.namespace`. Use a deployment-unique name so matching Rate Limit IDs cannot share counters across Workers or environments in the same Cloudflare account.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { preset: 'cloudflare', name: 'acme-image-service-production', rateLimit: true },
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
    vitehub({ preset: 'cloudflare', name: 'acme-image-service-production', rateLimit: true }),
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
  plugins: [vitehub({ preset: 'cloudflare', name: 'acme-image-service-production', rateLimit: true })],
})
```
:::
::

The deployment name comes from `name`, `WRANGLER_CI_OVERRIDE_NAME`, the `package.json` name, or the project directory, in that order.

Cloudflare native enforcement is best-effort and exposes only 10-second and 60-second windows. It does not return portable quota metadata, so incompatible policies fail during the build. Use a different namespace for staging, production, and any separately deployed Worker because Cloudflare shares counters with the same namespace ID across Workers.

Inspect generated `wrangler.json` entries and exercise the deployed Worker. A request-scoped Cloudflare binding cannot be validated from an unrelated Node script.
