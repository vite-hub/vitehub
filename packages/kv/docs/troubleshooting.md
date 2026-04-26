---
title: KV troubleshooting
description: Diagnose missing runtime mounts, provider routing, Cloudflare bindings, Upstash credentials, local storage, and virtual config issues.
navigation.title: Troubleshooting
navigation.order: 100
icon: i-lucide-wrench
frameworks: [vite, nitro, nuxt]
---

Use this page by symptom. Each section gives the likely cause, the fix, and a quick verification step.

## `KV runtime is disabled.`

**Cause:** Runtime config has no active KV store. This usually means `kv: false` was configured or the Nitro module did not install.

**Fix:** Remove `kv: false` or register the integration.

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
})
```
::

::fw{id="nuxt:dev nuxt:build"}
```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
})
```
::

**Verify:** Call a route that imports `kv` and runs `await kv.has('probe')`.

## `Missing runtime environment variable \`KV_REST_API_URL\` for Upstash KV.`

**Cause:** The active driver is `upstash`, but the runtime environment does not contain a REST URL.

**Fix:** Set one of the supported URL variables:

```bash
KV_REST_API_URL=https://example.upstash.io
```

or:

```bash
UPSTASH_REDIS_REST_URL=https://example.upstash.io
```

**Verify:** Restart the runtime and call the KV route again.

## `Missing runtime environment variable \`KV_REST_API_TOKEN\` for Upstash KV.`

**Cause:** The active driver is `upstash`, but the runtime environment does not contain a REST token.

**Fix:** Set one of the supported token variables:

```bash
KV_REST_API_TOKEN=<upstash-rest-token>
```

or:

```bash
UPSTASH_REDIS_REST_TOKEN=<upstash-rest-token>
```

**Verify:** Restart the runtime and call the KV route again.

## Vercel Logs Warn About `fs-lite`

**Cause:** Vercel hosting was detected while the active store is `fs-lite`.

**Fix:** Use the Upstash-backed driver on Vercel:

```ts
kv: {
  driver: 'upstash',
}
```

Then set `KV_REST_API_URL` and `KV_REST_API_TOKEN`.

**Verify:** Rebuild. The warning should disappear.

## Cloudflare Reads Return `null`

**Cause:** The runtime is reading from a different binding or namespace than the one you populated.

**Fix:** Check the binding name and namespace ID:

```ts
kv: {
  driver: 'cloudflare-kv-binding',
  binding: 'KV',
  namespaceId: '<kv-namespace-id>',
}
```

**Verify:** Write a new value through the app, then read the same key back through the app.

## Cloudflare Namespace Is Not Added to Wrangler Config

**Cause:** `namespaceId` was not available during setup.

**Fix:** Pass `namespaceId` in config or set `KV_NAMESPACE_ID`:

```bash
KV_NAMESPACE_ID=<kv-namespace-id>
```

**Verify:** Inspect generated Nitro or Cloudflare config for a `kv_namespaces` entry with the configured binding.

## Local Data Is in the Wrong Directory

**Cause:** The `fs-lite` base directory defaults to `.data/kv`, or another config value is active.

**Fix:** Set the base explicitly:

```ts
kv: {
  driver: 'fs-lite',
  base: '.cache/kv',
}
```

**Verify:** Write a test value and inspect the configured directory.

## TypeScript Cannot Find `virtual:@vitehub/kv/config`

**Cause:** The virtual module ambient types are not included.

**Fix:** Add the package type entry:

```json [tsconfig.json]
{
  "compilerOptions": {
    "types": ["@vitehub/kv/virtual"]
  }
}
```

**Verify:** Re-run typecheck.

## `Unknown \`kv.driver\``

**Cause:** The configured driver is not one of the supported values.

**Fix:** Use one of:

```ts
'cloudflare-kv-binding'
'upstash'
'fs-lite'
```

**Verify:** Rebuild or restart dev mode.

## Related Pages

- [Quickstart](./quickstart)
- [Cloudflare](./providers/cloudflare)
- [Vercel](./providers/vercel)
- [Runtime API](./runtime-api)
