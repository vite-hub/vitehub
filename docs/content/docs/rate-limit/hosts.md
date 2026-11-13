---
title: Rate Limit hosts
description: Inspect the generated Rate Limit manifest, share counts across Node instances through KV, and deploy managed Rate Limits to Cloudflare.
navigation.title: Hosts
navigation.order: 6
icon: i-lucide-cloud-cog
---

## Inspect generated guarantees

ViteHub writes `.vitehub/rate-limit/manifest.json` at config time for agents and tools to inspect, and refreshes it at build start after KV selects its driver. Application code keeps using the guard. With the `kv` provider, the manifest reports the effective provider and guarantees: shared KV drivers report `kv`, while stores such as `fs-lite` report the process-local `memory` fallback.

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

## Share counts on Node

On the `node` host, Rate Limit counts in memory by default, so each server process allows the full limit. Turn on [KV](/docs/kv) and the build selects the `kv` provider instead: each request runs one atomic `increment` on a KV key for the Rate Limit ID, the window length, the client key, and the window start. Every instance that uses the same Redis server or Postgres Database shares the count.

::tabs{sync="framework"}
:::tabs-item{label="Nuxt"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['vite-hub/nuxt'],
  vitehub: { host: 'node', kv: true, rateLimit: true },
})
```
:::

:::tabs-item{label="Nitro"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { nitro } from 'nitro/vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', kv: true, rateLimit: true }), nitro()],
})
```
:::

:::tabs-item{label="Vite"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { vitehub } from 'vite-hub'

export default defineConfig({
  plugins: [vitehub({ host: 'node', kv: true, rateLimit: true })],
})
```
:::
::

KV selects its driver at build time: `database` with a Postgres Default Database, else `fs-lite`. To use Redis, set `kv: { driver: 'redis' }` and supply `REDIS_URL` to each server process. Setting `REDIS_URL` alone does not change an inferred store. Rate Limit asks KV at boot and prints its choice:

```txt
[vitehub] Rate Limit counts in the KV store "default" (redis). Every server process that uses this store shares the counts.
```

`fs-lite` has no shared atomic increment, so Rate Limit then counts in memory and prints a warning:

```txt
[vitehub] Rate Limit counts in the memory of this process, because the KV store "default" uses fs-lite, which has no shared atomic increment. Each server process allows the full limit. Configure a Redis KV store or use a Postgres Database to share the counts.
```

A build that counts in memory also prints a warning. Set `rateLimit: { provider: 'memory' }` to keep memory counts with KV on. `provider: 'kv'` works with the `node` host only, and other hosts fail with `VITE_HUB_R0144`. Without ViteHub, pass `provider: 'kv'` to `hubRateLimit()`, or use [`kvRateLimitDriver()`](/docs/rate-limit/server-api#use-a-direct-driver) with any KV store. The `kv` provider counts rejected requests too, see [KV limits](/docs/rate-limit/limits-and-errors#kv-limits).

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
