---
title: KV
description: Set up key-value storage through one shared runtime handle.
navigation.title: Overview
icon: i-lucide-database-zap
---

`@vitehub/kv` starts with a Vite plugin that resolves KV config for Vite environments. Nitro installs that Vite primitive and mounts the runtime storage handle; Nuxt installs the Nitro adapter.

## Getting started

Start with [Quickstart](./quickstart) to get KV working locally first. It uses `fs-lite`, so you can verify config through Vite and read or write keys through the Nitro or Nuxt runtime adapters before choosing a hosted provider.

## Automatic configuration

ViteHub resolves the KV driver in this order:

1. Explicit `kv.driver` config wins.
2. Upstash env vars win if present.
3. Cloudflare hosting defaults to `cloudflare-kv-binding`.
4. Everything else falls back to `fs-lite`.

This mirrors the actual resolution logic in `normalizeKVOptions`, so the docs match the runtime behavior.

## Supported provider paths

### Vercel / Upstash

Use this path when your app has Upstash REST credentials available, including the Vercel `KV_REST_API_*` env vars. The resolved driver is `upstash`.

Read [Vercel](./providers/vercel) for the full setup, supported env vars, and fallback behavior.

### Cloudflare KV

Use this path when Cloudflare hosting is detected or when you explicitly set `kv.driver = 'cloudflare-kv-binding'`. The resolved driver is `cloudflare-kv-binding`.

Read [Cloudflare](./providers/cloudflare) for bindings, `namespaceId`, and framework-specific examples.

### Local / other

Use this path when no higher-priority config is found. The resolved driver is `fs-lite`, and data is stored locally in `.data/kv`.

If you want to stay local or use the simplest development path, start with [Quickstart](./quickstart).

## Manual configuration

Set `kv.driver` explicitly to bypass auto-resolution. See [Cloudflare](./providers/cloudflare), [Vercel](./providers/vercel), or [Quickstart](./quickstart) for per-driver config examples.

## What stays portable

These pieces stay stable when you change providers:

- the top-level `kv` config key
- the runtime handle `kv`
- the app-level call sites that use `kv.get()`, `kv.set()`, `kv.del()`, `kv.clear()`, and `kv.keys()`

## Fallback behavior

If no explicit config, supported env vars, or Cloudflare hosting signal is found, KV falls back to `fs-lite` and stores data in `.data/kv`.

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
  description: Configure the Upstash-backed Vercel path.
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
