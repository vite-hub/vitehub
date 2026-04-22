---
title: Vercel Queue
description: Configure Queue for Vercel topics and hosted callback handling.
navigation.title: Vercel
navigation.group: Providers
navigation.order: 20
icon: i-simple-icons-vercel
frameworks: [vite, nitro]
---

Use Vercel when queue publishing and callback handling should stay in a Vercel deployment.

::callout{to="https://vercel.com/docs/queues"}
Vercel Queue is a hosted service. Queue does not provide a local in-memory Vercel queue binding in development.
::

## Install the SDK

```bash
pnpm add @vitehub/queue @vercel/queue
```

## Configure the provider

Set `queue.provider = 'vercel'`. Set `queue.region` when you want an explicit region instead of runtime resolution.

::fw{id="vite:dev vite:build"}
```ts [vite.config.ts]
import { defineConfig } from 'vite'
import { hubQueue } from '@vitehub/queue/vite'

export default defineConfig({
  plugins: [hubQueue()],
  queue: {
    provider: 'vercel',
    region: 'fra1',
  },
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [nitro.config.ts]
import { defineNitroConfig } from 'nitro/config'

export default defineNitroConfig({
  modules: ['@vitehub/queue/nitro'],
  queue: {
    provider: 'vercel',
    region: 'fra1',
  },
})
```
::

## Topic naming

Queue derives Vercel topics from the discovered queue name. `welcome-email` becomes `topic--77656c636f6d652d656d61696c`.

Use `getVercelQueueTopicName()` when you need the exact derived topic name.

## Region resolution

Queue resolves the Vercel region in this order:

1. `queue.region`
2. `QUEUE_REGION`
3. `VERCEL_REGION`
4. request headers from a Vercel runtime

If Queue cannot resolve a region, the Vercel client throws `VERCEL_QUEUE_REGION_REQUIRED`.

## Hosted callbacks

Use `handleHostedVercelQueueCallback()` when you need to wire a discovered queue definition into a hosted Vercel callback route.

```ts
import { handleHostedVercelQueueCallback } from '@vitehub/queue'
import definition from '../../queues/welcome-email'

export default defineEventHandler((event) => {
  return handleHostedVercelQueueCallback(event, 'welcome-email', definition)
})
```

## Queue definition options

Vercel-specific definition options:

| Option | Purpose |
| --- | --- |
| `callbackOptions` | Configures visibility timeout and retry behavior for hosted callbacks. |

## Related pages

- [Overview](../index)
- [Quickstart](../quickstart)
- [Runtime API](../runtime-api)
