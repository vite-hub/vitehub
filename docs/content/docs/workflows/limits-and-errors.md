---
title: Workflows limits and errors
description: Throw Workflow errors with stable codes, and check a Workflow and its provider before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Structured errors

Throw `ViteHubError` for failures that look the same on every provider. ViteHub's own failures use the fixed `WorkflowErrorCode` list.

```ts [server/workflows/transcribe.ts] fragment
import { ViteHubError } from 'vite-hub/runtime'
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow('transcribe', async (payload: { recordingId: string }) => {
  try {
    return await transcribeRecording(payload.recordingId)
  }
  catch (cause) {
    throw new ViteHubError('TRANSCRIPTION_FAILED', 'Transcription failed.', {
      cause,
      details: { recordingId: payload.recordingId },
    })
  }
})
```

Every `ViteHubError` needs a stable `code` and a public `message`. `error.toJSON()` returns `name`, `code`, `message`, and JSON-safe `details`. It leaves out `cause`, which stays on the error in memory for debugging. Built-in codes have the `WorkflowErrorCode` type, with a message and details per code. When a run fails, `getWorkflowRun()` returns the thrown error as `run.error`: its `message`, and its `name` when it is not `Error`. Inline runs also keep its `code`. Cloudflare and OpenWorkflow store only the name and the message. Native Vercel runs read the error after Workflow DevKit serialization, which drops custom `code` properties on ordinary Errors. Application error codes are therefore not portable across providers. The stack, `cause`, and `details` stay out. A thrown error does not change its retry policy.

When a provider call fails, ViteHub throws `WORKFLOW_PROVIDER_OPERATION_FAILED`. Its `details` tell you what happened:

| Field | Value |
| --- | --- |
| `provider`, `operation` | The provider and the call, for example `cloudflare` and `create`. |
| `status` | The HTTP status of the provider, when it sent one. |
| `reason` | The provider error name and the first line of its message, at most 200 characters. ViteHub removes URLs, file paths, and credentials. |
| `acknowledgement` | `rejected`: the provider refused the call, so nothing started. `unknown`: the call can have reached the provider. Check the run before you start it again. |

In development, the server log also shows the full provider error.

## Retries and sleeps

A step file has no retry option. On Cloudflare and OpenWorkflow, every step file uses the same policy: `limit: 3`, `delay: '10 seconds'`, and `backoff: 'exponential'`. A Vercel `native` entry follows the Workflow DevKit rules. An inline run does not retry. [What ViteHub stores on each host](/docs/guides/durable-execution#what-vitehub-stores-on-each-host) shows what each provider does with the policy.

A `setTimeout` in a handler is not durable. Only a folder Workflow can sleep. Its `index.ts` calls `context.step.sleep(name, duration)` between steps, with a duration such as `'1 day'`. The run sleeps on Cloudflare and OpenWorkflow. A Vercel `native` entry uses `sleep()` from Workflow DevKit. Inline runs and normal Vercel handlers have no `context.step` in a folder Workflow.

```ts [server/workflows/remind-user/index.ts] fragment
import { defineWorkflow } from 'vite-hub/workflow'

export default defineWorkflow('remind-user', async (payload: { email: string }, { step, steps }) => {
  await steps.sendWelcome(payload)
  await step?.sleep?.('wait-a-day', '1 day')
  await steps.sendReminder(payload)
})
```

After a sleep, the provider runs `index.ts` again from the start. Completed step files return their stored results and do not run again, so put each side effect in a numbered step file.

A single-file Workflow, such as `server/workflows/remind-user.ts`, runs as one root step. A replay after a sleep would run the code before the sleep again. So `context.step.sleep()` in a root step throws `WORKFLOW_ROOT_STEP_SLEEP` on every provider, and the run fails without a retry. Move the Workflow to a folder to fix it.

## Production checks

Use Queue when background delivery is enough. Use Workflow when you must inspect run state, resume work, or run several steps over time.

Keep credentials and database URLs in Server Env. Hosted providers may need their own state storage or deploy setup.
