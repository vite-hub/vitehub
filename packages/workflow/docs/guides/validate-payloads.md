---
title: Validate workflow payloads
description: Parse and validate request payloads before starting a workflow.
navigation.title: Validate Payloads
navigation.order: 2
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
import { readValidatedPayload, runWorkflow } from '@vitehub/workflow'
import { z } from 'zod'

const welcomePayload = z.object({
  email: z.string().email(),
  marker: z.string().optional(),
})

export default {
  async fetch(request: Request) {
    const payload = await readValidatedPayload(request, welcomePayload)
    const run = await runWorkflow('welcome', payload)

    return Response.json({ ok: true, run })
  },
}
```

## Validate inside framework routes

Framework helpers are still a good fit when they already expose validated body parsing:

```ts
import { runWorkflow, validatePayload } from '@vitehub/workflow'
import { readBody } from 'h3'

export default defineEventHandler(async (event) => {
  const rawPayload = await readBody(event)
  const payload = await validatePayload(rawPayload, welcomePayload)

  return {
    ok: true,
    run: await runWorkflow('welcome', payload),
  }
})
```

The validation helpers throw the parser or schema error directly so the route can map it to the framework's normal error response.
