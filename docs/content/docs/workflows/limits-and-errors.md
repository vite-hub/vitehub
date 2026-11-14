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

Every `ViteHubError` needs a stable `code` and a public `message`. `error.toJSON()` returns `name`, `code`, `message`, and JSON-safe `details`. It leaves out `cause`, which stays on the error in memory for debugging. Built-in codes have the `WorkflowErrorCode` type, with a message and details per code. Set retries on the Workflow Step. A thrown error does not change its retry policy.

## Production checks

Use Queue when background delivery is enough. Use Workflow when you must inspect run state, resume work, or run several steps over time.

Keep credentials and database URLs in Server Env. Hosted providers may need their own state storage or deploy setup.
