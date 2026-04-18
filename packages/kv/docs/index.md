---
title: KV
description: Set up key-value storage through one shared runtime handle.
navigation.title: Overview
icon: i-lucide-database-zap
---

`@vitehub/kv` starts with a Vite plugin that resolves KV config for Vite environments. Nitro installs that Vite primitive and mounts the runtime storage handle; Nuxt installs the Nitro adapter.

## Getting started

Start with [Quickstart](./quickstart) to configure Cloudflare KV. Use the Vercel provider path when your deployment should resolve KV through REST credentials.

## Automatic configuration

ViteHub resolves the KV driver in this order:

1. Explicit `kv.driver` config wins.
2. Vercel KV REST env vars win if present.
3. Cloudflare hosting defaults to `cloudflare-kv-binding`.
4. Local development uses an internal filesystem fallback.

This mirrors the actual resolution logic in `normalizeKVOptions`, so the docs match the runtime behavior.

## Supported provider paths

### Vercel

Use this path when your app has Vercel KV REST credentials available through `KV_REST_API_*` env vars. The public driver is `vercel`.

Read [Vercel](./providers/vercel) for the full setup and supported env vars.

### Cloudflare KV

Use this path when Cloudflare hosting is detected or when you explicitly set `kv.driver = 'cloudflare-kv-binding'`. The resolved driver is `cloudflare-kv-binding`.

Read [Cloudflare](./providers/cloudflare) for bindings, `namespaceId`, and framework-specific examples.

## Manual configuration

Set `kv.driver` explicitly to bypass auto-resolution. See [Cloudflare](./providers/cloudflare) or [Vercel](./providers/vercel) for per-driver config examples.

## What stays portable

These pieces stay stable when you change providers:

- the top-level `kv` config key
- the runtime handle `kv`
- the app-level call sites that use `kv.get()`, `kv.set()`, `kv.del()`, `kv.clear()`, and `kv.keys()`

## Fallback behavior

If no explicit config, supported env vars, or Cloudflare hosting signal is found, KV uses an internal local fallback for development.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Get a first working local KV setup.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Use the KV runtime handle like an SDK.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, methods, and config types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure the Cloudflare KV path.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure the Vercel KV REST path.
  to: ./providers/vercel
  ---
  :::
  :::u-page-card
  ---
  title: NuxtHub KV migration
  description: Map NuxtHub KV docs and config to ViteHub.
  to: ./migration-from-nuxthub
  ---
  :::
::
