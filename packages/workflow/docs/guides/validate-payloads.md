---
title: Validate workflow payloads
description: Parse and validate request payloads before starting a workflow.
navigation.title: Validate Payloads
navigation.group: Guides
navigation.order: 32
icon: i-lucide-badge-check
frameworks: [vite, nitro]
---

Validate payloads before calling `runWorkflow()` so workflow definitions can focus on background work instead of request cleanup.

## Use a parser function

```ts
import { validatePayload } from '@vitehub/workflow'

const payload = await validatePayload(rawPayload, (value) => {
  if (!value || typeof value !== 'object') {
    throw new TypeError('Expected an object payload.')
  }

  return value as { email: string }
})
```

## Use a schema

`validatePayload()` and `readValidatedPayload()` accept schema objects with `parse()` or `safeParse()`.

```ts
import { validatePayload } from '@vitehub/workflow'
import { z } from 'zod'

const welcomePayload = z.object({
  email: z.string().email(),
  marker: z.string().optional(),
})

const payload = await validatePayload(rawPayload, welcomePayload)
```

## Validate inside framework routes

Framework helpers are still a good fit when they already expose body parsing. Read the request body with the framework helper, validate the parsed value, then call `runWorkflow()`.

## Full route examples

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { H3, readBody } from 'h3'
import { runWorkflow, validatePayload } from '@vitehub/workflow'
import { z } from 'zod'

const welcomePayload = z.object({
  email: z.string().email(),
  marker: z.string().optional(),
})

const app = new H3()

app.post('/api/welcome', async (event) => {
  const rawPayload = await readBody(event)
  const payload = await validatePayload(rawPayload, welcomePayload)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, run }
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/welcome.post.ts]
import { runWorkflow, validatePayload } from '@vitehub/workflow'
import { z } from 'zod'

const welcomePayload = z.object({
  email: z.string().email(),
  marker: z.string().optional(),
})

export default defineEventHandler(async (event) => {
  const rawPayload = await readBody(event)
  const payload = await validatePayload(rawPayload, welcomePayload)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, run }
})
```
::

The validation helpers throw the parser or schema error directly so the route can map it to the framework's normal error response.
