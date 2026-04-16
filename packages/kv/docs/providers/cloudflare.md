---
title: Cloudflare KV
description: Configure @vitehub/kv for Cloudflare Workers and Pages using KV bindings.
navigation.title: Cloudflare
navigation.group: Providers
navigation.order: 10
icon: i-logos-cloudflare-icon
---

Use this path when you deploy KV-backed code to Cloudflare or when you want to configure Cloudflare KV explicitly.

## Supported deployment targets

- Cloudflare Workers
- Cloudflare Pages

## Configuration

Set `kv.driver` to `cloudflare-kv-binding`. The binding name defaults to `KV`, and `namespaceId` should match your Cloudflare KV namespace.

::fw{id="vite:dev vite:build"}
The Vite entrypoint only registers the bridge config. Use Nitro or Nuxt for runtime access to the `kv` handle.

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

## Bindings

Cloudflare uses [bindings](https://developers.cloudflare.com/workers/runtime-apis/bindings/) to connect your worker to platform resources. `@vitehub/kv` uses a KV binding and defaults that binding name to `KV` unless you override it.

If you do not set `namespaceId` directly, the resolver can also read it from `KV_NAMESPACE_ID`.

## What this page does not cover

This page only covers the Cloudflare KV path exposed by `@vitehub/kv`. It does not document generic Cloudflare storage features beyond this driver.

## Related

- [Overview](../index)
- [Quickstart](../quickstart)
- [Usage](../usage)
