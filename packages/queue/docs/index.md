---
title: Queue
description: Send background jobs through one shared queue API.
navigation.title: Overview
icon: i-lucide-list-restart
---

`@vitehub/queue` discovers named queue definitions and sends jobs through the active provider. The first public providers are Cloudflare Queues and Vercel Queues.

## Getting started

Start with [Quickstart](./quickstart) to define one queue and enqueue one job with a first-round hosted provider.

## Automatic configuration

ViteHub resolves the queue provider in this order:

1. `queue: false` disables queues.
2. Explicit `queue.provider` config wins.
3. Cloudflare hosting defaults to `cloudflare`.
4. Vercel hosting defaults to `vercel`.
5. Everything else uses an internal development fallback.

This mirrors the `normalizeQueueOptions` runtime logic.

## Supported provider paths

### Cloudflare

Use this path when queue producers and consumers should run on Cloudflare Workers. ViteHub registers Wrangler queue producer and consumer bindings for discovered queue names.

Read [Cloudflare](./providers/cloudflare) for binding names and queue behavior.

### Vercel

Use this path when queue publishing and callbacks should stay inside the Vercel deployment model. ViteHub emits hidden Vercel queue callback functions during Vercel builds.

Read [Vercel](./providers/vercel) for topics, callback routes, and SDK behavior.

## What stays portable

These pieces stay stable when you change providers:

- the top-level `queue` config key
- discovered queue definition files
- `defineQueue()`
- `runQueue()`, `deferQueue()`, and `getQueue()`

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Define and run your first queue.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Send jobs and defer work after a response.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exports, options, and types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure Cloudflare Queues.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure Vercel Queues.
  to: ./providers/vercel
  ---
  :::
::
