---
title: Observe a workflow run
description: Read normalized workflow status and result metadata from a route.
navigation.title: Observe a Run
navigation.group: Guides
navigation.order: 31
icon: i-lucide-search-check
frameworks: [vite, nitro]
---

Use `getWorkflowRun()` when a caller has a workflow name and run id.

```ts
const run = await getWorkflowRun('welcome', id)
```

## Add a status route

Every status route follows the same shape:

1. Read the workflow run id from the request path.
2. Return `getWorkflowRun(name, id)`.
3. Map missing ids to the framework's normal error response.

::fw{id="vite:dev vite:build"}
```ts [src/server.ts]
import { createError, H3 } from 'h3'
import { getWorkflowRun } from '@vite-hub/workflow'

const app = new H3()

app.get('/api/workflow/:id', async (event) => {
  const id = event.context.params?.id
  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflow run id.',
    })
  }

  return await getWorkflowRun('welcome', id)
})

export default app
```
::

::fw{id="nitro:dev nitro:build"}
```ts [server/api/workflow/[id].get.ts]
import { getWorkflowRun } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const id = getRouterParam(event, 'id')
  if (!id) {
    throw createError({
      statusCode: 400,
      statusMessage: 'Missing workflow run id.',
    })
  }

  return await getWorkflowRun('welcome', id)
})
```
::

## Handle status values

Workflow status is normalized across providers:

| Status | Meaning |
| --- | --- |
| `queued` | The provider accepted the start. |
| `running` | The provider reports active work. |
| `completed` | The workflow finished successfully. |
| `failed` | The workflow failed. |
| `unknown` | The provider cannot resolve that run id from this runtime. |

## Persist what the app owns

Provider status is useful for infrastructure state. Application state still belongs in your app data model when users need durable history.

Store the workflow run id with the domain record that started the workflow:

```ts
await saveSignup({
  email: payload.email,
  workflowRunId: run.id,
})
```

Then use the stored id in your status route.
