---
title: Vercel
description: Vercel support across ViteHub packages.
navigation.title: Vercel
navigation.group: Providers
icon: i-simple-icons-vercel
---

Use this page to find package-specific Vercel guidance in ViteHub.

## Currently documented packages

### KV

`@vitehub/kv` supports a Vercel path through the Upstash-backed `upstash` driver.

- Setup overview: [KV overview](../kv)
- Provider details: [KV on Vercel](../kv/providers/vercel)

::fw{id="vite:dev vite:build"}
### Blob

`@vitehub/blob` supports a Vercel path on Vite and Nitro through the `vercel-blob` driver.

- Setup overview: [Blob overview](/docs/vite/blob)
- Provider details: [Blob on Vercel](/docs/vite/blob/providers/vercel)

### Queue

`@vitehub/queue` supports a Vercel path on Vite and Nitro through `queue.provider = 'vercel'`.

- Setup overview: [Queue overview](/docs/vite/queue)
- Provider details: [Queue on Vercel](/docs/vite/queue/providers/vercel)
::

::fw{id="nitro:dev nitro:build"}
### Blob

`@vitehub/blob` supports a Vercel path on Vite and Nitro through the `vercel-blob` driver.

- Setup overview: [Blob overview](/docs/nitro/blob)
- Provider details: [Blob on Vercel](/docs/nitro/blob/providers/vercel)

### Queue

`@vitehub/queue` supports a Vercel path on Vite and Nitro through `queue.provider = 'vercel'`.

- Setup overview: [Queue overview](/docs/nitro/queue)
- Provider details: [Queue on Vercel](/docs/nitro/queue/providers/vercel)
::

## What stays package-specific

Environment variables, fallback behavior, and exact config examples live with the package docs. Use this section as a routing page, not as the source of truth for package setup.
