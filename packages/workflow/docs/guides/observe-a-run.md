---
title: Observe a workflow run
description: Read normalized workflow status and result metadata from a route.
navigation.title: Observe a Run
navigation.order: 1
icon: i-lucide-search-check
frameworks: [vite, nitro]
---

Use `getWorkflowRun()` when a caller has a workflow name and run id.

```ts
const run = await getWorkflowRun('welcome', id)
```

## Add a status route

```ts [server/api/workflow/[id].get.ts]
import { getWorkflowRun } from '@vitehub/workflow'

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
