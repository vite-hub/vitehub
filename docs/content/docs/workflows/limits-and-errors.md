---
title: Workflows limits and errors
description: Throw stable Workflow errors and check Workflows before production.
navigation.title: Limits and errors
navigation.order: 7
icon: i-lucide-circle-alert
---

## Structured errors

Throw `ViteHubError` when app code needs a stable failure contract across Workflow Providers. ViteHub-owned failures use the package's fixed `WorkflowErrorCode` vocabulary.

```ts [server/workflows/transcribe.ts]
import { ViteHubError } from '@vite-hub/runtime'
import { defineWorkflow } from '@vite-hub/workflow'

export default defineWorkflow<{ recordingId: string }>(async ({ payload }) => {
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

Every `ViteHubError` requires a stable `code` and public `message`. Calling `error.toJSON()` returns `name`, `code`, `message`, and JSON-safe `details`; it omits `cause`, which stays on the in-memory error for logging and debugging. ViteHub's built-in codes are typed as `WorkflowErrorCode` with code-derived messages and code-specific details. Configure retries on the Workflow Step; throwing an error does not override the Step's retry policy.

## Production checks

Use Queue when background delivery is enough. Use Workflow when the app must inspect run state, resume work, or coordinate multiple steps over time.

Keep credentials and database URLs in Server Env. Hosted workflow providers may require explicit state storage or deployment setup.
