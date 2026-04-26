---
title: Start a workflow
description: Start a named workflow with a payload, stable id, and provider-neutral route code.
navigation.title: Start a Workflow
navigation.order: 0
icon: i-lucide-play
frameworks: [vite, nitro]
---

Use `runWorkflow()` when the route should wait until the provider accepts the workflow start.

## Define the workflow

```ts [server/workflows/welcome.ts]
import { defineWorkflow } from '@vitehub/workflow'

export type WelcomePayload = {
  email: string
  marker?: string
}

export default defineWorkflow<WelcomePayload>(async ({ id, payload, provider }) => {
  return {
    id,
    provider,
    message: `Welcome ${payload.email}`,
    marker: payload.marker,
  }
})
```

## Start with generated id

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

## Return the run

```ts [server/api/welcome.post.ts]
import { runWorkflow } from '@vitehub/workflow'
import type { WelcomePayload } from '../workflows/welcome'

export default defineEventHandler(async (event) => {
  const payload = await readBody<WelcomePayload>(event)
  const run = await runWorkflow('welcome', payload)

  return { ok: true, run }
})
```

The returned `id` is the value to store when the user needs a status page, receipt, or polling endpoint.
