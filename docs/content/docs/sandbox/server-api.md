---
title: Sandbox server API
description: Run Sandbox Task Definitions from server code and read their results.
navigation.title: Server API
navigation.order: 5
icon: i-lucide-code-2
---

## Public imports

| Import | Use |
| --- | --- |
| `runSandboxTask` from `@vite-hub/sandbox-task` | Invoke a discovered Definition by name. Returns a native `Response`. |
| `defineSandboxTask` from `@vite-hub/sandbox-task` | Declare a free-form `<path>.sandbox-task.ts` Definition. |
| `resolveSandboxTaskRunner` from `@vite-hub/sandbox-task` | Resolve a runner and read its `executionAuthority` before execution. |
| `readRequestPayload`, `readValidatedPayload` from `@vite-hub/sandbox-task` | Read a request body, then validate it with a Standard Schema or a validation function. |
| `hubSandboxTask` from `@vite-hub/sandbox-task/vite` | Register discovery, types, package preparation, and Provider Output. |

Applications that use the `vite-hub` distribution import the same runtime APIs from `vite-hub/sandbox-task`.

## Run a Sandbox Task

`runSandboxTask(name, payload?, options?)` infers its payload type from the default function and returns a native Web `Response`. A zero-argument function accepts an `unknown` payload.

```ts [server/api/release-notes-json.post.ts]
import { runSandboxTask } from '@vite-hub/sandbox-task'

export default defineEventHandler(async () => {
  const response = await runSandboxTask('release-notes', { notes: 'ship it' }, {
    context: { requestId: 'release-notes-42' },
  })
  if (!response.ok)
    throw new Error(await response.text())
  return await response.json()
})
```

| Option | Type | Description |
| --- | --- | --- |
| `context` | `Record<string, unknown>` | Second argument passed to the entrypoint. |
| `signal` | `AbortSignal` | Abort the invocation. The caller's abort reason is preserved; this also stops cancellable provider operations. |
| `sandboxId` | `string` | Cloudflare only. Reuse a named Sandbox instead of a new Sandbox for each run. |

Payloads, context, and results use JSON serialization. Nested `Blob` and `Uint8Array` values cross the Sandbox boundary through invocation-local Sandbox files, so you do not convert them to base64. Node.js `Buffer` values keep their `Buffer` type.

Failures, including timeouts and cleanup failures, return a non-2xx JSON `Response`. A timed-out attempt returns the `SANDBOX_TASK_TIMEOUT` code.
