---
title: Workflow
description: Coordinate durable server work with steps, waits, retries, and inspectable run state.
navigation.order: 9
icon: i-lucide-workflow
---

Workflow is the primitive for durable orchestration. Use it when work needs named steps, retries, waits, resumable state, or a run id that other code can inspect.

Use Queue when you only need background delivery.

## Define a workflow

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload, step }) => {
  const user = await step.run('create-user', () => createUser(payload.email))
  await step.run('send-email', () => sendWelcomeEmail(user.email))
  return { userId: user.id }
})
```

Each step should represent work you want to retry, inspect, or resume independently.

## Start a run

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)
  return runWorkflow('onboard-user', body)
})
```

## Inspect a run

```ts [server/api/workflows/[id].get.ts]
import { getWorkflowRun } from '@vite-hub/workflow'

export default defineEventHandler((event) => {
  return getWorkflowRun(getRouterParam(event, 'id')!)
})
```

## Host orchestration output

Each workflow host differs in how it persists steps, retries work, and exposes generated output. Keep those differences in workflow configuration and host setup. The Definition and Runtime Helper should stay stable.

## Workflows and agents

A workflow can call an agent, and an agent can start a workflow through a Capability only if you explicitly expose that behavior. Do not let agent docs blur the primitive boundary: Workflow owns durable orchestration; Agent owns model-backed behavior.
