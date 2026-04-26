---
title: Cloudflare KV
description: Configure @vitehub/kv for Cloudflare Workers and Pages using Cloudflare KV bindings.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-simple-icons-cloudflare
frameworks: [vite, nitro, nuxt]
---

Use the Cloudflare provider when runtime KV should read and write through a Cloudflare KV namespace.

Cloudflare needs a KV binding. ViteHub defaults that binding name to `KV` and can add the Wrangler namespace entry when `namespaceId` is available.

::steps{level="2"}

## Configure KV

::fw{id="vite:dev vite:build"}
Register the Vite plugin and set `kv.driver` to `cloudflare-kv-binding`:

```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubKv } from '@vitehub/kv/vite'

export default defineConfig({
  plugins: [hubKv()],
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: '<kv-namespace-id>',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
Register the Nitro module and set `kv.driver` to `cloudflare-kv-binding`:

```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: '<kv-namespace-id>',
  },
})
```
::

::fw{id="nuxt:dev nuxt:build"}
Register the Nuxt module and set `kv.driver` to `cloudflare-kv-binding`:

```ts [nuxt.config.ts]
export default defineNuxtConfig({
  modules: ['@vitehub/kv/nuxt'],
  kv: {
    driver: 'cloudflare-kv-binding',
    binding: 'KV',
    namespaceId: '<kv-namespace-id>',
  },
})
```
::

## Set the Namespace ID

Pass `namespaceId` in config:

```ts
kv: {
  driver: 'cloudflare-kv-binding',
  namespaceId: '<kv-namespace-id>',
}
```

Or set `KV_NAMESPACE_ID` in the build environment:

```bash
KV_NAMESPACE_ID=<kv-namespace-id>
```

When `namespaceId` is present, the Nitro module adds the namespace to Cloudflare Wrangler config:

```ts
cloudflare: {
  wrangler: {
    kv_namespaces: [
      { binding: 'KV', id: '<kv-namespace-id>' },
    ],
  },
}
```

## Use a Custom Binding Name

The default binding is `KV`. Set `binding` when the Cloudflare resource uses another name:

```ts
kv: {
  driver: 'cloudflare-kv-binding',
  binding: 'APP_KV',
  namespaceId: '<kv-namespace-id>',
}
```

The runtime driver reads from that Cloudflare binding.

## Let Hosting Select Cloudflare

When hosting resolves to Cloudflare and no explicit driver is set, ViteHub selects `cloudflare-kv-binding` automatically:

```ts
export default defineNitroConfig({
  modules: ['@vitehub/kv/nitro'],
})
```

Explicit `kv.driver` still wins. Use explicit config when you want local `fs-lite` behavior or need a custom binding.

## Verify the Provider

Write a value:

```bash
curl -X PUT https://<your-worker>/api/settings
```

Read it back:

```bash
curl https://<your-worker>/api/settings
```

Expected response:

```json
{
  "settings": {
    "enabled": true
  }
}
```

::

## Common Failures

| Symptom | Cause | Fix |
| --- | --- | --- |
| Reads always return `null` after deploy | The Worker is bound to the wrong namespace or binding name. | Check `binding`, `namespaceId`, and Cloudflare deployment config. |
| Local development stores files instead of Cloudflare data | Hosting was not detected as Cloudflare. | Set `kv.driver` to `cloudflare-kv-binding` explicitly. |
| Wrangler namespace config is missing | `namespaceId` was not configured and `KV_NAMESPACE_ID` was not set. | Add `namespaceId` or set `KV_NAMESPACE_ID`. |

## Related Pages

- [Quickstart](../quickstart)
- [Choose a driver](../guides/choose-a-driver)
- [Runtime API](../runtime-api)
- [Troubleshooting](../troubleshooting)
