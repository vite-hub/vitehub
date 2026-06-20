---
title: Workflows
description: Start provider-tracked long-running work with run ids, durable state, and optional steps.
navigation.order: 10
icon: i-lucide-workflow
---

Workflows own durable long-running execution. Use them when work needs a Workflow Run, provider-tracked state, retries, resumability, or optional Workflow Steps.

Workflow is not Queue. Queue delivers jobs; Workflow starts and tracks a run.

## Define a workflow

Create a Workflow Definition for named long-running work.

```ts [server/workflows/onboard-user.ts]
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ email: string }>(async ({ payload }) => {
  const user = await createUser(payload.email)
  await sendWelcomeEmail(user.email)

  return { userId: user.id }
})
```

Use Workflow Steps only when the selected provider and definition need independently retryable or inspectable units.

## Start a run

Use `runWorkflow()` from server code.

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runWorkflow('onboard-user', body, {
    id: `onboard:${body.email}`,
  })
})
```

The run id belongs to Invocation Options. Use a stable id when the provider should dedupe or resume the same logical run.

## Inspect a run

Use `getWorkflowRun()` when server code needs current run state.

```ts [server/api/workflows/[id].get.ts]
import { getWorkflowRun } from '@vite-hub/workflow'

export default defineEventHandler((event) => {
  return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
})
```

## Provider output

The Workflow Package discovers Workflow Definitions, selects a Workflow Provider, and generates provider-specific runtime output. Cloudflare, Vercel, and OpenWorkflow providers differ in how they persist runs, execute steps, and resume work.

The Definition and Runtime Helpers should stay stable when the provider changes. Provider selection belongs in Integration Options.

## Connect it to Agents

An Agent can start a workflow only when you explicitly expose that behavior through a Capability or server route. Workflow owns durable orchestration; Agent owns model-backed behavior and Agent Invocations.

Use a product-specific Capability when a model should start or inspect a particular Workflow Run.

## Production boundaries

Use Queue when background delivery is enough. Use Workflow when the app must inspect run state, resume work, or coordinate multiple steps over time.

Keep credentials and database URLs in Server Env. Hosted workflow providers may require explicit state storage or deployment setup.

## Next steps

- Use [Queue](/docs/server-primitives/queue) for simple background delivery.
- Trigger recurring work with [Schedule](/docs/server-primitives/schedule).
- Learn shared runtime events in [Runtime policy, approvals, and traces](/docs/concepts/runtime-policy-approvals-and-traces).
