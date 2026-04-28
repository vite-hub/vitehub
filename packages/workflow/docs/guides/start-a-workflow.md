---
title: Start a workflow
description: Start a named workflow with a payload, stable id, and provider-neutral route code.
navigation.title: Start a Workflow
navigation.group: Guides
navigation.order: 30
icon: i-lucide-play
frameworks: [vite, nitro]
---

This guide defines a `welcome` workflow, then starts it from a server route. It assumes Workflow is already registered in Vite or Nitro config.

## Define the workflow

Use `runWorkflow()` when the route should wait until the provider accepts the workflow start.

::fw{id="vite:dev vite:build"}
```ts [src/welcome.workflow.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload, provider }) => {
  return {
    id,
    marker: payload.marker,
    message: `Welcome ${payload.email}`,
    provider,
  }
})
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/workflows/welcome.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload, provider }) => {
  return {
    id,
    marker: payload.marker,
    message: `Welcome ${payload.email}`,
    provider,
  }
})
```
::

## Call pattern

Every producer follows the same shape:

1. Read or build a payload.
2. Call `runWorkflow(name, payload)`.
3. Return the normalized run metadata.

## Start with generated id

Pass the payload directly when the provider can generate the run id:

```ts
const run = await runWorkflow('welcome', {
  email: 'ava@example.com',
  marker: 'signup-42',
})
```

## Start with stable id

Use a stable id when the caller needs to poll the run later:

```ts
const run = await runWorkflow('welcome', { email: 'ava@example.com', marker: 'signup-42' }, { id: 'welcome-signup-42' })
```

## Return the run from a route

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { runWorkflow } from '@vitehub/workflow'
import type { WelcomePayload } from './welcome.workflow'

const app = new H3()

app.post('/api/welcome', async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, payload, run }
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/welcome.post.ts]
import { runWorkflow } from '@vitehub/workflow'
import type { WelcomePayload } from '../workflows/welcome'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, payload, run }
})
```
::

The returned `id` is the value to store when the user needs a status page, receipt, or polling endpoint.

## Verify the route

```bash
curl -X POST http://localhost:3000/api/welcome \
  -H 'content-type: application/json' \
  -d '{"email":"ava@example.com","marker":"signup-42"}'
```

Expected response:

```json
{
  "ok": true,
  "payload": {
    "email": "ava@example.com",
    "marker": "signup-42"
  },
  "run": {
    "id": "wrun_lvn4hx4f_x8k2p9s1",
    "provider": "vercel",
    "status": "queued"
  }
}
```
