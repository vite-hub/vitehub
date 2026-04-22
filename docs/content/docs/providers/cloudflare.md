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

::fw{vite nitro}
### Blob

`@vitehub/blob` supports a Cloudflare path on Vite and Nitro through the `cloudflare-r2` driver.

- Setup overview: [Blob overview](../blob)
- Provider details: [Blob on Cloudflare](../blob/providers/cloudflare)

### Queue

`@vitehub/queue` supports a Cloudflare path on Vite and Nitro through `queue.provider = 'cloudflare'`.

- Setup overview: [Queue overview](../queue)
- Provider details: [Queue on Cloudflare](../queue/providers/cloudflare)
::


## What stays package-specific

Bindings, namespace IDs, and exact config examples live with the package docs. Use this section as a routing page, not as the source of truth for package setup.
