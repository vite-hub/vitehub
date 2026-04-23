---
title: Cloudflare
description: Cloudflare support across ViteHub packages.
navigation.title: Cloudflare
navigation.group: Providers
icon: i-logos-cloudflare-icon
---

Use this page to find package-specific Cloudflare guidance in ViteHub.

## Currently documented packages

### KV

`@vitehub/kv` supports a Cloudflare KV path through `cloudflare-kv-binding`.

- Setup overview: [KV overview](../kv)
- Provider details: [KV on Cloudflare](../kv/providers/cloudflare)

::fw{id="vite:dev vite:build"}
### Blob

`@vitehub/blob` supports a Cloudflare path on Vite and Nitro through the `cloudflare-r2` driver.

- Setup overview: [Blob overview](/docs/vite/blob)
- Provider details: [Blob on Cloudflare](/docs/vite/blob/providers/cloudflare)

### Queue

`@vitehub/queue` supports a Cloudflare path on Vite and Nitro through `queue.provider = 'cloudflare'`.

- Setup overview: [Queue overview](/docs/vite/queue)
- Provider details: [Queue on Cloudflare](/docs/vite/queue/providers/cloudflare)
::

::fw{id="nitro:dev nitro:build"}
### Blob

`@vitehub/blob` supports a Cloudflare path on Vite and Nitro through the `cloudflare-r2` driver.

- Setup overview: [Blob overview](/docs/nitro/blob)
- Provider details: [Blob on Cloudflare](/docs/nitro/blob/providers/cloudflare)

### Queue

`@vitehub/queue` supports a Cloudflare path on Vite and Nitro through `queue.provider = 'cloudflare'`.

- Setup overview: [Queue overview](/docs/nitro/queue)
- Provider details: [Queue on Cloudflare](/docs/nitro/queue/providers/cloudflare)
::

## What stays package-specific

Bindings, namespace IDs, and exact config examples live with the package docs. Use this section as a routing page, not as the source of truth for package setup.
