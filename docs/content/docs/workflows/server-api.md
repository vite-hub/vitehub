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
| `defineWorkflow` from `@vite-hub/workflow` | Declare a Workflow Definition. |
| `runWorkflow`, `deferWorkflow`, `getWorkflowRun`, `cancelWorkflow`, `resumeWorkflowSignal` from `@vite-hub/workflow` | Start, defer, inspect, cancel, or resume Workflow Runs. |
| `createWorkflow` from `@vite-hub/workflow` | Create an inline Workflow Handle for app-owned code. |
| `normalizeWorkflowOptions` from `@vite-hub/workflow` | Resolve Integration Options to a concrete Workflow Provider. |
| `ViteHubError` from `@vite-hub/runtime` | Throw application-owned Workflow failures with stable codes. |
| `readRequestPayload`, `readValidatedPayload`, `validatePayload` from `@vite-hub/workflow` | Read provider request payloads in custom runtime entrypoints. |
| `hubWorkflow` from `@vite-hub/workflow/vite` | Register Workflow discovery and provider output generation. |

Workflow Provider, Definition, Run, Step, Start Options, and Integration Options types are exported from `@vite-hub/workflow`.

## Start a run

Use `runWorkflow()` from server code.

```ts [server/api/onboard.post.ts]
import { runWorkflow } from '@vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string }>(event)

  return runWorkflow('onboard-user', body)
})
```

The run id belongs to Invocation Options. Use a stable id when the selected
provider supports caller-assigned ids and needs to deduplicate or resume the
same logical run. Native Vercel workflows reject an explicit `id`; let Workflow
DevKit assign it as shown in [Add a durable Vercel entry](/docs/workflows/configure#add-a-durable-vercel-entry).

## Runtime helpers

| Helper | Description |
| --- | --- |
| `runWorkflow(name, payload?, options?)` | Starts a Workflow Run immediately. |
| `deferWorkflow(name, payload?, options?)` | Starts a run through the deferred provider path when available. |
| `getWorkflowRun(name, id)` | Reads the current run state. |
| `cancelWorkflow(name, id)` | Cancels a durable Vercel run. |
| `resumeWorkflowSignal(token, payload)` | Resumes a Vercel operation using a registered Workflow DevKit hook token. |
| `createWorkflow(name, options?)` | Returns a handle with `run`, `defer`, `getRun`, and `cancel`. |

`WorkflowStartOptions` currently accepts `id`.

Inline run inspection uses weak references while execution is active. A reachable
execution remains inspectable. An abandoned execution with no remaining owner
can be garbage-collected and then reports `unknown`. Completed inline runs are
retained for five minutes, up to 1,024 entries per runtime. Completed history
does not evict active executions. If either `WeakRef` or `FinalizationRegistry`
is unavailable, active inspection uses strong references capped at 1,024 entries.
Starting another run evicts the oldest active inspection entry, even if execution
is still reachable. It reports `unknown`, and completion does not restore it.
Use a durable provider when inspection must survive abandonment or a process restart.

Cancellation currently requires a native Vercel Workflow Definition.
Cloudflare, OpenWorkflow, and inline Vercel runs report
`WORKFLOW_OPERATION_UNSUPPORTED` instead of simulating cancellation.

Signal resumption requires the Vercel provider, the Workflow DevKit runtime,
and a registered hook token. The application can choose a deterministic opaque
token; it becomes resumable when a native workflow registers the hook and
suspends while waiting for it. Pass that token to `resumeWorkflowSignal()`.
It identifies the hook, not a Workflow Run. Cloudflare and OpenWorkflow report
signals as unsupported.

## Workflow Run shape

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Provider or ViteHub Workflow Run id. |
| `provider` | `WorkflowProvider` | Selected provider for the run. |
| `status` | `WorkflowRunStatus` | `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`. |
| `result` | `TResult` | Completed result when available. |
| `payload` | `TPayload` | Original payload when the provider returns it. |
| `metadata` | `unknown` | Provider metadata. |

## Inspect a run

Use `getWorkflowRun()` when server code needs current run state.

```ts [server/api/workflows/[id].get.ts]
import { getWorkflowRun } from '@vite-hub/workflow'

export default defineEventHandler((event) => {
  return getWorkflowRun('onboard-user', getRouterParam(event, 'id')!)
})
```

## Required handle input

A typed Workflow handle requires a payload when its handler requires one. Both `run()` and `defer()` use this rule. A handle with an optional payload or `void` input can still run with no argument. To set start options for a no-input Workflow, pass `undefined` first.

```ts
const welcome = createWorkflow<{ email: string }>("welcome", async ({ payload }) => {
  await sendWelcomeEmail(payload.email)
})
await welcome.run({ email: "ada@example.com" })
// welcome.run() is a type error.
```

This is a breaking type correction. Supply the required payload at each handle call. Named operational functions do not infer a handler from a string, and persisted run results remain unknown.
