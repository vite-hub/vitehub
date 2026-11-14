---
title: Workflows server API
description: Start, defer, inspect, cancel, and resume Workflow Runs from server code.
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `defineWorkflow` from `vite-hub/workflow` | Declare a workflow. |
| `startWorkflow`, `deferWorkflow`, `getWorkflowRun`, `cancelWorkflow`, `resumeWorkflow` from `vite-hub/workflow` | Start, defer, inspect, cancel, or resume runs. |
| `createWorkflow` from `vite-hub/workflow` | Create an inline Workflow Handle in your own code. |
| `ViteHubError` from `vite-hub/runtime` | Throw your own Workflow failures with stable codes. |
| `readRequestPayload`, `readValidatedPayload`, `validatePayload` from `vite-hub/workflow` | Read provider request payloads in custom runtime entry points. |
| `hubWorkflow` from `@vite-hub/workflow/vite` | Add Workflow discovery and host output. |

`vite-hub/workflow` also exports the Provider, Definition, Run, Step, Start Options, and Integration Options types.

## Start a run

Call `startWorkflow()` from server code.

```ts [server/api/onboard.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return startWorkflow('onboard-user', body)
})
```

Pass the run id in the options. Use a stable id when the provider accepts your own ids and must deduplicate or resume the same run. Native Vercel workflows reject an `id`. Let Workflow DevKit assign it, as in [Add a durable Vercel entry](/docs/workflows/configure#add-a-durable-vercel-entry).

## Runtime helpers

| Helper | Description |
| --- | --- |
| `startWorkflow(name, payload?, options?)` | Starts a Workflow Run immediately. |
| `deferWorkflow(name, payload?, options?)` | Starts a run after the response, through `waitUntil`. Returns nothing. A failure goes to the log. |
| `getWorkflowRun(name, id)` | Reads the current run state. |
| `cancelWorkflow(name, id)` | Cancels a native Vercel run or a pending or running OpenWorkflow run. |
| `resumeWorkflow(token, payload)` | Resumes a Vercel operation using a registered Workflow DevKit hook token. |
| `createWorkflow(name, options?)` | Returns a handle with `start`, `defer`, `getRun`, and `cancel`. |

`WorkflowStartOptions` accepts `id`.

Inline runs buffer the response body before they complete. Each inspection and duplicate start returns a new response, so reading or cancelling one result does not use up later ones. A failed body read marks the run as failed.

Inspection holds a weak reference to an active inline run:

- A run that your code still reaches stays inspectable. An abandoned run can be garbage-collected and then reports `unknown`.
- ViteHub keeps completed inline runs for five minutes, up to 1,024 per runtime. Completed runs do not push out active ones.
- Without `WeakRef` or `FinalizationRegistry`, inspection uses strong references, up to 1,024. A new run then pushes out the oldest active entry, even if it is still reachable. That entry reports `unknown`, also after it completes.

Use a durable provider when inspection must survive abandonment or a process restart.

Cancellation works for native Vercel workflows and OpenWorkflow. On OpenWorkflow, `cancelWorkflow()` cancels a pending or running run in storage. A step that already runs finishes, but its worker records no more steps or result. A finished run keeps its status. A run of another workflow reports `unknown`. Cloudflare and inline Vercel runs report `WORKFLOW_OPERATION_UNSUPPORTED`.

Signal resumption needs the Vercel provider, the Workflow DevKit runtime, and a registered hook token. You can choose a fixed opaque token. It becomes resumable when a native workflow registers the hook and waits for it. Pass it to `resumeWorkflow()`. It names the hook, not a run. Cloudflare and OpenWorkflow do not support signals.

## Workflow Run shape

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Run id from the provider or ViteHub. |
| `provider` | `WorkflowProvider` | Provider of the run. |
| `status` | `WorkflowRunStatus` | `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`. |
| `result` | `TResult` | Result, when completed. |
| `payload` | `TPayload` | Original payload when the provider returns it. |
| `metadata` | `unknown` | Provider metadata. |

Every provider uses the same statuses. A run that sleeps, waits, or waits between step retries reports `running`. A run that does not exist reports `unknown`. On Cloudflare, `waiting`, `waitingForPause`, and `paused` report `running`, and `terminated` reports `cancelled`. `metadata.status` keeps the Cloudflare status.

## Inspect a run

Call `getWorkflowRun()` to read the current run state.

```ts [server/api/workflows/[id].get.ts]
import { defineEventHandler, getRouterParam } from 'h3'
import { getWorkflowRun } from 'vite-hub/workflow'

export default defineEventHandler((event) => {
  return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
})
```

## Required handle input

A typed Workflow handle requires a payload when its handler requires one. Both `start()` and `defer()` use this rule. A handle with an optional payload or `void` input can still start with no argument. To set start options for a no-input Workflow, pass `undefined` first.

```ts fragment
const welcome = createWorkflow("welcome", async (payload: { email: string }) => {
  await sendWelcomeEmail(payload.email)
})
await welcome.start({ email: "ada@example.com" })
// welcome.start() is a type error.
```

This is a breaking type fix. Pass the required payload at each handle call. Functions that take a workflow name do not infer a handler from the string, and stored run results stay `unknown`.
