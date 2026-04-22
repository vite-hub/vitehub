---
title: Queue
description: Send background jobs through one portable API on Vite and Nitro.
navigation.title: Overview
icon: i-lucide-list-ordered
frameworks: [vite, nitro]
---

`@vitehub/queue` discovers named queues from your project, lets you enqueue work with one runtime API, and connects those queues to Cloudflare or Vercel delivery.

Use Queue when a request should return now and a handler can process the job later.

## What stays portable

These pieces stay stable across Vite and Nitro:

- queue definitions with `defineQueue()`
- enqueue calls with `runQueue()` and `deferQueue()`
- queue clients resolved with `getQueue()`
- typed payloads and shared enqueue envelopes

## Discovery model

::fw{id="vite:dev vite:build"}
Vite discovers queues from `src/**/*.queue.ts`.

The queue name comes from the path under `src`, without the `.queue` suffix. `src/email/welcome.queue.ts` becomes `email/welcome`.
::

::fw{id="nitro:dev nitro:build"}
Nitro discovers queues from `server/queues/**`.

The queue name comes from the path under `server/queues`, without the file extension. `server/queues/email/welcome.ts` becomes `email/welcome`.
::

## Supported providers

### Cloudflare

Use Cloudflare when producers and consumers should run in the Workers model with queue bindings and batch processing.

Read [Cloudflare](./providers/cloudflare) for binding naming, configuration, and handler behavior.

### Vercel

Use Vercel when queue publishing and callback handling should stay inside a Vercel deployment.

Read [Vercel](./providers/vercel) for topic naming, region resolution, and hosted callback behavior.

## Start here

Start with [Quickstart](./quickstart) for the smallest setup, then move to [Usage](./usage) and [Runtime API](./runtime-api) when you need the exact runtime surface.

## Next steps

::u-page-grid{class="pb-2"}
  :::u-page-card
  ---
  title: Quickstart
  description: Set up a first queue definition and enqueue route.
  to: ./quickstart
  ---
  :::
  :::u-page-card
  ---
  title: Usage
  description: Define queues, send payloads, and inspect provider handles.
  to: ./usage
  ---
  :::
  :::u-page-card
  ---
  title: Runtime API
  description: Review exported functions, helpers, and core types.
  to: ./runtime-api
  ---
  :::
  :::u-page-card
  ---
  title: When to use Queue
  description: Decide when Queue is better than inline request work.
  to: ./when-to-use
  ---
  :::
  :::u-page-card
  ---
  title: Cloudflare
  description: Configure Cloudflare queue bindings and batch processing.
  to: ./providers/cloudflare
  ---
  :::
  :::u-page-card
  ---
  title: Vercel
  description: Configure Vercel topics and hosted callbacks.
  to: ./providers/vercel
  ---
  :::
::
