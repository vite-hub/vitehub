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
| `NonRetryableError` from `vite-hub/workflow` | Fail a run at once, with no more retries, on every provider. |
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

Pass the run id in the options. Use a stable id when the provider accepts your own ids and must deduplicate or resume the same run. The id that you pass is the run id: `startWorkflow()` returns it, and `getWorkflowRun()` and `cancelWorkflow()` take it, on Cloudflare, OpenWorkflow, and inline runs. A second start with the same id returns the first run. Native Vercel workflows reject an `id`. Let Workflow DevKit assign it, as in [Add a durable Vercel entry](/docs/workflows/configure#add-a-durable-vercel-entry).

## Start a run later

Pass `delay` to start the run later. Use milliseconds, a duration such as `'30 minutes'` or `'3 days'`, or a `Date` that the run must not start before. A `Date` in the past starts the run now. Durations use ms, seconds, minutes, hours, days, and weeks. Use a `Date` for a month or a calendar time. A negative or unknown value fails with `WORKFLOW_START_DELAY_INVALID`.

```ts [server/api/signup.post.ts]
import { defineEventHandler, readBody } from 'h3'
import { startWorkflow } from 'vite-hub/workflow'

export default defineEventHandler(async (event) => {
  const body = await readBody<{ email: string, userId: string }>(event)
  if (!body) return new Response('Missing body', { status: 400 })

  return startWorkflow('send-reminder', body, { delay: '3 days', id: `reminder-${body.userId}` })
})
```

| Provider | How the delay works | Status during the delay |
| --- | --- | --- |
| OpenWorkflow | The run stays pending in storage until its start time. | `queued` |
| Cloudflare | The run sleeps until its start time before the handler. A waiting instance does not count toward the concurrency limit. | `running` |
| Vercel `native` entry of a folder Workflow | The generated entry calls Workflow DevKit `sleep()` before the first step. | `running` |
| Vercel `native` entry that you wrote | Not supported. `startWorkflow()` fails with `WORKFLOW_OPERATION_UNSUPPORTED`. | |
| Inline runs (`vite dev`, normal Vercel handlers) | A timer in the server process. It is not durable: a restart loses the run. | `queued` |

On Cloudflare, ViteHub cannot tell the delay from other sleeps, so the run reports `running`. For a run that repeats, call `startWorkflow()` from a [Schedule](/docs/schedule) handler.

## Runtime helpers

| Helper | Description |
| --- | --- |
| `startWorkflow(name, payload?, options?)` | Starts a Workflow Run now, or after `options.delay`. |
| `deferWorkflow(name, payload?, options?)` | Starts a run after the response, through `waitUntil`. Returns nothing. A failure goes to the log. |
| `getWorkflowRun(name, id)` | Reads the current run state. |
| `cancelWorkflow(name, id)` | Cancels a Cloudflare run, a native Vercel run, or a pending or running OpenWorkflow run. |
| `resumeWorkflow(token, payload)` | Resumes a Vercel operation using a registered Workflow DevKit hook token. |
| `createWorkflow(name, options?)` | Returns a handle with `start`, `defer`, `getRun`, and `cancel`. |

`WorkflowStartOptions` accepts `id` and `delay`. For `id`, use only letters, digits, `-`, and `_`, start with a letter, a digit, or `_`, and use up to 100 characters, so the id works on every provider. On Cloudflare, `startWorkflow()` rejects another id with `WORKFLOW_CLOUDFLARE_RUN_ID_INVALID`, also in `vite dev`. `getWorkflowRun()` queries Cloudflare for existing instances, whose ids can follow different rules. `createWorkflow({ id })` hashes its value into an id that follows these rules.

The `result` of a completed run is the value that the handler returned, stored as JSON. All providers return the same plain value. A `Date` comes back as a string, and `undefined` fields are removed. Return a JSON-safe value. Return a `Response` for binary data, a status, or headers. Then `result` is a `Response`.

Inline runs buffer a returned `Response` body before they complete. Each inspection and duplicate start returns a new `Response`, so reading or cancelling one result does not use up later ones. A failed body read marks the run as failed.

Inspection holds a weak reference to an active inline run:

- A run that your code still reaches stays inspectable. An abandoned run can be garbage-collected and then reports `unknown`.
- ViteHub keeps completed inline runs for five minutes, up to 1,024 per runtime. Completed runs do not push out active ones.
- Without `WeakRef` or `FinalizationRegistry`, inspection uses strong references, up to 1,024. A new run then pushes out the oldest active entry, even if it is still reachable. That entry reports `unknown`, also after it completes.

Use a durable provider when inspection must survive abandonment or a process restart.

Cancellation works for Cloudflare, native Vercel workflows, and OpenWorkflow. On Cloudflare, `cancelWorkflow()` calls `instance.terminate()` on a queued, running, waiting, or paused run, and returns the run with the status `cancelled`. On OpenWorkflow, it cancels a pending or running run in storage. A step that already runs finishes, but its worker records no more steps or result. On both, a finished run keeps its status and a run that does not exist reports `unknown`. On OpenWorkflow, a run of another workflow also reports `unknown`. Inline runs, such as Cloudflare runs in `vite dev` without a binding and inline Vercel runs, report `WORKFLOW_OPERATION_UNSUPPORTED`.

Signal resumption needs the Vercel provider, the Workflow DevKit runtime, and a registered hook token. You can choose a fixed opaque token. It becomes resumable when a native workflow registers the hook and waits for it. Pass it to `resumeWorkflow()`. It names the hook, not a run. Cloudflare, OpenWorkflow, and inline runs do not support signals: `resumeWorkflow()` throws `WORKFLOW_OPERATION_UNSUPPORTED`. In `vite dev` every run is inline, and so is an app with no native entry.

## Workflow Run shape

| Field | Type | Description |
| --- | --- | --- |
| `id` | `string` | Run id from the provider or ViteHub. |
| `provider` | `WorkflowProvider` | Provider of the run. |
| `status` | `WorkflowRunStatus` | `queued`, `running`, `completed`, `failed`, `cancelled`, or `unknown`. |
| `result` | `TResult` | The value that the handler returned, as JSON, when completed. A `Response` when the handler returned one. |
| `payload` | `TPayload` | Original payload when the provider returns it. |
| `error` | `WorkflowRunError` | `{ message, name?, code? }` when the status is `failed`. Every provider sets it. It is safe to send as JSON. |
| `metadata` | `unknown` | Provider metadata. |
| `createdAt`, `startedAt`, `completedAt` | `Date` | Run times. OpenWorkflow and native Vercel runs set them. |
| `steps` | `WorkflowRunStep[]` | One entry per step, with its latest `attempt`, `status`, times, and error `message`. OpenWorkflow and native Vercel runs set it in `getWorkflowRun()`. |

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
