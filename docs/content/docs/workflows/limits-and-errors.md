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

Every `ViteHubError` needs a stable `code` and a public `message`. `error.toJSON()` returns `name`, `code`, `message`, and JSON-safe `details`. It leaves out `cause`, which stays on the error in memory for debugging. Built-in codes have the `WorkflowErrorCode` type, with a message and details per code. A thrown error does not change the retry policy.

## Retries and sleeps

A step file has no retry option. On Cloudflare and OpenWorkflow, every step file uses the same policy: `limit: 3`, `delay: '10 seconds'`, and `backoff: 'exponential'`. A Vercel `native` entry follows the Workflow DevKit rules. An inline run does not retry. [What ViteHub stores on each host](/docs/guides/durable-execution#what-vitehub-stores-on-each-host) shows what each provider does with the policy.

ViteHub has no portable sleep. A `setTimeout` in a handler is not durable. On Cloudflare and OpenWorkflow, `context.step.sleep(name, duration)` calls the durable sleep of the provider, with a duration such as `'10 minutes'`. A Vercel `native` entry uses `sleep()` from Workflow DevKit. Inline runs and normal Vercel handlers have no `context.step`.

## Production checks

Use Queue when background delivery is enough. Use Workflow when you must inspect run state, resume work, or run several steps over time.

Keep credentials and database URLs in Server Env. Hosted providers may need their own state storage or deploy setup.
